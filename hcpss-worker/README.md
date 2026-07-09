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

6. (Optional) Set the Worker URL as the Discord Application Interactions Endpoint and implement request verification before enabling interaction handling.

Notes:
- The code currently posts messages and stores the last message id in KV. It includes a `Check again` button in the message components, but interaction verification/handling is not implemented in this scaffold for security reasons. See the README section "Interactions" for next steps.

Interactions:
- To safely handle button clicks, you must verify Discord request signatures using your `DISCORD_PUBLIC_KEY`. Use a library like `tweetnacl` and verify the `X-Signature-Ed25519` and `X-Signature-Timestamp` headers on incoming requests before responding.
