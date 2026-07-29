import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeRefreshStormEmbeds } from '../src/stormrefresh.js';

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); },
    async list({ prefix }) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
      return { keys, list_complete: true };
    }
  };
}

const STORM_ALERT = [{ event: 'Winter Storm Warning', severity: 'Severe', endsMs: 0 }];

// The refresh only runs on :00/:15/:30/:45 minutes — pin a gate-passing time.
const GATE_NOW = new Date('2026-01-15T12:00:00Z');

function seedGuild(store, gid, { tracked = true } = {}) {
  store.set(`config:${gid}`, JSON.stringify({ alert_channel_id: `chan-${gid}` }));
  if (tracked) {
    store.set(`last_message_id:${gid}`, `msg-${gid}`);
    store.set(`last_channel_id:${gid}`, `chan-${gid}`);
  }
}

function seedCommon(store, { storm = true } = {}) {
  store.set('weather_alerts_cache', JSON.stringify(storm ? STORM_ALERT : []));
  // Fresh last-good scrape so the refresh never hits the status page.
  store.set('last_good_scrape', JSON.stringify({
    at: Date.now(),
    cards: [{ date: 'July 18, 2026', title: 'Normal Operations', body: 'All schools open on time.' }]
  }));
}

function mockFetch(t, patches) {
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PATCH') {
      patches.push(String(url));
      return new Response('{}', { status: 200 });
    }
    // Districts/outages/roads/snowfall probes — all parsers tolerate junk.
    return new Response('{}', { status: 200 });
  });
}

test('storm refresh PATCHes tracked messages and dedupes its 15-minute slot', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store);
  seedGuild(kv.store, 'g1');
  seedGuild(kv.store, 'g2', { tracked: false }); // no posted message yet
  kv.store.set('guild_index', JSON.stringify(['g1', 'g2']));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const first = await maybeRefreshStormEmbeds(env, GATE_NOW);
  assert.equal(first.updated, 1);
  assert.equal(patches.length, 1);
  assert.match(patches[0], /channels\/chan-g1\/messages\/msg-g1$/);
  assert.ok(kv.store.has('last_storm_refresh_slot'));

  // Same 15-minute slot: no second refresh.
  const second = await maybeRefreshStormEmbeds(env, GATE_NOW);
  assert.equal(second.updated, 0);
  assert.equal(patches.length, 1);
});

test('no storm alert means no refresh and no slot claim', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store, { storm: false });
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, GATE_NOW);
  assert.equal(result.updated, 0);
  assert.equal(patches.length, 0);
  assert.equal(kv.store.has('last_storm_refresh_slot'), false);
});

test('advisory-level winter alerts with nobody without power do not trigger the refresh', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store);
  kv.store.set('weather_alerts_cache', JSON.stringify([
    { event: 'Winter Weather Advisory', severity: 'Minor', endsMs: 0 },
    { event: 'Wind Chill Advisory', severity: 'Moderate', endsMs: 0 }
  ]));
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, GATE_NOW);
  assert.equal(result.updated, 0);
  assert.equal(patches.length, 0);
  assert.equal(kv.store.has('last_storm_refresh_slot'), false);
});

test('a power threat in a primary district\'s own zone triggers the refresh', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store, { storm: false }); // Howard zone is quiet
  seedGuild(kv.store, 'g1');
  kv.store.set('config:g1', JSON.stringify({ alert_channel_id: 'chan-g1', primary_district: 'fcps' }));
  kv.store.set('guild_index', JSON.stringify(['g1']));
  // Frederick's zone cache has a warning-level power threat.
  kv.store.set('weather_alerts_cache:MDC021', JSON.stringify([
    { event: 'Ice Storm Warning', severity: 'Severe', endsMs: 0 }
  ]));
  // District guild payloads read the district status cache, not the scraper.
  kv.store.set('district_status_cache', JSON.stringify({
    at: Date.now(),
    districts: [{ id: 'fcps', name: 'Frederick Co.', status: 'none', detail: '' }]
  }));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, GATE_NOW);
  assert.equal(result.updated, 1);
  assert.match(patches[0], /channels\/chan-g1\/messages\/msg-g1$/);
});

test('off-gate minutes bail before any KV reads or writes', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store);
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);

  const reads = [];
  const origGet = kv.get.bind(kv);
  kv.get = async (key) => { reads.push(key); return origGet(key); };

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  // 12:07 is not a :00/:15/:30/:45 minute — the whole run is skipped even
  // though a storm alert is active.
  const result = await maybeRefreshStormEmbeds(env, new Date('2026-01-15T12:07:00Z'));
  assert.equal(result.updated, 0);
  assert.equal(patches.length, 0);
  assert.equal(reads.length, 0);
  assert.equal(kv.store.has('last_storm_refresh_slot'), false);
});

test('forced refresh skips the minute gate and dedupes on a 5-minute bucket', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store);
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  // 12:07 is off-gate for the cron, but a push-hook force runs anyway.
  const offGate = new Date('2026-01-15T12:07:00Z');
  const first = await maybeRefreshStormEmbeds(env, offGate, { force: true });
  assert.equal(first.updated, 1);
  assert.equal(patches.length, 1);

  // Another ping in the same 5-minute bucket: deduped.
  const second = await maybeRefreshStormEmbeds(env, new Date('2026-01-15T12:08:00Z'), { force: true });
  assert.equal(second.updated, 0);
  assert.equal(patches.length, 1);

  // Next 5-minute bucket: refreshes again.
  const third = await maybeRefreshStormEmbeds(env, new Date('2026-01-15T12:12:00Z'), { force: true });
  assert.equal(third.updated, 1);
  assert.equal(patches.length, 2);
});

test('forced refresh without a power threat (and no recent refresh) is skipped', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store, { storm: false });
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, new Date('2026-01-15T12:07:00Z'), { force: true });
  assert.equal(result.updated, 0);
  assert.equal(patches.length, 0);
  assert.equal(kv.store.has('last_storm_refresh_slot'), false);
});

test('a quiet heat advisory does not qualify a forced refresh', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store);
  // A heat advisory is a storm alert by event name but not a power threat,
  // and with nobody without power there is nothing for a refresh to update.
  // This is the July failure mode that used to burn the KV write budget, and
  // the outage floor is what still holds it shut now that the gate opens for
  // advisory-level alerts.
  kv.store.set('weather_alerts_cache', JSON.stringify([
    { event: 'Heat Advisory', severity: 'Moderate', endsMs: 0 }
  ]));
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, new Date('2026-01-15T12:07:00Z'), { force: true });
  assert.equal(result.updated, 0);
  assert.equal(patches.length, 0);
});

test('forced refresh still runs within an hour of the last one (expiry clears the embed)', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store, { storm: false }); // alert just expired — cache empty
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));
  const now = new Date('2026-01-15T12:07:00Z');
  // The last refresh ran 10 minutes ago (a forced 5-minute bucket).
  const tenAgo = now.getTime() - 10 * 60 * 1000;
  kv.store.set('last_storm_refresh_slot', `f${Math.floor(tenAgo / (5 * 60 * 1000))}`);

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, now, { force: true });
  assert.equal(result.updated, 1);
  assert.match(patches[0], /channels\/chan-g1\/messages\/msg-g1$/);
});

test('the trailing window closes: an hours-old slot no longer opens the gate', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store, { storm: false });
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));
  const now = new Date('2026-01-15T12:07:00Z');
  const threeHoursAgo = now.getTime() - 3 * 60 * 60 * 1000;
  kv.store.set('last_storm_refresh_slot', `f${Math.floor(threeHoursAgo / (5 * 60 * 1000))}`);

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, now, { force: true });
  assert.equal(result.updated, 0);
  assert.equal(patches.length, 0);
});

// The regression that made this module the top KV writer on the account: the
// trailing window was measured from the last refresh, and every trailing
// refresh rewrote the slot, so each one re-armed the window it was supposed to
// be running out. One storm kept the cascade firing on every push forever.
test('the trailing window runs out under a steady push stream after the storm ends', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store); // storm active for the first refresh
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };

  const start = new Date('2026-01-15T12:00:00Z').getTime();
  const armed = await maybeRefreshStormEmbeds(env, new Date(start), { force: true });
  assert.equal(armed.updated, 1, 'the storm itself warrants a refresh');

  // Storm over. The collector keeps pushing roads/news/outages every 5 minutes
  // all day, as it does on any quiet day.
  kv.store.set('weather_alerts_cache', JSON.stringify([]));
  const during = [];
  for (let i = 1; i <= 24; i++) {
    const r = await maybeRefreshStormEmbeds(env, new Date(start + i * 5 * 60 * 1000), { force: true });
    during.push(r.updated);
  }

  // The first hour of pushes still refreshes (that tail is deliberate — it
  // clears the embed's storm sections). After that it must stop, and stay
  // stopped no matter how many more pushes arrive.
  assert.equal(during.slice(0, 12).every(n => n === 1), true, 'one-hour tail still refreshes');
  assert.equal(during.slice(12).every(n => n === 0), true, 'tail closes and stays closed');
  assert.equal(patches.length, 13, 'the storm refresh plus exactly one hour of tail');
});

test('a quiet-day forced refresh leaves the flagged data caches alone', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store, { storm: false });
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));
  kv.store.set('bge_outage_cache', 'x');
  kv.store.set('chart_incidents_cache', 'x');

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, new Date('2026-01-15T12:07:00Z'), {
    force: true, refreshContextCaches: true
  });
  assert.equal(result.updated, 0);
  assert.equal(patches.length, 0);
  // Skipped runs must not churn the data caches either.
  assert.ok(kv.store.has('bge_outage_cache'));
  assert.ok(kv.store.has('chart_incidents_cache'));
});

test('forced refresh with a cached power threat clears flagged context caches', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store); // Winter Storm Warning — a power threat
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));
  kv.store.set('bge_outage_cache', 'x');
  kv.store.set('chart_incidents_cache', 'x');

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, new Date('2026-01-15T12:07:00Z'), {
    force: true, refreshContextCaches: true
  });
  assert.equal(result.updated, 1);
  assert.equal(patches.length, 1);
  // The stale caches were dropped; the rebuild re-fetched and re-cached, so
  // the old values must be gone.
  assert.notEqual(kv.store.get('bge_outage_cache'), 'x', 'outage cache replaced by a live fetch');
  assert.notEqual(kv.store.get('chart_incidents_cache'), 'x', 'roads cache replaced by a live fetch');
});

test('cron refresh still requires an active power threat', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store, { storm: false });
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, GATE_NOW);
  assert.equal(result.updated, 0);
  assert.equal(patches.length, 0);
});

// The gap these cover: the embed renders its live storm sections under
// hasStormAlert (advisories and watches included), but this module used to
// refresh only under hasPowerThreatAlert (warning-level only). Under a Winter
// Weather Advisory the embed therefore showed an outage line that nothing ever
// updated — frozen at the number from when the post went out, while a manual
// check showed the real one.
function seedOutages(store, out) {
  store.set('bge_outage_cache', JSON.stringify({
    at: Date.now(),
    summary: { stormMode: true, counties: { Howard: { out, served: 130377 } } }
  }));
}

test('an advisory with real outages now refreshes the embed', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store);
  kv.store.set('weather_alerts_cache', JSON.stringify([
    { event: 'Winter Weather Advisory', severity: 'Minor', endsMs: 0 }
  ]));
  seedOutages(kv.store, 4200);
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, new Date('2026-01-15T12:07:00Z'), { force: true });
  assert.equal(result.updated, 1);
  assert.match(patches[0], /channels\/chan-g1\/messages\/msg-g1$/);
});

test('an advisory with only a handful of outages stays below the floor', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store);
  kv.store.set('weather_alerts_cache', JSON.stringify([
    { event: 'Heat Advisory', severity: 'Moderate', endsMs: 0 }
  ]));
  // Routine baseline outages, not a storm — must not open the gate.
  seedOutages(kv.store, 120);
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, new Date('2026-01-15T12:07:00Z'), { force: true });
  assert.equal(result.updated, 0);
  assert.equal(patches.length, 0);
  assert.equal(kv.store.has('last_storm_refresh_slot'), false);
});

test('outages alone, with no storm alert at all, do not open the gate', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store, { storm: false });
  seedOutages(kv.store, 9000);
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, new Date('2026-01-15T12:07:00Z'), { force: true });
  // Without a storm alert the embed shows no storm sections, so there is
  // nothing to refresh however many customers are out.
  assert.equal(result.updated, 0);
  assert.equal(patches.length, 0);
});

test('the cron path opens for an advisory with real outages too', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store);
  kv.store.set('weather_alerts_cache', JSON.stringify([
    { event: 'Winter Weather Advisory', severity: 'Minor', endsMs: 0 }
  ]));
  seedOutages(kv.store, 4200);
  seedGuild(kv.store, 'g1');
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, GATE_NOW);
  assert.equal(result.updated, 1);
  assert.match(patches[0], /channels\/chan-g1\/messages\/msg-g1$/);
});

test('guilds with all storm sections disabled are skipped', async (t) => {
  const kv = makeKv();
  seedCommon(kv.store);
  seedGuild(kv.store, 'g1');
  kv.store.set('config:g1', JSON.stringify({
    alert_channel_id: 'chan-g1',
    toggle_outages: false,
    toggle_roads: false,
    toggle_districts: false,
    toggle_weather: false
  }));
  kv.store.set('guild_index', JSON.stringify(['g1']));

  const patches = [];
  mockFetch(t, patches);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
  const result = await maybeRefreshStormEmbeds(env, GATE_NOW);
  assert.equal(result.updated, 0);
  assert.equal(patches.length, 0);
});
