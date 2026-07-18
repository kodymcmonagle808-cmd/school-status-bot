// National Weather Service active alerts, defaulting to Howard County, MD
// (county zone MDC027). Guilds whose primary district is a neighboring county
// pass that county's zone instead.
// The NWS API is free and keyless but requires a User-Agent header.
export const DEFAULT_NWS_ZONE = 'MDC027';
const NWS_USER_AGENT = 'hcpss-status-monitor (github.com/kodymcmonagle808-cmd/hcpss-status-monitor)';

const WEATHER_CACHE_KEY = 'weather_alerts_cache';
const WEATHER_CACHE_TTL_SECONDS = 600;

export const MAX_ALERT_LINES = 3;

const SEVERITY_ORDER = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };

// Reduces raw NWS GeoJSON features to a small sorted list of
// { event, severity, endsMs } objects, deduped by event name.
export function summarizeWeatherAlerts(features) {
  const seen = new Set();
  const alerts = [];

  for (const f of Array.isArray(features) ? features : []) {
    const p = f && f.properties;
    if (!p || !p.event) continue;
    if (p.status && p.status !== 'Actual') continue;
    if (p.messageType === 'Cancel') continue;
    if (seen.has(p.event)) continue;
    seen.add(p.event);

    const endsRaw = p.ends || p.expires;
    const endsMs = endsRaw ? Date.parse(endsRaw) : 0;
    alerts.push({
      event: p.event,
      severity: p.severity || 'Unknown',
      endsMs: Number.isFinite(endsMs) ? endsMs : 0
    });
  }

  alerts.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4));
  return alerts;
}

export function formatWeatherAlertLines(alerts) {
  return (Array.isArray(alerts) ? alerts : []).slice(0, MAX_ALERT_LINES).map(a => {
    const until = a.endsMs ? ` — until <t:${Math.floor(a.endsMs / 1000)}:f>` : '';
    return `⚠️ **${a.event}**${until}`;
  }).join('\n');
}

// Alerts that justify storm-mode checking: winter-type events, or anything
// NWS rates Severe/Extreme.
const STORM_EVENT_RE = /winter|snow|ice|blizzard|freez|sleet|wind chill|cold|storm/i;

export function isStormAlert(alert) {
  if (!alert) return false;
  if (alert.severity === 'Extreme' || alert.severity === 'Severe') return true;
  return STORM_EVENT_RE.test(alert.event || '');
}

export function hasStormAlert(alerts) {
  return (Array.isArray(alerts) ? alerts : []).some(isStormAlert);
}

// Storm alerts likely still active tomorrow morning: no known end time, or an
// end time far enough out (default 9h) that it reaches past the next morning's
// decision window when evaluated during the evening.
export function alertsLikelyTomorrowMorning(alerts, nowMs, horizonMs = 9 * 60 * 60 * 1000) {
  return (Array.isArray(alerts) ? alerts : []).filter(a =>
    isStormAlert(a) && (!a.endsMs || a.endsMs > nowMs + horizonMs)
  );
}

// Returns the summarized active alerts, cached in KV for 10 minutes so
// frequent checks and Check-again clicks don't hammer the NWS API.
// Any failure returns [] — weather context is never allowed to break a status post.
export async function getActiveWeatherAlerts(env, zone = DEFAULT_NWS_ZONE) {
  // The default zone keeps the legacy cache key (the panel reads it directly).
  const cacheKey = zone === DEFAULT_NWS_ZONE ? WEATHER_CACHE_KEY : `${WEATHER_CACHE_KEY}:${zone}`;
  if (env && env.STATUS_KV) {
    try {
      const cached = await env.STATUS_KV.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
  }

  try {
    const r = await fetch(`https://api.weather.gov/alerts/active/zone/${zone}`, {
      headers: {
        'User-Agent': NWS_USER_AGENT,
        'Accept': 'application/geo+json'
      }
    });
    if (!r.ok) throw new Error('NWS fetch failed ' + r.status);
    const data = await r.json();
    const alerts = summarizeWeatherAlerts(data && data.features);
    if (env && env.STATUS_KV) {
      await env.STATUS_KV.put(cacheKey, JSON.stringify(alerts), { expirationTtl: WEATHER_CACHE_TTL_SECONDS }).catch(() => {});
    }
    return alerts;
  } catch {
    return [];
  }
}
