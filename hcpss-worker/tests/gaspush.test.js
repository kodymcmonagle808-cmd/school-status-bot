// The handshake between the Apps Script collector and the Worker's
// /push-data endpoint, tested across both runtimes at once.
//
// Two contracts have to hold, and neither is visible from either side alone:
//
//   1. The body keys the script sends are the ones the Worker reads. Get this
//      wrong and the Worker stores nothing while both sides report success.
//   2. The source names the Worker returns in `written` are the ones the
//      script waits for before advancing a fingerprint. Get this wrong and the
//      script re-pushes the same unchanged bodies on every 5-minute trigger,
//      forever — a silent write loop, which is the exact failure this whole
//      change exists to stop.
//
// So this drives the real collectors (in a sandbox with Google's services
// stubbed), takes the batch they produce, feeds it to the real handlePushData,
// and checks that every name the script is waiting for actually comes back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

import { handlePushData } from '../src/pushdata.js';

const here = dirname(fileURLToPath(import.meta.url));
const gasSource = readFileSync(join(here, '..', '..', 'gas', 'nws-alert-watcher.js'), 'utf8');

const RECENT = new Date(Date.now() - 30 * 60 * 1000).toISOString();

// Bodies keyed by a substring of the URL the collector will request.
const FEEDS = [
  ['api.thrillshare.com', JSON.stringify({ live_feeds: [{ status: 'Picture day Friday', publishing_at: RECENT }] })],
  ['bcps.org/WebServices', JSON.stringify({ d: [] })],
  ['fcps.org/WebServices', JSON.stringify({ d: [] })],
  ['boards/3/posts/feed', '<feed><entry><title>Board notes</title><updated>' + RECENT + '</updated></entry></feed>'],
  ['boards/63/posts/feed', '<feed></feed>'],
  ['montgomeryschoolsmd.org', JSON.stringify({ emsg: '<div class="emer-code-green">ok</div>' })],
  ['www.pgcps.org', '<html><body>quiet</body></html>'],
  ['news.hcpss.org', '<rss><channel><item><title>Menu update</title><pubDate>' + new Date().toUTCString() + '</pubDate></item></channel></rss>'],
  ['airnowgovapi.com', JSON.stringify([{ reportingArea: 'Metro Baltimore', dataType: 'O', category: 'Good', validDate: '01/01/26' }])],
  ['api.weather.gov/points', JSON.stringify({ properties: { forecast: 'https://api.weather.gov/gridpoints/LWX/1,1/forecast' } })],
  ['gridpoints', JSON.stringify({ properties: { periods: [{ name: 'Tonight', detailedForecast: 'New snow accumulation of 3 to 5 inches possible.' }] } })],
  ['alerts/active/zone', JSON.stringify({ features: [{ properties: { event: 'Winter Storm Warning', status: 'Actual', severity: 'Severe', ends: '2026-01-07T12:00:00Z' } }] })],
  ['chart.maryland.gov', '<Incidents><Incident><county>Howard</county><incidentType>Weather</incidentType><description>Snow on roadway</description><trafficAlert>true</trafficAlert><closed>false</closed></Incident></Incidents>'],
  ['bge-prod', JSON.stringify({ counties: [{ county: 'Howard', customersOut: 250 }] })],
  ['currentState', JSON.stringify({ data: { interval_generation_data: 'path/abc' } })],
  ['_report.json', JSON.stringify({ file_data: { areas: [{ name: 'HOWARD', cust_a: { val: 120 } }, { name: 'MG', cust_a: { val: 40 } }] } })]
];

function bodyFor(url) {
  for (const [needle, body] of FEEDS) {
    if (url.indexOf(needle) !== -1) return body;
  }
  return null;
}

function response(body) {
  return {
    getResponseCode: () => (body === null ? 404 : 200),
    getContentText: () => body || ''
  };
}

// A sandbox with just enough of Apps Script for the collectors to run.
function makeSandbox(seedProps) {
  const store = { ...seedProps };
  const sandbox = {
    console: { log() {}, error() {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in store ? store[k] : null),
        setProperty: (k, v) => { store[k] = String(v); },
        deleteProperty: k => { delete store[k]; },
        getProperties: () => ({ ...store })
      })
    },
    UrlFetchApp: {
      fetch: url => response(bodyFor(url)),
      fetchAll: reqs => reqs.map(r => response(bodyFor(r.url)))
    },
    Utilities: {
      DigestAlgorithm: { MD5: 'MD5' },
      computeDigest: (_alg, text) => Array.from(crypto.createHash('md5').update(String(text)).digest()),
      formatDate: () => '01/01/26'
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(gasSource, sandbox);
  return { sandbox, store };
}

// Every fingerprint pre-seeded as stale, so the collectors treat this run as a
// change rather than a first-run baseline.
const STALE = {
  fp_ctx_districts: 'stale', fp_ctx_news: 'stale', fp_ctx_snowfall: 'stale',
  fp_ctx_aqi: 'stale', fp_roads: 'stale', fp_outages: 'stale',
  fp_MDC027: 'stale', fp_MDC003: 'stale', fp_MDC005: 'stale', fp_MDC013: 'stale',
  fp_MDC021: 'stale', fp_MDC031: 'stale', fp_MDC033: 'stale',
  NWS_FORECAST_URL: 'https://api.weather.gov/gridpoints/LWX/1,1/forecast'
};

function collectAll() {
  const { sandbox } = makeSandbox(STALE);
  const props = sandbox.PropertiesService.getScriptProperties();
  const batch = { bodies: {}, zones: {}, units: [] };
  sandbox.collectContextSources(props, batch);
  sandbox.collectRoads(props, batch);
  sandbox.collectOutages(props, batch);
  sandbox.collectNwsAlerts(props, batch);
  // Copy out of the vm realm so assert can compare against this realm's types.
  return {
    bodies: { ...batch.bodies },
    zones: { ...batch.zones },
    units: batch.units.map(u => ({ fpKey: u.fpKey, fingerprint: u.fingerprint, expect: [...u.expect] }))
  };
}

test('the collectors stage every source when all fingerprints have moved', () => {
  const batch = collectAll();
  const fpKeys = batch.units.map(u => u.fpKey).sort();
  assert.deepEqual(fpKeys, [
    'fp_MDC003', 'fp_MDC005', 'fp_MDC013', 'fp_MDC021', 'fp_MDC027', 'fp_MDC031', 'fp_MDC033',
    'fp_ctx_aqi', 'fp_ctx_districts', 'fp_ctx_news', 'fp_ctx_snowfall', 'fp_outages', 'fp_roads'
  ]);
  // The district unit must carry all seven feed bodies, or the Worker refuses
  // the whole set rather than caching a partial picture.
  for (const key of ['aacps', 'bcps', 'ccps3', 'ccps63', 'fcps', 'mcps', 'pgcps']) {
    assert.equal(typeof batch.bodies[key], 'string', `missing district body ${key}`);
  }
  assert.equal(typeof batch.bodies.roads, 'string');
  assert.equal(typeof batch.bodies.bge, 'string');
  assert.equal(typeof batch.bodies.kubra_pepco, 'string');
  assert.equal(typeof batch.bodies.kubra_pe, 'string');
  assert.equal(typeof batch.zones.MDC027, 'string');
});

test('every source name the script waits for is one the Worker actually returns', async () => {
  const batch = collectAll();

  const written = [];
  const env = {
    STATUS_KV: {
      async get() { return null; },
      async put(key) { written.push(key); },
      async delete() {},
      async list() { return { keys: [], list_complete: true }; }
    }
  };

  const result = await handlePushData(env, { bodies: batch.bodies, zones: batch.zones });
  assert.equal(result.ok, true);

  // This is the assertion that matters: if a name drifts, the script never
  // advances that fingerprint and re-pushes the same bytes every 5 minutes.
  const expected = batch.units.reduce((all, u) => all.concat(u.expect), []);
  for (const name of expected) {
    assert.ok(
      result.written.includes(name),
      `script waits for "${name}" but the Worker returned [${result.written.join(', ')}]`
    );
  }
  assert.deepEqual(result.skipped, [], 'nothing the script staged should be unparseable');
});

test('a full push writes each cache key exactly once', async () => {
  const batch = collectAll();
  const puts = [];
  const env = {
    STATUS_KV: {
      async get() { return null; },
      async put(key) { puts.push(key); },
      async delete() {},
      async list() { return { keys: [], list_complete: true }; }
    }
  };

  await handlePushData(env, { bodies: batch.bodies, zones: batch.zones });

  assert.equal(new Set(puts).size, puts.length, `a key was written twice: ${puts.join(', ')}`);
  assert.ok(puts.includes('district_status_cache'));
  assert.ok(puts.includes('news_signal_cache'));
  assert.ok(puts.includes('snowfall_forecast_cache'));
  assert.ok(puts.includes('chart_incidents_cache'));
  assert.ok(puts.includes('bge_outage_cache'));
  assert.ok(puts.includes('aqi_cache:MD'));
});

test('a first run baselines silently instead of pushing everything at once', () => {
  const { sandbox } = makeSandbox({ NWS_FORECAST_URL: 'https://api.weather.gov/gridpoints/LWX/1,1/forecast' });
  const props = sandbox.PropertiesService.getScriptProperties();
  const batch = { bodies: {}, zones: {}, units: [] };
  sandbox.collectContextSources(props, batch);
  sandbox.collectRoads(props, batch);
  sandbox.collectOutages(props, batch);
  sandbox.collectNwsAlerts(props, batch);

  assert.equal(batch.units.length, 0, 'installing the script must not push the current state as if it were new');
  // ...but the baseline is recorded, so the next real change does push.
  assert.ok(props.getProperty('fp_ctx_districts'));
  assert.ok(props.getProperty('fp_MDC027'));
});

test('an unchanged run stages nothing', () => {
  const { sandbox } = makeSandbox({ NWS_FORECAST_URL: 'https://api.weather.gov/gridpoints/LWX/1,1/forecast' });
  const props = sandbox.PropertiesService.getScriptProperties();

  const first = { bodies: {}, zones: {}, units: [] };
  sandbox.collectContextSources(props, first);
  sandbox.collectNwsAlerts(props, first);

  const second = { bodies: {}, zones: {}, units: [] };
  sandbox.collectContextSources(props, second);
  sandbox.collectNwsAlerts(props, second);

  assert.equal(second.units.length, 0, 'a quiet 5 minutes must cost the Worker nothing');
});
