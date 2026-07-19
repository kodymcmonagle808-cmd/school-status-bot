# school-status-bot

Monitors the [HCPSS status page](https://status.hcpss.org) and posts the current operating status to Discord.

Everything runs in the Cloudflare Worker in [`hcpss-worker/`](hcpss-worker/) — see its [README](hcpss-worker/README.md) for setup, features, and deployment. The Worker:

- Checks the status page on each guild's configured schedule (Eastern time) and posts the status embed, replacing the previous message instead of stacking.
- Shows active NWS weather alerts for Howard County on status embeds, plus a Tomorrow Outlook on evening posts.
- Storm mode: checks every 15 minutes during the early-morning decision window (closings/delays) and the 10 AM–2 PM midday window (early dismissals) when a storm or heat alert is active, posting only on real status changes.
- Closure Outlook: during storm/heat alerts, estimates the chance of a closing/delay from NWS alerts and nearby districts' announcements — and grades its own evening predictions so `/stats` shows the outlook's track record.
- Snowfall Forecast: storm-time embeds include expected snow/ice accumulations from the NWS forecast.
- Night-Before Heads-Up: 7:00 PM ET alert when the Closure Outlook hits High/Very High before HCPSS has announced anything.
- Bus & Transportation Alerts: posts HCPSS News transportation service alerts (route suspensions, delays, restorations).
- Activities & Athletics Alerts: posts after-school activity, athletics, and field trip cancellations that never reach the status page.
- School-Specific Notices: surfaces single-building announcements (no pings) that district-wide filters skip.
- Power Outages: BGE county outage counts on storm embeds, feeding the Closure Outlook when widespread; `/outages` shows the county-by-county counts to any member, any time.
- Road Conditions: active MD CHART road incidents for the county on storm embeds.
- Primary District: any server can follow a neighboring district instead of HCPSS (per-server setting) — status posts, storm mode, the night-before heads-up, and `/history`/`/stats` all follow that district's own weather zone and announcements.
- Cross-checks the HCPSS News feed and flags when it disagrees with the (sometimes lagging) status page.
- Falls back to the last known status (with a stale banner) if the status page is unreachable, and alerts staff on repeated scraper failures (with a recovery notice).
- Tracks per-school-year closure stats so `/stats` can compare this year against previous years.
- Handles slash commands (`/post-status`, `/override`, `/calendar`, `/history`, `/events`, `/stats`, `/setup`, `/announce`) and the interactive control panel.
- Fully multi-server: per-guild config, schedules, calendar events, and stats/history (each server's numbers start at its own `/setup`).
- Optional Morning Digest: a daily 6:00 AM ET summary post (status, calendar, weather) per opted-in server.
- Lets anyone opt into DMs on status changes via the `🔔 Notify Me` button, or self-assign a status ping role from the dropdown on status posts.

## Repo layout

- `hcpss-worker/` — the Cloudflare Worker (source, tests, deploy script).
- `.github/workflows/deploy_worker.yml` — runs the worker tests and deploys on push to `main`.
- `.github/workflows/current_status.yml` — manual workflow that triggers an on-demand status post via the Worker (requires the `MANUAL_TRIGGER_TOKEN` secret).

## Tests

```bash
cd hcpss-worker
node --test
```
