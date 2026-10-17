import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGreetedUserIds } from '../src/greeter.js';

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

test('reads the consolidated greeted_users key', async () => {
  const kv = makeKv();
  kv.store.set('greeted_users:g1', JSON.stringify(['u1', 'u2']));
  const ids = await getGreetedUserIds({ STATUS_KV: kv }, 'g1');
  assert.deepEqual([...ids].sort(), ['u1', 'u2']);
});

test('migrates legacy per-user keys into the consolidated key and deletes them', async () => {
  const kv = makeKv();
  kv.store.set('greeted:g1:u1', 'true');
  kv.store.set('greeted:g1:u2', 'failed');
  kv.store.set('greeted:g2:u9', 'true'); // other guild untouched

  const ids = await getGreetedUserIds({ STATUS_KV: kv }, 'g1');
  assert.deepEqual([...ids].sort(), ['u1', 'u2']);

  assert.equal(kv.store.has('greeted:g1:u1'), false);
  assert.equal(kv.store.has('greeted:g1:u2'), false);
  assert.equal(kv.store.has('greeted:g2:u9'), true);
  assert.deepEqual(JSON.parse(kv.store.get('greeted_users:g1')).sort(), ['u1', 'u2']);

  // Second read comes from the consolidated key, no legacy keys involved.
  const again = await getGreetedUserIds({ STATUS_KV: kv }, 'g1');
  assert.deepEqual([...again].sort(), ['u1', 'u2']);
});

test('returns an empty set for a guild with no history', async () => {
  const kv = makeKv();
  const ids = await getGreetedUserIds({ STATUS_KV: kv }, 'g1');
  assert.equal(ids.size, 0);
  assert.equal(kv.store.get('greeted_users:g1'), '[]');
});
