// Write-through data push from the Apps Script watcher (gas/nws-alert-watcher.js).
//
// The watcher already fetches every external feed on its own 5-minute trigger
// and already knows, by fingerprint, which ones actually changed. Before this
// endpoint existed it told the Worker "source X changed" (/context-hook), the
// Worker deleted that source's KV cache, and the next reader fetched the same
// bytes all over again and re-cached them. Every real change therefore cost a
// KV delete plus a KV write plus an outbound fetch — and deletes and writes
// are the two metered operations with only 1,000/day on the free plan.
//
// Here the watcher POSTs the bodies it already has. The Worker parses them
// with its own parsers — the same functions the live fetchers use, so there is
// exactly one parser per source and no hand-copied mirror to drift — and
// writes the result straight into the cache key the reader already looks at.
// One KV write per real change, no delete, no refetch, no second parser.
//
// Nothing here is required for correctness: every cache key still has a TTL,
// and if the watcher dies the live fetchers take over exactly as before. This
// is a cost optimization layered on top of a system that already worked, so
// every failure path degrades to "don't write anything" and lets the Worker
// fall back to fetching.

import {
  DISTRICTS,
  parseThrillshareFeed,
  parseSharpSchoolAlerts,
  parseAtomEntries,
  parseMcpsEmergency,
  parsePgcpsAlert,
  summarizeDistrictEntries
} from './districts.js';
import { parseRssItems, summarizeNewsItems, countFeedItems, capNewsItems } from './crosscheck.js';
import { extractAccumulationLines } from './snowfall.js';
import { summarizeWeatherAlerts, DEFAULT_NWS_ZONE } from './weather.js';
import { parseChartIncidents } from './roads.js';
import { summarizeOutageFeed, summarizeKubraReport, KUBRA_UTILITIES } from './outages.js';
import { HOOK_ARMED_TTL_SECONDS } from './hookmode.js';

// Cache keys the live fetchers read. Pushed values must be byte-compatible
// with what those fetchers write, which is what the tests in
// tests/pushdata.test.js pin down.
export const CACHE_KEYS = {
  districts: 'district_status_cache',
  news: 'news_signal_cache',
  snowfall: 'snowfall_forecast_cache',
  roads: 'chart_incidents_cache',
  bge: 'bge_outage_cache',
  aqi: 'aqi_cache', // suffixed with :MD / :DC
  weather: 'weather_alerts_cache' // suffixed with :ZONE for non-default zones
};

// Pushed data is refreshed by the watcher within minutes of any real change,
// so the TTL is not the freshness mechanism — it is the safety net for a dead
// watcher, and matches what the hook-armed caches already use.
const PUSH_TTL_SECONDS = HOOK_ARMED_TTL_SECONDS;

export function weatherCacheKey(zone) {
  return zone === DEFAULT_NWS_ZONE ? CACHE_KEYS.weather : `${CACHE_KEYS.weather}:${zone}`;
}

// --- Pure parsers: raw bodies in, cache-shaped values out ---

// The watcher fetches the same six district feeds the Worker does, keyed by
// district id (Carroll needs two boards). Returns null when a required body is
// missing — a district we could not read must never be written to the cache as
// 'none', because that is indistinguishable from "no announcement" and would
// mask a real closure until the TTL expired.
export function parseDistrictsFromBodies(bodies, nowMs = Date.now()) {
  if (!bodies || typeof bodies !== 'object') return null;
  const required = ['aacps', 'bcps', 'fcps', 'mcps', 'pgcps'];
  for (const key of required) {
    if (typeof bodies[key] !== 'string' || !bodies[key]) return null;
  }
  // Carroll tolerates one of its two boards being down, mirroring the live
  // fetcher's Promise.allSettled behaviour.
  if (!bodies.ccps3 && !bodies.ccps63) return null;

  const entriesById = {
    aacps: parseThrillshareFeed(bodies.aacps, nowMs),
    bcps: parseSharpSchoolAlerts(bodies.bcps),
    ccps: [
      ...(bodies.ccps3 ? parseAtomEntries(bodies.ccps3, nowMs) : []),
      ...(bodies.ccps63 ? parseAtomEntries(bodies.ccps63, nowMs) : [])
    ],
    fcps: parseSharpSchoolAlerts(bodies.fcps),
    mcps: parseMcpsEmergency(bodies.mcps),
    pgcps: parsePgcpsAlert(bodies.pgcps)
  };

  return DISTRICTS.map(d => ({
    id: d.id,
    name: d.name,
    ...summarizeDistrictEntries(entriesById[d.id] || [])
  }));
}

// HCPSS news RSS. feedItems separates "nothing to report" from "feed broken",
// so an unreadable body returns null rather than a zero count. The parsed
// items ride along because busalerts.js classifies them directly — without
// them in the cache it fetched this same feed itself every 10 minutes.
export function parseNewsFromBody(xml, nowMs = Date.now()) {
  if (typeof xml !== 'string' || !xml) return null;
  const items = capNewsItems(parseRssItems(xml, nowMs));
  return {
    signal: summarizeNewsItems(items),
    feedItems: countFeedItems(xml),
    items
  };
}

// NWS gridpoint forecast JSON → accumulation lines.
export function parseSnowfallFromBody(json) {
  if (typeof json !== 'string' || !json) return null;
  try {
    const parsed = JSON.parse(json);
    return extractAccumulationLines(parsed && parsed.properties && parsed.properties.periods);
  } catch {
    return null;
  }
}

// AirNow returns a bare array of records; the Worker caches it unchanged.
export function parseAqiFromBody(json) {
  if (typeof json !== 'string' || !json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// NWS active-alerts GeoJSON → the summarized alert list readers expect.
export function parseWeatherFromBody(json) {
  if (typeof json !== 'string' || !json) return null;
  try {
    const parsed = JSON.parse(json);
    return summarizeWeatherAlerts(parsed && parsed.features);
  } catch {
    return null;
  }
}

// Maryland CHART incident XML → the meaningful-incident list.
export function parseRoadsFromBody(xml) {
  if (typeof xml !== 'string' || !xml) return null;
  try {
    return parseChartIncidents(xml);
  } catch {
    return null;
  }
}

// BGE's county datafeed → the per-county customers-out summary.
export function parseBgeFromBody(json) {
  if (typeof json !== 'string' || !json) return null;
  try {
    return summarizeOutageFeed(JSON.parse(json)) || null;
  } catch {
    return null;
  }
}

// One Kubra utility's report JSON → its per-county summary. The county name
// map is the Worker's, so a utility renaming an area is a one-place fix here
// rather than something the watcher has to know about.
export function parseKubraFromBody(utilityId, json) {
  const u = KUBRA_UTILITIES[utilityId];
  if (!u || typeof json !== 'string' || !json) return null;
  try {
    return summarizeKubraReport(JSON.parse(json), u.nameMap) || null;
  } catch {
    return null;
  }
}

// --- Endpoint handler ---

async function put(env, key, value) {
  await env.STATUS_KV.put(key, JSON.stringify(value), { expirationTtl: PUSH_TTL_SECONDS });
}

// Accepts { bodies: {...}, zones: { MDC027: '<geojson>' } } and writes each
// source the watcher sent. Returns { ok, written: [...], skipped: [...] } so
// the watcher can log exactly what landed and only advance its fingerprint for
// sources the Worker actually stored. Never throws.
export async function handlePushData(env, payload) {
  if (!env || !env.STATUS_KV) return { ok: false, error: 'KV unavailable' };

  const bodies = (payload && payload.bodies) || {};
  const zones = (payload && payload.zones) || {};
  const nowMs = Date.now();
  const written = [];
  const skipped = [];

  async function store(source, key, value) {
    if (value === null || value === undefined) {
      skipped.push(source);
      return;
    }
    try {
      await put(env, key, value);
      written.push(source);
    } catch (e) {
      console.error(`push-data write failed for ${source}:`, e);
      skipped.push(source);
    }
  }

  // Districts is all-or-nothing: the watcher sends the whole set together
  // because the cache holds one combined value.
  if (Object.keys(bodies).some(k => ['aacps', 'bcps', 'ccps3', 'ccps63', 'fcps', 'mcps', 'pgcps'].includes(k))) {
    const districts = parseDistrictsFromBodies(bodies, nowMs);
    await store('districts', CACHE_KEYS.districts, districts && { at: nowMs, districts });
  }

  if ('news' in bodies) {
    const news = parseNewsFromBody(bodies.news, nowMs);
    await store('news', CACHE_KEYS.news, news && { at: nowMs, ...news });
  }

  if ('snowfall' in bodies) {
    const lines = parseSnowfallFromBody(bodies.snowfall);
    await store('snowfall', CACHE_KEYS.snowfall, lines && { at: nowMs, lines });
  }

  if ('roads' in bodies) {
    const incidents = parseRoadsFromBody(bodies.roads);
    await store('roads', CACHE_KEYS.roads, incidents && { at: nowMs, incidents });
  }

  // Outage summaries are cached as { at, summary }, and the readers check for
  // the 'summary' property specifically, so a null summary must not be stored.
  if ('bge' in bodies) {
    const summary = parseBgeFromBody(bodies.bge);
    await store('bge', CACHE_KEYS.bge, summary && { at: nowMs, summary });
  }

  for (const utilityId of Object.keys(KUBRA_UTILITIES)) {
    const bodyKey = `kubra_${utilityId}`;
    if (!(bodyKey in bodies)) continue;
    const summary = parseKubraFromBody(utilityId, bodies[bodyKey]);
    await store(`outages:${utilityId}`, KUBRA_UTILITIES[utilityId].cacheKey, summary && { at: nowMs, summary });
  }

  for (const state of ['MD', 'DC']) {
    const bodyKey = `aqi${state.toLowerCase()}`;
    if (!(bodyKey in bodies)) continue;
    const records = parseAqiFromBody(bodies[bodyKey]);
    await store(`aqi:${state}`, `${CACHE_KEYS.aqi}:${state}`, records);
  }

  // Weather is the one source where an empty result must clear the key rather
  // than write an empty array: the live fetcher deliberately never caches an
  // empty alert set (a miss and an empty list mean the same thing to every
  // reader), so leaving a stale non-empty value behind would keep expired
  // alerts on embeds. One delete per alert-clear event, instead of the one
  // delete per any change that /nws-hook used to spend.
  for (const [rawZone, body] of Object.entries(zones)) {
    const zone = String(rawZone || '').trim().toUpperCase();
    if (!/^[A-Z]{3}\d{3}$/.test(zone)) {
      skipped.push(`weather:${rawZone}`);
      continue;
    }
    const alerts = parseWeatherFromBody(body);
    if (alerts === null) {
      skipped.push(`weather:${zone}`);
      continue;
    }
    const key = weatherCacheKey(zone);
    try {
      if (alerts.length > 0) {
        await put(env, key, alerts);
      } else {
        await env.STATUS_KV.delete(key);
      }
      written.push(`weather:${zone}`);
    } catch (e) {
      console.error(`push-data weather write failed for ${zone}:`, e);
      skipped.push(`weather:${zone}`);
    }
  }

  return { ok: true, written, skipped };
}
