// Cloudflare Workers Analytics Engine integration for school-status-bot.
//
// Records high-cardinality telemetry data points (scraper latencies, status changes,
// slash command executions, weather alerts, screenshot generations) without consuming
// any KV writes (10,000,000 datapoints/month and 100,000 SQL queries/day free),
// and queries live 24h summaries via the Analytics Engine SQL API.
//
// Never throws; degrades cleanly if env.ANALYTICS or CF credentials are not bound.

const ANALYTICS_SQL_CACHE_KEY = 'analytics_sql_cache';
const ANALYTICS_CACHE_TTL_SECONDS = 300;
export const ANALYTICS_DATASET = 'school_status_analytics';

/**
 * Records a telemetry data point to Cloudflare Workers Analytics Engine.
 *
 * @param {object} env - Worker environment object
 * @param {object} eventData
 * @param {string} eventData.event - Event category ('scrape', 'interaction', 'weather_alert', 'screenshot', 'email')
 * @param {string} [eventData.status='ok'] - Event outcome or status key ('ok', 'error', 'cached', 'changed')
 * @param {string} [eventData.guildId=''] - Discord Guild ID
 * @param {number} [eventData.durationMs=0] - Elapsed duration in milliseconds
 * @param {string} [eventData.detail=''] - Extra context (e.g., command name, alert type)
 * @param {boolean} [eventData.enabled=true] - Optional toggle guard
 * @returns {boolean} True if recorded, false if skipped
 */
export function recordAnalyticsEvent(env, {
  event,
  status = 'ok',
  guildId = '',
  durationMs = 0,
  detail = '',
  enabled = true
} = {}) {
  if (enabled === false) return false;
  if (!env || !env.ANALYTICS || typeof env.ANALYTICS.writeDataPoint !== 'function') {
    return false;
  }

  try {
    env.ANALYTICS.writeDataPoint({
      blobs: [
        String(event || 'generic').slice(0, 32),
        String(status || 'ok').slice(0, 32),
        String(guildId || '').slice(0, 64),
        String(detail || '').slice(0, 128)
      ],
      doubles: [
        Number(durationMs) || 0,
        1 // Count
      ],
      indexes: [
        String(guildId || event || 'default').slice(0, 32)
      ]
    });
    return true;
  } catch (err) {
    console.warn('Analytics Engine writeDataPoint error:', err && err.message ? err.message : err);
    return false;
  }
}

export function buildAnalyticsSummarySql(dataset = ANALYTICS_DATASET) {
  return `SELECT blob1 AS event, blob2 AS status, SUM(_sample_interval * double2) AS count, AVG(double1) AS avg_ms FROM ${dataset} WHERE timestamp >= NOW() - INTERVAL '1' DAY GROUP BY event, status FORMAT JSON`;
}

export function buildTopInteractionsSql(dataset = ANALYTICS_DATASET) {
  return `SELECT blob4 AS detail, SUM(_sample_interval * double2) AS count FROM ${dataset} WHERE timestamp >= NOW() - INTERVAL '1' DAY AND blob1 = 'interaction' AND blob4 != '' GROUP BY detail ORDER BY count DESC LIMIT 5 FORMAT JSON`;
}

/**
 * Folds raw Analytics Engine SQL JSON responses into a structured 24h summary.
 * Pure helper exported for unit testing.
 */
export function parseAnalyticsSqlResults(summaryRows = [], topRows = []) {
  const byEvent = {};
  let totalEvents24h = 0;

  for (const row of Array.isArray(summaryRows) ? summaryRows : []) {
    const ev = String(row?.event || 'other');
    const st = String(row?.status || 'ok');
    const cnt = Math.round(Number(row?.count) || 0);
    const avgMs = Number(row?.avg_ms) || 0;
    if (!byEvent[ev]) {
      byEvent[ev] = { total: 0, weightedMs: 0, avgMs: 0, statuses: {} };
    }
    byEvent[ev].total += cnt;
    byEvent[ev].weightedMs += avgMs * cnt;
    byEvent[ev].statuses[st] = (byEvent[ev].statuses[st] || 0) + cnt;
    totalEvents24h += cnt;
  }

  for (const ev of Object.values(byEvent)) {
    ev.avgMs = ev.total > 0 ? Math.round(ev.weightedMs / ev.total) : 0;
    delete ev.weightedMs;
  }

  const topCommands = (Array.isArray(topRows) ? topRows : [])
    .filter(r => r && r.detail)
    .map(r => ({ detail: String(r.detail), count: Math.round(Number(r.count) || 0) }))
    .slice(0, 5);

  return {
    totalEvents24h,
    byEvent,
    topCommands
  };
}

async function runSqlQuery(accountId, token, sql, fetchFn = fetch) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain'
    },
    body: sql
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}${errText ? `: ${errText.slice(0, 100)}` : ''}`);
  }
  const json = await resp.json();
  return Array.isArray(json?.data) ? json.data : [];
}

/**
 * Queries live 24-hour telemetry from Cloudflare Workers Analytics Engine SQL API.
 * Caches successful results in STATUS_KV for 5 minutes. Never throws.
 */
export async function queryAnalyticsSummary(env, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  if (!options.force && env?.STATUS_KV && typeof env.STATUS_KV.get === 'function') {
    try {
      const raw = await env.STATUS_KV.get(ANALYTICS_SQL_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && typeof cached.at === 'number' && (now - cached.at < ANALYTICS_CACHE_TTL_SECONDS * 1000) && cached.data) {
          return cached.data;
        }
      }
    } catch {}
  }

  const token = env?.CF_API_TOKEN;
  const accountId = env?.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    return { configured: false, reason: 'Set CF_API_TOKEN and CF_ACCOUNT_ID to query live SQL stats.' };
  }

  const fetchFn = options.fetch || fetch;
  try {
    const [summaryRows, topRows] = await Promise.all([
      runSqlQuery(accountId, token, buildAnalyticsSummarySql(), fetchFn),
      runSqlQuery(accountId, token, buildTopInteractionsSql(), fetchFn).catch(() => [])
    ]);
    const parsed = parseAnalyticsSqlResults(summaryRows, topRows);
    const data = { configured: true, ...parsed };

    if (env?.STATUS_KV && typeof env.STATUS_KV.put === 'function') {
      await env.STATUS_KV.put(
        ANALYTICS_SQL_CACHE_KEY,
        JSON.stringify({ at: now, data }),
        { expirationTtl: ANALYTICS_CACHE_TTL_SECONDS }
      ).catch(() => {});
    }
    return data;
  } catch (err) {
    return { configured: true, error: String(err?.message || 'Analytics SQL query failed').slice(0, 140) };
  }
}

/**
 * Formats 24h Analytics Engine SQL stats into concise Markdown lines for embeds.
 */
export function formatAnalyticsLines(stats) {
  if (!stats || !stats.configured) {
    return `⚪ *Live SQL query standby* (${stats?.reason || 'CF credentials not configured'})`;
  }
  if (stats.error) {
    return `⚠️ *SQL query unavailable:* \`${stats.error}\``;
  }

  const ev = stats.byEvent || {};
  const scrapes = ev.scrape || { total: 0, avgMs: 0, statuses: {} };
  const interactions = ev.interaction || { total: 0 };
  const shots = ev.screenshot || { total: 0, statuses: {} };
  const emails = ev.email || { total: 0 };
  const alerts = ev.weather_alert || { total: 0 };

  const shotCached = (shots.statuses?.cached || 0) + (shots.statuses?.web_r2 || 0) + (shots.statuses?.web_mem || 0);
  const shotHitPct = shots.total > 0 ? Math.round((shotCached / shots.total) * 100) : 0;

  const lines = [
    `• **24h Total Datapoints:** **${(stats.totalEvents24h || 0).toLocaleString('en-US')}**`,
    `• **Scrapes (24h):** ${scrapes.total} checks · avg \`${scrapes.avgMs}ms\` (${scrapes.statuses?.error || 0} err)`,
    `• **Discord Interactions (24h):** ${interactions.total}`,
    `• **Screenshots (24h):** ${shots.total} (${shotHitPct}% cache hits)`,
    `• **Emails / Weather Alerts (24h):** ${emails.total} emails · ${alerts.total} alerts`
  ];

  if (Array.isArray(stats.topCommands) && stats.topCommands.length > 0) {
    const topStr = stats.topCommands.map(c => `\`${c.detail}\` (${c.count})`).join(', ');
    lines.push(`• **Top Actions (24h):** ${topStr}`);
  }

  return lines.join('\n');
}
