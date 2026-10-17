import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getBlockedGuilds, isGuildBlocked, setGuildBlocked, removeFromBlocklist } from '../src/blocklist.js';
import { buildServerLines } from '../src/panel.js';

function kvStub(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); }
  };
}

const HOME = '99999999999999999';
const OTHER = '11111111111111111';

test('setGuildBlocked adds to the blocklist and removes from guild_index', async () => {
  const kv = kvStub({ guild_index: JSON.stringify([HOME, OTHER]) });
  const env = { STATUS_KV: kv, DISCORD_GUILD_ID: HOME };

  await setGuildBlocked(env, OTHER, true);
  assert.deepEqual(await getBlockedGuilds(env), [OTHER]);
  assert.ok(await isGuildBlocked(env, OTHER));
  assert.deepEqual(JSON.parse(kv.store.get('guild_index')), [HOME]);
});

test('setGuildBlocked(false) unblocks and restores the guild to the index', async () => {
  const kv = kvStub({
    guild_index: JSON.stringify([HOME]),
    guild_blocklist: JSON.stringify([OTHER])
  });
  const env = { STATUS_KV: kv, DISCORD_GUILD_ID: HOME };

  await setGuildBlocked(env, OTHER, false);
  assert.deepEqual(await getBlockedGuilds(env), []);
  assert.deepEqual(JSON.parse(kv.store.get('guild_index')), [HOME, OTHER]);
});

test('the home guild can never be blocked', async () => {
  const kv = kvStub({ guild_index: JSON.stringify([HOME]) });
  const env = { STATUS_KV: kv, DISCORD_GUILD_ID: HOME };

  await setGuildBlocked(env, HOME, true);
  assert.deepEqual(await getBlockedGuilds(env), []);
  assert.deepEqual(JSON.parse(kv.store.get('guild_index')), [HOME]);
});

test('removeFromBlocklist drops a departed guild', async () => {
  const kv = kvStub({ guild_blocklist: JSON.stringify([OTHER]) });
  const env = { STATUS_KV: kv };

  await removeFromBlocklist(env, OTHER);
  assert.deepEqual(await getBlockedGuilds(env), []);
});

test('isGuildBlocked degrades to false on junk data', async () => {
  const kv = kvStub({ guild_blocklist: 'not json' });
  const env = { STATUS_KV: kv };
  assert.equal(await isGuildBlocked(env, OTHER), false);
});

test('buildServerLines renders home, active, and locked servers', () => {
  const out = buildServerLines(
    [
      { id: HOME, name: 'Home Server' },
      { id: OTHER, name: 'Other Server' }
    ],
    [OTHER],
    HOME
  );
  const lines = out.split('\n');
  assert.match(lines[0], /^🟢 \*\*Home Server\*\*.*🏠$/);
  assert.match(lines[1], /^🔒 \*\*Other Server\*\*.*locked down$/);
  assert.equal(buildServerLines([], [], HOME), '(none)');
});
