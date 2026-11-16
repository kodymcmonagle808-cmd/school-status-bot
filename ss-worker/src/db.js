// Cloudflare D1 database adapter for school-status-bot.
//
// Provides transparent SQLite-backed storage for all bot operations, upgrading
// daily write quotas from KV's 1,000 writes/day to D1's 100,000 writes/day,
// daily read quotas to 5,000,000 reads/day, and storage to 5 GB for free.
//
// Automatically falls back to STATUS_KV for legacy keys not yet migrated,
// ensuring zero-downtime backward compatibility.

/**
 * Creates a KV-compatible adapter backed by Cloudflare D1 (SQLite).
 *
 * @param {object} db - Cloudflare D1 database binding (env.DB)
 * @param {object} [fallbackKv] - Legacy Cloudflare KV namespace (env.STATUS_KV)
 * @returns {object} An object implementing get, put, delete, and list
 */
export function createD1KvAdapter(db, fallbackKv = null) {
  return {
    async get(key, options = {}) {
      if (!key) return null;
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const row = await db.prepare(
          'SELECT value, expires_at FROM kv_store WHERE key = ?'
        ).bind(String(key)).first();

        if (row) {
          if (row.expires_at != null && Number(row.expires_at) <= nowSec) {
            return null;
          }
          const val = row.value;
          if (options === 'json' || options?.type === 'json') {
            try { return JSON.parse(val); } catch { return null; }
          }
          return val;
        }
      } catch (err) {
        console.error('D1 get error:', err);
      }

      if (fallbackKv && typeof fallbackKv.get === 'function') {
        const fallbackVal = await fallbackKv.get(key, options);
        if (fallbackVal !== null && fallbackVal !== undefined) {
          try {
            const strVal = typeof fallbackVal === 'object' ? JSON.stringify(fallbackVal) : String(fallbackVal);
            await db.prepare(
              'INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
            ).bind(String(key), strVal).run();
          } catch {}
          return fallbackVal;
        }
      }

      return null;
    },

    async put(key, value, options = {}) {
      if (!key) return;
      let expiresAt = null;
      const nowSec = Math.floor(Date.now() / 1000);
      if (options?.expirationTtl) {
        expiresAt = nowSec + Number(options.expirationTtl);
      } else if (options?.expiration) {
        expiresAt = Number(options.expiration);
      }

      const valStr = typeof value === 'string' ? value : JSON.stringify(value);

      try {
        await db.prepare(
          `INSERT INTO kv_store (key, value, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             expires_at = excluded.expires_at`
        ).bind(String(key), valStr, expiresAt).run();
      } catch (err) {
        console.error('D1 put error:', err);
        if (fallbackKv && typeof fallbackKv.put === 'function') {
          await fallbackKv.put(key, value, options);
        }
      }
    },

    async delete(key) {
      if (!key) return;
      try {
        await db.prepare('DELETE FROM kv_store WHERE key = ?').bind(String(key)).run();
      } catch (err) {
        console.error('D1 delete error:', err);
      }
      if (fallbackKv && typeof fallbackKv.delete === 'function') {
        try { await fallbackKv.delete(key); } catch {}
      }
    },

    async list(options = {}) {
      const prefix = options.prefix || '';
      const limit = Math.min(Number(options.limit) || 1000, 1000);
      const nowSec = Math.floor(Date.now() / 1000);

      const d1Keys = [];
      try {
        let stmt;
        if (prefix) {
          stmt = db.prepare(
            `SELECT key FROM kv_store
             WHERE substr(key, 1, ?) = ?
               AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY key
             LIMIT ?`
          ).bind(prefix.length, prefix, nowSec, limit);
        } else {
          stmt = db.prepare(
            `SELECT key FROM kv_store
             WHERE (expires_at IS NULL OR expires_at > ?)
             ORDER BY key
             LIMIT ?`
          ).bind(nowSec, limit);
        }
        const res = await stmt.all();
        if (res && Array.isArray(res.results)) {
          for (const r of res.results) {
            d1Keys.push({ name: r.key });
          }
        }
      } catch (err) {
        console.error('D1 list error:', err);
      }

      if (fallbackKv && typeof fallbackKv.list === 'function') {
        try {
          const fbRes = await fallbackKv.list(options);
          if (fbRes && Array.isArray(fbRes.keys)) {
            const seen = new Set(d1Keys.map(k => k.name));
            for (const k of fbRes.keys) {
              if (!seen.has(k.name)) {
                d1Keys.push(k);
                seen.add(k.name);
              }
            }
          }
        } catch {}
      }

      return {
        keys: d1Keys.slice(0, limit),
        list_complete: true
      };
    }
  };
}

/**
 * Initializes the environment storage. When env.DB is present, replaces
 * env.STATUS_KV with the D1 adapter.
 *
 * @param {object} env - Cloudflare Worker environment object
 * @returns {object} The environment object
 */
export function initEnv(env) {
  if (env && env.DB && !env._d1_wrapped) {
    env.STATUS_KV = createD1KvAdapter(env.DB, env.STATUS_KV);
    env._d1_wrapped = true;
  }
  return env;
}

/**
 * Formats byte counts into human-readable strings.
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Queries D1 for database stats (total keys and approximate storage used).
 *
 * @param {object} db - Cloudflare D1 database binding
 * @returns {Promise<object|null>} Stats object or null if unavailable
 */
export async function getD1Stats(db) {
  if (!db) return null;
  try {
    const row = await db.prepare(
      'SELECT count(*) AS total_keys, coalesce(sum(length(value)), 0) AS total_bytes FROM kv_store'
    ).first();
    return {
      configured: true,
      ok: true,
      totalKeys: Number(row?.total_keys || 0),
      totalBytes: Number(row?.total_bytes || 0)
    };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      error: err && err.message ? err.message : String(err)
    };
  }
}

/**
 * Formats D1 database stats for the Owner's Control Panel embed.
 *
 * @param {object} stats - Stats returned by getD1Stats
 * @returns {string} Formatted markdown text
 */
export function buildD1Section(stats) {
  if (!stats) return 'D1 database not bound.';
  if (!stats.ok) return `⚠️ D1 error: ${stats.error}`;
  const storagePct = ((stats.totalBytes / (5 * 1024 * 1024 * 1024)) * 100).toFixed(2);
  return `🟢 **Active Storage Engine** — \`school-status-db\`\n` +
    `• **Daily Writes:** 100,000 / day (upgraded from 1,000)\n` +
    `• **Daily Reads:** 5,000,000 / day (upgraded from 100,000)\n` +
    `• **Active Records:** ${stats.totalKeys.toLocaleString()} keys\n` +
    `• **Storage Used:** ${formatBytes(stats.totalBytes)} / 5 GB (${storagePct}%)\n` +
    `> All bot operations automatically read and write via Cloudflare D1.`;
}

/**
 * Ensures the emails archive table exists in D1 SQLite.
 */
export async function ensureEmailsTable(db) {
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS emails (
        id TEXT,
        guild_id TEXT,
        subject TEXT,
        body TEXT,
        channel_id TEXT,
        message_id TEXT,
        ts INTEGER,
        url TEXT,
        image_url TEXT,
        ai_summary TEXT,
        PRIMARY KEY (id, guild_id)
      )
    `).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_emails_guild_ts ON emails(guild_id, ts DESC)').run();
  } catch (err) {
    console.error('ensureEmailsTable error:', err);
  }
}

/**
 * Records an incoming school announcement email into the D1 archive.
 */
export async function recordEmailToD1(db, { id, guildId, subject, body, channelId, messageId, ts, url, imageUrl, aiSummary }) {
  if (!db || !id || !guildId) return;
  try {
    await ensureEmailsTable(db);
    await db.prepare(`
      INSERT INTO emails (id, guild_id, subject, body, channel_id, message_id, ts, url, image_url, ai_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, guild_id) DO UPDATE SET
        subject = excluded.subject,
        body = excluded.body,
        channel_id = excluded.channel_id,
        message_id = excluded.message_id,
        ts = excluded.ts,
        url = excluded.url,
        image_url = excluded.image_url,
        ai_summary = excluded.ai_summary
    `).bind(
      String(id),
      String(guildId),
      String(subject || ''),
      String(body || ''),
      channelId ? String(channelId) : null,
      messageId ? String(messageId) : null,
      Number(ts) || Date.now(),
      url ? String(url) : null,
      imageUrl ? String(imageUrl) : null,
      aiSummary ? String(aiSummary) : null
    ).run();
  } catch (err) {
    console.error('recordEmailToD1 error:', err);
  }
}

/**
 * Searches the D1 email archive for matching subjects or content.
 */
export async function searchEmailsInD1(db, guildId, query, limit = 5) {
  if (!db || !guildId || !query) return [];
  try {
    await ensureEmailsTable(db);
    const searchPattern = `%${String(query).trim()}%`;
    const res = await db.prepare(`
      SELECT id, subject, body, channel_id, message_id, ts, url, image_url, ai_summary
      FROM emails
      WHERE guild_id = ? AND (subject LIKE ? OR body LIKE ?)
      ORDER BY ts DESC
      LIMIT ?
    `).bind(String(guildId), searchPattern, searchPattern, Math.min(Number(limit) || 5, 20)).all();
    return (res && Array.isArray(res.results)) ? res.results : [];
  } catch (err) {
    console.error('searchEmailsInD1 error:', err);
    return [];
  }
}

/**
 * Fetches announcement email statistics for the Analytics tab.
 */
export async function getEmailStats(db, guildId) {
  if (!db || !guildId) return { total: 0, past7Days: 0, past30Days: 0 };
  try {
    await ensureEmailsTable(db);
    const now = Date.now();
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
    const res = await db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS past_7_days,
        SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS past_30_days
      FROM emails
      WHERE guild_id = ?
    `).bind(sevenDaysAgo, thirtyDaysAgo, String(guildId)).first();
    return {
      total: Number(res?.total || 0),
      past7Days: Number(res?.past_7_days || 0),
      past30Days: Number(res?.past_30_days || 0)
    };
  } catch (err) {
    console.error('getEmailStats error:', err);
    return { total: 0, past7Days: 0, past30Days: 0 };
  }
}
