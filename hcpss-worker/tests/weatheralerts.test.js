import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSchoolImpactIssuance, summarizeWeatherAlerts, clearWeatherAlertCache } from '../src/weather.js';
import { pickNewAlerts, formatIssuanceLines, issuanceEmbedColor, shouldScanThisMinute, SCAN_MINUTE_OFFSET } from '../src/weatheralerts.js';
import worker from '../src/index.js';

test('isSchoolImpactIssuance matches winter and heat watch/warning/advisory events', () => {
  assert.ok(isSchoolImpactIssuance({ event: 'Winter Storm Warning', severity: 'Severe' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Winter Storm Watch', severity: 'Moderate' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Winter Weather Advisory', severity: 'Minor' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Ice Storm Warning', severity: 'Severe' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Wind Chill Advisory', severity: 'Minor' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Heat Advisory', severity: 'Minor' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Excessive Heat Warning', severity: 'Severe' }));
});

test('isSchoolImpactIssuance includes Extreme severity regardless of event name', () => {
  assert.ok(isSchoolImpactIssuance({ event: 'Tornado Warning', severity: 'Extreme' }));
});

test('isSchoolImpactIssuance excludes summer noise and non-alert products', () => {
  assert.ok(!isSchoolImpactIssuance({ event: 'Severe Thunderstorm Warning', severity: 'Severe' }));
  assert.ok(!isSchoolImpactIssuance({ event: 'Flood Advisory', severity: 'Minor' }));
  assert.ok(!isSchoolImpactIssuance({ event: 'Special Weather Statement', severity: 'Moderate' }));
  assert.ok(!isSchoolImpactIssuance({ event: 'Winter Outlook', severity: 'Minor' })); // no watch/warning/advisory level
  assert.ok(!isSchoolImpactIssuance(null));
});

test('summarizeWeatherAlerts carries onset and headline for issuance notices', () => {
  const alerts = summarizeWeatherAlerts([{
    properties: {
      event: 'Winter Storm Warning',
      severity: 'Severe',
      status: 'Actual',
      onset: '2026-01-15T21:00:00Z',
      ends: '2026-01-16T15:00:00Z',
      headline: 'Winter Storm Warning issued January 15 at 1:02PM EST until January 16 at 10:00AM EST'
    }
  }]);
  assert.equal(alerts[0].onsetMs, Date.parse('2026-01-15T21:00:00Z'));
  assert.match(alerts[0].headline, /^Winter Storm Warning issued/);
});

test('pickNewAlerts announces unseen events and marks them until their end time', () => {
  const now = 1_000_000;
  const ends = now + 3_600_000;
  const { newAlerts, updatedSeen } = pickNewAlerts(
    [{ event: 'Winter Storm Warning', endsMs: ends }],
    {},
    now
  );
  assert.equal(newAlerts.length, 1);
  assert.equal(updatedSeen['Winter Storm Warning'], ends);
});

test('pickNewAlerts stays quiet for already-seen events and prunes expired ones', () => {
  const now = 1_000_000;
  const seen = {
    'Winter Storm Warning': now + 1000, // still active — skip
    'Old Advisory': now - 1000 // expired — pruned
  };
  const { newAlerts, updatedSeen } = pickNewAlerts(
    [{ event: 'Winter Storm Warning', endsMs: now + 5000 }],
    seen,
    now
  );
  assert.equal(newAlerts.length, 0);
  assert.ok(!('Old Advisory' in updatedSeen));
  assert.equal(updatedSeen['Winter Storm Warning'], now + 1000);
});

test('pickNewAlerts falls back to 24h when the alert has no end time', () => {
  const now = 1_000_000;
  const { updatedSeen } = pickNewAlerts([{ event: 'Winter Storm Watch', endsMs: 0 }], {}, now);
  assert.equal(updatedSeen['Winter Storm Watch'], now + 24 * 60 * 60 * 1000);
});

test('formatIssuanceLines renders window and headline', () => {
  const out = formatIssuanceLines([{
    event: 'Winter Storm Warning',
    onsetMs: 1750000000000,
    endsMs: 1750050000000,
    headline: 'Heavy snow expected'
  }]);
  assert.match(out, /\*\*Winter Storm Warning\*\* from <t:1750000000:f> until <t:1750050000:f>/);
  assert.match(out, /> Heavy snow expected/);
});

test('issuanceEmbedColor escalates with severity', () => {
  assert.equal(issuanceEmbedColor([{ severity: 'Minor' }]), 0xF1C40F);
  assert.equal(issuanceEmbedColor([{ severity: 'Severe' }]), 0xE67E22);
  assert.equal(issuanceEmbedColor([{ severity: 'Severe' }, { severity: 'Extreme' }]), 0xE74C3C);
});

test('shouldScanThisMinute polls every 10 minutes without the push hook', () => {
  assert.ok(shouldScanThisMinute(SCAN_MINUTE_OFFSET, false));
  assert.ok(shouldScanThisMinute(SCAN_MINUTE_OFFSET + 10, false));
  assert.ok(shouldScanThisMinute(SCAN_MINUTE_OFFSET + 50, false));
  assert.ok(!shouldScanThisMinute(SCAN_MINUTE_OFFSET + 1, false));
});

test('shouldScanThisMinute drops to hourly when the push hook is configured', () => {
  assert.ok(shouldScanThisMinute(SCAN_MINUTE_OFFSET, true));
  assert.ok(!shouldScanThisMinute(SCAN_MINUTE_OFFSET + 10, true));
  assert.ok(!shouldScanThisMinute(SCAN_MINUTE_OFFSET + 30, true));
});

function kvStub(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); }
  };
}

function hookRequest(token, body) {
  return new Request('https://worker.example/nws-hook', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {},
    body: JSON.stringify(body)
  });
}

test('/nws-hook rejects when the secret is missing or wrong', async () => {
  const ctx = { waitUntil() {} };
  const disabled = await worker.fetch(hookRequest('anything', { zone: 'MDC027' }), { STATUS_KV: kvStub() }, ctx);
  assert.equal(disabled.status, 403);

  const env = { NWS_HOOK_SECRET: 'right', STATUS_KV: kvStub() };
  const wrong = await worker.fetch(hookRequest('wrong', { zone: 'MDC027' }), env, ctx);
  assert.equal(wrong.status, 403);
});

test('/nws-hook validates the zone and clears its alert cache', async (t) => {
  // The hook's background passes may refetch the cleared zone — keep them offline.
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ features: [] }), { status: 200 }));
  const kv = kvStub({
    weather_alerts_cache: '[]',
    'weather_alerts_cache:MDC031': '[]'
  });
  const waited = [];
  const ctx = { waitUntil(p) { waited.push(Promise.resolve(p).catch(() => {})); } };
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv };

  const bad = await worker.fetch(hookRequest('s3cret', { zone: 'not-a-zone' }), env, ctx);
  assert.equal(bad.status, 400);

  const defaultZone = await worker.fetch(hookRequest('s3cret', { zone: 'mdc027' }), env, ctx);
  assert.equal(defaultZone.status, 200);
  assert.deepEqual(await defaultZone.json(), { ok: true, zone: 'MDC027' });
  assert.ok(!kv.map.has('weather_alerts_cache'), 'default zone cache cleared');

  const districtZone = await worker.fetch(hookRequest('s3cret', { zone: 'MDC031' }), env, ctx);
  assert.equal(districtZone.status, 200);
  assert.ok(!kv.map.has('weather_alerts_cache:MDC031'), 'district zone cache cleared');

  // The forced scan runs in waitUntil; with an empty guild index it must
  // finish without touching the network.
  await Promise.all(waited);
});

// The regression this guards: shouldScanThisMinute drops the cron scan to once
// an hour whenever NWS_HOOK_SECRET is set, because the push path is supposed to
// force a scan the instant a zone's alerts move. /nws-hook did; /push-data
// didn't when the collector moved to it, so a pushed warning sat in KV
// unannounced for up to 59 minutes while showing up immediately on any manual
// check. If the forced scan is ever dropped again, this fails.
function pushRequest(token, body) {
  return new Request('https://worker.example/push-data', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('/push-data announces a pushed NWS alert instead of waiting for the hourly scan', async (t) => {
  // 10:00 AM ET — inside the 6 AM-10 PM posting window, so the run is not
  // silently skipped by quiet hours on whatever clock CI happens to have.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-07T15:00:00Z') });

  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    posts.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return new Response('{}', { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1' })
  });
  const waited = [];
  const ctx = { waitUntil(p) { waited.push(Promise.resolve(p).catch(() => {})); } };
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok' };

  const zoneBody = JSON.stringify({
    features: [{
      properties: {
        event: 'Winter Storm Warning',
        status: 'Actual',
        severity: 'Severe',
        ends: '2026-01-08T12:00:00Z'
      }
    }]
  });

  const resp = await worker.fetch(pushRequest('s3cret', { zones: { MDC027: zoneBody } }), env, ctx);
  assert.equal(resp.status, 200);
  assert.deepEqual((await resp.json()).written, ['weather:MDC027']);

  await Promise.all(waited);

  const announcement = posts.find(p => p.url.includes('/channels/chan-1/messages'));
  assert.ok(announcement, `no issuance notice posted; calls: ${posts.map(p => p.url).join(', ')}`);
  assert.match(announcement.body.embeds[0].title, /Winter Storm Warning/);
  // Marked as seen, so a re-push of the same alert stays quiet.
  assert.ok(kv.map.has('nws_alerts_seen:g1'));
});

test('/push-data does not run the issuance scan when no weather zone changed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-07T15:00:00Z') });
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1' })
  });
  const waited = [];
  const ctx = { waitUntil(p) { waited.push(Promise.resolve(p).catch(() => {})); } };
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok' };

  const roads = '<Incidents></Incidents>';
  const resp = await worker.fetch(pushRequest('s3cret', { bodies: { roads } }), env, ctx);
  assert.equal(resp.status, 200);
  await Promise.all(waited);

  assert.ok(!kv.map.has('nws_alerts_seen:g1'), 'a roads-only push must not sweep guilds for alerts');
});

test('/status-hook requires the shared secret and acks a valid ping', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ features: [] }), { status: 200 }));
  const waited = [];
  const ctx = { waitUntil(p) { waited.push(Promise.resolve(p).catch(() => {})); } };
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kvStub() };
  const req = (token) => new Request('https://worker.example/status-hook', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: '{}'
  });

  assert.equal((await worker.fetch(req('wrong'), env, ctx)).status, 403);
  assert.equal((await worker.fetch(req(null), env, ctx)).status, 403);

  const ok = await worker.fetch(req('s3cret'), env, ctx);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  // The change-only check runs in waitUntil; with no guilds registered it
  // must finish without touching the network.
  await Promise.all(waited);
});

test('/refresh-hook acks but touches nothing when no alert is active', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ features: [] }), { status: 200 }));
  const kv = kvStub({
    bge_outage_cache: 'x',
    pepco_outage_cache: 'x',
    pe_outage_cache: 'x'
  });
  const waited = [];
  const ctx = { waitUntil(p) { waited.push(Promise.resolve(p).catch(() => {})); } };
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv };
  const req = (token) => new Request('https://worker.example/refresh-hook', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: '{}'
  });

  assert.equal((await worker.fetch(req('wrong'), env, ctx)).status, 403);

  const ok = await worker.fetch(req('s3cret'), env, ctx);
  assert.equal(ok.status, 200);
  await Promise.all(waited);
  // Quiet day (no cached alerts): the refresh skips entirely — caches stay.
  assert.ok(kv.map.has('bge_outage_cache'));
  assert.ok(kv.map.has('pepco_outage_cache'));
  assert.ok(kv.map.has('pe_outage_cache'));
});

test('clearWeatherAlertCache never throws without KV', async () => {
  await clearWeatherAlertCache(null, 'MDC027');
  await clearWeatherAlertCache({}, 'MDC031');
});
