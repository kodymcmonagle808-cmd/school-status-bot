# Deploys and rollback

## How a deploy happens

Every push to `main` runs `Deploy HCPSS Worker`
(`.github/workflows/deploy_worker.yml`): lint → tests → deploy script
(uploads secrets, registers slash commands, `wrangler deploy`). Deploys are
**serialized** — if several land at once they queue instead of racing.

Every run (success or failure) is recorded and shown on the control panel's
🚀 **Worker Updates** page (owner-only), including the currently running
version. A ⚠️ drift warning there means the last deploy failed and the old
version is still live.

If a deploy fails, the bot posts ❌ **Worker deploy failed** in the log
channel; the previous version keeps running — a failed deploy never takes
the bot down.

## Roll back a bad deploy

Use this when a deploy succeeded but the new code is misbehaving:

1. Open the panel's **Worker Updates** page and copy the SHA of the last
   known-good deploy (or find it in the repo's commit list).
2. GitHub → **Actions** → **Rollback Worker** → **Run workflow**.
3. Paste the SHA (short like `75b85fc` or full — both work) and run it.
4. Watch for the ↩️ **Worker rolled back** line in the log channel
   (~2 minutes). The rollback also appears on Worker Updates tagged ↩️.

Rollback skips lint/tests for speed — the target commit already passed them
when it first deployed. It uses the same queue as normal deploys, so it can
never race one.

After rolling back, **fix or revert the bad commit on `main` promptly**: the
next push to `main` deploys `main`'s code again, rolling forward over your
rollback.

## Failed deploy (nothing new is live)

If the deploy itself failed (❌ in the log channel), there's nothing to roll
back — the old version is still running. Check the Actions run log, fix the
cause, push again. If the failure is transient (rate limit, Cloudflare
hiccup), re-run it: open the failed run → **Re-run failed jobs**.

## Bumping wrangler

The wrangler CLI is pinned (currently `4.112.0`) in `deploy_worker.yml` and
`rollback.yml` so a bad release can't break deploys at random. To bump:
change the version in both files, push, and confirm the deploy goes green.
