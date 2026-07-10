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
  kv_id=$(echo "$list_resp" | jq -r '.result | map(select(.title | test("^hcpss-status-kv-[0-9]+$"))) | sort_by(.title) | last | .id // empty')
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

ensure_command() {
  local name="$1"
  local description="$2"

  local command_payload
  if [ "$name" = "override" ]; then
    command_payload=$(jq -n \
      --arg name "$name" \
      --arg description "$description" \
      '{
        name: $name,
        description: $description,
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
      }')
  elif [ "$name" = "config" ]; then
    command_payload=$(jq -n \
      --arg name "$name" \
      --arg description "$description" \
      '{
        name: $name,
        description: $description,
        type: 1,
        dm_permission: false,
        options: [
          { name: "color", description: "Custom HEX color code for status embeds (e.g. 2ECC71).", type: 3, required: false },
          { name: "footer", description: "Custom footer text for status embeds.", type: 3, required: false },
          {
            name: "status",
            description: "Which status to apply the custom color to (defaults to current configuration selection).",
            type: 3,
            required: false,
            choices: [
              { name: "Normal Operations", value: "normal_operations" },
              { name: "Schools Closed", value: "schools_closed" },
              { name: "Schools and Offices Closed", value: "schools_and_offices_closed" },
              { name: "Schools Open 2 Hours Late", value: "schools_open_2_hours_late" },
              { name: "Schools Close 3 Hours Early", value: "schools_close_3_hours_early" },
              { name: "Other/Unknown Alert", value: "unknown_alert" }
            ]
          }
        ]
      }')
  elif [ "$name" = "events" ]; then
    command_payload=$(jq -n \
      --arg name "$name" \
      --arg description "$description" \
      '{
        name: $name,
        description: $description,
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
      }')
  else
    command_payload=$(jq -n \
      --arg name "$name" \
      --arg description "$description" \
      '{ name: $name, description: $description, type: 1, dm_permission: false }')
  fi

global_base="https://discord.com/api/v10/applications/${discord_application_id}"
# Register commands globally so they are available across all servers
commands_base="$global_base"

commands_resp=$(curl -sS -X GET "${commands_base}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json")
command_id=$(echo "$commands_resp" | jq -r --arg name "$name" '.[]? | select(.name == $name) | .id' | head -n 1)

if [ -n "$command_id" ]; then
  command_resp=$(curl -sS -X PATCH "${commands_base}/commands/${command_id}" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$command_payload")
else
  command_resp=$(curl -sS -X POST "${commands_base}/commands" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$command_payload")
fi

if [ -z "$(echo "$command_resp" | jq -r '.id // empty')" ]; then
  echo "Failed to register /${name} command: $command_resp" >&2
  exit 1
fi

# If we are registering a global command, delete any guild command to avoid duplicate commands.
if [ -n "${DISCORD_GUILD_ID:-}" ]; then
  guild_resp=$(curl -sS -X GET "${global_base}/guilds/${DISCORD_GUILD_ID}/commands" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json")
  guild_ids=$(echo "$guild_resp" | jq -r --arg name "$name" '.[]? | select(.name == $name) | .id')
  if [ -n "$guild_ids" ]; then
    echo "Removing guild /${name} command(s) to prevent duplicates..."
    while IFS= read -r id; do
      [ -z "$id" ] && continue
      curl -sS -X DELETE "${global_base}/guilds/${DISCORD_GUILD_ID}/commands/${id}" \
        -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
        -H "Content-Type: application/json" >/dev/null || true
    done <<< "$guild_ids"
  fi
fi
}

delete_command() {
  local name="$1"
  local global_base="https://discord.com/api/v10/applications/${discord_application_id}"
  local commands_base="$global_base"

  # Delete from global commands base
  local commands_resp
  commands_resp=$(curl -sS -X GET "${commands_base}/commands" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json")
  local command_ids
  command_ids=$(echo "$commands_resp" | jq -r --arg name "$name" '.[]? | select(.name == $name) | .id')
  if [ -n "$command_ids" ]; then
    while IFS= read -r id; do
      [ -z "$id" ] && continue
      echo "Deleting global command /${name} (ID: ${id})..."
      curl -sS -X DELETE "${commands_base}/commands/${id}" \
        -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
        -H "Content-Type: application/json" >/dev/null || true
    done <<< "$command_ids"
  fi

  # Also delete from guild scope if guild id is set to prevent duplicates
  if [ -n "${DISCORD_GUILD_ID:-}" ]; then
    local guild_resp
    guild_resp=$(curl -sS -X GET "${global_base}/guilds/${DISCORD_GUILD_ID}/commands" \
      -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
      -H "Content-Type: application/json")
    local guild_ids
    guild_ids=$(echo "$guild_resp" | jq -r --arg name "$name" '.[]? | select(.name == $name) | .id')
    if [ -n "$guild_ids" ]; then
      while IFS= read -r id; do
        [ -z "$id" ] && continue
        echo "Deleting guild command /${name} (ID: ${id}) to prevent duplicates..."
        curl -sS -X DELETE "${global_base}/guilds/${DISCORD_GUILD_ID}/commands/${id}" \
          -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
          -H "Content-Type: application/json" >/dev/null || true
      done <<< "$guild_ids"
    fi
  fi
}

ensure_command "post-status" "Post the latest HCPSS status now."
ensure_command "override" "Override the posted status for a set number of days."
ensure_command "calendar" "Show scheduled closures or events in the next 7 days."
ensure_command "history" "Show the last 5 operating status changes."
ensure_command "events" "Manage dynamic calendar events."
ensure_command "stats" "Show status check and operating status statistics."

delete_command "overide"
delete_command "config"

echo "Publishing Worker..."
wrangler deploy

echo "Done. Worker published."
