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
  `/terms`, `/privacy`, manual trigger) and the cron `scheduled()` handler.
  The cron fires **every minute**; each watcher decides for itself whether
  this minute matters, and every watcher is wrapped in its own try/catch.
- `src/check.js` — core check-and-post loop (`doCheckAndPost`): schedule
  matching, storm mode (15-min ticks, 4:30–7:30 AM + 10 AM–2 PM ET),
  conversion watch (7:45–9:30 when a delay is announced), posting, history.
- `src/embeds.js` — builds status embeds (HCPSS scraper or district source),
  layering optional context fields (weather, snowfall, outages, roads,
  districts, outlook, cross-check, snow-day budget).
- `src/interactions.js` — routes slash commands/components/modals to
  `commands.js`, `panel.js`, `panelcomponents.js`, `setupflow.js`, `modals.js`.
- Watchers (all cron-driven, all per-guild-toggleable): `digest.js`,
  `headsup.js` (7 PM + evening escalation), `busalerts.js` (news feed),
  `decisionwatch.js` (live morning board), `stormrefresh.js`, `aqi.js`,
  `outlookaccuracy.js`, `recap.js`, `cleanup.js`, `greeter.js`.
- Data sources: `scraper.js` (status page), `districts.js` (6 neighboring
  districts, one fetcher per platform), `weather.js`/`snowfall.js` (NWS),
  `outages.js` (BGE + Pepco/Potomac Edison via Kubra), `roads.js` (MD CHART),
  `aqi.js` (AirNow), `crosscheck.js` (HCPSS News RSS).

## Iron rules

- **Context never breaks a status post.** Every external data source degrades
  to `null`/`[]`/`''` on failure — never throw out of a fetcher. The status
  post must go out even when every side feed is down. Because failures are
  silent at runtime, `scripts/canary.mjs` (daily CI) is what detects breakage.
- **Multi-server everything.** Per-guild config via
  `getConfig`/`getEffectiveConfig` (`config.js`); new features get a
  `toggle_*` default in `getEffectiveConfig`, a control-panel entry in
  `panel.js` (`config_toggles` page **and** `applyConfigUpdate`), and honor
  `cfg.alert_channel_id`. Guilds can follow a neighboring district
  (`primary_district`) — district-aware features must use that district's
  county/NWS zone/history, not Howard's.
- **KV discipline.** Per-guild keys end in `:${guildId}` and MUST be added to
  `guildKeys()` in `cleanup.js` (purge on bot removal is a Privacy Policy
  promise). Cron dedupe uses slot-value keys (`last_*_slot`, `last_*_day`) —
  always **mark before posting** so a delayed tick can't double-post. Read the
  `guild_index` cached list, never `KV.list()`, in per-minute paths (free-plan
  list quota). Per-minute watchers do a "cheap pass" (time gate / cooldown key)
  before reading guild configs.
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
