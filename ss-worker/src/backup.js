// Exports the entire KV namespace to Cloudflare R2 on a weekly schedule
// (and on manual trigger), completely free with zero GitHub Actions required.
//
// Stored as:
//   kv_backup_<YYYY-MM-DD>.json
//   kv_backup_latest.json
//
// Automatically prunes historical backups older than 90 days.

import { logAction } from './actionlog.js';

export const BACKUP_DATE_KEY = 'last_kv_backup_date';

/**
 * Runs a full KV export and writes the snapshot to the Cloudflare R2 bucket.
 */
export async function runKvBackup(env) {
  if (!env || !env.STATUS_KV || !env.BACKUPS_BUCKET) {
    throw new Error('STATUS_KV and BACKUPS_BUCKET must be bound to run KV backup');
  }

  const entries = {};
  let cursor = undefined;

  do {
    const res = await env.STATUS_KV.list({ limit: 1000, cursor });
    if (!res || !res.keys) break;

    for (const item of res.keys) {
      const val = await env.STATUS_KV.get(item.name);
      if (val !== null) {
        entries[item.name] = val;
      }
    }

    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const keyCount = Object.keys(entries).length;

  const backupData = {
    exportedAt: now.toISOString(),
    keyCount,
    entries
  };

  const payload = JSON.stringify(backupData, null, 2);
  const datedFilename = `kv_backup_${todayStr}.json`;

  // Write dated snapshot
  await env.BACKUPS_BUCKET.put(datedFilename, payload, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      exportedAt: backupData.exportedAt,
      keyCount: String(keyCount)
    }
  });

  // Write pointer to latest snapshot
  await env.BACKUPS_BUCKET.put('kv_backup_latest.json', payload, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      exportedAt: backupData.exportedAt,
      keyCount: String(keyCount)
    }
  });

  // Record last run date
  await env.STATUS_KV.put(BACKUP_DATE_KEY, todayStr);

  logAction(`Backed up ${keyCount} KV keys to Cloudflare R2 (${datedFilename})`);

  // Prune backups older than 90 days
  try {
    const listed = await env.BACKUPS_BUCKET.list({ prefix: 'kv_backup_' });
    if (listed && listed.objects) {
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      const cutoff = now.getTime() - ninetyDaysMs;

      for (const obj of listed.objects) {
        if (obj.key === 'kv_backup_latest.json') continue;
        if (obj.uploaded && new Date(obj.uploaded).getTime() < cutoff) {
          await env.BACKUPS_BUCKET.delete(obj.key);
          console.log(`Pruned old R2 backup: ${obj.key}`);
        }
      }
    }
  } catch (err) {
    console.error('Failed to prune old R2 backups:', err);
  }

  return {
    ok: true,
    filename: datedFilename,
    keyCount,
    exportedAt: backupData.exportedAt
  };
}

/**
 * Scheduled check: runs on Mondays (UTC) if not already run today.
 */
export async function maybeRunKvBackup(env) {
  if (!env || !env.STATUS_KV || !env.BACKUPS_BUCKET) return null;

  const now = new Date();
  // Monday is UTC day 1
  if (now.getUTCDay() !== 1) return null;

  const todayStr = now.toISOString().split('T')[0];
  const lastRun = await env.STATUS_KV.get(BACKUP_DATE_KEY);
  if (lastRun === todayStr) return null;

  try {
    return await runKvBackup(env);
  } catch (err) {
    console.error('Scheduled KV backup to R2 failed:', err);
    logAction(`Scheduled KV backup to R2 failed: ${err && err.message ? err.message : err}`, { level: 'error' });
    return null;
  }
}
