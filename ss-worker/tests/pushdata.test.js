// /push-data: the watcher hands over the bodies it already fetched and the
// Worker parses them with its own parsers, writing straight into the cache
// keys the live fetchers read.
//
// The tests that matter most here are the round-trips at the bottom. The whole
// design rests on one claim — that a pushed value is byte-compatible with what
// the live fetcher would have written — and the only honest way to check that
// is to push a body, then call the real getter with fetch mocked to throw. If
// the getter returns the pushed data without touching the network, the shapes
// agree; if the shape ever drifts, the getter falls through to fetch and the
// test fails loudly instead of silently degrading in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  parseDistrictsFromBodies,
  parseNewsFromBody,
  parseSnowfallFromBody,
  parseAqiFromBody,
  parseWeatherFromBody,
  CACHE_KEYS,
  weatherCacheKey
} from '../src/pushdata.js';
import { getDistrictStatuses } from '../src/districts.js';
import { getNewsSignal } from '../src/crosscheck.js';
import { getSnowfallForecast } from '../src/snowfall.js';
import { getChartIncidents } from '../src/roads.js';
import { getActiveWeatherAlerts } from '../src/weather.js';

function kvStub(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    writes: 0,
    deletes: 0,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, val) { this.writes++; map.set(key, val); },
    async delete(key) { this.deletes++; map.delete(key); },
    async list() { return { keys: [], list_complete: true }; }
  };
}

function ctxStub() {
  return { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
}

function pushRequest(token, body) {
  return new Request('https://worker.example/push-data', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {},
    body: JSON.stringify(body)
  });
}

const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

// Minimal but structurally real bodies, one per platform the watcher fetches.
function districtBodies(overrides = {}) {
  return {
    aacps: JSON.stringify({ live_feeds: [{ status: 'Field trip reminder', publishing_at: RECENT }] }),
    bcps: JSON.stringify({ d: [] }),
    ccps3: '<feed><entry><title>Board meeting</title><updated>' + RECENT + '</updated></entry></feed>',
    ccps63: '<feed></feed>',
    fcps: JSON.stringify({ d: [] }),
    mcps: JSON.stringify({ emsg: '<div class="emer-code-green">All normal</div>' }),
    pgcps: '<html><body>nothing</body></html>',
    ...overrides
  };
}

test('/push-data rejects a missing or wrong secret', async () => {
  const disabled = await worker.fetch(pushRequest('anything', {}), { STATUS_KV: kvStub() }, ctxStub());
  assert.equal(disabled.status, 403);

  const env = { NWS_HOOK_SECRET: 'right', STATUS_KV: kvStub() };
  const wrong = await worker.fetch(pushRequest('wrong', {}), env, ctxStub());
  assert.equal(wrong.status, 403);
});

test('parseDistrictsFromBodies returns one entry per district in DISTRICTS order', () => {
  const districts = parseDistrictsFromBodies(districtBodies());
  assert.equal(districts.length, 6);
  assert.deepEqual(districts.map(d => d.id), ['aacps', 'bcps', 'ccps', 'fcps', 'mcps', 'pgcps']);
  // Nothing in the fixtures classifies as a closing.
  assert.ok(districts.every(d => d.status === 'none'));
  assert.ok(districts.every(d => typeof d.name === 'string' && d.name));
});

test('parseDistrictsFromBodies classifies a real closure', () => {
  const districts = parseDistrictsFromBodies(districtBodies({
    pgcps: '<section class="site-alert-component"><h3 class="title">All schools closed today</h3>' +
           '<div class="read-more">Due to snow.</div></section>'
  }));
  const pgcps = districts.find(d => d.id === 'pgcps');
  assert.equal(pgcps.status, 'closed');
  assert.match(pgcps.detail, /All schools closed/);
});

test('parseDistrictsFromBodies refuses a partial set rather than reporting a gap as "none"', () => {
  // A district we could not read must not be cached as "no announcement" —
  // that is indistinguishable from a real all-clear and would mask a closure.
  for (const missing of ['aacps', 'bcps', 'fcps', 'mcps', 'pgcps']) {
    const bodies = districtBodies();
    delete bodies[missing];
    assert.equal(parseDistrictsFromBodies(bodies), null, `${missing} missing should abort`);
  }
  // Carroll tolerates one of its two boards being down, but not both.
  const oneBoard = districtBodies({ ccps3: '' });
  assert.ok(Array.isArray(parseDistrictsFromBodies(oneBoard)));
  const noBoards = districtBodies({ ccps3: '', ccps63: '' });
  assert.equal(parseDistrictsFromBodies(noBoards), null);
});

test('body parsers reject unusable input instead of inventing empty data', () => {
  assert.equal(parseNewsFromBody(''), null);
  assert.equal(parseNewsFromBody(null), null);
  assert.equal(parseSnowfallFromBody('not json'), null);
  assert.equal(parseAqiFromBody('{"not":"an array"}'), null);
  assert.equal(parseWeatherFromBody('{'), null);
  assert.equal(parseDistrictsFromBodies(null), null);
});

test('/push-data writes each source once and reports what landed', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const kv = kvStub();
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv };

  const resp = await worker.fetch(pushRequest('s3cret', {
    bodies: {
      ...districtBodies(),
      news: '<rss><channel><item><title>Nothing</title><pubDate>' + new Date().toUTCString() + '</pubDate></item></channel></rss>',
      snowfall: JSON.stringify({ properties: { periods: [{ name: 'Tonight', detailedForecast: 'New snow accumulation of 4 to 8 inches possible.' }] } }),
      aqimd: JSON.stringify([{ reportingArea: 'Metro Baltimore', category: 'Good' }]),
      aqidc: JSON.stringify([])
    }
  }), env, ctxStub());

  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.written.sort(), ['aqi:DC', 'aqi:MD', 'districts', 'news', 'snowfall']);
  assert.deepEqual(body.skipped, []);

  // Exactly one write per source — the point of the endpoint.
  assert.equal(kv.writes, 5);
  assert.equal(kv.deletes, 0);
  assert.ok(kv.map.has(CACHE_KEYS.districts));
  assert.ok(kv.map.has(CACHE_KEYS.news));
  assert.ok(kv.map.has(CACHE_KEYS.snowfall));
  assert.ok(kv.map.has(`${CACHE_KEYS.aqi}:MD`));
});

test('/push-data reports an unparseable source as skipped and writes nothing for it', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const kv = kvStub();
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv };

  const resp = await worker.fetch(pushRequest('s3cret', {
    bodies: { snowfall: 'garbage', news: '' }
  }), env, ctxStub());

  const body = await resp.json();
  assert.deepEqual(body.written, []);
  assert.deepEqual(body.skipped.sort(), ['news', 'snowfall']);
  assert.equal(kv.writes, 0);
});

test('/push-data writes weather alerts, and clears the key when a zone goes quiet', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const kv = kvStub();
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv };

  const feed = JSON.stringify({
    features: [{
      properties: {
        event: 'Winter Storm Warning',
        status: 'Actual',
        severity: 'Severe',
        ends: '2026-01-02T12:00:00Z',
        headline: 'Winter Storm Warning until noon'
      }
    }]
  });

  await worker.fetch(pushRequest('s3cret', { zones: { MDC027: feed } }), env, ctxStub());
  const stored = JSON.parse(kv.map.get(weatherCacheKey('MDC027')));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].event, 'Winter Storm Warning');

  // An empty alert set must delete rather than store [] — the live fetcher
  // deliberately never caches an empty list, so a stale non-empty value would
  // otherwise keep an expired alert on the embeds.
  await worker.fetch(pushRequest('s3cret', { zones: { MDC027: '{"features":[]}' } }), env, ctxStub());
  assert.equal(kv.map.has(weatherCacheKey('MDC027')), false);

  // A malformed zone code is rejected, not written under a junk key.
  const resp = await worker.fetch(pushRequest('s3cret', { zones: { 'not-a-zone': feed } }), env, ctxStub());
  const body = await resp.json();
  assert.deepEqual(body.written, []);
  assert.ok(body.skipped.includes('weather:not-a-zone'));
});

// --- Round-trips: the pushed value must satisfy the real reader with no network ---

test('pushed districts are served by getDistrictStatuses without any fetch', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network used'); });
  const kv = kvStub();
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv };

  await worker.fetch(pushRequest('s3cret', {
    bodies: districtBodies({
      mcps: JSON.stringify({ emsg: '<div>All schools closed today due to snow.</div>' })
    })
  }), env, ctxStub());

  const callsBefore = fetchMock.mock.callCount();
  const districts = await getDistrictStatuses(env);
  assert.equal(fetchMock.mock.callCount(), callsBefore, 'reader must not hit the network');
  assert.equal(districts.length, 6);
  assert.equal(districts.find(d => d.id === 'mcps').status, 'closed');
});

test('pushed news, snowfall and roads are served by their readers without any fetch', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network used'); });
  const kv = kvStub();
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv };

  const pubDate = new Date().toUTCString();
  await worker.fetch(pushRequest('s3cret', {
    bodies: {
      news: `<rss><channel><item><title>All schools closed Tuesday</title><description>Snow.</description><pubDate>${pubDate}</pubDate></item></channel></rss>`,
      snowfall: JSON.stringify({
        properties: { periods: [{ name: 'Tonight', detailedForecast: 'New snow accumulation of 4 to 8 inches possible.' }] }
      }),
      roads: '<Incidents><Incident><county>Howard</county><incidentType>Weather</incidentType>' +
             '<description>Snow covered roadway</description><trafficAlert>true</trafficAlert><closed>false</closed></Incident></Incidents>'
    }
  }), env, ctxStub());

  const callsBefore = fetchMock.mock.callCount();

  const signal = await getNewsSignal(env);
  assert.equal(signal.status, 'closed');

  const lines = await getSnowfallForecast(env);
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /4 to 8 inches/);

  const incidents = await getChartIncidents(env);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].county, 'Howard');

  assert.equal(fetchMock.mock.callCount(), callsBefore, 'no reader may hit the network');
});

test('pushed weather alerts are served by getActiveWeatherAlerts without any fetch', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network used'); });
  const kv = kvStub();
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv };

  await worker.fetch(pushRequest('s3cret', {
    zones: {
      MDC027: JSON.stringify({
        features: [{ properties: { event: 'Ice Storm Warning', status: 'Actual', severity: 'Severe', ends: '2026-01-02T12:00:00Z' } }]
      })
    }
  }), env, ctxStub());

  const callsBefore = fetchMock.mock.callCount();
  const alerts = await getActiveWeatherAlerts(env, 'MDC027');
  assert.equal(fetchMock.mock.callCount(), callsBefore, 'reader must not hit the network');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, 'Ice Storm Warning');
  assert.equal(alerts[0].severity, 'Severe');
});
