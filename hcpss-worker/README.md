# HCPSS Status Monitor - Cloudflare Worker

This Worker checks the HCPSS status page, posts the current status to Discord, and handles the Discord `Check again` button privately.

## What It Does

- Posts status updates on the configured cron schedule.
- Replaces the previous Discord status message instead of stacking messages.
- Verifies Discord interaction signatures before handling button clicks.
- Responds to `Check again` with a private ephemeral embed.
- Shows active NWS weather alerts for Howard County on status embeds (toggleable in Settings > Feature Toggles).
- Storm mode: while a winter storm alert is active, checks every 15 minutes during the 4:30–7:30 AM ET decision window and posts (with pings) only if the status changed.
- Evening posts (5 PM ET onward) include a Tomorrow Outlook: the next day's calendar event and storm alerts likely to still be active by morning.
- Retries failed scrapes once, then falls back to the last known status (up to 24h old) with a stale-data banner instead of going dark.
- Offers a `🔔 Notify Me` button — anyone can opt into a DM when the operating status actually changes; click again to unsubscribe.
- Records up to 200 status changes and reports school-year stats (closure days, delays, early closings) in `/stats`.
- Adds staff-only `/post-status` to publish a fresh public status from Discord.
- Adds staff-only `/config` to set the alert channel, log channel, staff role, and emergency ping roles.
- Logs scheduled checks, manual triggers, and `/post-status` runs to the configured log channel.
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
- `DISCORD_GUILD_ID` optional, recommended so `/post-status` and `/config` appear immediately
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

## Worker Source Layout

- `src/index.js` — Discord interaction routing, control panel, and check/post pipeline.
- `src/scraper.js` — status page fetching/parsing, retry, and last-good-scrape fallback cache.
- `src/weather.js` — NWS active alerts for Howard County (zone MDC027) with a 10-minute KV cache.
- `src/history.js` — status change history (200 entries) and school-year incident stats.
- `src/subscriptions.js` — DM notify-on-change subscriber list and delivery.
- `src/timeutil.js` — Eastern-time and schedule formatting helpers.

## Tests

```bash
cd hcpss-worker
node --test
```

No dependencies needed (Node 20+). The deploy workflow runs these before deploying.

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

By default, commands require staff role `1521682363942436896` and check logs go to channel `1524911607942221965`. Both can be changed with `/config`.
