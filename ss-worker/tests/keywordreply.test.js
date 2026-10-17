import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from '../src/interactions.js';
import { PANEL_NAV_TABS } from '../src/panel.js';
import { getConfig, setConfig } from '../src/config.js';

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

// Build a modal-submit (type 5) body from a map of input custom_id -> value.
function modalSubmit(customId, inputs) {
  const components = Object.entries(inputs).map(([id, value]) => ({
    type: 1,
    components: [{ type: 4, custom_id: id, value }]
  }));
  return {
    type: 5,
    guild_id: 'g1',
    token: 'itoken',
    member: member({ admin: true }),
    data: { custom_id: customId, components }
  };
}

async function json(responsePromise) {
  const resp = await responsePromise;
  return JSON.parse(await resp.text());
}

test('the control panel exposes an Auto-Reply tab and a Music tab', () => {
  const values = PANEL_NAV_TABS.map(t => t.value);
  assert.ok(values.includes('config_autoreply'), 'Auto-Reply tab present');
  assert.ok(values.includes('config_music'), 'Music Settings tab present');
});

test('the add-rule action opens a modal (type 9)', async () => {
  const env = makeEnv();
  // panel_btn_add_keyword is routed through the action-select forwarder.
  const out = await json(handleInteraction(
    component('panel_action_select', { member: member({ admin: true }), values: ['panel_btn_add_keyword'] }), env, ctx));
  assert.equal(out.type, 9, 'opens a modal');
  assert.equal(out.data.custom_id, 'modal_add_keyword');
});

test('submitting the add-rule modal appends a keyword rule', async () => {
  const env = makeEnv();
  const out = await json(handleInteraction(
    modalSubmit('modal_add_keyword', {
      input_keyword_channel: '123456789012345678',
      input_keyword_terms: 'Mod Abuse, Staff Abuse',
      input_keyword_response: 'Please open a ticket to report a staff member.'
    }), env, ctx));

  assert.equal(out.type, 7, 're-renders the panel');
  const stored = JSON.parse(env.STATUS_KV.store.get('config:g1'));
  assert.ok(Array.isArray(stored.keyword_rules));
  assert.equal(stored.keyword_rules.length, 1);
  const rule = stored.keyword_rules[0];
  assert.equal(rule.channel_id, '123456789012345678');
  assert.deepEqual(rule.keywords, ['mod abuse', 'staff abuse']);
  assert.match(rule.response, /open a ticket/);
  assert.equal(env.STATUS_KV.store.get('panel_page:g1'), 'config_autoreply');
});

test('the add-rule modal rejects an invalid channel id', async () => {
  const env = makeEnv();
  const out = await json(handleInteraction(
    modalSubmit('modal_add_keyword', {
      input_keyword_channel: 'not-a-channel',
      input_keyword_terms: 'hello',
      input_keyword_response: 'hi'
    }), env, ctx));
  assert.equal(out.type, 4);
  assert.match(out.data.content, /Invalid channel/i);
  assert.equal(env.STATUS_KV.store.get('config:g1'), undefined, 'nothing saved');
});

test('removing a rule by index deletes the right one', async () => {
  const store = new Map();
  store.set('config:g1', JSON.stringify({
    keyword_rules: [
      { channel_id: '111', keywords: ['a'], response: 'A' },
      { channel_id: '222', keywords: ['b'], response: 'B' },
      { channel_id: '333', keywords: ['c'], response: 'C' }
    ]
  }));
  const env = makeEnv(store);

  const out = await json(handleInteraction(
    component('cfg_keyword_remove_select', { member: member({ admin: true }), values: ['1'] }), env, ctx));

  assert.equal(out.type, 7);
  const stored = JSON.parse(env.STATUS_KV.store.get('config:g1'));
  assert.equal(stored.keyword_rules.length, 2);
  assert.deepEqual(stored.keyword_rules.map(r => r.channel_id), ['111', '333']);
});

test('keyword rules round-trip through getConfig/setConfig', async () => {
  const env = makeEnv();
  const rules = [{ channel_id: 'chan789', keywords: ['mod abuse'], response: 'open a ticket' }];
  await setConfig(env, 'g1', { keyword_rules: rules });
  const cfg = await getConfig(env, 'g1');
  assert.deepEqual(cfg.keyword_rules, rules);
});

test('/api/config returns the stored keyword_rules', async () => {
  const store = new Map();
  store.set('config:g1', JSON.stringify({ keyword_rules: [{ channel_id: 'c9', keywords: ['x'], response: 'y' }] }));
  const env = makeEnv(store);
  const cfg = await getConfig(env, 'g1');
  assert.equal(cfg.keyword_rules[0].channel_id, 'c9');
});

test('the owner panel includes a refresh button', async () => {
  const { buildWorkerUpdatesPayload } = await import('../src/panel.js');
  const store = new Map();
  store.set('guild_index', JSON.stringify([]));
  const env = makeEnv(store);
  env.OWNER_ID = 'owner1';
  const payload = await buildWorkerUpdatesPayload(env);
  const buttonRows = (payload.components || []).filter(c => c.type === 1);
  const ids = buttonRows.flatMap(r => r.components.map(b => b.custom_id));
  assert.ok(ids.includes('panel_owner_refresh'), 'refresh button present');
});

test('the music leave button acks and forwards a leave command to the greeter', async (t) => {
  const posted = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/channels/') && (opts.method || 'GET') === 'POST') {
      posted.push(JSON.parse(opts.body || '{}').content);
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(null, { status: 204 });
  });

  const env = makeEnv();
  // Run ctx.waitUntil callbacks synchronously so the forwarded command is captured.
  const runCtx = { waitUntil: (p) => { Promise.resolve(p).catch(() => {}); } };
  const out = await json(handleInteraction(
    component('music_btn_leave', { member: member({ admin: true }) }), env, runCtx));

  // Ephemeral ack.
  assert.equal(out.type, 4);
  assert.match(out.data.content, /Disconnecting/i);
  // The leave command is dispatched to the greeter via a channel message.
  assert.ok(posted.some(c => typeof c === 'string' && c.includes('GREET_BOT_COMMAND: TOGGLE_VOICE LEAVE')),
    'forwarded a leave command');
});

