# school-status-bot

Monitors the [HCPSS status page](https://status.hcpss.org) and posts the current operating status to Discord.

Everything runs in the Cloudflare Worker in [`hcpss-worker/`](hcpss-worker/) — see its [README](hcpss-worker/README.md) for setup, features, and deployment. Operational runbooks (backups, rollback, monitoring, secrets) live in [`instructions/`](instructions/). The Worker:

- Checks the status page on each guild's configured schedule (Eastern time) and posts the status embed, replacing the previous message instead of stacking.
- Shows active NWS weather alerts for Howard County on status embeds, plus a Tomorrow Outlook on evening posts.
- Storm mode: checks every 15 minutes during the early-morning decision window (closings/delays) and the 10 AM–2 PM midday window (early dismissals) when a storm or heat alert is active, posting only on real status changes — and when a 2-hour delay is announced, the conversion watch keeps checking until 9:30 AM for the delay-to-closure upgrade.
- Decision Watch: on storm mornings, one live board per server showing every district's closing/delay announcements (with when each was first detected), edited in place every 15 minutes through the 4:30–7:30 AM window.
- Closure Outlook: during storm/heat alerts, estimates the chance of a closing/delay from NWS alerts and nearby districts' announcements — and grades its own evening predictions so `/stats` shows the outlook's track record.
- Snowfall Forecast: storm-time embeds include expected snow/ice accumulations from the NWS forecast — plus Observed Snowfall, the spotter-measured totals from NWS Local Storm Reports for the district's county, so the post shows what actually fell alongside what was predicted.
- Skip Non-School Days: the status page reads "Normal Operations" straight through winter break, so storm mode, Decision Watch, and the night-before heads-up all check whether school is actually in session first — weekends, breaks, holidays, and summer never produce a closure alert. The heads-up asks about *tomorrow*, so a Friday or Sunday evening storm stays quiet. Guilds following a neighboring district get only the rules that hold everywhere (weekends, summer, federal holidays), never Howard's own PD days; per-server `toggle_session_gate` turns it off.
- Night-Before Heads-Up: 7:00 PM ET alert when the Closure Outlook hits High/Very High before HCPSS has announced anything — and the watch keeps running until 11:45 PM, posting an update if the outlook climbs a tier later in the evening.
- Inclement Weather Day Budget: closure posts and `/stats` show how many of the built-in snow days the district has used and when makeup days start kicking in.
- Bus & Transportation Alerts: posts HCPSS News transportation service alerts (route suspensions, delays, restorations).
- Activities & Athletics Alerts: posts after-school activity, athletics, and field trip cancellations that never reach the status page.
- School-Specific Notices: surfaces single-building announcements (no pings) that district-wide filters skip — and members can register their building with `/myschool` to get a DM when a notice mentions it.
- Power Outages: county outage counts on storm embeds from every utility serving the district's county — BGE, Pepco (Montgomery/Prince George's), and Potomac Edison (Frederick/Carroll) — feeding the Closure Outlook when widespread; `/outages` shows all utilities' county-by-county counts to any member, any time.
- Air Quality Alerts: posts when AirNow reports Code Orange (AQI 101+) or worse for the district's area — the days outdoor athletics and recess get modified.
- NWS Issuance Notices: posts within ~15 minutes when the National Weather Service issues a school-impacting alert (winter/heat watch, warning, or advisory) for the district's county — the moment the closure question starts, hours before any district announcement.
- Road Conditions: active MD CHART road incidents for the county on storm embeds.
- Primary District: any server can follow a neighboring district instead of HCPSS (per-server setting) — status posts, storm mode, the night-before heads-up, and `/history`/`/stats` all follow that district's own weather zone and announcements.
- Cross-checks the HCPSS News feed and flags when it disagrees with the (sometimes lagging) status page.
- Falls back to the last known status (with a stale banner) if the status page is unreachable, and alerts staff on repeated scraper failures (with a recovery notice).
- Source Health: every data source degrades silently by design, so a feed that quietly starts returning nothing looks exactly like a calm day. An hourly sweep watches the sources that should never be empty (status page, neighboring districts, news feed) and warns the log channel when one goes quiet past its threshold; `/health` shows the full board.
- Tracks per-school-year closure stats so `/stats` can compare this year against previous years.
- Handles slash commands (`/post-status`, `/override`, `/calendar`, `/history`, `/events`, `/stats`, `/setup`, `/announce`, `/myschool`, `/health`) and the interactive control panel; `/districts` pins the server's own district to the top of the board with its live status.
- Fully multi-server: per-guild config, schedules, calendar events, and stats/history (each server's numbers start at its own `/setup`).
- Optional Morning Digest: a daily 6:00 AM ET summary post (status, calendar, weather) per opted-in server, built from the server's own primary district.
- Lets anyone opt into DMs on status changes via the `🔔 Notify Me` button, or self-assign a status ping role from the dropdown on status posts.
- Serves a public read-only status page at the Worker's root URL (current status, active alerts, recent history) — shareable with people who aren't in a Discord server.
- Worker Action Log: a running record of what the Worker does — posts, status changes, config edits, and any watcher failure. The log channel gets no chat messages for any of it. The complete stream goes to Cloudflare's log store, which costs nothing and survives the bot itself being broken; the control panel's **System Logs** action opens it as a web page (a private link, good for 30 minutes, filterable by level and window from 2h to 48h), and `showLogs()` in the Apps Script project reads the same store from outside Cloudflare. The panel's own Recent Logs list stays in Discord for status posts and failures that stop updates reaching members — the two things worth a KV write.

## Where the work happens

Polling lives in [`gas/nws-alert-watcher.js`](gas/nws-alert-watcher.js), an Apps Script project on a free 5-minute Google trigger. It fetches every external feed, works out whether anything actually changed, and only then hands the Worker the bodies it already downloaded (`/push-data`). The Worker parses them with its own parsers and stores the result — one KV write per real change.

That split exists because Cloudflare's free plan allows 1,000 KV writes and 1,000 deletes a day, and the Worker's job is the part that genuinely has to run there: signed Discord interactions, scheduled posts, and storm mode. Steady-state polling isn't, so it doesn't. The Worker keeps its own fetchers as the fallback for a dead collector, so nothing breaks if the Apps Script project stops running — it just gets slower to notice changes.

The Apps Script file is **not deployed by CI**; paste it into [script.google.com](https://script.google.com) by hand. Setup steps are in the comment at the top of the file.

## Repo layout

- `hcpss-worker/` — the Cloudflare Worker (source, tests, deploy script).
- `gas/` — the Apps Script collector (pasted in by hand, not deployed by CI).
- `.github/workflows/deploy_worker.yml` — runs the worker tests and deploys on push to `main`.

## Tests

```bash
cd hcpss-worker
node --test
```
