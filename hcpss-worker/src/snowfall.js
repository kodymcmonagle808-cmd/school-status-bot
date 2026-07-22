// Snowfall forecast detail from the NWS gridpoint forecast for Howard County.
// The forecast's detailedForecast sentences carry expected accumulations
// ("New snow accumulation of 4 to 8 inches possible."), which make the
// Closure Outlook concrete. Failures always degrade to no lines — forecast
// detail is never allowed to break a status post.

const NWS_POINT_URL = 'https://api.weather.gov/points/39.2156,-76.8582'; // Columbia, MD
const NWS_USER_AGENT = 'school-status-bot (github.com/kodymcmonagle808-cmd/school-status-bot)';

import { contextCacheTtl } from './hookmode.js';

const FORECAST_URL_CACHE_KEY = 'nws_forecast_url';
const SNOWFALL_CACHE_KEY = 'snowfall_forecast_cache';
const SNOWFALL_CACHE_TTL_SECONDS = 1800;
const FETCH_TIMEOUT_MS = 8000;

// Drops the cached lines so the next reader fetches live. Used by the
// /context-hook push path. Never throws.
export async function clearSnowfallCache(env) {
  try {
    if (env && env.STATUS_KV) await env.STATUS_KV.delete(SNOWFALL_CACHE_KEY);
  } catch {}
}

export const MAX_SNOWFALL_LINES = 3;

function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/geo+json' },
    signal: timeoutSignal(FETCH_TIMEOUT_MS)
  });
  if (!r.ok) throw new Error(`NWS fetch failed ${r.status} for ${url}`);
  return await r.json();
}

// Pulls accumulation sentences (snow, ice, sleet) out of the next forecast
// periods. Returns [{ name, text }] — empty when no accumulation is forecast.
export function extractAccumulationLines(periods, maxPeriods = 4) {
  const lines = [];
  for (const p of (Array.isArray(periods) ? periods : []).slice(0, maxPeriods)) {
    const detail = String((p && p.detailedForecast) || '');
    const sentences = detail.match(/[^.!?]*accumulation[^.!?]*[.!?]/gi) || [];
    const text = sentences.map(s => s.trim().replace(/\s+/g, ' ')).join(' ');
    if (text) lines.push({ name: (p && p.name) || 'Upcoming', text });
  }
  return lines;
}

export function formatSnowfallLines(lines) {
  return (Array.isArray(lines) ? lines : []).slice(0, MAX_SNOWFALL_LINES)
    .map(l => `❄️ **${l.name}** — ${l.text}`)
    .join('\n');
}

// Returns accumulation lines for Howard County, cached in KV for 30 minutes.
// The gridpoint forecast URL is resolved once via the points API and kept in
// KV indefinitely (NWS grid assignments are effectively static).
export async function getSnowfallForecast(env) {
  if (env && env.STATUS_KV) {
    try {
      const cached = await env.STATUS_KV.get(SNOWFALL_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.lines)) return parsed.lines;
      }
    } catch {}
  }

  let lines = [];
  try {
    let forecastUrl = env && env.STATUS_KV ? await env.STATUS_KV.get(FORECAST_URL_CACHE_KEY) : null;
    if (!forecastUrl) {
      const point = await fetchJson(NWS_POINT_URL);
      forecastUrl = point && point.properties && point.properties.forecast;
      if (!forecastUrl) throw new Error('NWS points response missing forecast URL');
      if (env && env.STATUS_KV) {
        await env.STATUS_KV.put(FORECAST_URL_CACHE_KEY, forecastUrl).catch(() => {});
      }
    }
    const forecast = await fetchJson(forecastUrl);
    lines = extractAccumulationLines(forecast && forecast.properties && forecast.properties.periods);
  } catch {
    return [];
  }

  if (env && env.STATUS_KV) {
    await env.STATUS_KV.put(
      SNOWFALL_CACHE_KEY,
      JSON.stringify({ at: Date.now(), lines }),
      { expirationTtl: contextCacheTtl(env, SNOWFALL_CACHE_TTL_SECONDS) }
    ).catch(() => {});
  }
  return lines;
}
