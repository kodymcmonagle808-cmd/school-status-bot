import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from '../src/interactions.js';

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

function makeEnv(store) {
  return { STATUS_KV: makeKv(store), DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '', DISCORD_APPLICATION_ID: 'app1' };
}

function member({ admin = false, roles = [] } = {}) {
  return { permissions: admin ? '8' : '0', roles, user: { id: 'user1' } };
}

test('join_approve_ adds give role and removes the configured remove role', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), method: init && init.method });
    return new Response('{}', { status: 200 });
  });
  const store = new Map();
  store.set('joinlogs_config:', JSON.stringify({ channel: 'chan-1', giveRole: 'role-give', removeRole: 'role-remove' }));
  const env = makeEnv(store);
  const body = {
    type: 3, guild_id: '',
    member: member({ admin: true }),
    token: 'tok',
    message: { embeds: [{ description: 'User: <@u1>\n\n**Set name:** Test' }] },
    data: { custom_id: 'join_approve_u1_role-give' }
  };
  // waitUntil is a no-op in tests, so flush the background work manually.
  const pending = [];
  await handleInteraction(body, env, { waitUntil(p) { pending.push(p); } });
  await Promise.all(pending);
  const puts = calls.filter(c => c.method === 'PUT').map(c => c.url);
  const dels = calls.filter(c => c.method === 'DELETE').map(c => c.url);
  assert.ok(puts.some(u => u.includes('/roles/role-give')), 'give role PUT missing');
  assert.ok(dels.some(u => u.includes('/roles/role-remove')), 'remove role DELETE missing');
});

test('join_approve_ skips removal when no remove role is configured', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), method: init && init.method });
    return new Response('{}', { status: 200 });
  });
  const store = new Map();
  store.set('joinlogs_config:', JSON.stringify({ channel: 'chan-1', giveRole: 'role-give', removeRole: null }));
  const env = makeEnv(store);
  const body = {
    type: 3, guild_id: '',
    member: member({ admin: true }),
    token: 'tok',
    message: { embeds: [{ description: 'User: <@u1>\n\n**Set name:** Test' }] },
    data: { custom_id: 'join_approve_u1_role-give' }
  };
  const pending = [];
  await handleInteraction(body, env, { waitUntil(p) { pending.push(p); } });
  await Promise.all(pending);
  const dels = calls.filter(c => c.method === 'DELETE');
  assert.equal(dels.length, 0, 'no DELETE expected without a remove role');
});