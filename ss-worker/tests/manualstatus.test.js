import test from 'node:test';
import assert from 'node:assert/strict';
import { runManualStatusCommand } from '../src/commands.js';
import { buildControlPanelPayload } from '../src/panel.js';
import { handleModalSubmit } from '../src/modals.js';
import { getActiveOverride, setOverride } from '../src/config.js';

function mockKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, val) {
      store.set(key, String(val));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const keys = [];
      for (const k of store.keys()) {
        if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
      }
      return { keys, list_complete: true };
    },
    _store: store
  };
}

test('runManualStatusCommand set enables manual status and notes', async () => {
  const kv = mockKv();
  const env = {
    STATUS_KV: kv,
    DISCORD_CHANNEL_ID: 'alert-chan-1',
    DISCORD_BOT_TOKEN: 'fake-token'
  };

  const body = {
    guild_id: 'g1',
    token: 'interaction-token-123',
    member: { user: { id: 'u123' } },
    data: {
      name: 'manualstatus',
      options: [
        {
          name: 'set',
          type: 1,
          options: [
            { name: 'operation', value: 'schools_closed' },
            { name: 'notes', value: 'We do not have school today due to heavy snowfall.' },
            { name: 'days', value: 2 },
            { name: 'headline', value: 'Winter Snow Day' }
          ]
        }
      ]
    }
  };

  await runManualStatusCommand(body, env);

  const active = await getActiveOverride(env, 'g1');
  assert.ok(active);
  assert.equal(active.status_key, 'schools_closed');
  assert.equal(active.status_label, 'Schools Closed');
  assert.equal(active.details, 'We do not have school today due to heavy snowfall.');
  assert.equal(active.title, 'Winter Snow Day');
  assert.equal(active.created_by, 'u123');
});

test('runManualStatusCommand view shows current status or live mode', async () => {
  const kv = mockKv();
  const env = { STATUS_KV: kv };

  // When no override is set
  const body1 = {
    guild_id: 'g1',
    token: 'tok-1',
    member: { user: { id: 'u1' } },
    data: {
      name: 'manualstatus',
      options: [{ name: 'view', type: 1 }]
    }
  };

  // Override fetch for Discord interaction updates in tests
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  await runManualStatusCommand(body1, env);

  // Set an override and test view
  await setOverride(env, 'g1', {
    status_key: 'schools_open_2_hours_late',
    status_label: 'Schools Open 2 Hours Late',
    details: 'Buses will arrive 2 hours late.',
    title: '2-Hour Delay Notice',
    until: Date.now() + 24 * 60 * 60 * 1000,
    created_by: 'u1'
  });

  const body2 = {
    guild_id: 'g1',
    token: 'tok-2',
    member: { user: { id: 'u1' } },
    data: {
      name: 'manualstatus',
      options: [{ name: 'view', type: 1 }]
    }
  };

  await runManualStatusCommand(body2, env);
  globalThis.fetch = origFetch;
  const active = await getActiveOverride(env, 'g1');
  assert.equal(active.status_key, 'schools_open_2_hours_late');
});

test('runManualStatusCommand clear removes manual status', async () => {
  const kv = mockKv();
  const env = {
    STATUS_KV: kv,
    DISCORD_CHANNEL_ID: 'alert-chan-1',
    DISCORD_BOT_TOKEN: 'fake-token'
  };

  await setOverride(env, 'g1', {
    status_key: 'schools_closed',
    status_label: 'Schools Closed',
    details: 'Ice storm',
    until: Date.now() + 10000
  });

  const body = {
    guild_id: 'g1',
    token: 'tok-3',
    member: { user: { id: 'u1' } },
    data: {
      name: 'manualstatus',
      options: [{ name: 'clear', type: 1 }]
    }
  };

  await runManualStatusCommand(body, env);
  const active = await getActiveOverride(env, 'g1');
  assert.equal(active, null);
});

test('control panel renders Manual School Status page', async () => {
  const kv = mockKv({
    'panel_page:g1': 'config_manual_status'
  });
  const env = { STATUS_KV: kv };

  // Without override
  const payload1 = await buildControlPanelPayload(env, 'g1');
  assert.ok(payload1.embeds && payload1.embeds[0]);
  assert.match(payload1.embeds[0].title, /Manual School Status/);
  assert.match(payload1.embeds[0].description, /Live Scraper Mode Active/);

  // With active override
  await setOverride(env, 'g1', {
    status_key: 'schools_closed',
    status_label: 'Schools Closed',
    details: 'Closed today for severe weather',
    title: 'Closure Notice',
    until: Date.now() + 24 * 60 * 60 * 1000,
    created_by: 'u123'
  });

  const payload2 = await buildControlPanelPayload(env, 'g1');
  assert.match(payload2.embeds[0].description, /Manual School Status is ACTIVE/);
  assert.match(payload2.embeds[0].description, /Closed today for severe weather/);
  assert.match(payload2.embeds[0].description, /Schools Closed/);
});

test('modal_set_override sets manual status and notes from control panel', async () => {
  const kv = mockKv({
    'config:g1': JSON.stringify({ editing_override_status_key: 'schools_closed' }),
    'panel_page:g1': 'config_manual_status'
  });
  const env = {
    STATUS_KV: kv,
    DISCORD_CHANNEL_ID: 'alert-chan-1',
    DISCORD_BOT_TOKEN: 'fake-token'
  };

  const body = {
    guild_id: 'g1',
    member: { user: { id: 'staff_1' }, permissions: '8' },
    data: {
      custom_id: 'modal_set_override',
      components: [
        {
          components: [{ custom_id: 'input_override_details', value: 'We do not have school today due to icy road conditions.' }]
        },
        {
          components: [{ custom_id: 'input_override_days', value: '1' }]
        },
        {
          components: [{ custom_id: 'input_override_title', value: 'Emergency Weather Closure' }]
        }
      ]
    }
  };

  const ctx = { waitUntil: (p) => {} };
  await handleModalSubmit(body, env, ctx, 'g1');

  const active = await getActiveOverride(env, 'g1');
  assert.ok(active);
  assert.equal(active.status_key, 'schools_closed');
  assert.equal(active.status_label, 'Schools Closed');
  assert.equal(active.details, 'We do not have school today due to icy road conditions.');
  assert.equal(active.title, 'Emergency Weather Closure');
});
