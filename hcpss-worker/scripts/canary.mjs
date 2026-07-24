// Scraper canary: fetches every live external source the Worker depends on
// and runs each through the REAL parser from src/. At runtime these sources
// all degrade silently by design (context must never break a status post), so
// this is the only place a quietly-broken scraper gets noticed. Run daily by
// .github/workflows/canary.yml; exits non-zero when any source fails.
//
// Usage: node scripts/canary.mjs

import { HCPSS_URL, fetchHtml, extractCards, determineStatusKey } from '../src/scraper.js';
import { DISTRICTS } from '../src/districts.js';
import { HCPSS_NEWS_FEED_URL, parseRssItems } from '../src/crosscheck.js';
import { summarizeWeatherAlerts, DEFAULT_NWS_ZONE } from '../src/weather.js';
import { BGE_COUNTIES_URL, KUBRA_UTILITIES, summarizeOutageFeed, summarizeKubraReport } from '../src/outages.js';
import { CHART_INCIDENTS_URL, parseChartIncidents } from '../src/roads.js';
import { COUNTY_REPORTING_AREAS, worstAqiToday } from '../src/aqi.js';
import { LSR_PRODUCT_LIST_URL, parseLocalStormReports } from '../src/snowfall.js';

const UA = 'school-status-bot canary (github.com/kodymcmonagle808-cmd/school-status-bot)';
const TIMEOUT_MS = 15000;

function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

async function get(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...(init.headers || {}) },
    signal: timeoutSignal(TIMEOUT_MS)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// Each check fetches live data and asserts the real parser still understands
// it. Empty results are only a failure where the source is never legitimately
// empty (the status page always has cards, the news feed always has items).
const CHECKS = {
  'HCPSS status page': async () => {
    const cards = extractCards(await fetchHtml(HCPSS_URL));
    assert(cards.length > 0, 'no status cards extracted');
    assert(typeof determineStatusKey(cards) === 'string', 'no status key');
  },

  'HCPSS news feed': async () => {
    // The RSS recency window would legitimately empty this, so parse raw.
    const xml = await (await get(HCPSS_NEWS_FEED_URL, { headers: { Accept: 'application/rss+xml' } })).text();
    assert(/<item[\s>]/.test(xml), 'feed has no <item> entries');
    assert(Array.isArray(parseRssItems(xml, Date.now())), 'parseRssItems did not return a list');
  },

  'NWS alerts': async () => {
    const data = await (await get(`https://api.weather.gov/alerts/active/zone/${DEFAULT_NWS_ZONE}`, {
      headers: { Accept: 'application/geo+json' }
    })).json();
    assert(Array.isArray(data.features), 'alerts response has no features array');
    assert(Array.isArray(summarizeWeatherAlerts(data.features)), 'summarizeWeatherAlerts failed');
  },

  'NWS snowfall gridpoint': async () => {
    const point = await (await get('https://api.weather.gov/points/39.2156,-76.8582', {
      headers: { Accept: 'application/geo+json' }
    })).json();
    assert(point.properties && point.properties.forecastGridData, 'point lookup has no forecastGridData URL');
  },

  'BGE outage feed': async () => {
    const summary = summarizeOutageFeed(await (await get(BGE_COUNTIES_URL, { headers: { Accept: 'application/json' } })).json());
    assert(summary && summary.counties.Howard, 'no Howard County in BGE feed');
  },

  'Pepco outage map (Kubra)': () => checkKubra('pepco', 'Montgomery'),
  'Potomac Edison outage map (Kubra)': () => checkKubra('pe', 'Frederick'),

  'AirNow air quality': async () => {
    const records = await (await get('https://airnowgovapi.com/reportingarea/get_state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'state_code=MD'
    })).json();
    assert(Array.isArray(records) && records.length, 'no MD records');
    const areas = new Set(records.map(r => r.reportingArea));
    for (const { area, state } of Object.values(COUNTY_REPORTING_AREAS)) {
      if (state === 'MD') assert(areas.has(area), `reporting area "${area}" missing from MD feed`);
    }
    assert(typeof worstAqiToday === 'function' && worstAqiToday(records, 'Metro Baltimore', '00/00/00') === null,
      'worstAqiToday sanity check failed');
  },

  'MD CHART road incidents': async () => {
    const xml = await (await get(CHART_INCIDENTS_URL)).text();
    assert(/^\s*</.test(xml), 'CHART response is not XML');
    assert(Array.isArray(parseChartIncidents(xml)), 'parseChartIncidents failed');
  },

  'NWS local storm reports (observed snowfall)': async () => {
    const list = await (await get(LSR_PRODUCT_LIST_URL, { headers: { Accept: 'application/ld+json' } })).json();
    const graph = list && list['@graph'];
    assert(Array.isArray(graph) && graph.length, 'no LSR products listed for LWX');
    assert(graph[0] && graph[0].id, 'LSR product entry has no id');
    const full = await (await get(`https://api.weather.gov/products/${graph[0].id}`, {
      headers: { Accept: 'application/ld+json' }
    })).json();
    assert(typeof full.productText === 'string' && full.productText.length, 'LSR product has no text');
    assert(Array.isArray(parseLocalStormReports(full.productText)), 'parseLocalStormReports failed');
    assert(/LOCAL STORM REPORT/i.test(full.productText), 'LSR bulletin header changed');

    // Snow reports are legitimately absent for most of the year, so instead of
    // asserting on them, assert the thing the parser actually depends on: the
    // fixed-width column layout declared by the bulletin's own legend.
    const legend = full.productText.split(/\r?\n/).find(l => /\.\.DATE\.\.\./.test(l));
    assert(legend, 'LSR column legend line missing');
    assert(legend.indexOf('....MAG....') === 12, `magnitude column moved (found at ${legend.indexOf('....MAG....')})`);
    assert(legend.indexOf('..COUNTY LOCATION..ST..') === 29, 'county/state column moved');

    // And prove the parser still reads a record laid out on those columns.
    const probe = [
      '0300 PM     Snow             1 SW Ellicott City      39.26N  76.83W',
      `${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' }).replace(/-/g, '/')}  M6.0 Inch        Howard             MD   Trained Spotter`
    ].join('\n');
    const parsed = parseLocalStormReports(probe);
    assert(parsed.length === 1 && parsed[0].county === 'Howard' && parsed[0].inches === 6,
      'parseLocalStormReports no longer reads a canonical record');
  }
};

// Every district announcement fetcher, through the real per-platform parser.
for (const d of DISTRICTS) {
  CHECKS[`${d.name} announcements (${d.id})`] = async () => {
    const entries = await d.fetchEntries();
    assert(Array.isArray(entries), 'fetcher did not return a list');
  };
}

async function checkKubra(utilityId, expectedCounty) {
  const u = KUBRA_UTILITIES[utilityId];
  const cs = await (await get(
    `${u.apiBase}/stormcenter/api/v1/stormcenters/${u.instanceId}/views/${u.viewId}/currentState`,
    { headers: { Accept: 'application/json' } }
  )).json();
  const igd = cs && cs.data && cs.data.interval_generation_data;
  assert(igd, 'currentState missing interval_generation_data');
  const report = await (await get(`https://kubra.io/${igd}/public/reports/${u.reportId}_report.json`, {
    headers: { Accept: 'application/json' }
  })).json();
  const summary = summarizeKubraReport(report, u.nameMap);
  assert(summary && summary.counties[expectedCounty], `no ${expectedCounty} County in ${u.label} report`);
}

async function runWithRetry(name, fn, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return null;
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 3000));
    }
  }
  return lastError;
}

const failures = [];
for (const [name, fn] of Object.entries(CHECKS)) {
  const error = await runWithRetry(name, fn);
  if (error) {
    failures.push(name);
    console.log(`❌ ${name}: ${error.message}`);
  } else {
    console.log(`✅ ${name}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} source(s) failing: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nAll ${Object.keys(CHECKS).length} sources healthy.`);
