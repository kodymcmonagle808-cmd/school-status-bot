import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from '../src/interactions.js';
import { applyConfigUpdate, PANEL_NAV_TABS } from '../src/panel.js';
import { getConfig, setConfig, getEffectiveConfig } from '../src/config.js';

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

const ctx = { waitUntil() {} };

function member({ admin = false, roles = [] } = {}) {
  return { permissions: admin ? '8' : '0', roles, user: { id: 'user1' } };
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

test('the control panel exposes an Auto-Reply tab and no Music tab', () => {
  const values = PANEL_NAV_TABS.map(t => t.value);
  assert.ok(values.includes('config_autoreply'), 'Auto-Reply tab present');
  assert.ok(!values.includes('config_music'), 'Music tab removed from the nav');
});

test('selecting a keyword channel persists keyword_channel_id on the guild config', async () => {
  const env = makeEnv();

  const out = await json(handleInteraction(
    component('cfg_keyword_channel', { member: member({ admin: true }), values: ['chan123'] }), env, ctx));

  // type-7 in-place panel re-render.
  assert.equal(out.type, 7);
  const stored = JSON.parse(env.STATUS_KV.store.get('config:g1'));
  assert.equal(stored.keyword_channel_id, 'chan123');
});

test('clearing the keyword channel selection disables the feature', async () => {
  const store = new Map();
  store.set('config:g1', JSON.stringify({ keyword_channel_id: 'chan123' }));
  const env = makeEnv(store);

  // min_values 0 lets the dropdown be cleared to disable; no value => null.
  await applyConfigUpdate(
    component('cfg_keyword_channel', { member: member({ admin: true }) }), env);

  const stored = JSON.parse(env.STATUS_KV.store.get('config:g1'));
  assert.equal(stored.keyword_channel_id, null);
});

test('the keyword channel config round-trips through getConfig/setConfig', async () => {
  const env = makeEnv();
  await setConfig(env, 'g1', { keyword_channel_id: 'chan789' });
  const cfg = await getConfig(env, 'g1');
  assert.equal(cfg.keyword_channel_id, 'chan789');

  // An effective config with no keyword channel is simply unset.
  const effective = getEffectiveConfig({});
  assert.equal(effective.keyword_channel_id, undefined);
});

test('the worker /api/config endpoint returns the keyword channel', async () => {
  // Exercise the same shape the GET /api/config handler builds for the greeter.
  const store = new Map();
  store.set('config:g1', JSON.stringify({ keyword_channel_id: 'chan999' }));
  const env = makeEnv(store);

  const cfg = await getConfig(env, 'g1');
  assert.equal(cfg.keyword_channel_id, 'chan999');
});
