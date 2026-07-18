// Road conditions from Maryland CHART (chart.maryland.gov), the state's
// traffic operations feed. During storms this shows what the roads actually
// look like — crashes, closures, and weather events in the county. Failures
// always degrade to no incidents — road context never breaks a status post.

import { stripHtml } from './districts.js';

export const CHART_INCIDENTS_URL = 'https://chart.maryland.gov/DataFeeds/GetIncidentXml';
const ROADS_CACHE_KEY = 'chart_incidents_cache';
const ROADS_CACHE_TTL_SECONDS = 600;
const FETCH_TIMEOUT_MS = 8000;

const UA = 'hcpss-status-monitor (github.com/kodymcmonagle808-cmd/hcpss-status-monitor)';

export const MAX_ROAD_LINES = 2;

function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function tagValue(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
}

// The feed is full of routine traffic-ops noise (stuck signals, Opticom
// events, off-road activity). Keep an incident when its type or description
// reads as weather, a closure, or a crash — or CHART itself flagged it.
const MEANINGFUL_TYPE_RE = /weather|closure|collision|injury|damage|debris|flood/i;
const MEANINGFUL_DESC_RE = /\b(snow|ice|icy|sleet|flood(?:ed|ing)?|closed|closure|crash|collision|jack-?knif\w*|overturn\w*|downed (?:tree|wire|pole)|tree down|wires? down)\b/i;

// Parses <Incident> blocks into [{ county, type, description, trafficAlert }],
// keeping only open, meaningful incidents.
export function parseChartIncidents(xml) {
  const incidents = [];
  for (const m of String(xml || '').matchAll(/<Incident>[\s\S]*?<\/Incident>/g)) {
    const block = m[0];
    if (tagValue(block, 'closed') === 'true') continue;
    const county = tagValue(block, 'county');
    const type = tagValue(block, 'incidentType');
    const description = stripHtml(tagValue(block, 'description'));
    const trafficAlert = tagValue(block, 'trafficAlert') === 'true';
    if (!county || !description) continue;
    if (!trafficAlert && !MEANINGFUL_TYPE_RE.test(type) && !MEANINGFUL_DESC_RE.test(description)) continue;
    incidents.push({ county, type, description, trafficAlert });
  }
  return incidents;
}

export function incidentsForCounty(incidents, countyName) {
  return (Array.isArray(incidents) ? incidents : []).filter(i => i.county === countyName);
}

// Renders a county's incidents, alerts first, capped at MAX_ROAD_LINES plus a
// "+N more" line. Returns '' when the county's roads are quiet.
export function formatRoadLines(incidents, countyName) {
  const mine = incidentsForCounty(incidents, countyName)
    .sort((a, b) => (b.trafficAlert ? 1 : 0) - (a.trafficAlert ? 1 : 0));
  if (!mine.length) return '';
  const lines = mine.slice(0, MAX_ROAD_LINES).map(i =>
    `${i.trafficAlert ? '🚨' : '🚧'} ${i.description.slice(0, 140)}`
  );
  if (mine.length > MAX_ROAD_LINES) {
    lines.push(`…and ${mine.length - MAX_ROAD_LINES} more active incident(s)`);
  }
  return lines.join('\n');
}

// Fetches statewide incidents with a 10-minute KV cache. Never throws.
export async function getChartIncidents(env) {
  if (env && env.STATUS_KV) {
    try {
      const cached = await env.STATUS_KV.get(ROADS_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.incidents)) return parsed.incidents;
      }
    } catch {}
  }

  let incidents = [];
  try {
    const r = await fetch(CHART_INCIDENTS_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/xml, text/xml' },
      signal: timeoutSignal(FETCH_TIMEOUT_MS)
    });
    if (!r.ok) throw new Error('CHART fetch failed ' + r.status);
    incidents = parseChartIncidents(await r.text());
  } catch {
    return [];
  }

  if (env && env.STATUS_KV) {
    await env.STATUS_KV.put(
      ROADS_CACHE_KEY,
      JSON.stringify({ at: Date.now(), incidents }),
      { expirationTtl: ROADS_CACHE_TTL_SECONDS }
    ).catch(() => {});
  }
  return incidents;
}
