#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CF_API_TOKEN:-}" ] || [ -z "${CF_ACCOUNT_ID:-}" ]; then
  echo "CF_API_TOKEN and CF_ACCOUNT_ID must be set as repository secrets." >&2
  exit 1
fi

export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-$CF_API_TOKEN}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$CF_ACCOUNT_ID}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
toml_file="$project_dir/wrangler.toml"

cd "$project_dir"

namespace_title="hcpss-status-kv"

echo "Finding KV namespace..."
list_resp=$(curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces?per_page=100" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json")

kv_id=$(echo "$list_resp" | jq -r --arg title "$namespace_title" '.result[]? | select(.title == $title) | .id' | head -n 1)
if [ -z "$kv_id" ]; then
  kv_id=$(echo "$list_resp" | jq -r '.result // [] | map(select(.title | test("^hcpss-status-kv-[0-9]+$"))) | sort_by(.title) | last | .id // empty')
fi

if [ -z "$kv_id" ]; then
  echo "Creating KV namespace..."
  create_resp=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{ \"title\": \"${namespace_title}\" }")
  kv_id=$(echo "$create_resp" | jq -r '.result.id // empty')
  if [ -z "$kv_id" ]; then
    echo "Failed to create KV namespace: $create_resp" >&2
    exit 1
  fi
  echo "Created KV id: $kv_id"
else
  echo "Reusing KV id: $kv_id"
fi

echo "Patching wrangler.toml with KV id..."
sed -i.bak -E "s/id = \"[^\"]*\"/id = \"${kv_id}\"/" "$toml_file"
sed -i.bak -E "s/DISCORD_PUBLIC_KEY = \"[^\"]*\"/DISCORD_PUBLIC_KEY = \"${DISCORD_PUBLIC_KEY}\"/" "$toml_file"
if [ -n "${DISCORD_GUILD_ID:-}" ]; then
  sed -i.bak -E "s/DISCORD_GUILD_ID = \"[^\"]*\"/DISCORD_GUILD_ID = \"${DISCORD_GUILD_ID}\"/" "$toml_file"
fi
echo "Patched $toml_file"

echo "Uploading Discord secrets to Wrangler (non-interactive)..."
printf '%s' "$DISCORD_BOT_TOKEN" | wrangler secret put DISCORD_BOT_TOKEN
printf '%s' "$DISCORD_CHANNEL_ID" | wrangler secret put DISCORD_CHANNEL_ID
if [ -n "${MANUAL_TRIGGER_TOKEN:-}" ]; then
  printf '%s' "$MANUAL_TRIGGER_TOKEN" | wrangler secret put MANUAL_TRIGGER_TOKEN
else
  echo "MANUAL_TRIGGER_TOKEN not set; manual public POST trigger will remain disabled."
fi

echo "Registering Discord slash commands..."
discord_application_id=$(grep -E '^DISCORD_APPLICATION_ID = ' "$toml_file" | sed -E 's/.*"([^"]+)".*/\1/')
if [ -z "$discord_application_id" ]; then
  echo "Could not find DISCORD_APPLICATION_ID in wrangler.toml." >&2
  exit 1
fi

payload=$(jq -n '[
  {
    name: "post-status",
    description: "Post the latest HCPSS status now.",
    type: 1,
    dm_permission: false
  },
  {
    name: "override",
    description: "Override the posted status for a set number of days.",
    type: 1,
    dm_permission: false,
    options: [
      {
        name: "set",
        description: "Enable an override for a number of days.",
        type: 1,
        options: [
          { name: "days", description: "How many days the override should last (1-30).", type: 4, required: true, min_value: 1, max_value: 30 },
          {
            name: "status",
            description: "Which status to display.",
            type: 3,
            required: true,
            choices: [
              { name: "Normal Operations", value: "normal_operations" },
              { name: "Schools Closed", value: "schools_closed" },
              { name: "Schools and Offices Closed", value: "schools_and_offices_closed" },
              { name: "Schools Open 2 Hours Late", value: "schools_open_2_hours_late" },
              { name: "Schools Close 3 Hours Early", value: "schools_close_3_hours_early" }
            ]
          },
          { name: "details", description: "Optional extra details.", type: 3, required: false, max_length: 4000 },
          { name: "title", description: "Optional embed title override.", type: 3, required: false, max_length: 256 }
        ]
      },
      {
        name: "clear",
        description: "Disable the active override immediately.",
        type: 1
      }
    ]
  },
  {
    name: "calendar",
    description: "Show scheduled closures or events in the next 7 days.",
    type: 1,
    dm_permission: false
  },
  {
    name: "history",
    description: "Show the last 10 operating status changes.",
    type: 1,
    dm_permission: false
  },
  {
    name: "events",
    description: "Manage dynamic calendar events.",
    type: 1,
    dm_permission: false,
    options: [
      {
        name: "add",
        description: "Add a dynamic calendar event.",
        type: 1,
        options: [
          { name: "date", description: "Date of the event (YYYY-MM-DD).", type: 3, required: true },
          { name: "event", description: "Event description (e.g. Winter Break).", type: 3, required: true }
        ]
      },
      {
        name: "remove",
        description: "Remove a dynamic calendar event.",
        type: 1,
        options: [
          { name: "date", description: "Date of the event to remove (YYYY-MM-DD).", type: 3, required: true }
        ]
      },
      {
        name: "list",
        description: "List all dynamic calendar events.",
        type: 1
      }
    ]
  },
  {
    name: "stats",
    description: "Show status check and operating status statistics.",
    type: 1,
    dm_permission: false
  },
  {
    name: "setup",
    description: "Initial one-time setup for the status monitor.",
    type: 1,
    dm_permission: false,
    default_member_permissions: "8"
  },
  {
    name: "announce",
    description: "Post a custom embed announcement in this channel.",
    type: 1,
    dm_permission: false
  }
]')

global_base="https://discord.com/api/v10/applications/${discord_application_id}"

echo "Registering global slash commands via bulk overwrite..."
resp=$(curl -sS -X PUT "${global_base}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$payload")

if ! echo "$resp" | jq -e 'type == "array"' >/dev/null; then
  echo "Failed to register global commands: $resp" >&2
  exit 1
fi
echo "Registered global slash commands successfully."

if [ -n "${DISCORD_GUILD_ID:-}" ]; then
  echo "Clearing guild-specific commands to prevent duplicates..."
  guild_resp=$(curl -sS -X PUT "${global_base}/guilds/${DISCORD_GUILD_ID}/commands" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "[]")
  if ! echo "$guild_resp" | jq -e 'type == "array"' >/dev/null; then
    echo "Warning: Failed to clear guild commands: $guild_resp" >&2
  fi
fi

echo "Publishing Worker..."
wrangler deploy

echo "Done. Worker published."
