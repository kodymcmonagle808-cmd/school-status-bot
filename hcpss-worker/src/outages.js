// BGE power outages by county, from the same public feed BGE's own outage
// report page uses. Widespread outages are a real closure driver (and a
// direct signal for the Closure Outlook). Failures always degrade to null —
// outage context is never allowed to break a status post.

const BGE_COUNTIES_URL = 'https://bge-prod.ifactornotifi.com/report/datafeed/counties';
const OUTAGE_CACHE_KEY = 'bge_outage_cache';
const OUTAGE_CACHE_TTL_SECONDS = 600;
const FETCH_TIMEOUT_MS = 8000;

const UA = 'school-status-bot (github.com/kodymcmonagle808-cmd/school-status-bot)';

function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// Reduces the raw feed to { stormMode, counties: { name: { out, served } } }.
export function summarizeOutageFeed(json) {
  let data;
  try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!data || !Array.isArray(data.counties)) return null;

  const counties = {};
  for (const c of data.counties) {
    if (!c || !c.county) continue;
    counties[c.county] = {
      out: Number(c.customersOut) || 0,
      served: Number(c.customersServed) || 0
    };
  }
  return { stormMode: data.stormmode === 'Y', counties };
}

export function getCountyOutage(summary, countyName) {
  if (!summary || !summary.counties || !countyName) return null;
  return summary.counties[countyName] || null;
}

export function outagePercent(county) {
  if (!county || !county.served) return 0;
  return (county.out / county.served) * 100;
}

// One display line, e.g. "🔌 2,410 of 130,377 BGE customers without power in
// Howard County (1.8%)". Returns '' when the county isn't in BGE territory.
export function formatOutageLine(summary, countyName) {
  const county = getCountyOutage(summary, countyName);
  if (!county) return '';
  const pct = outagePercent(county);
  const pctStr = pct >= 0.05 ? ` (${pct.toFixed(1)}%)` : '';
  return `🔌 **${county.out.toLocaleString('en-US')}** of ${county.served.toLocaleString('en-US')} BGE customers without power in ${countyName} County${pctStr}`;
}

// Fetches the county outage summary with a 10-minute KV cache. Never throws.
export async function getBgeOutages(env) {
  if (env && env.STATUS_KV) {
    try {
      const cached = await env.STATUS_KV.get(OUTAGE_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed === 'object' && 'summary' in parsed) return parsed.summary;
      }
    } catch {}
  }

  let summary = null;
  try {
    const r = await fetch(BGE_COUNTIES_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: timeoutSignal(FETCH_TIMEOUT_MS)
    });
    if (!r.ok) throw new Error('BGE outage feed fetch failed ' + r.status);
    summary = summarizeOutageFeed(await r.json());
  } catch {
    return null;
  }

  if (env && env.STATUS_KV) {
    await env.STATUS_KV.put(
      OUTAGE_CACHE_KEY,
      JSON.stringify({ at: Date.now(), summary }),
      { expirationTtl: OUTAGE_CACHE_TTL_SECONDS }
    ).catch(() => {});
  }
  return summary;
}
