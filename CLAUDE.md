# school-status-bot

Discord bot that monitors the HCPSS (Howard County, MD) status page and related
feeds, posting operating-status updates to Discord. Everything runs in one
Cloudflare Worker in `hcpss-worker/` (no framework, plain ESM JS, KV storage).
`hcpss-greeter/` is a separate legacy Node bot — rarely touched.

## Commands

```bash
cd hcpss-worker
node --test          # full test suite
npm run lint         # ESLint (correctness rules only, no style rules)
node scripts/canary.mjs   # live-fetch every external source through the real parsers
```

Deploys happen on push to `main` via `.github/workflows/deploy_worker.yml` →
`hcpss-worker/scripts/deploy_worker.sh` (tests, secrets, **slash-command
registration**, `wrangler deploy`).

## Architecture

- `src/index.js` — HTTP entry (signed Discord interactions, `/health`,
  `/terms`, `/privacy`, push hooks, manual trigger) and the cron `scheduled()`
  handler. The cron fires **every minute**; each watcher decides for itself
  whether this minute matters, and the watcher table is driven by one loop so
  every watcher is isolated and logged the same way.
- `src/pushdata.js` — `/push-data`, the write-through path from the Apps
  Script collector (`gas/nws-alert-watcher.js`). The script owns all
  steady-state polling: it fetches each feed, fingerprints it, and POSTs the
  raw bodies that changed. The Worker parses them **with its own parsers** and
  writes straight into the cache key the reader already uses — one KV write
  per change, no delete, no outbound fetch, and no second copy of any parser.
  Adding a source here means adding a `parse*FromBody` and a `store()` call;
  the live fetcher stays untouched as the dead-collector fallback.
  **A pushed source that drives an alert must also trigger that alert here.**
  Writing the cache is only half the job: `weatheralerts.js` drops its cron
  scan to once an hour (`shouldScanThisMinute`) whenever `NWS_HOOK_SECRET` is
  set, on the assumption that the push path announces new alerts the moment
  they land — so `/push-data` forces `maybeSendWeatherAlertNotices` when it
  writes a `weather:*` zone. When the collector moved off `/nws-hook` that
  forced scan was left behind, and pushed warnings sat unannounced for up to
  59 minutes while appearing instantly on any manual check.
- `src/actionlog.js` — the "everything the Worker did" log, at **zero KV cost
  and zero Discord noise**. Every line is a prefixed `console.log`
  (`ACT|<iso>|<level>|<guild>|<text>`, persisted by `observability.logs`) and
  goes nowhere else; `logAction`/`logActionError`/`logDetail` differ only in
  the level tag the readers filter on. **This module must never send a Discord
  message.** It used to batch its lines into the log channel, which buried the
  control panel under a running restatement of it. **This is where a new log
  line goes by default.** `postLog()` in `panel.js` is the *control panel*
  logger, not a general one: it costs a KV write plus a Discord edit per call
  against a 1,000-write day, so it is reserved for status posts and failures
  that stop updates reaching members (broken alert channel, source gone
  quiet). Everything else — watcher posts, config edits, calendar edits,
  announcements, plumbing — is `logAction`/`logDetail`. When the panel needs
  re-rendering but the event doesn't belong in that list, use
  `refreshPanelMessage()` (a render with no log line, so no write).
  Always pass `guildId` for anything server-specific: the System Logs page
  shows a guild its own lines plus the *unscoped* ones, so an unscoped line
  about server A is visible to server B.
- `src/workerlogs.js` — the System Logs web page (`GET /logs`), which reads
  those ACT lines back out of Cloudflare's log store through the Workers
  Observability API (the same query `gas/showLogs()` runs) and renders them,
  filterable by level and window. It exists because the panel used to paste
  its stored 25-line KV history into an embed description with no clamp: at
  ~200 characters per status-check line that measured **4,949 against
  Discord's 4,096 limit**, so Discord rejected the interaction response with a
  400 and the click read as *"the application did not respond"* — an overflow
  that looks exactly like a dead Worker. **Anything built from a stored list
  must be clamped** (`renderPanelLogLines` in `panel.js` caps both lines and
  characters). Access is a signed 30-minute link the panel mints
  (`buildLogsUrl`), because the link *is* the credential — there's no login,
  so it must stay short-lived, ephemeral in Discord, and `no-store`/noindex on
  the way out. Needs `PUBLIC_BASE_URL` (a `wrangler.toml` var — interactions
  arrive over Discord's webhook, so the origin can't be inferred at click
  time) and a `CF_API_TOKEN` with **Workers Observability → Read**, which is a
  *different* permission from the Account Analytics one `kvanalytics.js` uses;
  the page names the missing one rather than reading as "logs are broken".
- `src/check.js` — core check-and-post loop (`doCheckAndPost`): schedule
  matching, storm mode (15-min ticks, 4:30–7:30 AM + 10 AM–2 PM ET),
  conversion watch (7:45–9:30 when a delay is announced), posting, history.
- `src/embeds.js` — builds status embeds (HCPSS scraper or district source),
  layering optional context fields (weather, snowfall, outages, roads,
  districts, outlook, cross-check, snow-day budget). The live storm sections
  (outages, roads, districts) render under `hasStormAlert` — advisories and
  watches included. **`stormrefresh.js`'s gate must stay aligned with that**,
  or the embed shows a field nothing ever refreshes: it gated on
  `hasPowerThreatAlert` (warning-level only), so under a Winter Weather
  Advisory the outage line stayed frozen at the number from when the post went
  out while a manual check showed the real one. The gate now also opens for
  any storm alert once `MIN_OUTAGE_CUSTOMERS_FOR_REFRESH` customers are out —
  the outage floor is what keeps a July heat advisory (a storm alert by event
  name) from running the refresh cascade all day for nothing. **The floor is
  set well below the measured quiet-day baseline** (BGE alone ran ~2,900
  customers out across served counties on a clear day with no alert anywhere,
  against a floor of 500), so today it stops nothing — only `hasStormAlert`
  being false does. Re-measure before trusting it.
  The forced path also keeps refreshing for `TRAILING_REFRESH_MS` after the
  last **warranted** refresh, so the ping following an alert's expiry still
  clears the embed's storm sections. That window must be anchored to the last
  refresh that weather actually justified — never to the last refresh that
  *ran*. It was anchored to the stored slot, which every trailing refresh
  rewrites, so each one re-armed the window it was meant to be running out:
  one Severe alert on 2026-07-28 left the cascade firing on every push for
  days with no alert active, taking KV writes from ~300/day to ~900/day
  against a 1,000/day cap. The armed-at timestamp now rides in the slot value
  (`<bucket>@<ms>`) so it costs no extra key — compare the **bucket only**
  when deduping, or the dedupe silently never matches.
- `src/interactions.js` — routes slash commands/components/modals to
  `commands.js`, `panel.js`, `panelcomponents.js`, `setupflow.js`, `modals.js`.
- Watchers (all cron-driven, all per-guild-toggleable): `digest.js`,
  `headsup.js` (7 PM + evening escalation), `busalerts.js` (classifies the
  pushed news items from `news_signal_cache` — it must never fetch the feed
  itself; that is the collector's job),
  `decisionwatch.js` (live morning board), `stormrefresh.js`, `aqi.js`,
  `outlookaccuracy.js`, `recap.js`, `cleanup.js`, `greeter.js`,
  `sourcehealth.js` (hourly silent-zero sweep), `weatheralerts.js` (NWS
  issuance notices, plus a second cron pass that deletes each notice once its
  alert ends). That cleanup pass is deliberately separate from the scan: the
  scan returns early during quiet hours and skips any guild with no active
  alert, which is exactly the state a just-expired alert leaves behind. The
  posted message id lives in the `nws_alerts_seen:<guild>` entry it already
  writes, so tracking it costs one extra write per notice actually posted and
  nothing per scan.
- `src/session.js` — "is school actually in session?", the gate storm mode,
  `decisionwatch.js`, and `headsup.js` consult before alerting. Pure and
  one-sided: `noSchoolReason()` returns a reason only when the bot is
  *confident* there's no school, and null (don't suppress) for anything
  unknown. HCPSS gets the built-in calendar; other districts get only the
  rules that hold everywhere (weekend, summer, federal holidays). Its
  `SCHOOL_YEAR_WINDOWS` must be updated whenever `SCHOOL_CALENDAR_EVENTS` in
  `constants.js` rolls to a new school year — `/health` warns 60 days out.
- Data sources: `scraper.js` (status page), `districts.js` (6 neighboring
  districts, one fetcher per platform), `weather.js`/`snowfall.js` (NWS),
  `outages.js` (BGE + Pepco/Potomac Edison via Kubra), `roads.js` (MD CHART),
  `aqi.js` (AirNow), `crosscheck.js` (HCPSS News RSS).

## Iron rules

- **Context never breaks a status post.** Every external data source degrades
  to `null`/`[]`/`''` on failure — never throw out of a fetcher. The status
  post must go out even when every side feed is down. Because failures are
  silent at runtime, `scripts/canary.mjs` (daily CI) is what detects breakage;
  `sourcehealth.js` is the in-production half, alerting when a source that
  should never be empty goes quiet. A new always-expect source belongs in
  both — but only add one to `SOURCE_EXPECTATIONS` if it has an unambiguous
  failure signal, or a quiet season will read as an outage.
- **Multi-server everything.** Per-guild config via
  `getConfig`/`getEffectiveConfig` (`config.js`); new features get a
  `toggle_*` default in `getEffectiveConfig`, a control-panel entry in
  `panel.js` (`config_toggles` page **and** `applyConfigUpdate`), and honor
  `cfg.alert_channel_id`. Guilds can follow a neighboring district
  (`primary_district`) — district-aware features must use that district's
  county/NWS zone/history, not Howard's.
- **KV discipline.** Writes and deletes are the binding quota — **1,000/day
  each** on the free plan, against 100,000 reads. Per-guild keys end in
  `:${guildId}` and MUST be added to `guildKeys()` in `cleanup.js` (purge on
  bot removal is a Privacy Policy promise). Cron dedupe uses slot-value keys
  (`last_*_slot`, `last_*_day`) — always **mark before posting** so a delayed
  tick can't double-post. Read the `guild_index` cached list, never
  `KV.list()`, in per-minute paths (free-plan list quota). Per-minute watchers
  do a "cheap pass" (time gate / cooldown key) before reading guild configs.
  Prefer a **clock gate over a cooldown key** — a gate costs nothing, a key
  costs a write. Never invalidate a cache you could overwrite: a delete makes
  the next reader refetch and re-put, so it spends a delete *and* a write to
  land the same bytes `/push-data` writes once.
- **Polling belongs in Apps Script, not the Worker.** `gas/nws-alert-watcher.js`
  runs on a free 5-minute Google trigger and only contacts the Worker when a
  fingerprint actually moves, so quiet days cost nothing. The Worker's own
  fetchers are the fallback for a dead collector, not the primary path — keep
  them working, but don't add new scheduled polling to the cron. Anything the
  Worker would discard must also be filtered out of the script's fingerprint,
  or it pushes data that gets thrown away. Two cross-runtime contracts are
  covered by `tests/gaspush.test.js`: the body keys the script sends, and the
  source names it waits for in `written` before advancing a fingerprint. A
  drift in the second is a silent write loop — the script re-pushes forever.
  **The GAS file is not deployed by CI**; it has to be pasted into
  script.google.com by hand, so a fix there is inert until that happens, and
  the Worker must keep accepting the older build's hooks until it does.
- **User data is a liability.** Anything new stored about users or servers
  must show up in `/mydata view`, be purged by `purgeGuildData`, and be
  reflected in `legal.js` + the root policy docs (all three stay in sync).
- **Discord embed limits** are enforced in `embeds.js` (`clampText`,
  `enforceEmbedBudget`) — add fields in priority order; the least critical are
  dropped first.

## Adding a slash command

1. Handler in `commands.js`, route in `interactions.js` (member commands go in
   the open block; staff commands after the `canUseCommands` gate).
2. Register it in the `payload` array in `scripts/deploy_worker.sh` (bulk
   overwrite — forgetting this means the command never appears).
3. Add it to `/help` in `commands.js` and the README feature list.

## Tests

`node --test` under `tests/`, `node:test` + `assert/strict`. Logic meant for
testing is exported as pure functions (parsers, classifiers, formatters,
window/slot math) and tested without network — mock `fetch` with
`t.mock.method(globalThis, 'fetch', ...)`; a KV stub is a small Map wrapper
(see `tests/subscriptions.test.js`). Tests must never hit live endpoints —
that's the canary's job.
