import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toggleSubscriber, getSubscribers, notifySubscribers } from '../src/subscriptions.js';

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); }
  };
}

test('toggleSubscriber subscribes then unsubscribes', async () => {
  const env = { STATUS_KV: makeKv() };

  const first = await toggleSubscriber(env, 'guild1', 'user1');
  assert.equal(first.subscribed, true);
  assert.equal(first.count, 1);
  assert.deepEqual(await getSubscribers(env, 'guild1'), ['user1']);

  const second = await toggleSubscriber(env, 'guild1', 'user1');
  assert.equal(second.subscribed, false);
  assert.equal(second.count, 0);
  assert.deepEqual(await getSubscribers(env, 'guild1'), []);
});

test('subscriber lists are per guild', async () => {
  const env = { STATUS_KV: makeKv() };
  await toggleSubscriber(env, 'guild1', 'user1');
  assert.deepEqual(await getSubscribers(env, 'guild2'), []);
});

test('notifySubscribers DMs each subscriber and survives individual failures', async (t) => {
  const env = { STATUS_KV: makeKv(), DISCORD_BOT_TOKEN: 'token' };
  await toggleSubscriber(env, 'guild1', 'user-ok');
  await toggleSubscriber(env, 'guild1', 'user-blocked');

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push(String(url));
    if (String(url).endsWith('/users/@me/channels')) {
      const body = JSON.parse(opts.body);
      if (body.recipient_id === 'user-blocked') return new Response('forbidden', { status: 403 });
      return new Response(JSON.stringify({ id: 'dm-channel' }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'message' }), { status: 200 });
  });

  const sent = await notifySubscribers(env, 'guild1', [{ title: 'Status' }]);
  assert.equal(sent, 1);
});

test('notifySubscribers is a no-op without subscribers or token', async () => {
  const env = { STATUS_KV: makeKv(), DISCORD_BOT_TOKEN: 'token' };
  assert.equal(await notifySubscribers(env, 'guild1', [{ title: 'Status' }]), 0);
  const env2 = { STATUS_KV: makeKv() };
  await toggleSubscriber(env2, 'guild1', 'user1');
  assert.equal(await notifySubscribers(env2, 'guild1', [{ title: 'Status' }]), 0);
});
