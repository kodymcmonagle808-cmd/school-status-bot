import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeCleanupDepartedGuilds } from '../src/cleanup.js';

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

function seedGuild(store, gid) {
  store.set(`config:${gid}`, '{}');
  store.set(`panel_logs:${gid}`, '[]');
  store.set(`dm_subscribers:${gid}`, '["u1"]');
  store.set(`setup_done:${gid}`, 'true');
  store.set(`calendar_event:${gid}:2026-12-25`, 'Winter Break');
  store.set(`greeted:${gid}:u1`, 'true');
}

function mockDiscord(t, memberGuildIds) {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const gid = String(url).split('/').pop();
    if (memberGuildIds.includes(gid)) {
      return new Response(JSON.stringify({ id: gid }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: 'Unknown Guild', code: 10004 }), { status: 404 });
  });
}

test('purges all data for a departed guild and keeps active guilds', async (t) => {
  const kv = makeKv();
  seedGuild(kv.store, '111');
  seedGuild(kv.store, '222');
  kv.store.set('guild_index', JSON.stringify(['111', '222']));
  kv.store.set('status_history', '[]');
  mockDiscord(t, ['111']);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token' };
  const result = await maybeCleanupDepartedGuilds(env);

  assert.deepEqual(result.purged, ['222']);
  assert.equal([...kv.store.keys()].some(k => k.includes('222')), false);
  assert.equal(kv.store.has('config:111'), true);
  assert.equal(kv.store.has('greeted:111:u1'), true);
  assert.deepEqual(JSON.parse(kv.store.get('guild_index')), ['111']);
  // Global keys are untouched.
  assert.equal(kv.store.has('status_history'), true);
});

test('runs at most once per day', async (t) => {
  const kv = makeKv();
  seedGuild(kv.store, '222');
  mockDiscord(t, []);

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token' };
  const first = await maybeCleanupDepartedGuilds(env);
  assert.deepEqual(first.purged, ['222']);

  seedGuild(kv.store, '333');
  const second = await maybeCleanupDepartedGuilds(env);
  assert.deepEqual(second.purged, []);
  assert.equal(kv.store.has('config:333'), true);
});

test('never purges on ambiguous responses (rate limit, server error, network failure)', async (t) => {
  const kv = makeKv();
  seedGuild(kv.store, '111');
  seedGuild(kv.store, '222');
  seedGuild(kv.store, '333');
  let call = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    call++;
    if (call === 1) return new Response('rate limited', { status: 429 });
    if (call === 2) return new Response('oops', { status: 500 });
    throw new Error('network down');
  });

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token' };
  const result = await maybeCleanupDepartedGuilds(env);

  assert.deepEqual(result.purged, []);
  assert.equal(kv.store.has('config:111'), true);
  assert.equal(kv.store.has('config:222'), true);
  assert.equal(kv.store.has('config:333'), true);
});

test('a plain 404 without the Unknown Guild code does not purge', async (t) => {
  const kv = makeKv();
  seedGuild(kv.store, '111');
  t.mock.method(globalThis, 'fetch', async () => new Response('not found', { status: 404 }));

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token' };
  const result = await maybeCleanupDepartedGuilds(env);

  assert.deepEqual(result.purged, []);
  assert.equal(kv.store.has('config:111'), true);
});

test('skips config:default and non-snowflake ids', async (t) => {
  const kv = makeKv();
  kv.store.set('config:default', '{}');
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ code: 10004 }), { status: 404 });
  });

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token' };
  const result = await maybeCleanupDepartedGuilds(env);

  assert.deepEqual(result.purged, []);
  assert.deepEqual(urls, []);
  assert.equal(kv.store.has('config:default'), true);
});

test('is a no-op without KV or bot token', async () => {
  assert.deepEqual(await maybeCleanupDepartedGuilds(null), { purged: [] });
  assert.deepEqual(await maybeCleanupDepartedGuilds({ STATUS_KV: makeKv() }), { purged: [] });
});
