// Power outages by county. BGE covers the core service area (Howard, Anne
// Arundel, Baltimore, most of Carroll) via its simple public feed; guilds
// following Montgomery/Prince George's (Pepco) or Frederick/Carroll (Potomac
// Edison) get their utility's Kubra outage-map data instead, merged per
// county where territories overlap. Widespread outages are a real closure
// driver (and a direct signal for the Closure Outlook). Failures always
// degrade to null — outage context is never allowed to break a status post.

export const BGE_COUNTIES_URL = 'https://bge-prod.ifactornotifi.com/report/datafeed/counties';
const OUTAGE_CACHE_KEY = 'bge_outage_cache';
const OUTAGE_CACHE_TTL_SECONDS = 600;
const FETCH_TIMEOUT_MS = 8000;

const UA = 'school-status-bot (github.com/kodymcmonagle808-cmd/school-status-bot)';

// Kubra stormcenter deployments (the platform behind Pepco's and
// FirstEnergy's outage maps). The instance/view IDs are stable per utility;
// the report ID comes from the deployed view config and the data path from
// currentState, so each fetch resolves currentState first.
export const KUBRA_UTILITIES = {
  pepco: {
    label: 'Pepco',
    // Pepco fronts the Kubra API with its own proxy; kubra.io serves the data files.
    apiBase: 'https://phi-pepco.ifactornotifi.com/bpu/sc5',
    instanceId: 'bac68083-1c42-44ee-bb3c-6d1c1c026f52',
    viewId: 'ebc719f2-1185-46c2-8bf6-d0a2876c537f',
    reportId: '3a6114a2-76f8-4f13-820e-fef1610dd2d6',
    cacheKey: 'pepco_outage_cache',
    // report_district.json names: DC / MG / PG.
    nameMap: { MG: 'Montgomery', PG: "Prince George's", DC: 'District of Columbia' }
  },
  pe: {
    label: 'Potomac Edison',
    apiBase: 'https://kubra.io',
    instanceId: '6c715f0e-bbec-465f-98cc-0b81623744be',
    viewId: '5ed3ddf1-3a6f-4cfd-8957-eba54b5baaad',
    reportId: 'f168325d-ae23-407f-8134-b18e1946bf41',
    cacheKey: 'pe_outage_cache',
    // report_mdmuni.json uses uppercase county names.
    nameMap: {
      FREDERICK: 'Frederick', CARROLL: 'Carroll', MONTGOMERY: 'Montgomery',
      WASHINGTON: 'Washington', GARRETT: 'Garrett', ALLEGANY: 'Allegany',
      HOWARD: 'Howard', HARFORD: 'Harford'
    }
  }
};

// Which utilities serve each county the bot can follow (BGE is fetched via
// its own feed; the rest come from KUBRA_UTILITIES).
export const COUNTY_UTILITIES = {
  'Howard': ['bge'],
  'Anne Arundel': ['bge'],
  'Baltimore': ['bge'],
  'Carroll': ['bge', 'pe'],
  'Frederick': ['pe'],
  'Montgomery': ['pepco', 'pe'],
  "Prince George's": ['pepco', 'bge']
};

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

// Reduces a Kubra county report ({ file_data: { areas: [...] } }) to the same
// { counties: { name: { out, served } } } shape as the BGE feed, using the
// utility's name map (unmapped areas — municipalities, other states — are
// skipped). Exported for tests.
export function summarizeKubraReport(json, nameMap) {
  let data;
  try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  const areas = data && data.file_data && Array.isArray(data.file_data.areas) ? data.file_data.areas : null;
  if (!areas) return null;

  const counties = {};
  for (const a of areas) {
    const name = a && nameMap[a.name];
    if (!name) continue;
    counties[name] = {
      out: Number(a.cust_a && a.cust_a.val) || 0,
      served: Number(a.cust_s) || 0
    };
  }
  return { stormMode: false, counties };
}

// Fetches one Kubra utility's county summary with a 10-minute KV cache:
// currentState gives the current data path, then the county report comes from
// kubra.io. Never throws.
async function getKubraOutages(env, utilityId) {
  const u = KUBRA_UTILITIES[utilityId];
  if (!u) return null;

  if (env && env.STATUS_KV) {
    try {
      const cached = await env.STATUS_KV.get(u.cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed === 'object' && 'summary' in parsed) return parsed.summary;
      }
    } catch {}
  }

  let summary = null;
  try {
    const csResp = await fetch(
      `${u.apiBase}/stormcenter/api/v1/stormcenters/${u.instanceId}/views/${u.viewId}/currentState`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: timeoutSignal(FETCH_TIMEOUT_MS) }
    );
    if (!csResp.ok) throw new Error(`Kubra currentState failed ${csResp.status}`);
    const cs = await csResp.json();
    const igd = cs && cs.data && cs.data.interval_generation_data;
    if (!igd) throw new Error('Kubra currentState missing data path');

    const repResp = await fetch(`https://kubra.io/${igd}/public/reports/${u.reportId}_report.json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: timeoutSignal(FETCH_TIMEOUT_MS)
    });
    if (!repResp.ok) throw new Error(`Kubra report failed ${repResp.status}`);
    summary = summarizeKubraReport(await repResp.json(), u.nameMap);
  } catch {
    return null;
  }

  if (env && env.STATUS_KV && summary) {
    await env.STATUS_KV.put(
      u.cacheKey,
      JSON.stringify({ at: Date.now(), summary }),
      { expirationTtl: OUTAGE_CACHE_TTL_SECONDS }
    ).catch(() => {});
  }
  return summary;
}

// Merges per-utility summaries into one county entry, summing customers where
// territories overlap. Pure; exported for tests. Returns null when no utility
// had data for the county.
export function combineCountyOutages(summaries, countyName) {
  let out = 0;
  let served = 0;
  const providers = [];
  for (const { label, summary } of Array.isArray(summaries) ? summaries : []) {
    const c = getCountyOutage(summary, countyName);
    if (!c) continue;
    out += c.out;
    served += c.served;
    providers.push(label);
  }
  return providers.length ? { out, served, providers } : null;
}

// One display line for a merged county entry, naming the utility only when a
// single one serves the county.
export function formatCombinedOutageLine(entry, countyName) {
  if (!entry) return '';
  const pct = entry.served ? (entry.out / entry.served) * 100 : 0;
  const pctStr = pct >= 0.05 ? ` (${pct.toFixed(1)}%)` : '';
  const who = entry.providers.length === 1 ? `${entry.providers[0]} customers` : 'customers';
  return `🔌 **${entry.out.toLocaleString('en-US')}** of ${entry.served.toLocaleString('en-US')} ${who} without power in ${countyName} County${pctStr}`;
}

// The merged outage picture for one county, fetching only the utilities that
// actually serve it. Returns { entry, line, percent } (all null/''/0 when no
// data). Never throws.
export async function getCountyOutagePicture(env, countyName) {
  const utilities = COUNTY_UTILITIES[countyName] || ['bge'];
  const summaries = [];
  for (const id of utilities) {
    const summary = id === 'bge' ? await getBgeOutages(env) : await getKubraOutages(env, id);
    if (summary) summaries.push({ label: id === 'bge' ? 'BGE' : KUBRA_UTILITIES[id].label, summary });
  }
  const entry = combineCountyOutages(summaries, countyName);
  return {
    entry,
    line: entry && entry.out > 0 ? formatCombinedOutageLine(entry, countyName) : '',
    percent: entry && entry.served ? (entry.out / entry.served) * 100 : 0
  };
}

// All non-BGE utility summaries, for the /outages command's full listing.
export async function getKubraUtilitySummaries(env) {
  const results = [];
  for (const id of Object.keys(KUBRA_UTILITIES)) {
    const summary = await getKubraOutages(env, id);
    if (summary) results.push({ id, label: KUBRA_UTILITIES[id].label, summary });
  }
  return results;
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
