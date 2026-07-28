import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSchoolImpactIssuance, summarizeWeatherAlerts, clearWeatherAlertCache } from '../src/weather.js';
import {
  pickNewAlerts, formatIssuanceLines, issuanceEmbedColor, shouldScanThisMinute, SCAN_MINUTE_OFFSET,
  maybeCleanupExpiredAlertNotices, isNoticeCleanupMinute, CLEANUP_MINUTE_OFFSET
} from '../src/weatheralerts.js';
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

test('isSchoolImpactIssuance matches convective events at any severity', () => {
  // The event name decides, not the severity: NWS rates most tornado products
  // Extreme but not all, and a Tornado Watch commonly arrives as Severe. This
  // used to make it announce or stay silent depending on that field alone.
  assert.ok(isSchoolImpactIssuance({ event: 'Tornado Watch', severity: 'Severe' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Tornado Watch', severity: 'Moderate' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Tornado Warning', severity: 'Severe' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Severe Thunderstorm Warning', severity: 'Severe' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Severe Thunderstorm Watch', severity: 'Moderate' }));
});

test('isSchoolImpactIssuance includes Extreme severity regardless of event name', () => {
  assert.ok(isSchoolImpactIssuance({ event: 'Tornado Warning', severity: 'Extreme' }));
});

test('isSchoolImpactIssuance excludes non-alert products and unrelated events', () => {
  assert.ok(!isSchoolImpactIssuance({ event: 'Flood Advisory', severity: 'Minor' }));
  assert.ok(!isSchoolImpactIssuance({ event: 'Special Weather Statement', severity: 'Moderate' }));
  assert.ok(!isSchoolImpactIssuance({ event: 'Winter Outlook', severity: 'Minor' })); // no watch/warning/advisory level
  // Convective matching is scoped to watch/warning: NWS issues no advisory at
  // that tier, and an outlook is not an alert.
  assert.ok(!isSchoolImpactIssuance({ event: 'Severe Thunderstorm Outlook', severity: 'Minor' }));
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
  assert.equal(updatedSeen['Winter Storm Warning'].until, ends);
});

test('pickNewAlerts stays quiet for already-seen events and prunes expired ones', () => {
  const now = 1_000_000;
  const seen = {
    'Winter Storm Warning': { until: now + 1000 }, // still active — skip
    'Old Advisory': { until: now - 1000 } // expired — pruned
  };
  const { newAlerts, updatedSeen } = pickNewAlerts(
    [{ event: 'Winter Storm Warning', endsMs: now + 5000 }],
    seen,
    now
  );
  assert.equal(newAlerts.length, 0);
  assert.ok(!('Old Advisory' in updatedSeen));
});

test('pickNewAlerts carries a later end time forward when NWS extends an alert', () => {
  // NWS routinely extends an alert rather than reissuing it. The notice must
  // not be deleted at the original end time while the alert is still running,
  // and the extension must not re-announce.
  const now = 1_000_000;
  const seen = { 'Winter Storm Warning': { until: now + 1000, msg: 'm1', ch: 'c1' } };
  const { newAlerts, updatedSeen } = pickNewAlerts(
    [{ event: 'Winter Storm Warning', endsMs: now + 90_000 }],
    seen,
    now
  );
  assert.equal(newAlerts.length, 0, 'an extension is not a new alert');
  assert.equal(updatedSeen['Winter Storm Warning'].until, now + 90_000);
  // The posted message is still tracked, so it can be deleted at the new time.
  assert.equal(updatedSeen['Winter Storm Warning'].msg, 'm1');
  assert.equal(updatedSeen['Winter Storm Warning'].ch, 'c1');
});

test('pickNewAlerts reports expired entries that still have a notice to delete', () => {
  const now = 1_000_000;
  const seen = {
    'Tornado Watch': { until: now - 1, msg: 'm1', ch: 'c1' }, // over — delete
    'Winter Storm Warning': { until: now + 5000, msg: 'm2', ch: 'c1' }, // live — keep
    'Ancient Advisory': { until: now - 5000 } // over, but predates id tracking
  };
  // An empty alert list is the cleanup pass's "what aged out?" query.
  const { expired, updatedSeen } = pickNewAlerts([], seen, now);
  assert.deepEqual(expired, [{ event: 'Tornado Watch', msg: 'm1', ch: 'c1' }]);
  assert.deepEqual(Object.keys(updatedSeen), ['Winter Storm Warning']);
});

test('pickNewAlerts still dedupes against entries written before id tracking', () => {
  // Legacy shape: a bare expiry number with no message to delete.
  const now = 1_000_000;
  const { newAlerts, updatedSeen, expired } = pickNewAlerts(
    [{ event: 'Winter Storm Warning', endsMs: now + 5000 }],
    { 'Winter Storm Warning': now + 1000 },
    now
  );
  assert.equal(newAlerts.length, 0, 'a legacy entry must still suppress a repost');
  assert.equal(updatedSeen['Winter Storm Warning'].until, now + 5000);
  assert.deepEqual(expired, []);
});

test('pickNewAlerts falls back to 24h when the alert has no end time', () => {
  const now = 1_000_000;
  const { updatedSeen } = pickNewAlerts([{ event: 'Winter Storm Watch', endsMs: 0 }], {}, now);
  assert.equal(updatedSeen['Winter Storm Watch'].until, now + 24 * 60 * 60 * 1000);
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

// --- Deleting a notice once its alert is over ---

// A cleanup-gate minute. Deliberately at 2 AM UTC (9 PM ET) so these also
// prove cleanup ignores the posting quiet hours: an alert ending late at night
// must still get its notice removed.
function cleanupNow(minuteOffset = 0) {
  const d = new Date(Date.parse('2026-07-29T02:00:00Z'));
  d.setUTCMinutes(CLEANUP_MINUTE_OFFSET + minuteOffset);
  return d;
}

test('isNoticeCleanupMinute gates to one minute every quarter hour', () => {
  assert.ok(isNoticeCleanupMinute(CLEANUP_MINUTE_OFFSET));
  assert.ok(isNoticeCleanupMinute(CLEANUP_MINUTE_OFFSET + 15));
  assert.ok(isNoticeCleanupMinute(CLEANUP_MINUTE_OFFSET + 45));
  assert.ok(!isNoticeCleanupMinute(CLEANUP_MINUTE_OFFSET + 1));
  assert.ok(!isNoticeCleanupMinute(CLEANUP_MINUTE_OFFSET + 7));
});

test('an expired notice is deleted and its entry dropped', async (t) => {
  const now = cleanupNow();
  const deletes = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init && init.method === 'DELETE') deletes.push(String(url));
    return new Response('{}', { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'nws_alerts_seen:g1': JSON.stringify({
      'Tornado Watch': { until: now.getTime() - 60_000, msg: 'msg-1', ch: 'chan-1' }
    })
  });
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok' };

  const result = await maybeCleanupExpiredAlertNotices(env, now);
  assert.equal(result.deleted, 1);
  assert.deepEqual(deletes, ['https://discord.com/api/v10/channels/chan-1/messages/msg-1']);
  // Nothing left to track, so the key goes away entirely.
  assert.ok(!kv.map.has('nws_alerts_seen:g1'));
});

test('a still-active alert keeps its notice', async (t) => {
  const now = cleanupNow();
  const deletes = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init && init.method === 'DELETE') deletes.push(String(url));
    return new Response('{}', { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'nws_alerts_seen:g1': JSON.stringify({
      'Tornado Watch': { until: now.getTime() + 3_600_000, msg: 'msg-1', ch: 'chan-1' }
    })
  });
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok' };

  const result = await maybeCleanupExpiredAlertNotices(env, now);
  assert.equal(result.deleted, 0);
  assert.deepEqual(deletes, []);
  assert.ok(kv.map.has('nws_alerts_seen:g1'), 'a live alert must keep its entry');
});

test('a notice covering several alerts survives until the last one ends', async (t) => {
  const now = cleanupNow();
  const deletes = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init && init.method === 'DELETE') deletes.push(String(url));
    return new Response('{}', { status: 200 });
  });

  // One message announced both; the watch is over but the warning runs to 6 AM.
  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'nws_alerts_seen:g1': JSON.stringify({
      'Tornado Watch': { until: now.getTime() - 60_000, msg: 'msg-1', ch: 'chan-1' },
      'Winter Storm Warning': { until: now.getTime() + 3_600_000, msg: 'msg-1', ch: 'chan-1' }
    })
  });
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok' };

  const result = await maybeCleanupExpiredAlertNotices(env, now);
  assert.equal(result.deleted, 0, 'deleting now would take the live warning with it');
  assert.deepEqual(deletes, []);
});

test('an already-deleted notice (404) is treated as cleaned up', async (t) => {
  const now = cleanupNow();
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 404 }));

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'nws_alerts_seen:g1': JSON.stringify({
      'Tornado Watch': { until: now.getTime() - 60_000, msg: 'msg-1', ch: 'chan-1' }
    })
  });
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok' };

  const result = await maybeCleanupExpiredAlertNotices(env, now);
  assert.equal(result.deleted, 1);
  assert.ok(!kv.map.has('nws_alerts_seen:g1'), 'a message already gone must not be retried forever');
});

test('a failed delete keeps the entry so the next pass retries', async (t) => {
  const now = cleanupNow();
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 500 }));

  const seen = JSON.stringify({
    'Tornado Watch': { until: now.getTime() - 60_000, msg: 'msg-1', ch: 'chan-1' }
  });
  const kv = kvStub({ guild_index: JSON.stringify(['g1']), 'nws_alerts_seen:g1': seen });
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok' };

  const result = await maybeCleanupExpiredAlertNotices(env, now);
  assert.equal(result.deleted, 0);
  assert.equal(kv.map.get('nws_alerts_seen:g1'), seen, 'the message id must not be lost');
});

test('off-gate minutes do no work at all', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('an off-gate cleanup must not touch Discord');
  });
  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'nws_alerts_seen:g1': JSON.stringify({
      'Tornado Watch': { until: 1, msg: 'msg-1', ch: 'chan-1' }
    })
  });
  const reads = [];
  const origGet = kv.get.bind(kv);
  kv.get = async (key) => { reads.push(key); return origGet(key); };

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok' };
  const result = await maybeCleanupExpiredAlertNotices(env, cleanupNow(1));
  assert.equal(result.deleted, 0);
  assert.equal(reads.length, 0, 'the clock gate must come before any KV read');
});

test('a posted notice records where it landed so it can be deleted later', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-07T15:00:00Z') });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('/messages') && init && init.method === 'POST') {
      return new Response(JSON.stringify({ id: 'posted-99' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1' })
  });
  const waited = [];
  const ctx = { waitUntil(p) { waited.push(Promise.resolve(p).catch(() => {})); } };
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok' };

  // Severity Extreme is what carries a Tornado Watch past
  // isSchoolImpactIssuance — the event classifier itself only covers winter
  // and heat events, so a Severe-rated tornado watch never posts at all.
  const zoneBody = JSON.stringify({
    features: [{
      properties: {
        event: 'Tornado Watch', status: 'Actual', severity: 'Extreme',
        ends: '2026-01-07T22:00:00Z'
      }
    }]
  });
  await worker.fetch(pushRequest('s3cret', { zones: { MDC027: zoneBody } }), env, ctx);
  await Promise.all(waited);

  const seen = JSON.parse(kv.map.get('nws_alerts_seen:g1'));
  assert.equal(seen['Tornado Watch'].msg, 'posted-99');
  assert.equal(seen['Tornado Watch'].ch, 'chan-1');
  assert.equal(seen['Tornado Watch'].until, Date.parse('2026-01-07T22:00:00Z'));
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
