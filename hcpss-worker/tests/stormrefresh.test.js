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

test('advisory-level winter alerts do not trigger the refresh', async (t) => {
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
