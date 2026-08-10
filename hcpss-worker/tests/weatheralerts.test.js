import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSchoolImpactIssuance, isEmergencyAlert, isWeaAlert, summarizeWeatherAlerts, clearWeatherAlertCache } from '../src/weather.js';
import {
  pickNewAlerts, formatIssuanceLines, issuanceEmbedColor, shouldScanThisMinute, SCAN_MINUTE_OFFSET,
  maybeCleanupExpiredAlertNotices, isNoticeCleanupMinute, CLEANUP_MINUTE_OFFSET,
  maybeSendWeatherAlertNotices, splitEmergencyAlerts, buildEmergencyMessage, emergencyActionLine,
  recordNotice
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
  assert.deepEqual(updatedSeen['Winter Storm Warning'].msgs, [{ m: 'm1', c: 'c1' }]);
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
  assert.deepEqual(expired, [{ event: 'Tornado Watch', until: now - 1, msgs: [{ m: 'm1', c: 'c1' }] }]);
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

  const until = now.getTime() - 60_000;
  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'nws_alerts_seen:g1': JSON.stringify({ 'Tornado Watch': { until, msg: 'msg-1', ch: 'chan-1' } })
  });
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok' };

  const result = await maybeCleanupExpiredAlertNotices(env, now);
  assert.equal(result.deleted, 0);
  // Kept (normalized to the list shape) so the next pass retries it.
  assert.deepEqual(JSON.parse(kv.map.get('nws_alerts_seen:g1')), {
    'Tornado Watch': { until, msgs: [{ m: 'msg-1', c: 'chan-1' }] }
  }, 'the message id must not be lost');
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

  // A routine notice, so it is the tier that gets tracked for deletion. Note
  // the severity: Extreme would make this an emergency alert, and those are
  // deliberately never recorded for cleanup (see the emergency tests below).
  const zoneBody = JSON.stringify({
    features: [{
      properties: {
        event: 'Tornado Watch', status: 'Actual', severity: 'Severe',
        ends: '2026-01-07T22:00:00Z'
      }
    }]
  });
  await worker.fetch(pushRequest('s3cret', { zones: { MDC027: zoneBody } }), env, ctx);
  await Promise.all(waited);

  const seen = JSON.parse(kv.map.get('nws_alerts_seen:g1'));
  assert.deepEqual(seen['Tornado Watch'].msgs, [{ m: 'posted-99', c: 'chan-1' }]);
  assert.equal(seen['Tornado Watch'].until, Date.parse('2026-01-07T22:00:00Z'));
});

// --- The emergency tier ---
//
// Fixtures are the real properties NWS published for Howard County (MDC027)
// on 2026-08-10, the afternoon a tornado warning and a destructive-wind severe
// thunderstorm warning both went to phones.

// The 4:10 PM product: 80 mph winds, tagged for phones.
const destructiveTstorm = {
  event: 'Severe Thunderstorm Warning', status: 'Actual', messageType: 'Alert',
  severity: 'Severe', urgency: 'Immediate', certainty: 'Observed',
  ends: '2026-08-10T16:45:00-04:00',
  parameters: {
    windThreat: ['RADAR INDICATED'],
    thunderstormDamageThreat: ['DESTRUCTIVE'],
    BLOCKCHANNEL: ['EAS', 'NWEM'],
    WEAHandling: ['Imminent Threat'],
    CMAMlongtext: ['National Weather Service: SEVERE THUNDERSTORM WARNING in effect for this area until 4:45 PM EDT for DESTRUCTIVE 80 mph winds. Take shelter in a sturdy building, away from windows. Flying debris may be deadly to those caught without shelter.']
  }
};

// The 3:55 PM product: same event name, same end time, no phone alert.
const ordinaryTstorm = {
  event: 'Severe Thunderstorm Warning', status: 'Actual', messageType: 'Alert',
  severity: 'Severe', urgency: 'Immediate', certainty: 'Observed',
  ends: '2026-08-10T16:45:00-04:00',
  parameters: {
    windThreat: ['OBSERVED'],
    thunderstormDamageThreat: ['CONSIDERABLE'],
    BLOCKCHANNEL: ['EAS', 'NWEM', 'CMAS']
  }
};

// The 4:22 PM continuation of the tornado warning: WEAHandling is gone,
// because phones were already alerted at 4:14.
const tornadoContinuation = {
  event: 'Tornado Warning', status: 'Actual', messageType: 'Update',
  severity: 'Extreme', ends: '2026-08-10T16:45:00-04:00',
  parameters: { BLOCKCHANNEL: ['EAS', 'NWEM', 'CMAS'] }
};

test('isWeaAlert matches exactly the products NWS sent to phones', () => {
  assert.ok(isWeaAlert(destructiveTstorm), 'the 80 mph warning alerted every phone in the county');
  assert.ok(!isWeaAlert(ordinaryTstorm), 'CMAS in BLOCKCHANNEL is NWS saying "not for phones"');
  // CONSIDERABLE is the tag one step below the WEA threshold. If this ever
  // starts returning true, half of every summer squall line pings @everyone.
  assert.ok(!isWeaAlert({ parameters: { thunderstormDamageThreat: ['CONSIDERABLE'], BLOCKCHANNEL: ['EAS', 'NWEM', 'CMAS'] } }));
  assert.ok(!isWeaAlert({ parameters: { BLOCKCHANNEL: ['EAS', 'NWEM', 'CMAS'] } }));
  assert.ok(!isWeaAlert({}));
  assert.ok(!isWeaAlert(null));
});

test('isWeaAlert reads the damage tags that outlive WEAHandling', () => {
  // These persist on continuation products, which is what makes an alert first
  // seen mid-life still recognizable as the phone-alerting tier.
  assert.ok(isWeaAlert({ parameters: { tornadoDamageThreat: ['CONSIDERABLE'] } }));
  assert.ok(isWeaAlert({ parameters: { tornadoDamageThreat: ['CATASTROPHIC'] } }));
  assert.ok(isWeaAlert({ parameters: { flashFloodDamageThreat: ['CATASTROPHIC'] } }));
  assert.ok(!isWeaAlert({ parameters: { flashFloodDamageThreat: ['CONSIDERABLE'] } }));
});

test('a WEA-tagged alert is an emergency whatever it is called', () => {
  const [alert] = summarizeWeatherAlerts([{ properties: destructiveTstorm }]);
  assert.equal(alert.wea, true);
  assert.ok(isEmergencyAlert(alert), 'if it went to phones, it pings @everyone');

  // The same event name without the tag stays in the quiet tier.
  const [ordinary] = summarizeWeatherAlerts([{ properties: ordinaryTstorm }]);
  assert.ok(!ordinary.wea);
  assert.ok(!isEmergencyAlert(ordinary));
});

test('a tornado warning first seen mid-life is still an emergency', () => {
  // WEAHandling is absent by 4:22 PM, so name and severity are what carry it.
  const [alert] = summarizeWeatherAlerts([{ properties: tornadoContinuation }]);
  assert.ok(!alert.wea, 'the continuation genuinely is not a WEA product');
  assert.ok(isEmergencyAlert(alert), 'but it is still a live tornado warning');
});

test('the emergency message quotes the text that went to phones', () => {
  const [alert] = summarizeWeatherAlerts([{ properties: destructiveTstorm }]);
  // CMAMlongtext is preferred over the generic instruction block, so the
  // Discord alert reads as the same message someone just got on their phone.
  assert.match(alert.instruction, /^National Weather Service: SEVERE THUNDERSTORM WARNING/);
  const msg = buildEmergencyMessage([alert], { county: 'Howard' });
  assert.match(msg.embeds[0].fields[0].value, /DESTRUCTIVE 80 mph winds/);
  assert.match(msg.content, /@everyone/);
});

test('a WEA product wins over an ordinary one of the same name', () => {
  // Both are active at once, covering different polygons. Whichever sorts
  // first in the feed is not something to bet the ping on.
  for (const order of [[ordinaryTstorm, destructiveTstorm], [destructiveTstorm, ordinaryTstorm]]) {
    const alerts = summarizeWeatherAlerts(order.map(properties => ({ properties })));
    assert.equal(alerts.length, 1, 'still one entry per event name');
    assert.equal(alerts[0].wea, true, 'the phone-alerting product must be the one kept');
  }
});

test('an in-place upgrade to the WEA tier re-announces as an emergency', () => {
  // 2026-08-10: ordinary warnings at 3:55 and 3:57 PM, then the destructive
  // one at 4:10 — same event name, same end time. Plain dedupe swallows it.
  const now = 1_000_000;
  const [ordinary] = summarizeWeatherAlerts([{ properties: ordinaryTstorm }]);
  const [destructive] = summarizeWeatherAlerts([{ properties: destructiveTstorm }]);

  const first = pickNewAlerts([ordinary], {}, now);
  assert.equal(first.newAlerts.length, 1);
  assert.equal(first.updatedSeen['Severe Thunderstorm Warning'].tier, 'r');

  // The routine notice records where it landed.
  recordNotice(first.updatedSeen, first.newAlerts, 'm1', 'c1');
  const seen = first.updatedSeen;
  const second = pickNewAlerts([destructive], seen, now);
  assert.equal(second.newAlerts.length, 1, 'the upgrade must break through the dedupe');
  const entry = second.updatedSeen['Severe Thunderstorm Warning'];
  assert.equal(entry.tier, 'e');
  // The quiet notice is still tracked, so it is still cleaned up later — the
  // emergency post appends to this list rather than replacing it.
  assert.deepEqual(entry.msgs, [{ m: 'm1', c: 'c1' }]);

  // And it escalates exactly once.
  const third = pickNewAlerts([destructive], second.updatedSeen, now);
  assert.equal(third.newAlerts.length, 0);
});

test('an entry written before tiers existed never re-announces', () => {
  // A deploy mid-alert must not re-ping for everything currently active, so
  // "no tier recorded" is unknown, not "routine".
  const now = 1_000_000;
  const [destructive] = summarizeWeatherAlerts([{ properties: destructiveTstorm }]);
  const legacy = { 'Severe Thunderstorm Warning': { until: now + 60_000, msg: 'm1', ch: 'c1' } };
  assert.equal(pickNewAlerts([destructive], legacy, now).newAlerts.length, 0);
});

test('isEmergencyAlert covers the act-now events by name and by Extreme severity', () => {
  // By name, because NWS severity on tornado products is not dependable.
  assert.ok(isEmergencyAlert({ event: 'Tornado Warning', severity: 'Severe' }));
  assert.ok(isEmergencyAlert({ event: 'Extreme Wind Warning', severity: 'Severe' }));
  assert.ok(isEmergencyAlert({ event: 'Civil Emergency Message', severity: 'Unknown' }));
  // By severity: a Flash Flood Emergency arrives as an Extreme-rated Flash
  // Flood Warning, which is the only thing separating it from the routine one.
  assert.ok(isEmergencyAlert({ event: 'Flash Flood Warning', severity: 'Extreme' }));
});

test('isEmergencyAlert leaves the routine storm products alone', () => {
  // These are the ones that would train a server to ignore the ping.
  assert.ok(!isEmergencyAlert({ event: 'Tornado Watch', severity: 'Severe' }));
  assert.ok(!isEmergencyAlert({ event: 'Severe Thunderstorm Warning', severity: 'Severe' }));
  assert.ok(!isEmergencyAlert({ event: 'Flash Flood Warning', severity: 'Severe' }));
  assert.ok(!isEmergencyAlert({ event: 'Winter Storm Warning', severity: 'Severe' }));
  assert.ok(!isEmergencyAlert({ event: 'Heat Advisory', severity: 'Minor' }));
  assert.ok(!isEmergencyAlert(null));
});

test('every emergency alert also passes the school-impact filter', () => {
  // The notice pass only ever sees school-impact alerts, so an emergency that
  // failed this filter would be dropped before anything could announce it.
  // A Hurricane Warning matches neither the winter nor the heat pattern.
  for (const a of [
    { event: 'Tornado Warning', severity: 'Severe' },
    { event: 'Hurricane Warning', severity: 'Severe' },
    { event: 'Civil Emergency Message', severity: 'Unknown' },
    { event: 'Flash Flood Warning', severity: 'Extreme' }
  ]) {
    assert.ok(isEmergencyAlert(a) && isSchoolImpactIssuance(a), `${a.event} must survive both filters`);
  }
});

test('summarizeWeatherAlerts keeps NWS instructions for emergencies only', () => {
  const [emergency] = summarizeWeatherAlerts([{
    properties: {
      event: 'Tornado Warning', status: 'Actual', severity: 'Severe',
      instruction: 'TAKE COVER NOW!  Move to a basement or an\n  interior room.'
    }
  }]);
  assert.equal(emergency.instruction, 'TAKE COVER NOW! Move to a basement or an interior room.');

  // A routine alert must not carry it: this list is cached and read on every
  // embed render, for text only the emergency message displays.
  const [routine] = summarizeWeatherAlerts([{
    properties: {
      event: 'Winter Storm Warning', status: 'Actual', severity: 'Severe',
      instruction: 'Slow down and use caution while traveling.'
    }
  }]);
  assert.ok(!('instruction' in routine));
});

test('emergencyActionLine gives each event something to do in the next minute', () => {
  assert.match(emergencyActionLine('Tornado Warning'), /^TAKE SHELTER NOW/);
  assert.match(emergencyActionLine('Flash Flood Warning'), /^MOVE TO HIGHER GROUND NOW/);
  assert.match(emergencyActionLine('Evacuation Immediate'), /^EVACUATE NOW/);
  assert.match(emergencyActionLine('Some Unmapped Warning'), /TAKE SHELTER NOW/);
  assert.match(emergencyActionLine(''), /TAKE SHELTER NOW/);
});

test('splitEmergencyAlerts separates the loud tier from the routine one', () => {
  const { emergency, routine } = splitEmergencyAlerts([
    { event: 'Winter Weather Advisory', severity: 'Minor' },
    { event: 'Tornado Warning', severity: 'Severe' },
    null
  ]);
  assert.deepEqual(emergency.map(a => a.event), ['Tornado Warning']);
  assert.deepEqual(routine.map(a => a.event), ['Winter Weather Advisory']);
});

test('buildEmergencyMessage pings @everyone and leads with the action', () => {
  const msg = buildEmergencyMessage([{
    event: 'Tornado Warning',
    severity: 'Extreme',
    endsMs: 1750050000000,
    instruction: 'TAKE COVER NOW!'
  }], { county: 'Howard', footer: 'School Status', nowIso: '2026-07-29T20:00:00.000Z' });

  assert.deepEqual(msg.allowed_mentions, { parse: ['everyone'] });
  assert.match(msg.content, /^@everyone\n/);
  // Markdown headings are the only way to make the text physically bigger.
  assert.match(msg.content, /^@everyone\n# 🚨 TORNADO WARNING\n## Howard County — TAKE SHELTER NOW/);
  assert.equal(msg.embeds[0].color, 0xFFD700);
  assert.match(msg.embeds[0].title, /🚨 TORNADO WARNING — Howard County/);
  assert.match(msg.embeds[0].description, /TAKE SHELTER NOW/);
  assert.equal(msg.embeds[0].fields[0].value, 'TAKE COVER NOW!');
  assert.ok(msg.content.length <= 2000);
});

test('buildEmergencyMessage drops the ping but keeps the alert when pings are off', () => {
  const msg = buildEmergencyMessage([{ event: 'Tornado Warning' }], { county: 'Carroll', ping: false });
  assert.deepEqual(msg.allowed_mentions, { parse: [] });
  assert.ok(!msg.content.includes('@everyone'));
  assert.match(msg.content, /# 🚨 TORNADO WARNING/);
  // No NWS instruction text came through, so there is no empty field.
  assert.ok(!msg.embeds[0].fields);
});

test('buildEmergencyMessage folds several emergencies into one banner', () => {
  const msg = buildEmergencyMessage([
    { event: 'Tornado Warning' },
    { event: 'Flash Flood Warning', severity: 'Extreme' }
  ], { county: 'Howard' });
  assert.match(msg.content, /# 🚨 2 EMERGENCY ALERTS/);
  // The first match wins, so the most urgent action leads.
  assert.match(msg.content, /TAKE SHELTER NOW/);
  assert.match(msg.embeds[0].description, /Tornado Warning[\s\S]*Flash Flood Warning/);
});

test('buildEmergencyMessage returns null with nothing to announce', () => {
  assert.equal(buildEmergencyMessage([]), null);
  assert.equal(buildEmergencyMessage(null), null);
  assert.equal(buildEmergencyMessage([{ severity: 'Extreme' }]), null); // no event name
});

// The emergency path's whole reason for existing: quiet hours must not sit on
// a tornado warning, and the notice must not be deleted out from under the
// ping. Both are the opposite of what routine issuance notices do.
function emergencyEnv(kv, extra = {}) {
  return { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok', ...extra };
}

// A cached zone holding one live Tornado Warning, so the scan needs no fetch.
function tornadoZone(kv, now) {
  kv.map.set('weather_alerts_cache', JSON.stringify([{
    event: 'Tornado Warning', severity: 'Extreme', endsMs: now.getTime() + 1_800_000, onsetMs: 0, headline: ''
  }]));
}

test('an emergency alert posts in the middle of the night, when a routine one waits', async (t) => {
  // 2:06 AM ET — deep inside quiet hours, on a scan gate minute.
  const now = new Date(Date.parse('2026-07-29T06:06:00Z'));
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    posts.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 'm-1' }), { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1' }),
    // Cached so the scan needs no live fetch: a Tornado Warning plus a routine
    // advisory, both new.
    weather_alerts_cache: JSON.stringify([
      { event: 'Tornado Warning', severity: 'Extreme', endsMs: now.getTime() + 1_800_000, onsetMs: 0, headline: '' },
      { event: 'Winter Weather Advisory', severity: 'Minor', endsMs: now.getTime() + 36_000_000, onsetMs: 0, headline: '' }
    ])
  });

  const result = await maybeSendWeatherAlertNotices(emergencyEnv(kv), now);
  assert.equal(result.sent, 1, 'only the emergency may post overnight');

  const sentPosts = posts.filter(p => p.url.includes('/channels/chan-1/messages'));
  assert.equal(sentPosts.length, 1);
  assert.match(sentPosts[0].body.content, /@everyone/);
  assert.match(sentPosts[0].body.content, /TORNADO WARNING/);

  // The advisory was held back rather than marked seen, so it still announces
  // at 6 AM instead of being silenced for good.
  const seen = JSON.parse(kv.map.get('nws_alerts_seen:g1'));
  assert.ok(seen['Tornado Warning']);
  assert.ok(!seen['Winter Weather Advisory'], 'a held-back alert must not be marked seen');
});

test('an emergency notice is deleted once its alert ends, like any other', async (t) => {
  const now = new Date(Date.parse('2026-07-29T18:06:00Z')); // 2:06 PM ET
  const deletes = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init && init.method === 'DELETE') deletes.push(String(url));
    return new Response(JSON.stringify({ id: 'm-99' }), { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1' })
  });
  tornadoZone(kv, now);

  await maybeSendWeatherAlertNotices(emergencyEnv(kv), now);
  const seen = JSON.parse(kv.map.get('nws_alerts_seen:g1'));
  assert.deepEqual(seen['Tornado Warning'].msgs, [{ m: 'm-99', c: 'chan-1' }]);

  // A "TAKE SHELTER NOW" banner still at the top of the channel an hour after
  // the tornado passed is its own kind of wrong.
  const later = cleanupNow();
  kv.map.set('nws_alerts_seen:g1', JSON.stringify({
    'Tornado Warning': { until: later.getTime() - 1000, msgs: [{ m: 'm-99', c: 'chan-1' }] }
  }));
  const cleaned = await maybeCleanupExpiredAlertNotices(emergencyEnv(kv), later);
  assert.equal(cleaned.deleted, 1);
  assert.deepEqual(deletes, ['https://discord.com/api/v10/channels/chan-1/messages/m-99']);
  assert.ok(!kv.map.has('nws_alerts_seen:g1'));
});

// The 2026-08-10 leak. pickNewAlerts prunes aged-out entries and reports them
// in `expired`; the cleanup pass acted on that list but the scan ignored it,
// then wrote the pruned map anyway. Any notice that expired between two scans
// lost its message id and was left in the channel with nothing that knew it
// existed — that afternoon's 4:49 PM scan orphaned the tornado warning notice
// that had expired at 4:45, four minutes before cleanup would have taken it.
test('the scan deletes the notices it prunes instead of orphaning them', async (t) => {
  const now = new Date(Date.parse('2026-07-29T18:06:00Z')); // 2:06 PM ET
  const deletes = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init && init.method === 'DELETE') deletes.push(String(url));
    return new Response(JSON.stringify({ id: 'm-new' }), { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1' }),
    // Already announced and already over — exactly the state the scan used to
    // drop on the floor.
    'nws_alerts_seen:g1': JSON.stringify({
      'Tornado Warning': { until: now.getTime() - 60_000, msgs: [{ m: 'stale-1', c: 'chan-1' }] }
    })
  });
  // A brand-new alert, so the scan posts and rewrites the map.
  kv.map.set('weather_alerts_cache', JSON.stringify([
    { event: 'Heat Advisory', severity: 'Minor', endsMs: now.getTime() + 36_000_000, onsetMs: 0, headline: '' }
  ]));

  const result = await maybeSendWeatherAlertNotices(emergencyEnv(kv), now);
  assert.equal(result.deleted, 1, 'the expired notice must come down');
  assert.deepEqual(deletes, ['https://discord.com/api/v10/channels/chan-1/messages/stale-1']);

  const seen = JSON.parse(kv.map.get('nws_alerts_seen:g1'));
  assert.ok(!seen['Tornado Warning'], 'and only then leave the map');
  assert.deepEqual(seen['Heat Advisory'].msgs, [{ m: 'm-new', c: 'chan-1' }]);
});

test('a scan with nothing to announce leaves expired entries for the cleanup pass', async (t) => {
  // The early return must come before the deletion, not after: the cleanup
  // pass is what handles this case, and doing it here too would just add
  // Discord calls to every quiet scan.
  const now = new Date(Date.parse('2026-07-29T18:06:00Z'));
  const deletes = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init && init.method === 'DELETE') deletes.push(String(url));
    return new Response('{}', { status: 200 });
  });

  const stale = JSON.stringify({
    // Over, its notice still up.
    'Tornado Warning': { until: now.getTime() - 60_000, msgs: [{ m: 'stale-1', c: 'chan-1' }] },
    // Still running and already announced, so the scan finds nothing new.
    'Heat Advisory': { until: now.getTime() + 36_000_000, msgs: [{ m: 'live-1', c: 'chan-1' }] }
  });
  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1' }),
    'nws_alerts_seen:g1': stale,
    weather_alerts_cache: JSON.stringify([
      { event: 'Heat Advisory', severity: 'Minor', endsMs: now.getTime() + 36_000_000, onsetMs: 0, headline: '' }
    ])
  });

  await maybeSendWeatherAlertNotices(emergencyEnv(kv), now);
  assert.deepEqual(deletes, []);
  assert.equal(kv.map.get('nws_alerts_seen:g1'), stale, 'the entry survives for the cleanup pass');
});

test('an escalated alert keeps both its messages and deletes both', async (t) => {
  // The quiet notice went out first, then NWS upgraded the same event to the
  // phone tier. Recording only the latest message id would orphan the first.
  const now = new Date(Date.parse('2026-07-29T18:06:00Z'));
  const deletes = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init && init.method === 'DELETE') deletes.push(String(url).split('/messages/')[1]);
    return new Response(JSON.stringify({ id: 'emergency-msg' }), { status: 200 });
  });

  const [destructive] = summarizeWeatherAlerts([{ properties: destructiveTstorm }]);
  const endsMs = now.getTime() + 1_800_000;
  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1' }),
    'nws_alerts_seen:g1': JSON.stringify({
      'Severe Thunderstorm Warning': { until: endsMs, tier: 'r', msgs: [{ m: 'quiet-msg', c: 'chan-1' }] }
    }),
    weather_alerts_cache: JSON.stringify([{ ...destructive, endsMs }])
  });

  await maybeSendWeatherAlertNotices(emergencyEnv(kv), now);
  const seen = JSON.parse(kv.map.get('nws_alerts_seen:g1'));
  assert.deepEqual(seen['Severe Thunderstorm Warning'].msgs, [
    { m: 'quiet-msg', c: 'chan-1' },
    { m: 'emergency-msg', c: 'chan-1' }
  ], 'both posts must stay tracked');

  // When it ends, both come down.
  const later = cleanupNow();
  kv.map.set('nws_alerts_seen:g1', JSON.stringify({
    'Severe Thunderstorm Warning': {
      until: later.getTime() - 1000,
      msgs: [{ m: 'quiet-msg', c: 'chan-1' }, { m: 'emergency-msg', c: 'chan-1' }]
    }
  }));
  const cleaned = await maybeCleanupExpiredAlertNotices(emergencyEnv(kv), later);
  assert.equal(cleaned.deleted, 2);
  assert.deepEqual(deletes.sort(), ['emergency-msg', 'quiet-msg']);
});

test('an emergency alert still posts for a guild that turned routine notices off', async (t) => {
  const now = new Date(Date.parse('2026-07-29T18:06:00Z'));
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    posts.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 'm-1' }), { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1', toggle_nws_alerts: false })
  });
  kv.map.set('weather_alerts_cache', JSON.stringify([
    { event: 'Tornado Warning', severity: 'Extreme', endsMs: now.getTime() + 1_800_000, onsetMs: 0, headline: '' },
    { event: 'Winter Weather Advisory', severity: 'Minor', endsMs: now.getTime() + 36_000_000, onsetMs: 0, headline: '' }
  ]));

  const result = await maybeSendWeatherAlertNotices(emergencyEnv(kv), now);
  assert.equal(result.sent, 1);
  assert.match(posts.find(p => p.url.includes('/messages')).body.content, /TORNADO WARNING/);
});

test('both emergency toggles are honored', async (t) => {
  const now = new Date(Date.parse('2026-07-29T18:06:00Z'));
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    posts.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 'm-1' }), { status: 200 });
  });

  // Ping off: the alert still posts, just without the mention.
  const noPing = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1', toggle_emergency_ping: false })
  });
  tornadoZone(noPing, now);
  await maybeSendWeatherAlertNotices(emergencyEnv(noPing), now);
  const posted = posts.find(p => p.url.includes('/messages'));
  assert.ok(posted, 'the alert must still post with pings disabled');
  assert.ok(!posted.body.content.includes('@everyone'));

  // Feature off: nothing posts at all.
  posts.length = 0;
  const off = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({
      alert_channel_id: 'chan-1', toggle_emergency_alerts: false, toggle_nws_alerts: false
    })
  });
  tornadoZone(off, now);
  const result = await maybeSendWeatherAlertNotices(emergencyEnv(off), now);
  assert.equal(result.sent, 0);
  assert.equal(posts.filter(p => p.url.includes('/messages')).length, 0);
  assert.ok(!off.map.has('nws_alerts_seen:g1'), 'a disabled guild must not be marked seen either');
});

test('a failed emergency post is unmarked so the next scan retries it', async (t) => {
  const now = new Date(Date.parse('2026-07-29T18:06:00Z'));
  let fail = true;
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (fail) return new Response('{}', { status: 500 });
    posts.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 'm-1' }), { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1' })
  });
  tornadoZone(kv, now);

  const failed = await maybeSendWeatherAlertNotices(emergencyEnv(kv), now);
  assert.equal(failed.sent, 0);
  // Mark-before-post is right everywhere else, but here it would trade a
  // duplicate tornado warning for a missing one.
  const seen = JSON.parse(kv.map.get('nws_alerts_seen:g1') || '{}');
  assert.ok(!seen['Tornado Warning'], 'a failed emergency must not stay marked as announced');

  fail = false;
  const retried = await maybeSendWeatherAlertNotices(emergencyEnv(kv), now);
  assert.equal(retried.sent, 1);
  assert.match(posts.find(p => p.url.includes('/messages')).body.content, /@everyone/);
});

test('an emergency and a routine alert in one scan post as separate messages', async (t) => {
  const now = new Date(Date.parse('2026-07-29T18:06:00Z')); // 2:06 PM ET — routine allowed
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    posts.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 'm-routine' }), { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1' })
  });
  kv.map.set('weather_alerts_cache', JSON.stringify([
    { event: 'Tornado Warning', severity: 'Extreme', endsMs: now.getTime() + 1_800_000, onsetMs: 0, headline: '' },
    { event: 'Heat Advisory', severity: 'Minor', endsMs: now.getTime() + 36_000_000, onsetMs: 0, headline: '' }
  ]));

  const result = await maybeSendWeatherAlertNotices(emergencyEnv(kv), now);
  assert.equal(result.sent, 2, 'folding the tornado into the heat advisory is the bug this guards');

  const messages = posts.filter(p => p.url.includes('/channels/chan-1/messages'));
  assert.equal(messages.length, 2);
  assert.match(messages[0].body.content, /@everyone/);
  assert.equal(messages[1].body.content, undefined);
  assert.match(messages[1].body.embeds[0].title, /Heat Advisory/);

  // Both are tracked for deletion, each pointing at its own message.
  const seen = JSON.parse(kv.map.get('nws_alerts_seen:g1'));
  assert.deepEqual(seen['Heat Advisory'].msgs, [{ m: 'm-routine', c: 'chan-1' }]);
  assert.deepEqual(seen['Tornado Warning'].msgs, [{ m: 'm-routine', c: 'chan-1' }]);
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
