# HCPSS Status Monitor - Cloudflare Worker

This Worker checks the HCPSS status page, posts the current status to Discord, and handles the Discord `Check again` button privately.

## What It Does

- Posts status updates on the configured cron schedule.
- Replaces the previous Discord status message instead of stacking messages.
- Verifies Discord interaction signatures before handling button clicks.
- Responds to `Check again` with a private ephemeral embed.
- Adds `Last checked` timing to public and private embeds.
- Posts an error embed if the HCPSS status page cannot be fetched.
- Exposes `GET /health` for a lightweight health check.
- Protects unsigned manual `POST` triggers with `MANUAL_TRIGGER_TOKEN`.

## GitHub Actions Deploy

Add these repository secrets under GitHub repo `Settings` > `Secrets and variables` > `Actions`:

- `CF_API_TOKEN`
- `CF_ACCOUNT_ID`
- `DISCORD_BOT_TOKEN`
- `DISCORD_CHANNEL_ID`
- `DISCORD_PUBLIC_KEY`
- `MANUAL_TRIGGER_TOKEN` optional, but required if you want manual public POST triggers

Then run the `Deploy HCPSS Worker` workflow, or push to `main`.

The workflow creates a KV namespace, patches `wrangler.toml`, uploads Worker secrets, and deploys the Worker.

The deploy script reuses an existing HCPSS KV namespace when one is present so the Worker keeps the previous Discord message ID across redeploys.

## Discord Setup

Set the Worker URL as your Discord Application Interactions Endpoint URL:

```text
https://hcpss-worker.kodymcmonagle808.workers.dev
```

Discord Developer Portal path:

```text
Application > General Information > Interactions Endpoint URL
```

## Manual Trigger

Unsigned manual `POST` requests are blocked unless `MANUAL_TRIGGER_TOKEN` is configured.

The GitHub `Get Current Status On-Demand` workflow also uses this Worker endpoint, so manual runs and scheduled Worker runs share the same KV message tracker.

PowerShell example:

```powershell
$headers = @{ Authorization = "Bearer YOUR_MANUAL_TRIGGER_TOKEN" }
Invoke-WebRequest -Method POST "https://hcpss-worker.kodymcmonagle808.workers.dev" -Headers $headers
```

You can also use the explicit header:

```powershell
$headers = @{ "x-manual-trigger-token" = "YOUR_MANUAL_TRIGGER_TOKEN" }
Invoke-WebRequest -Method POST "https://hcpss-worker.kodymcmonagle808.workers.dev" -Headers $headers
```

## Health Check

```text
GET https://hcpss-worker.kodymcmonagle808.workers.dev/health
```

The health check returns JSON with the Worker name, timestamp, and whether the manual trigger token is configured.

## Local Wrangler Notes

If deploying locally instead of GitHub Actions:

```bash
wrangler kv:namespace create STATUS_STATE --binding STATUS_KV
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_CHANNEL_ID
wrangler secret put MANUAL_TRIGGER_TOKEN
wrangler deploy
```

`DISCORD_PUBLIC_KEY` is stored as a Worker variable in `wrangler.toml`, not as a secret.
