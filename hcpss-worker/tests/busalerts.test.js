import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBusAlert, classifyActivityAlert, classifySchoolNotice, isWithinBusAlertHours, maybeSendBusAlerts } from '../src/busalerts.js';

test('classifyBusAlert flags service-impact transportation posts', () => {
  assert.equal(classifyBusAlert('HCPSS Transportation Update: several bus routes suspended Monday'), true);
  assert.equal(classifyBusAlert('Bus 123 delayed 30 minutes due to mechanical issues'), true);
  assert.equal(classifyBusAlert('Superintendent Transportation Update – Several Routes Restored'), true);
  assert.equal(classifyBusAlert('Buses running late systemwide this afternoon'), true);
});

test('classifyBusAlert ignores newsletters and non-transportation posts', () => {
  assert.equal(classifyBusAlert('Transportation Reminders for the Start of the School Year'), false);
  assert.equal(classifyBusAlert('Schools closed today due to snow'), false);
  assert.equal(classifyBusAlert('Board of Education meeting delayed'), false);
  assert.equal(classifyBusAlert(''), false);
  assert.equal(classifyBusAlert(null), false);
});

test('classifyActivityAlert flags after-school/athletics cancellations', () => {
  assert.equal(classifyActivityAlert('All after-school and evening activities are canceled today, January 6'), true);
  assert.equal(classifyActivityAlert('All HCPSS athletic events and practices are canceled this afternoon'), true);
  assert.equal(classifyActivityAlert('Field trips scheduled for today are canceled'), true);
  assert.equal(classifyActivityAlert('Evening activities are postponed due to expected ice'), true);
  assert.equal(classifyActivityAlert('After-school programs called off ahead of the storm'), true);
});

test('classifyActivityAlert ignores schedules and as-planned posts', () => {
  assert.equal(classifyActivityAlert('High school sports schedules announced'), false);
  assert.equal(classifyActivityAlert('Evening activities will continue as scheduled'), false);
  assert.equal(classifyActivityAlert('Athletic boosters meeting Thursday'), false);
  assert.equal(classifyActivityAlert('Schools closed today due to snow'), false);
  assert.equal(classifyActivityAlert(''), false);
  assert.equal(classifyActivityAlert(null), false);
});

test('bus alerts outrank activity alerts for the same post', () => {
  // A post about canceled bus routes is a transportation alert, not an
  // activities one — the scanner checks classifyBusAlert first.
  const text = 'Several bus routes to after-school activities are canceled';
  assert.equal(classifyBusAlert(text), true);
  assert.equal(classifyActivityAlert(text), true);
});

test('classifySchoolNotice flags single-school impacts', () => {
  assert.equal(classifySchoolNotice('Centennial High School closed today due to a water main break'), true);
  assert.equal(classifySchoolNotice('Swansfield Elementary School students dismissed early after power outage'), true);
  assert.equal(classifySchoolNotice('Oakland Mills Middle School will reopen tomorrow'), true);
});

test('classifySchoolNotice ignores district-wide and unrelated posts', () => {
  // District-wide closures belong to the status scraper, not school notices.
  assert.equal(classifySchoolNotice('All HCPSS schools closed today due to snow'), false);
  assert.equal(classifySchoolNotice('HCPSS schools will open two hours late'), false);
  assert.equal(classifySchoolNotice('Ethics panel seeks new members'), false);
  assert.equal(classifySchoolNotice('High school sports schedules announced'), false);
  assert.equal(classifySchoolNotice(''), false);
});

test('isWithinBusAlertHours limits scanning to 5 AM - 10 PM ET', () => {
  assert.equal(isWithinBusAlertHours('5:00'), true);
  assert.equal(isWithinBusAlertHours('14:30'), true);
  assert.equal(isWithinBusAlertHours('21:59'), true);
  assert.equal(isWithinBusAlertHours('22:00'), false);
  assert.equal(isWithinBusAlertHours('4:59'), false);
  assert.equal(isWithinBusAlertHours('0:15'), false);
  assert.equal(isWithinBusAlertHours('garbage'), false);
});

// 10:02 AM ET — inside bus-alert hours and on the scan minute (m % 10 === 2).
const SCAN_TIME = new Date(Date.parse('2026-01-07T15:02:00Z'));

function kvStub(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); }
  };
}

// The watcher used to download news.hcpss.org/feed/ itself on every scan —
// ~102 fetches a day of a feed the Apps Script collector already pushes on
// change. It now classifies the items the push stored, so a scan must not
// touch the network at all.
test('the news watcher classifies pushed items without fetching the feed', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return new Response('{}', { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1' }),
    news_signal_cache: JSON.stringify({
      at: SCAN_TIME.getTime(),
      signal: null,
      feedItems: 3,
      items: [{ text: 'HCPSS Transportation Update: several bus routes suspended today', atMs: SCAN_TIME.getTime() - 60000 }]
    })
  });
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok' };

  const result = await maybeSendBusAlerts(env, SCAN_TIME);
  assert.equal(result.sent, 1);

  assert.ok(
    !calls.some(u => u.includes('news.hcpss.org')),
    `the watcher fetched the feed itself: ${calls.join(', ')}`
  );
  const post = calls.find(u => u.includes('/channels/chan-1/messages'));
  assert.ok(post, `no alert posted; calls: ${calls.join(', ')}`);
  // Marked as posted, so the next scan of the same item stays quiet.
  assert.equal(kv.map.get('bus_alert_last_ms'), String(SCAN_TIME.getTime() - 60000));
});

test('the news watcher stays quiet when the pushed items are unknown', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return new Response('{}', { status: 200 });
  });

  // A cache entry written before items were stored: items is absent, which
  // means "unknown", not "no news" — classifying it as an empty feed would
  // silently stop the watcher rather than fall back.
  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ alert_channel_id: 'chan-1' }),
    news_signal_cache: JSON.stringify({ at: SCAN_TIME.getTime(), signal: null, feedItems: 3 })
  });
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'tok' };

  const result = await maybeSendBusAlerts(env, SCAN_TIME);
  assert.equal(result.sent, 0);
  assert.ok(!calls.some(u => u.includes('/channels/')), 'nothing may be posted from an unknown feed');
});

test('the news watcher skips minutes outside its clock gate', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('a gated-out scan must not read anything');
  });
  const env = { STATUS_KV: kvStub(), DISCORD_BOT_TOKEN: 'tok' };
  // 10:03 AM ET is not a scan minute; 3 AM ET is outside bus-alert hours.
  assert.equal((await maybeSendBusAlerts(env, new Date(Date.parse('2026-01-07T15:03:00Z')))).sent, 0);
  assert.equal((await maybeSendBusAlerts(env, new Date(Date.parse('2026-01-07T08:02:00Z')))).sent, 0);
});
