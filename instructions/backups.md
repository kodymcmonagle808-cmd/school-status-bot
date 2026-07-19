# Backups

The Worker's KV namespace is the only copy of irreplaceable data: multi-year
closure history, yearly stats, the outlook track record, and every server's
config. Backups export all of it.

## How it works (automatic)

Every **Monday ~3–4 AM ET**, the `KV backup` workflow
(`.github/workflows/kv_backup.yml`):

1. Exports every key/value to `kv_backup.json`.
2. Encrypts it with AES-256 using the `KV_BACKUP_PASSPHRASE` secret.
3. **Verifies the encrypted copy actually decrypts and parses** (key count
   must match the manifest) — a backup that can't restore fails the run.
4. Uploads `kv_backup.json.enc` as a workflow artifact, kept **90 days**.

If it fails, the bot posts ❌ **KV backup failed** in the log channel.

## Run a backup manually

1. Go to the repo on GitHub → **Actions** tab.
2. Pick **KV backup** in the left sidebar.
3. Click **Run workflow** → **Run workflow** (green button, defaults are fine).
4. Wait for the green check (~1 minute), then open the run — the artifact
   `kv-backup-<run id>` is at the bottom of the run page.

Or from a terminal: `gh workflow run "KV backup"`.

## Download and decrypt a backup

1. Open the run in the Actions tab and download the `kv-backup-...` artifact
   (a zip containing `kv_backup.json.enc`).
2. Unzip it, then decrypt (you'll be prompted for the passphrase — the value
   of the `KV_BACKUP_PASSPHRASE` secret):

   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -in kv_backup.json.enc -out kv_backup.json
   ```

3. `kv_backup.json` is plain JSON: `{ exportedAt, namespaceId, keyCount,
   entries: { "key": "value", ... } }`.

⚠️ The decrypted file contains server configs and opt-in user IDs. Don't
commit it, share it, or leave it lying around — delete it when done.

## Restore

Restore defaults to a **dry run** — it prints what it would write without
touching anything. Only `--write` modifies the namespace.

```bash
cd hcpss-worker
# dry run first, always:
CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/kv_restore.mjs kv_backup.json
# then, if the plan looks right:
CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/kv_restore.mjs kv_backup.json --write
```

`CF_API_TOKEN` / `CF_ACCOUNT_ID` are the same values as the repo secrets
(Cloudflare dashboard → My Profile → API Tokens if you need a fresh token).

Restoring overwrites current values for every key in the backup but does not
delete keys created after the backup was taken.

## If the passphrase is lost

Old artifacts become permanently unreadable. Set a new `KV_BACKUP_PASSPHRASE`
secret and run a manual backup immediately so at least one restorable backup
exists again.
