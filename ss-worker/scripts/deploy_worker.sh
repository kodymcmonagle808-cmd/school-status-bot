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
# Keep the analytics var in sync with the actual namespace (uppercase name, so
# the lowercase `id = ` patch above never touches it).
sed -i.bak -E "s/KV_NAMESPACE_ID = \"[^\"]*\"/KV_NAMESPACE_ID = \"${kv_id}\"/" "$toml_file"
sed -i.bak -E "s/DISCORD_PUBLIC_KEY = \"[^\"]*\"/DISCORD_PUBLIC_KEY = \"${DISCORD_PUBLIC_KEY}\"/" "$toml_file"
# Stamp the deployed commit so /health reports exactly what's running.
if [ -n "${GITHUB_SHA:-}" ]; then
  sed -i.bak -E "s/GIT_SHA = \"[^\"]*\"/GIT_SHA = \"${GITHUB_SHA}\"/" "$toml_file"
fi
if [ -n "${DISCORD_GUILD_ID:-}" ]; then
  sed -i.bak -E "s/DISCORD_GUILD_ID = \"[^\"]*\"/DISCORD_GUILD_ID = \"${DISCORD_GUILD_ID}\"/" "$toml_file"
fi
echo "Patched $toml_file"

echo "Uploading Discord secrets to Wrangler (non-interactive)..."
# Upload all secrets in one bulk call (a single new worker version) instead of
# sequential `secret put` calls, which each create a version and intermittently
# fail with Cloudflare API error 10013.
secrets_json=$(jq -n --arg bot "$DISCORD_BOT_TOKEN" --arg chan "$DISCORD_CHANNEL_ID" \
  '{DISCORD_BOT_TOKEN: $bot, DISCORD_CHANNEL_ID: $chan}')
if [ -n "${MANUAL_TRIGGER_TOKEN:-}" ]; then
  secrets_json=$(printf '%s' "$secrets_json" | jq --arg t "$MANUAL_TRIGGER_TOKEN" '. + {MANUAL_TRIGGER_TOKEN: $t}')
else
  echo "MANUAL_TRIGGER_TOKEN not set; manual public POST trigger will remain disabled."
fi
if [ -n "${OWNER_ID:-}" ]; then
  secrets_json=$(printf '%s' "$secrets_json" | jq --arg o "$OWNER_ID" '. + {OWNER_ID: $o}')
else
  echo "OWNER_ID not set; the panel's Worker Updates page will stay locked."
fi
if [ -n "${NWS_HOOK_SECRET:-}" ]; then
  secrets_json=$(printf '%s' "$secrets_json" | jq --arg n "$NWS_HOOK_SECRET" '. + {NWS_HOOK_SECRET: $n}')
else
  echo "NWS_HOOK_SECRET not set; /nws-hook stays disabled and the NWS alert scan keeps its 10-minute cron cadence."
fi
# CF creds (already required above) let the Worker read Cloudflare's KV
# analytics for the owner Worker Updates usage gauge — no KV writes involved.
secrets_json=$(printf '%s' "$secrets_json" | jq \
  --arg tok "$CF_API_TOKEN" --arg acct "$CF_ACCOUNT_ID" \
  '. + {CF_API_TOKEN: $tok, CF_ACCOUNT_ID: $acct}')

secrets_uploaded=0
for attempt in 1 2 3; do
  if printf '%s' "$secrets_json" | wrangler secret bulk; then
    secrets_uploaded=1
    break
  fi
  echo "Secret bulk upload failed (attempt $attempt); retrying in 10s..." >&2
  sleep 10
done
if [ "$secrets_uploaded" != "1" ]; then
  echo "Failed to upload secrets after 3 attempts." >&2
  exit 1
fi

echo "Registering Discord slash commands..."
discord_application_id=$(grep -E '^DISCORD_APPLICATION_ID = ' "$toml_file" | sed -E 's/.*"([^"]+)".*/\1/')
if [ -z "$discord_application_id" ]; then
  echo "Could not find DISCORD_APPLICATION_ID in wrangler.toml." >&2
  exit 1
fi

payload=$(cat "$script_dir/commands_schema.json")

global_base="https://discord.com/api/v10/applications/${discord_application_id}"

echo "Registering global slash commands via bulk overwrite..."
# Back-to-back deploys (e.g. merging several PRs) can trip Discord's rate
# limit on this endpoint; honor retry_after instead of failing the deploy.
for attempt in 1 2 3; do
  resp=$(curl -sS -X PUT "${global_base}/commands" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$payload")
  if echo "$resp" | jq -e 'type == "array"' >/dev/null; then
    break
  fi
  retry_after=$(echo "$resp" | jq -r '.retry_after // empty' 2>/dev/null)
  if [ -n "$retry_after" ] && [ "$attempt" -lt 3 ]; then
    wait_s=$(awk -v r="$retry_after" 'BEGIN { printf "%d", r + 2 }')
    echo "Rate limited registering commands; retrying in ${wait_s}s (attempt ${attempt}/3)..."
    sleep "$wait_s"
  else
    echo "Failed to register global commands: $resp" >&2
    exit 1
  fi
done
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
