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

    let statusCount = 0;
    let weatherCount = 0;
    let emailCount = 0;
    try {
      const sRow = await db.prepare('SELECT count(*) AS cnt FROM status_history').first();
      statusCount = Number(sRow?.cnt || 0);
    } catch {}
    try {
      const wRow = await db.prepare('SELECT count(*) AS cnt FROM weather_events').first();
      weatherCount = Number(wRow?.cnt || 0);
    } catch {}
    try {
      const eRow = await db.prepare('SELECT count(*) AS cnt FROM emails').first();
      emailCount = Number(eRow?.cnt || 0);
    } catch {}

    return {
      configured: true,
      ok: true,
      totalKeys: Number(row?.total_keys || 0),
      totalBytes: Number(row?.total_bytes || 0),
      statusCount,
      weatherCount,
      emailCount
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
 * Formats a percentage with up to specified decimals (default 7).
 * Accurately represents fractions down to 0.0000001%.
 */
export function formatPrecisePercent(value, max, decimals = 7) {
  const val = Number(value) || 0;
  const total = Number(max) || 0;
  if (total <= 0 || val <= 0) return (0).toFixed(decimals) + '%';
  const pct = (val / total) * 100;
  return `${pct.toFixed(decimals)}%`;
}

function commas(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function filledCount(value, max, segments = 20) {
  return Math.min(segments, Math.max(0, Math.round(((Number(value) || 0) / (Number(max) || 1)) * segments)));
}

function barFromFilled(filled, segments = 20) {
  const f = Math.max(0, Math.min(segments, filled));
  return '`' + '■'.repeat(f) + ' '.repeat(segments - f) + '`';
}

function easternResetLabel(now) {
  const d = new Date(now);
  const nextUtcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(nextUtcMidnight);
}

/**
 * Formats D1 database stats with visual progress bars and precise percentage (up to 0.0000001%).
 *
 * @param {object} stats - Stats returned by getD1Stats
 * @param {object} [usage] - Cloudflare analytics usage (reads, writes, etc.)
 * @param {number} [now] - Current timestamp
 * @returns {string} Formatted markdown text
 */
export function buildD1Section(stats, usage = null, now = Date.now()) {
  if (!stats) return 'D1 database not bound.';
  if (!stats.ok) return `⚠️ D1 error: ${stats.error}`;

  const storageBytes = 5 * 1024 * 1024 * 1024; // 5 GB
  const storagePct = formatPrecisePercent(stats.totalBytes, storageBytes, 7);

  const items = [];
  if (stats.statusCount != null && stats.statusCount > 0) items.push(`${stats.statusCount} status changes`);
  if (stats.weatherCount != null && stats.weatherCount > 0) items.push(`${stats.weatherCount} weather alerts`);
  if (stats.emailCount != null && stats.emailCount > 0) items.push(`${stats.emailCount} emails`);
  const details = items.length ? ` (${items.join(' · ')})` : '';

  const writesUsed = Number(usage?.writes) || 0;
  const readsUsed = Number(usage?.reads) || 0;
  const writesLimit = 100000;
  const readsLimit = 5000000;

  const writesPct = formatPrecisePercent(writesUsed, writesLimit, 7);
  const readsPct = formatPrecisePercent(readsUsed, readsLimit, 7);

  const writeDot = (writesUsed / writesLimit) >= 0.9 ? '🔴' : (writesUsed / writesLimit) >= 0.7 ? '🟡' : '🟢';
  const readDot = (readsUsed / readsLimit) >= 0.9 ? '🔴' : (readsUsed / readsLimit) >= 0.7 ? '🟡' : '🟢';
  const storageDot = (stats.totalBytes / storageBytes) >= 0.9 ? '🔴' : (stats.totalBytes / storageBytes) >= 0.7 ? '🟡' : '🟢';

  return `🟢 **Active Storage Engine** — \`school-status-db\`\n` +
    `• **Active Records:** ${stats.totalKeys.toLocaleString()} keys${details}\n` +
    `• **Free-Plan Daily Budget (100,000 / day writes · 5,000,000 / day reads · resets ${easternResetLabel(now)}):**\n\n` +
    `${writeDot} ✍️ **Daily Writes** — ${commas(writesUsed)} / ${commas(writesLimit)} / day · ${writesPct}\n` +
    `${barFromFilled(filledCount(writesUsed, writesLimit))}\n` +
    `${readDot} 📖 **Daily Reads** — ${commas(readsUsed)} / ${commas(readsLimit)} / day · ${readsPct}\n` +
    `${barFromFilled(filledCount(readsUsed, readsLimit))}\n` +
    `${storageDot} 💾 **Storage Used** — ${formatBytes(stats.totalBytes)} / 5 GB · ${storagePct}\n` +
    `${barFromFilled(filledCount(stats.totalBytes, storageBytes))}\n\n` +
    `> All status changes, weather delays, emails, and bot operations store in Cloudflare D1.`;
}

/**
 * Ensures status history and weather events tables exist in D1 SQLite.
 */
export async function ensureStatusTables(db) {
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        district_id TEXT NOT NULL DEFAULT 'hcpss',
        status_key TEXT,
        status_text TEXT,
        status_date TEXT,
        timestamp INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_status_history_district_ts ON status_history(district_id, timestamp DESC)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS weather_events (
        id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        severity TEXT,
        headline TEXT,
        description TEXT,
        zone TEXT,
        county TEXT,
        effective INTEGER,
        expires INTEGER,
        timestamp INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_weather_events_ts ON weather_events(timestamp DESC)').run();
  } catch (err) {
    console.error('ensureStatusTables error:', err);
  }
}

/**
 * Records an HCPSS or neighboring district status change into D1 SQLite.
 */
export async function recordStatusToD1(db, { districtId = 'hcpss', statusKey = '', statusText = '', statusDate = '', timestamp = Date.now() }) {
  if (!db) return;
  try {
    await ensureStatusTables(db);
    await db.prepare(`
      INSERT INTO status_history (district_id, status_key, status_text, status_date, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      String(districtId || 'hcpss'),
      String(statusKey || ''),
      String(statusText || ''),
      String(statusDate || ''),
      Number(timestamp) || Date.now()
    ).run();
  } catch (err) {
    console.error('recordStatusToD1 error:', err);
  }
}

/**
 * Records an NWS weather alert or weather delay notice into D1 SQLite.
 */
export async function recordWeatherEventToD1(db, { id, event, severity = '', headline = '', description = '', zone = '', county = '', effective = 0, expires = 0, timestamp = Date.now() }) {
  if (!db || !id) return;
  try {
    await ensureStatusTables(db);
    await db.prepare(`
      INSERT INTO weather_events (id, event, severity, headline, description, zone, county, effective, expires, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        event = excluded.event,
        severity = excluded.severity,
        headline = excluded.headline,
        description = excluded.description,
        zone = excluded.zone,
        county = excluded.county,
        effective = excluded.effective,
        expires = excluded.expires,
        timestamp = excluded.timestamp
    `).bind(
      String(id),
      String(event || 'Weather Alert'),
      String(severity || ''),
      String(headline || ''),
      String(description || ''),
      String(zone || ''),
      String(county || ''),
      Number(effective) || 0,
      Number(expires) || 0,
      Number(timestamp) || Date.now()
    ).run();
  } catch (err) {
    console.error('recordWeatherEventToD1 error:', err);
  }
}

/**
 * Retrieves recorded status history events from D1 SQLite.
 */
export async function getStatusHistoryFromD1(db, districtId = 'hcpss', limit = 20) {
  if (!db) return [];
  try {
    await ensureStatusTables(db);
    const res = await db.prepare(`
      SELECT id, district_id, status_key, status_text, status_date, timestamp, created_at
      FROM status_history
      WHERE district_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).bind(String(districtId || 'hcpss'), Math.min(Number(limit) || 20, 100)).all();
    return (res && Array.isArray(res.results)) ? res.results : [];
  } catch (err) {
    console.error('getStatusHistoryFromD1 error:', err);
    return [];
  }
}

/**
 * Retrieves recorded weather events from D1 SQLite.
 */
export async function getWeatherEventsFromD1(db, limit = 20) {
  if (!db) return [];
  try {
    await ensureStatusTables(db);
    const res = await db.prepare(`
      SELECT id, event, severity, headline, description, zone, county, effective, expires, timestamp, created_at
      FROM weather_events
      ORDER BY timestamp DESC
      LIMIT ?
    `).bind(Math.min(Number(limit) || 20, 100)).all();
    return (res && Array.isArray(res.results)) ? res.results : [];
  } catch (err) {
    console.error('getWeatherEventsFromD1 error:', err);
    return [];
  }
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
  if (!db || !query) return [];
  try {
    await ensureEmailsTable(db);
    const searchPattern = `%${String(query).trim()}%`;
    const lim = Math.min(Number(limit) || 5, 20);

    if (guildId) {
      const res = await db.prepare(`
        SELECT id, subject, body, channel_id, message_id, ts, url, image_url, ai_summary
        FROM emails
        WHERE guild_id = ? AND (subject LIKE ? OR body LIKE ?)
        ORDER BY ts DESC
        LIMIT ?
      `).bind(String(guildId), searchPattern, searchPattern, lim).all();
      if (res && Array.isArray(res.results) && res.results.length > 0) {
        return res.results;
      }
    }

    // Fallback: search any stored announcements
    const fallbackRes = await db.prepare(`
      SELECT id, subject, body, channel_id, message_id, ts, url, image_url, ai_summary
      FROM emails
      WHERE subject LIKE ? OR body LIKE ?
      ORDER BY ts DESC
      LIMIT ?
    `).bind(searchPattern, searchPattern, lim).all();
    return (fallbackRes && Array.isArray(fallbackRes.results)) ? fallbackRes.results : [];
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
