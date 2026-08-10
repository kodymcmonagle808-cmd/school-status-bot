// National Weather Service active alerts, defaulting to Howard County, MD
// (county zone MDC027). Guilds whose primary district is a neighboring county
// pass that county's zone instead.
// The NWS API is free and keyless but requires a User-Agent header.
export const DEFAULT_NWS_ZONE = 'MDC027';
const NWS_USER_AGENT = 'school-status-bot (github.com/kodymcmonagle808-cmd/school-status-bot)';

import { contextCacheTtl } from './hookmode.js';

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
    const onsetMs = p.onset ? Date.parse(p.onset) : 0;
    const alert = {
      event: p.event,
      severity: p.severity || 'Unknown',
      endsMs: Number.isFinite(endsMs) ? endsMs : 0,
      onsetMs: Number.isFinite(onsetMs) ? onsetMs : 0,
      headline: typeof p.headline === 'string' ? p.headline.slice(0, 300) : ''
    };
    // NWS's own "what to do right now" text, kept for the emergency tier only.
    // It runs several hundred characters and is shown in exactly one place (the
    // emergency alert); carrying it on every alert would grow a cached list
    // that every embed render reads, for text nothing displays.
    if (isEmergencyAlert(alert) && typeof p.instruction === 'string') {
      alert.instruction = p.instruction.replace(/\s+/g, ' ').trim().slice(0, 600);
    }
    alerts.push(alert);
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

// Alerts that justify storm-mode checking: winter-type events, heat events
// (schools without AC close or dismiss early for extreme heat), or anything
// NWS rates Severe/Extreme.
const STORM_EVENT_RE = /winter|snow|ice|blizzard|freez|sleet|wind chill|cold|storm|heat/i;

// Winter vs heat classification, used to pick seasonal emoji for the outlook.
export const WINTER_EVENT_RE = /winter|snow|ice|blizzard|freez|sleet|wind chill|cold/i;
export const HEAT_EVENT_RE = /heat/i;

export function isStormAlert(alert) {
  if (!alert) return false;
  if (alert.severity === 'Extreme' || alert.severity === 'Severe') return true;
  return STORM_EVENT_RE.test(alert.event || '');
}

export function hasStormAlert(alerts) {
  return (Array.isArray(alerts) ? alerts : []).some(isStormAlert);
}

// Storms that plausibly threaten power infrastructure: ice, heavy snow,
// damaging wind, severe thunderstorms, tropical systems, tornadoes. Only
// warning-level events count — watches and advisory-level events (Wind Chill
// Advisory, Winter Weather Advisory) don't take down power lines. Anything
// NWS rates Extreme qualifies regardless of name.
const POWER_THREAT_EVENT_RE = /ice storm|blizzard|winter storm|heavy snow|freezing rain|high wind|severe thunderstorm|tropical storm|hurricane|tornado/i;

export function isPowerThreatAlert(alert) {
  if (!alert) return false;
  if (alert.severity === 'Extreme') return true;
  const event = alert.event || '';
  return POWER_THREAT_EVENT_RE.test(event) && /warning/i.test(event);
}

export function hasPowerThreatAlert(alerts) {
  return (Array.isArray(alerts) ? alerts : []).some(isPowerThreatAlert);
}

// Convective events schools act on regardless of season: a tornado watch means
// hold students inside and call off outdoor activities, a tornado warning
// means shelter now, and a severe thunderstorm warning routinely holds
// dismissal. Matched at watch/warning level only (NWS issues no advisory at
// this tier).
//
// These are named explicitly rather than left to the severity check because
// severity is not dependable here: NWS rates most tornado products Extreme,
// but not all — a Tornado Watch commonly comes through as Severe, which used
// to mean it announced or stayed silent depending on a field the bot has no
// control over. For an alert this consequential that coin-flip isn't
// acceptable, so the event name decides.
const CONVECTIVE_EVENT_RE = /tornado|severe thunderstorm/i;

// The emergency tier: alerts where the correct response is to act in the next
// minute, not to watch the forecast. This is the only thing in the bot that
// pings @everyone, so the list stays deliberately short — a Severe
// Thunderstorm Warning or a Flash Flood Warning is a routine summer product
// here, and a ping that fires a dozen times a season is one the server learns
// to ignore, which is the failure that matters for an alert like this.
//
// Extreme severity counts on its own because NWS reserves it for exactly this
// tier: it is what separates a Flash Flood *Emergency* from the ordinary
// warning it is filed under (both arrive as event "Flash Flood Warning"). The
// named events are listed anyway because severity is not dependable for
// tornado products — see CONVECTIVE_EVENT_RE above; a Tornado Warning must
// never come down to a field the bot has no control over.
const EMERGENCY_EVENT_RE = /tornado warning|extreme wind warning|hurricane warning|civil emergency|evacuation immediate/i;

export function isEmergencyAlert(alert) {
  if (!alert) return false;
  if (alert.severity === 'Extreme') return true;
  return EMERGENCY_EVENT_RE.test(alert.event || '');
}

export function hasEmergencyAlert(alerts) {
  return (Array.isArray(alerts) ? alerts : []).some(isEmergencyAlert);
}

// Alerts worth announcing the moment NWS issues them: the winter and heat
// events school decisions hinge on, at watch/warning/advisory level (a
// Winter Weather Advisory is the classic 2-hour-delay signal), the convective
// events above at watch/warning level, plus the emergency tier.
//
// The emergency check leads so that tier is a strict subset of this one: an
// emergency that failed the classifier below would be filtered out before the
// notice pass ever saw it (a Hurricane Warning matches neither the winter nor
// the heat pattern), and the loudest alert the bot has would go unsent.
export function isSchoolImpactIssuance(alert) {
  if (!alert) return false;
  if (isEmergencyAlert(alert)) return true;
  const event = alert.event || '';
  if (CONVECTIVE_EVENT_RE.test(event)) return /warning|watch/i.test(event);
  if (!WINTER_EVENT_RE.test(event) && !HEAT_EVENT_RE.test(event)) return false;
  return /warning|watch|advisory/i.test(event);
}

// Storm alerts likely still active tomorrow morning: no known end time, or an
// end time far enough out (default 9h) that it reaches past the next morning's
// decision window when evaluated during the evening.
export function alertsLikelyTomorrowMorning(alerts, nowMs, horizonMs = 9 * 60 * 60 * 1000) {
  return (Array.isArray(alerts) ? alerts : []).filter(a =>
    isStormAlert(a) && (!a.endsMs || a.endsMs > nowMs + horizonMs)
  );
}

// Drops a zone's cached alert list so the next reader fetches live. Used by
// the /nws-hook push endpoint when the external poller reports a change —
// without this, a forced scan could serve the pre-change cache for 10 minutes.
export async function clearWeatherAlertCache(env, zone = DEFAULT_NWS_ZONE) {
  const cacheKey = zone === DEFAULT_NWS_ZONE ? WEATHER_CACHE_KEY : `${WEATHER_CACHE_KEY}:${zone}`;
  try {
    if (env && env.STATUS_KV) await env.STATUS_KV.delete(cacheKey);
  } catch {}
}

// Cache-only read for surfaces that must never wait on an NWS fetch (the
// control panel renders inside an interaction deadline). Returns [] on a miss.
export async function getCachedWeatherAlerts(env, zone = DEFAULT_NWS_ZONE) {
  const cacheKey = zone === DEFAULT_NWS_ZONE ? WEATHER_CACHE_KEY : `${WEATHER_CACHE_KEY}:${zone}`;
  try {
    const cached = env && env.STATUS_KV ? await env.STATUS_KV.get(cacheKey) : null;
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
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
    // Only cache when there ARE active alerts. Callers are clock-gated, so a
    // quiet zone costs a few NWS fetches per hour and zero KV writes — the
    // old always-write-with-TTL pattern spent ~144 writes/day per zone
    // rewriting an empty array all summer. A cache miss and an empty list
    // mean the same thing to every reader.
    if (env && env.STATUS_KV && alerts.length > 0) {
      // Hook-armed guilds get a longer TTL: /nws-hook clears this key the
      // moment the zone's alert set changes (including expirations).
      await env.STATUS_KV.put(cacheKey, JSON.stringify(alerts), { expirationTtl: contextCacheTtl(env, WEATHER_CACHE_TTL_SECONDS) }).catch(() => {});
    }
    return alerts;
  } catch {
    return [];
  }
}
