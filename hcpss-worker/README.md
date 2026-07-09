HCPSs Status Monitor - Cloudflare Worker

This Worker performs the scheduled HCPSS status check and posts to Discord using a Bot token.

Quick setup:

1. Install Wrangler and login:
```bash
npm install -g wrangler
wrangler login
```

2. Create a KV namespace and note the ID:
```bash
wrangler kv:namespace create STATUS_STATE --binding STATUS_KV
```

3. Edit `wrangler.toml` and replace `PASTE_YOUR_KV_ID_HERE` with the KV id returned above.

4. Set secrets:
```bash
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_CHANNEL_ID
```

5. Publish the worker:
```bash
wrangler publish
```

6. Set the Worker URL as the Discord Application Interactions Endpoint (Application → General Information → Interactions Endpoint URL).

Notes:
- The code posts messages and stores the last message id in KV `STATUS_KV` at key `last_message_id`.
- The Worker now implements request signature verification for Discord interactions and will:
	- Respond to PINGs (type 1) with a PONG.
	- Respond to the `check_again` button (component interaction) with an ephemeral reply containing the latest status.

Secrets and bindings required (use `wrangler secret put` and `wrangler kv:namespace create`):
```bash
wrangler kv:namespace create STATUS_STATE --binding STATUS_KV
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_CHANNEL_ID
wrangler secret put DISCORD_PUBLIC_KEY
```

After those are configured, `wrangler publish` will deploy the Worker which will handle both scheduled runs and interactions.

CI / GitHub Actions automatic deploy
----------------------------------
If you prefer not to run `wrangler` locally, this repository includes a GitHub Actions workflow that can create the KV namespace, upload the required secrets, and publish the Worker for you.

Required repository secrets:
- `CF_API_TOKEN` — Cloudflare API token with Workers & KV permissions
- `CF_ACCOUNT_ID` — your Cloudflare account id
- `DISCORD_BOT_TOKEN` — your Discord bot token
- `DISCORD_CHANNEL_ID` — the target Discord channel id for posts
- `DISCORD_PUBLIC_KEY` — your Discord Application public key

After setting the secrets in the repo, go to the Actions tab and run the "Deploy HCPSS Worker" workflow (or push to `main`). The workflow will create a KV namespace and publish the Worker.
