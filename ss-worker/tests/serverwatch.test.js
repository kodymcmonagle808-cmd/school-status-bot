import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffGuilds, maybeWatchServerMembership, SCAN_MINUTE_OFFSET } from '../src/serverwatch.js';

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); }
  };
}

// A minute that passes the every-30-minute clock gate.
const GATE_NOW = new Date(Date.UTC(2026, 0, 15, 12, SCAN_MINUTE_OFFSET));

function mockDiscord(t, { guilds = [], posts = [] } = {}) {
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/users/@me/guilds')) {
      return new Response(JSON.stringify(guilds), { status: 200 });
    }
    if ((opts.method || 'GET') === 'POST') {
      posts.push({ url: u, body: String(opts.body || '') });
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  return posts;
}

function makeEnv(kv) {
  return { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: 'home' };
}

test('diffGuilds reports joins and leaves', () => {
  const current = [{ id: '1', name: 'Alpha' }, { id: '3', name: 'Gamma' }];
  const known = { 1: 'Alpha', 2: 'Beta' };
  const { joined, left } = diffGuilds(current, known);
  assert.deepEqual(joined, [{ id: '3', name: 'Gamma' }]);
  assert.deepEqual(left, [{ id: '2', name: 'Beta' }]);
  assert.deepEqual(diffGuilds(null, null), { joined: [], left: [] });
});

test('off-gate minutes bail before any KV or Discord traffic', async (t) => {
  const kv = makeKv();
  const posts = mockDiscord(t, { guilds: [{ id: '1', name: 'Alpha' }] });
  const reads = [];
  const origGet = kv.get.bind(kv);
  kv.get = async (key) => { reads.push(key); return origGet(key); };

  const offGate = new Date(Date.UTC(2026, 0, 15, 12, (SCAN_MINUTE_OFFSET + 1) % 60));
  const result = await maybeWatchServerMembership(makeEnv(kv), offGate);
  assert.deepEqual(result, { changes: 0 });
  assert.equal(reads.length, 0);
  assert.equal(posts.length, 0);
});

test('first run seeds the snapshot silently', async (t) => {
  const kv = makeKv();
  const posts = mockDiscord(t, { guilds: [{ id: '1', name: 'Alpha' }] });

  const result = await maybeWatchServerMembership(makeEnv(kv), GATE_NOW);
  assert.deepEqual(result, { changes: 0 });
  assert.deepEqual(JSON.parse(kv.store.get('known_guilds')), { 1: 'Alpha' });
  assert.equal(posts.length, 0);
});

test('a join is announced in the home log channel and the snapshot updates', async (t) => {
  const kv = makeKv();
  kv.store.set('known_guilds', JSON.stringify({ 1: 'Alpha' }));
  kv.store.set('config:home', JSON.stringify({ log_channel_id: 'log-chan' }));
  const posts = mockDiscord(t, {
    guilds: [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Newcomer' }]
  });

  const result = await maybeWatchServerMembership(makeEnv(kv), GATE_NOW);
  assert.equal(result.changes, 1);
  assert.deepEqual(JSON.parse(kv.store.get('known_guilds')), { 1: 'Alpha', 2: 'Newcomer' });
  const announce = posts.find(p => p.url.includes('/channels/log-chan/messages') && p.body.includes('Bot added to'));
  assert.ok(announce, 'expected a join announcement in the log channel');
  assert.match(announce.body, /Newcomer/);
});

test('no membership change means no snapshot rewrite', async (t) => {
  const kv = makeKv();
  kv.store.set('known_guilds', JSON.stringify({ 1: 'Alpha' }));
  const posts = mockDiscord(t, { guilds: [{ id: '1', name: 'Alpha' }] });
  const writes = [];
  const origPut = kv.put.bind(kv);
  kv.put = async (key, val) => { writes.push(key); return origPut(key, val); };

  const result = await maybeWatchServerMembership(makeEnv(kv), GATE_NOW);
  assert.deepEqual(result, { changes: 0 });
  assert.equal(writes.length, 0);
  assert.equal(posts.length, 0);
});
