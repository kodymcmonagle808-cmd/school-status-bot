# School Status - Cloudflare Worker

School Status is an unofficial Discord bot that monitors the HCPSS operating status (and six neighboring Maryland districts) and posts automated updates.

This Worker checks the HCPSS status page, posts the current status to Discord, and handles the Discord `Check again` button privately.

## What It Does

- Posts status updates on the configured cron schedule.
- Replaces the previous Discord status message instead of stacking messages.
- Verifies Discord interaction signatures before handling button clicks.
- Responds to `Check again` with a private ephemeral embed.
- Shows active NWS weather alerts for Howard County on status embeds (toggleable in Settings > Feature Toggles).
- Storm mode: while a storm or heat alert is active, checks every 15 minutes during the 4:30–7:30 AM ET decision window (closings/delays) and the 10 AM–2 PM ET midday window (early dismissals), posting (with pings) only if the status changed. An alert in any followed district's NWS zone opens the window, not just Howard County's.
- Evening posts (5 PM ET onward) include a Tomorrow Outlook: the next day's calendar event and storm alerts likely to still be active by morning.
- Nearby Districts: while a storm alert is active, status embeds show what the six neighboring districts (Anne Arundel, Baltimore Co., Carroll, Frederick, Montgomery, Prince George's) have announced; `/districts` shows the same list on demand (toggleable in Settings > Feature Toggles).
- Closure Outlook: while a storm or heat alert is active (and HCPSS still shows Normal Operations), embeds include a Low/Moderate/High/Very High estimate of a closing or delay, scored from the strongest NWS alert plus nearby districts' calls (toggleable). Winter events get a ❄️ title, heat events a 🌡️ one.
- Outlook Track Record: every storm evening's 7 PM outlook is recorded as a prediction and graded the next day against what HCPSS actually did; `/stats` shows the per-level hit rate ("High evenings: 5/6 followed by a closing or delay").
- Snowfall Forecast: during a storm alert, embeds show the NWS forecast's expected snow/ice accumulations ("New snow accumulation of 4 to 8 inches possible") for the next few forecast periods.
- Night-Before Heads-Up: a 7:00 PM ET alert (with pings) when the Closure Outlook reaches High/Very High while the district still shows Normal Operations — includes the snowfall forecast, active alerts, and nearby districts (toggleable, on by default). Servers following a neighboring district get a heads-up built from that district's own weather zone, county, and announcements.
- Bus & Transportation Alerts: watches the HCPSS News feed for transportation service posts (route suspensions, systemwide delays, restorations) and posts new ones to the alert channel between 5 AM–10 PM ET (toggleable, on by default).
- Activities & Athletics Alerts: after-school activity, athletics, and field trip cancellations from HCPSS News ("all after-school and evening activities are canceled") post without pings — the status page never shows these (toggleable, on by default).
- School-Specific Notices: single-building announcements from HCPSS News ("X Elementary closed for a water main break") post as low-key notices without pings (toggleable, on by default).
- Power Outages: during storm alerts, embeds show BGE customers without power in the county (from BGE's own public county feed); widespread outages (5%+/20%+ of the county) raise the Closure Outlook score (toggleable).
- Storm Live Refresh: while a power-threatening storm warning is active (ice storm, blizzard, winter storm, high wind, severe thunderstorm, or anything NWS rates Extreme), the posted status message is edited in place every 15 minutes so outages, road conditions, nearby districts, and weather alerts stay current — no new posts, no pings. Watches and advisory-level events don't trigger it. A qualifying warning in a followed district's own zone triggers it too (probed at most once per 15 minutes).
- Road Conditions: during storm alerts, embeds show active MD CHART road incidents in the county — crashes, closures, ice/flooding — with traffic alerts first (toggleable).
- Primary District: each server can follow a neighboring district (Anne Arundel, Baltimore Co., Carroll, Frederick, Montgomery, Prince George's) instead of HCPSS — status posts, weather alerts (that county's NWS zone), storm-mode change detection, the night-before heads-up, `/history`/`/stats` (each district keeps its own status history and per-year archive), ping roles, and DM notifications all follow the chosen district, with HCPSS shown in its Nearby Districts list. Set it in Settings > Feature Toggles.
- Source Cross-Check: scans the [HCPSS News](https://news.hcpss.org) RSS feed and warns on the embed when a recent news post reads as a closing/delay but the status page still shows Normal Operations (toggleable).
- Retries failed scrapes once, then falls back to the last known status (up to 24h old) with a stale-data banner instead of going dark.
- Alerts staff after 3 consecutive scraper failures, and posts a recovery notice when the scraper starts working again.
- Offers a `🔔 Notify Me` button — anyone can opt into a DM when the operating status actually changes; click again to unsubscribe.
- Records up to 200 status changes and reports school-year stats (closure days, delays, early closings) in `/stats`, including a per-school-year archive so past years stay comparable ("3 closures this year vs. 5 in 2025-26").
- Adds staff-only `/post-status` to publish a fresh public status from Discord.
- Adds staff-only `/config` to set the alert channel, log channel, staff role, and emergency ping roles.
- Logs scheduled checks, manual triggers, and `/post-status` runs to the configured log channel.
- Adds `Last checked` timing to public and private embeds.
- Posts an error embed if the HCPSS status page cannot be fetched.
- Daily cleanup: once a day, checks each configured server for bot membership and automatically purges all stored KV data (config, logs, subscribers, calendar events, greeter records) for servers the bot has been removed from, as promised in the Privacy Policy.
- Member commands (no staff role needed, all ephemeral): `/status` (current status on demand), `/snowday` (closing/delay outlook from weather, districts, and outages), `/calendar`, `/history`, `/districts`, `/outages` (current BGE outage counts by county, any time — the server's own county pinned first), `/stats`, `/notify` (DM subscription toggle), `/help`, `/terms`, `/privacy`.
- Admin `/mydata view` shows everything the bot stores for the server; `/mydata delete` erases it after a confirmation, fulfilling the Privacy Policy's data-rights promises in-app.
- End-of-year recap: a June 15 summary post comparing the school year's closures/delays/early closings to the previous year (toggleable, on by default).
- "My notification roles" option on status posts opens a private panel with a multi-select pre-checked to the roles you actually have — review and sync all ping roles in one submit.
- Serves the Terms and Privacy Policy as web pages at `GET /terms` and `GET /privacy` (public URLs for bot directory listings), from the same text as the `/terms` and `/privacy` commands.
- Caches status scrapes for 60 seconds, so member-triggered `/status` checks can't hammer the HCPSS site.
- Warns the log channel and DMs the server owner after 3 consecutive failed posts to the alert channel (deleted channel, missing permissions), and resets the streak on the next successful post.
- Discord API calls retry once on rate limits (honoring `retry_after`) and transient 5xx errors, and embeds are clamped to Discord's field/total size limits so a burst-heavy storm morning can't drop a guild's post.
- Exposes `GET /health` for a lightweight health check, including the served-guild count, current scraper failure streak, and the last status-change timestamp.
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

The health check returns JSON with the Worker name, timestamp, whether the manual trigger token is configured, the number of served guilds, the current scraper failure streak, and the last status-change timestamp.

## Worker Source Layout

- `src/index.js` — entry point: HTTP routing, manual trigger, and the cron handler.
- `src/interactions.js` — Discord interaction routing (slash commands, panel components, modals, setup).
- `src/commands.js` — slash command runners and panel quick-action handlers.
- `src/panel.js` — control panel pages, the persistent log-channel panel message, and panel-driven config updates.
- `src/check.js` — the check-and-post loop and scraper health tracking (failure alerts + recovery notice).
- `src/embeds.js` — status/override/error embed building.
- `src/config.js` — per-guild config and status overrides in KV.
- `src/discord.js` — Discord API helpers and request signature verification.
- `src/constants.js` — status labels, colors, defaults, and the school calendar.
- `src/scraper.js` — status page fetching/parsing, retry, and last-good-scrape fallback cache.
- `src/weather.js` — NWS active alerts (Howard County zone MDC027 by default, per-district zones supported) with a 10-minute KV cache.
- `src/snowfall.js` — NWS gridpoint forecast accumulation lines with a 30-minute KV cache.
- `src/headsup.js` — the 7:00 PM ET night-before heads-up post.
- `src/busalerts.js` — HCPSS News watcher (transportation alerts + school-specific notices).
- `src/outages.js` — BGE county power outage feed with a 10-minute KV cache.
- `src/roads.js` — MD CHART road incident feed with a 10-minute KV cache.
- `src/districts.js` — neighboring districts' operating status (per-platform fetchers, keyword classifier, 10-minute KV cache).
- `src/outlook.js` — Closure Outlook scoring from weather alerts + district statuses.
- `src/outlookaccuracy.js` — nightly outlook predictions and next-day grading for the /stats track record.
- `src/crosscheck.js` — HCPSS News RSS second-source signal and mismatch detection.
- `src/history.js` — status change history (200 entries), school-year incident stats, and the per-year archive.
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
