# Monitoring and alerts

Four automated monitors watch the bot. All alerts appear as bot messages in
the **log channel** (no webhooks, no repo links). This page lists every alert
that can fire and what to do.

## 🚨 Worker health check failed (every 20 min, `uptime.yml`)

The live `/health` endpoint is unreachable, unhealthy, or the cron heartbeat
is older than 40 minutes (the cron has stopped firing). **This is the
most urgent alert** — status posts are not going out.

- Open <https://hcpss-worker.kodymcmonagle808.workers.dev/health> yourself.
  - Unreachable → check the Cloudflare dashboard (Workers → hcpss-worker)
    for errors or a paused worker; a redeploy (push to `main` or re-run the
    last deploy) usually revives it.
  - Reachable but `lastCronTickAt` is stale → Cloudflare dashboard →
    hcpss-worker → Triggers: confirm the `* * * * *` cron exists. Redeploy
    if missing.
- The alert fires **once** and opens a GitHub issue; repeat failures stay
  quiet while the issue is open. When the check recovers it closes the issue
  and posts ✅ recovered. Manual run: Actions → **Worker uptime check**.

## ❌ Scraper canary failed (daily ~5 AM ET, `canary.yml`)

An external data source stopped parsing (the worker degrades silently, so
this is the only visibility). The alert lists which sources failed and a
GitHub issue gets the full output.

- Status page source failing = urgent (that's the core product).
- Side feeds (weather, outages, roads, AQI, districts) = the bot keeps
  running without that context; fix the parser when you can.
- Reproduce locally: `cd hcpss-worker && node scripts/canary.mjs`.

## ❌ Worker deploy failed (`deploy_worker.yml`)

See [deploys-and-rollback.md](deploys-and-rollback.md). Old version still
running; nothing is down.

## ❌ KV backup failed (Mondays, `kv_backup.yml`)

This week's backup didn't complete or didn't verify. See
[backups.md](backups.md) — check the run log, fix, then run a manual backup
so the week isn't skipped.

## KV orphan audit (monthly, `kv_audit.yml`, issue-only)

Report-only: opens an issue if per-guild KV keys exist for guilds no longer
in `guild_index` (a purge missed a key). Add the missing base key to
`guildKeys()` in `hcpss-worker/src/cleanup.js`, then purge the leftovers
manually. Nothing is deleted automatically.

## 🩺 Watcher errors (no alert — check the panel)

Every cron watcher (digest, heads-up, bus alerts, decision watch, …) is
try/caught so a broken side feature can't block status posts — meaning
breakage is silent by design. The owner-only **Worker Updates** panel page
shows per-watcher failure counters ("failure hours") with the last error
message. Glance at it occasionally, especially after deploys and during
storm season.
