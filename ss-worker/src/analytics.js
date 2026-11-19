// Cloudflare Workers Analytics Engine integration for school-status-bot.
//
// Records high-cardinality telemetry data points (scraper latencies, status changes,
// slash command executions, weather alerts, screenshot generations) without consuming
// any KV writes (10,000,000 datapoints/month and 100,000 SQL queries/day free).
//
// Never throws; degrades cleanly to false if env.ANALYTICS is not bound.

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
 * @returns {boolean} True if recorded, false if skipped
 */
export function recordAnalyticsEvent(env, {
  event,
  status = 'ok',
  guildId = '',
  durationMs = 0,
  detail = ''
} = {}) {
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
