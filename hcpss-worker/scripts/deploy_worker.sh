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

echo "Creating KV namespace..."
create_resp=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{ \"title\": \"hcpss-status-kv-$(date +%s)\" }")
kv_id=$(echo "$create_resp" | jq -r '.result.id // empty')
if [ -z "$kv_id" ]; then
  echo "Failed to create KV namespace: $create_resp" >&2
  exit 1
fi
echo "Created KV id: $kv_id"

echo "Patching wrangler.toml with KV id..."
sed -i.bak -E "s/id = \"[^\"]*\"/id = \"${kv_id}\"/" "$toml_file"
echo "Patched $toml_file"

echo "Uploading Discord secrets to Wrangler (non-interactive)..."
printf '%s' "$DISCORD_BOT_TOKEN" | wrangler secret put DISCORD_BOT_TOKEN
printf '%s' "$DISCORD_CHANNEL_ID" | wrangler secret put DISCORD_CHANNEL_ID
printf '%s' "$DISCORD_PUBLIC_KEY" | wrangler secret put DISCORD_PUBLIC_KEY

echo "Publishing Worker..."
wrangler deploy

echo "Done. Worker published."
