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
  return { STATUS_KV: makeKv(store), DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
}

const ctx = { waitUntil() {} };

// permissions "8" = Administrator; "0" = none.
function member({ admin = false, roles = [] } = {}) {
  return { permissions: admin ? '8' : '0', roles, user: { id: 'user1' } };
}

function slash(name, { member: m = member(), options } = {}) {
  return {
    type: 2,
    guild_id: 'g1',
    token: 'itoken',
    member: m,
    data: { name, ...(options ? { options } : {}) }
  };
}

function component(customId, { member: m = member(), values } = {}) {
  return {
    type: 3,
    guild_id: 'g1',
    token: 'itoken',
    member: m,
    data: { custom_id: customId, ...(values ? { values } : {}) }
  };
}

async function json(responsePromise) {
  const resp = await responsePromise;
  return JSON.parse(await resp.text());
}

test('ping interactions get a pong', async () => {
  const out = await json(handleInteraction({ type: 1 }, makeEnv(), ctx));
  assert.equal(out.type, 1);
});

test('informational commands work for members with no permissions', async () => {
  const env = makeEnv();
  for (const name of ['terms', 'privacy', 'help']) {
    const out = await json(handleInteraction(slash(name), env, ctx));
    assert.equal(out.type, 4, name);
    assert.ok(out.data.embeds && out.data.embeds.length, name);
  }
  // KV-backed read-only commands too.
  for (const name of ['calendar', 'history', 'stats']) {
    const out = await json(handleInteraction(slash(name), env, ctx));
    assert.equal(out.type, 4, name);
    assert.ok(out.data.embeds && out.data.embeds.length, name);
  }
});

test('staff commands are denied for plain members', async () => {
  const env = makeEnv();
  for (const name of ['post-status', 'override', 'events', 'announce', 'refresh-panel']) {
    const out = await json(handleInteraction(slash(name), env, ctx));
    assert.equal(out.type, 4, name);
    assert.match(out.data.content, /permission/i, name);
  }
});

test('admin-only commands are denied for non-admins and allowed for admins', async () => {
  const env = makeEnv();

  for (const name of ['setup', 'mydata']) {
    const denied = await json(handleInteraction(slash(name), env, ctx));
    assert.match(denied.data.content, /Administrator/i, name);
  }

  const view = await json(handleInteraction(
    slash('mydata', { member: member({ admin: true }), options: [{ type: 1, name: 'view' }] }), env, ctx));
  assert.equal(view.type, 4);
  assert.match(view.data.embeds[0].title, /Data Stored/);

  const del = await json(handleInteraction(
    slash('mydata', { member: member({ admin: true }), options: [{ type: 1, name: 'delete' }] }), env, ctx));
  assert.match(del.data.content, /Delete all server data/);
  assert.equal(del.data.components[0].components[0].custom_id, 'mydata_delete_confirm');
});

test('mydata delete confirm is admin-gated', async () => {
  const env = makeEnv();
  const denied = await json(handleInteraction(component('mydata_delete_confirm'), env, ctx));
  assert.match(denied.data.content, /Administrator/i);
});

test('/notify subscribes and unsubscribes', async () => {
  const env = makeEnv();
  const first = await json(handleInteraction(slash('notify'), env, ctx));
  assert.match(first.data.content, /Subscribed/);
  assert.deepEqual(JSON.parse(env.STATUS_KV.store.get('dm_subscribers:g1')), ['user1']);

  const second = await json(handleInteraction(slash('notify'), env, ctx));
  assert.match(second.data.content, /Unsubscribed/);
  assert.deepEqual(JSON.parse(env.STATUS_KV.store.get('dm_subscribers:g1')), []);
});

test('role removal asks for confirmation when the member has the role', async () => {
  const env = makeEnv();
  env.STATUS_KV.store.set('config:g1', JSON.stringify({ status_ping_roles: { schools_closed: 'r1' } }));

  const warn = await json(handleInteraction(
    component('role_toggle_select', { member: member({ roles: ['r1'] }), values: ['schools_closed'] }), env, ctx));
  assert.match(warn.data.content, /no longer be pinged/);
  assert.equal(warn.data.components[0].components[0].custom_id, 'role_remove_confirm:schools_closed');

  const kept = await json(handleInteraction(component('role_remove_cancel'), env, ctx));
  assert.equal(kept.type, 7);
  assert.match(kept.data.content, /unchanged/);
});

test('picking the Normal Operations ping role warns about daily pings first', async () => {
  const env = makeEnv();
  env.STATUS_KV.store.set('config:g1', JSON.stringify({ status_ping_roles: { normal_operations: 'r2' } }));

  const warn = await json(handleInteraction(
    component('role_toggle_select', { member: member({ roles: [] }), values: ['normal_operations'] }), env, ctx));
  assert.match(warn.data.content, /every day/i);
  assert.equal(warn.data.components[0].components[0].custom_id, 'role_add_confirm:normal_operations');

  const cancelled = await json(handleInteraction(component('role_add_cancel'), env, ctx));
  assert.equal(cancelled.type, 7);
  assert.match(cancelled.data.content, /No role added/);
});

test('other status ping roles still add without a confirmation step', async (t) => {
  const putUrls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT') putUrls.push(String(url));
    return new Response(null, { status: 204 });
  });

  const env = makeEnv();
  env.STATUS_KV.store.set('config:g1', JSON.stringify({ status_ping_roles: { schools_closed: 'r1' } }));

  const out = await json(handleInteraction(
    component('role_toggle_select', { member: member({ roles: [] }), values: ['schools_closed'] }), env, ctx));
  assert.match(out.data.content, /Added/);
  assert.equal(out.data.components, undefined);
  assert.equal(putUrls.length, 1);
  assert.match(putUrls[0], /members\/user1\/roles\/r1$/);
});

test('my notifications panel pre-checks the roles the member has', async () => {
  const env = makeEnv();
  env.STATUS_KV.store.set('config:g1', JSON.stringify({
    status_ping_roles: { schools_closed: 'r1', normal_operations: 'r2' }
  }));

  const out = await json(handleInteraction(
    component('role_toggle_select', { member: member({ roles: ['r1'] }), values: ['my_pings'] }), env, ctx));
  assert.equal(out.type, 4);
  const select = out.data.components[0].components[0];
  assert.equal(select.custom_id, 'my_pings_select');
  const byValue = Object.fromEntries(select.options.map(o => [o.value, !!o.default]));
  assert.equal(byValue.schools_closed, true);
  assert.equal(byValue.normal_operations, false);
});

test('unknown interactions fall through to a generic ack', async () => {
  const out = await json(handleInteraction(component('something_unknown'), makeEnv(), ctx));
  assert.equal(out.type, 4);
  assert.match(out.data.content, /Interaction received/);
});
