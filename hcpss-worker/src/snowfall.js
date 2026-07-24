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

// ---------------------------------------------------------------------------
// Observed totals
//
// The forecast answers "how much is coming"; families watching a storm want
// "how much actually fell" — it's the number that explains a call nobody
// expected. NWS Local Storm Reports carry spotter-measured accumulations by
// county, issued by the Baltimore/Washington office (LWX) as they come in.

export const LSR_PRODUCT_LIST_URL = 'https://api.weather.gov/products/types/LSR/locations/LWX';
const OBSERVED_CACHE_KEY = 'observed_snowfall_cache';
const OBSERVED_CACHE_TTL_SECONDS = 1800;

// How many recent LSR products to pull. Each is a small text bulletin; during
// a storm the office issues them every few hours.
const LSR_PRODUCTS_TO_READ = 3;

// Reports older than this aren't about the storm anyone is currently asking
// about, so they're dropped rather than shown as today's totals.
export const OBSERVED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// LSR bulletins are fixed-format two-line records:
//
//   0300 PM     SNOW             1 SW ELLICOTT CITY      39.26N 76.83W
//   01/06/2025  M6.0 INCH        HOWARD             MD   TRAINED SPOTTER
//
// The second line carries the measurement and county; the first carries the
// event type and place. Returns [{ county, state, inches, event, place, atMs }].
// Tolerant by design — a format drift yields fewer reports, never a throw.
export function parseLocalStormReports(text, nowMs = Date.now()) {
  const lines = String(text || '').split(/\r?\n/);
  const reports = [];

  for (let i = 1; i < lines.length; i++) {
    const dataLine = lines[i].trim();
    const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+M?([\d.]+)\s+INCH(?:ES)?\s+(.+?)\s{2,}([A-Z]{2})\b/.exec(dataLine);
    if (!m) continue;

    const [, mm, dd, yyyy, mag, countyRaw, state] = m;
    const inches = Number(mag);
    if (!isFinite(inches)) continue;

    // The record's own timestamp is only a date; pair it with the time on the
    // header line when one is there, else treat it as midday. LSR times are
    // local (ET) and this builds a UTC instant from them, so `atMs` runs ~4-5
    // hours early — irrelevant against a 24-hour window, and it only ever
    // makes a report look older, never fresher.
    const headerLine = lines[i - 1].trim();
    const timeMatch = /^(\d{1,2})(\d{2})\s*(AM|PM)\b/.exec(headerLine);
    let hour = 12;
    let minute = 0;
    if (timeMatch) {
      hour = Number(timeMatch[1]) % 12;
      minute = Number(timeMatch[2]);
      if (timeMatch[3] === 'PM') hour += 12;
    }
    const atMs = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), hour, minute);
    if (nowMs - atMs > OBSERVED_MAX_AGE_MS) continue;

    // Header line: "<time> <AM/PM>  <EVENT>  <PLACE>  <LAT> <LON>". Only snow
    // and ice events carry an accumulation worth reporting.
    const eventMatch = /^\d{1,2}\d{2}\s*(?:AM|PM)\s+([A-Z][A-Z ]*?)\s{2,}(.*?)\s{2,}[\d.]+[NS]/.exec(headerLine);
    const event = eventMatch ? eventMatch[1].trim() : 'SNOW';
    const place = eventMatch ? eventMatch[2].trim() : '';
    if (!/SNOW|SLEET|ICE|FREEZING/i.test(event)) continue;

    reports.push({
      county: countyRaw.trim(),
      state,
      inches,
      event,
      place,
      atMs
    });
  }
  return reports;
}

// Reduces one county's reports to the headline number: the highest measured
// total, which is what "we got 8 inches" means colloquially. Returns null when
// that county has no reports.
export function summarizeObservedSnowfall(reports, county) {
  const want = String(county || '').trim().toUpperCase();
  const mine = (Array.isArray(reports) ? reports : []).filter(
    r => r && String(r.county || '').toUpperCase() === want
  );
  if (!mine.length) return null;

  const top = mine.reduce((a, b) => (b.inches > a.inches ? b : a));
  return {
    county,
    max: top.inches,
    place: top.place,
    atMs: top.atMs,
    reportCount: mine.length
  };
}

export function formatObservedSnowfallLines(summary) {
  if (!summary) return '';
  const place = summary.place ? ` at ${titleCasePlace(summary.place)}` : '';
  const others = summary.reportCount > 1
    ? ` · ${summary.reportCount} spotter reports`
    : '';
  return `📏 **${summary.max}"** measured${place}${others}`;
}

// LSR place names arrive shouting ("1 SW ELLICOTT CITY").
function titleCasePlace(place) {
  return String(place || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
    // Keep compass abbreviations upper: "1 Sw Ellicott City" → "1 SW Ellicott City".
    .replace(/\b(N|S|E|W|Ne|Nw|Se|Sw|Nne|Ene|Ese|Sse|Ssw|Wsw|Wnw|Nnw)\b/g, s => s.toUpperCase());
}

// Observed totals for one county, cached in KV for 30 minutes. All counties
// come from the same bulletins, so the fetch is shared across districts.
// Degrades to null on any failure.
export async function getObservedSnowfall(env, county) {
  let reports = null;

  if (env && env.STATUS_KV) {
    try {
      const cached = await env.STATUS_KV.get(OBSERVED_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.reports)) reports = parsed.reports;
      }
    } catch {}
  }

  if (!reports) {
    try {
      const list = await fetchJson(LSR_PRODUCT_LIST_URL);
      const graph = (list && list['@graph']) || [];
      const collected = [];
      for (const product of graph.slice(0, LSR_PRODUCTS_TO_READ)) {
        if (!product || !product.id) continue;
        const full = await fetchJson(`https://api.weather.gov/products/${product.id}`);
        collected.push(...parseLocalStormReports(full && full.productText));
      }
      reports = collected;
    } catch {
      return null;
    }

    if (env && env.STATUS_KV) {
      await env.STATUS_KV.put(
        OBSERVED_CACHE_KEY,
        JSON.stringify({ at: Date.now(), reports }),
        { expirationTtl: contextCacheTtl(env, OBSERVED_CACHE_TTL_SECONDS) }
      ).catch(() => {});
    }
  }

  return summarizeObservedSnowfall(reports, county);
}
