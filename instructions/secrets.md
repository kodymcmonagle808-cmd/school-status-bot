# Repository secrets

Repo Settings → Secrets and variables → Actions. What each one is, what
breaks without it, and how to rotate it.

| Secret | What it is | If missing/wrong |
| --- | --- | --- |
| `CF_API_TOKEN` | Cloudflare API token (Workers + KV edit rights) | Deploys, backups, audits all fail |
| `CF_ACCOUNT_ID` | Cloudflare account id (dashboard → Workers overview, right sidebar) | Same as above |
| `DISCORD_BOT_TOKEN` | Bot token (Discord Developer Portal → Bot) | Bot can't post; deploys fail registering commands |
| `DISCORD_PUBLIC_KEY` | App public key (Developer Portal → General Information) | Interactions fail signature check — every command/button breaks |
| `DISCORD_CHANNEL_ID` | Default status-alert channel | Fallback only; per-guild config normally wins |
| `DISCORD_GUILD_ID` | Home guild id | Guild-command cleanup and audit allow-listing skip the home guild |
| `DISCORD_LOG_CHANNEL_ID` | *(optional)* overrides the log channel CI alerts post to | Falls back to the default log channel in `src/constants.js` |
| `MANUAL_TRIGGER_TOKEN` | Bearer token for the manual POST trigger | Manual trigger endpoint disabled (fine) |
| `OWNER_ID` | Your Discord user id | Worker Updates panel page locked for everyone |
| `KV_BACKUP_PASSPHRASE` | Encrypts weekly KV backups | Backup workflow refuses to run; **losing it makes old backups unreadable** |

## Rotating a secret

1. Generate the new value at the source (Cloudflare dashboard / Discord
   Developer Portal).
2. Update the repo secret (Settings → Secrets → Actions → pencil icon).
3. Run a deploy (push to `main`, or Actions → Deploy HCPSS Worker → Run
   workflow) — the deploy uploads Discord/owner secrets to the Worker, so
   the Worker only picks up new values on deploy.

Rotate immediately if a value may have leaked. `DISCORD_BOT_TOKEN` resets
from the Developer Portal ("Reset Token") — the old token dies the moment
you reset, so update the secret and deploy right after.

## Where secrets flow

- CI-only: `CF_*`, `KV_BACKUP_PASSPHRASE`, `DISCORD_LOG_CHANNEL_ID`.
- Uploaded to the Worker at deploy time (wrangler secrets):
  `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `MANUAL_TRIGGER_TOKEN`,
  `OWNER_ID`.
- Baked into `wrangler.toml` at deploy time (not secret):
  `DISCORD_PUBLIC_KEY`, `DISCORD_GUILD_ID`, `GIT_SHA`.
