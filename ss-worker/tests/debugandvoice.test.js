import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchVoiceAnnouncement } from '../src/voice.js';
import { buildControlPanelPayload, PANEL_NAV_TABS } from '../src/panel.js';
import { handlePanelComponent } from '../src/panelcomponents.js';

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

test('PANEL_NAV_TABS includes Debug tab and is within 25 items', () => {
  assert.ok(PANEL_NAV_TABS.length <= 25);
  const debugTab = PANEL_NAV_TABS.find(t => t.value === 'config_debug');
  assert.ok(debugTab, 'config_debug tab should exist in PANEL_NAV_TABS');
  assert.equal(debugTab.label, 'Debug');
  assert.equal(debugTab.emoji, '🛠️');
});

test('dispatchVoiceAnnouncement skips when disabled or missing channel', async () => {
  const kv = mockKv({
    'config:g1': JSON.stringify({ toggle_voice_announcements: false })
  });
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'fake-token' };

  const disabledResult = await dispatchVoiceAnnouncement(env, 'g1', 'Test Announcement');
  assert.equal(disabledResult, false);

  const kvNoChannel = mockKv({
    'config:g1': JSON.stringify({ toggle_voice_announcements: true })
  });
  const envNoChannel = { STATUS_KV: kvNoChannel, DISCORD_BOT_TOKEN: 'fake-token' };
  const noChannelResult = await dispatchVoiceAnnouncement(envNoChannel, 'g1', 'Test Announcement');
  assert.equal(noChannelResult, false);
});

test('dispatchVoiceAnnouncement sends GREET_BOT_COMMAND: ANNOUNCE_VOICE', async () => {
  const kv = mockKv({
    'config:g1': JSON.stringify({
      toggle_voice_announcements: true,
      music_channel_id: 'chan-voice-bridge'
    })
  });
  const env = {
    STATUS_KV: kv,
    DISCORD_BOT_TOKEN: 'fake-token'
  };

  let postedUrl = null;
  let postedBody = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    postedUrl = url;
    postedBody = JSON.parse(opts.body || '{}');
    return {
      ok: true,
      json: async () => ({ id: 'msg-voice-123' }),
      text: async () => ''
    };
  };

  const res = await dispatchVoiceAnnouncement(env, 'g1', 'HCPSS Status Update (Schools Closed)');
  globalThis.fetch = origFetch;

  assert.equal(res, true);
  assert.match(postedUrl, /channels\/chan-voice-bridge\/messages/);
  assert.equal(postedBody.content, 'GREET_BOT_COMMAND: ANNOUNCE_VOICE HCPSS Status Update (Schools Closed)');
});

test('control panel renders Debug & Diagnostics page with staff and owner sections', async () => {
  const kv = mockKv({
    'panel_page:g1': 'config_debug'
  });
  const env = {
    STATUS_KV: kv,
    OWNER_ID: 'owner-999',
    BACKUPS_BUCKET: 'ss-backups'
  };

  const payload = await buildControlPanelPayload(env, 'g1', null, 'config_debug');
  assert.ok(payload.embeds && payload.embeds[0]);
  assert.match(payload.embeds[0].title, /Control Panel — Debug & Diagnostics/);
  assert.match(payload.embeds[0].description, /Staff Diagnostics/);
  assert.match(payload.embeds[0].description, /Owner-Only Sensitive Diagnostics/);
  assert.match(payload.embeds[0].description, /ss-backups/);

  // Check action row has debug options
  const actionRow = payload.components[1];
  assert.ok(actionRow);
  const options = actionRow.components[0].options;
  assert.ok(options.some(o => o.value === 'panel_btn_debug_test_voice'));
  assert.ok(options.some(o => o.value === 'panel_btn_debug_test_weather_voice'));
  assert.ok(options.some(o => o.value === 'panel_btn_debug_canary'));
  assert.ok(options.some(o => o.value === 'panel_btn_debug_backup'));
  assert.ok(options.some(o => o.value === 'panel_btn_debug_purge_cache'));
  assert.ok(options.some(o => o.value === 'panel_btn_debug_raw_config'));
});

test('debug actions: staff can test voice, non-owner is blocked from owner actions, owner allowed', async () => {
  const kv = mockKv({
    'config:g1': JSON.stringify({ music_channel_id: 'chan-123' }),
    weather_alerts_cache: 'cached-weather-data'
  });
  const env = {
    STATUS_KV: kv,
    DISCORD_BOT_TOKEN: 'fake-token',
    OWNER_ID: 'owner-123'
  };
  const ctx = { waitUntil: (p) => {} };

  // 1. Staff triggers test voice announcement
  let voicePosted = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.body && opts.body.includes('GREET_BOT_COMMAND: ANNOUNCE_VOICE')) {
      voicePosted = true;
    }
    return { ok: true, json: async () => ({ id: '1' }), text: async () => '' };
  };

  const staffVoiceBody = {
    guild_id: 'g1',
    token: 'tok-staff',
    member: { user: { id: 'staff-user' }, permissions: '8' },
    data: { custom_id: 'panel_btn_debug_test_voice' }
  };

  const voiceResp = await handlePanelComponent(staffVoiceBody, env, ctx, 'g1');
  const voiceJson = await voiceResp.json();
  assert.match(voiceJson.data.content, /Voice Diagnostic Dispatched/);
  assert.ok(voicePosted);

  // 2. Non-owner tries owner-only cache purge
  const nonOwnerBody = {
    guild_id: 'g1',
    token: 'tok-staff',
    member: { user: { id: 'staff-user' }, permissions: '8' },
    data: { custom_id: 'panel_btn_debug_purge_cache' }
  };

  const deniedResp = await handlePanelComponent(nonOwnerBody, env, ctx, 'g1');
  const deniedJson = await deniedResp.json();
  assert.match(deniedJson.data.content, /Owner Only/);
  // Verify cache key was NOT deleted
  assert.equal(await kv.get('weather_alerts_cache'), 'cached-weather-data');

  // 3. Owner triggers cache purge
  const ownerBody = {
    guild_id: 'g1',
    token: 'tok-owner',
    member: { user: { id: 'owner-123' }, permissions: '8' },
    data: { custom_id: 'panel_btn_debug_purge_cache' }
  };

  const ownerResp = await handlePanelComponent(ownerBody, env, ctx, 'g1');
  const ownerJson = await ownerResp.json();
  assert.equal(ownerJson.type, 5); // deferred response
  // Wait a microtask for waitUntil to run
  await new Promise(r => setTimeout(r, 10));
  assert.equal(await kv.get('weather_alerts_cache'), null);

  // 4. Non-owner tries viewing raw config
  const nonOwnerConfigBody = {
    guild_id: 'g1',
    token: 'tok-staff',
    member: { user: { id: 'staff-user' }, permissions: '8' },
    data: { custom_id: 'panel_btn_debug_raw_config' }
  };
  const deniedConfigResp = await handlePanelComponent(nonOwnerConfigBody, env, ctx, 'g1');
  const deniedConfigJson = await deniedConfigResp.json();
  assert.match(deniedConfigJson.data.content, /Owner Only/);

  // 5. Owner views raw config
  const ownerConfigBody = {
    guild_id: 'g1',
    token: 'tok-owner',
    member: { user: { id: 'owner-123' }, permissions: '8' },
    data: { custom_id: 'panel_btn_debug_raw_config' }
  };
  const ownerConfigResp = await handlePanelComponent(ownerConfigBody, env, ctx, 'g1');
  const ownerConfigJson = await ownerConfigResp.json();
  assert.equal(ownerConfigJson.type, 5);

  globalThis.fetch = origFetch;
});

test('panel_debug_select dropdown dispatches selected action', async () => {
  const kv = mockKv({
    'config:g1': JSON.stringify({ music_channel_id: 'chan-123' })
  });
  const env = {
    STATUS_KV: kv,
    DISCORD_BOT_TOKEN: 'fake-token',
    OWNER_ID: 'owner-123'
  };
  const ctx = { waitUntil: (p) => {} };

  let voicePosted = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.body && opts.body.includes('GREET_BOT_COMMAND: ANNOUNCE_VOICE')) {
      voicePosted = true;
    }
    return { ok: true, json: async () => ({ id: '1' }), text: async () => '' };
  };

  const selectBody = {
    guild_id: 'g1',
    token: 'tok-staff',
    member: { user: { id: 'staff-user' }, permissions: '8' },
    data: {
      custom_id: 'panel_debug_select',
      values: ['panel_btn_debug_test_voice']
    }
  };

  const resp = await handlePanelComponent(selectBody, env, ctx, 'g1');
  const json = await resp.json();
  assert.match(json.data.content, /Voice Diagnostic Dispatched/);
  assert.ok(voicePosted);

  globalThis.fetch = origFetch;
});

test('Simulated status alert sends zero pings (empty content and empty allowed_mentions)', async () => {
  const kv = mockKv({
    'config:g1': JSON.stringify({
      alert_channel_id: 'chan-alert',
      ping_role_ids: ['role-everyone', 'role-staff'],
      alert_embed_footer: 'HCPSS Status'
    })
  });
  const env = {
    STATUS_KV: kv,
    DISCORD_BOT_TOKEN: 'fake-token'
  };

  let postedPayload = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('/channels/chan-alert/messages')) {
      postedPayload = JSON.parse(opts.body);
    }
    return { ok: true, json: async () => ({ id: 'msg-alert-1' }), text: async () => '' };
  };

  const { handleTestAlert } = await import('../src/panelcomponents.js');
  const body = {
    guild_id: 'g1',
    token: 'tok-test',
    member: { user: { id: 'staff-1' }, permissions: '8' },
    data: {
      values: ['schools_closed']
    }
  };

  let bgPromise = null;
  const ctx = {
    waitUntil: (p) => { bgPromise = p; }
  };

  const resp = handleTestAlert(body, env, ctx, 'g1');
  const json = await resp.json();
  assert.equal(json.type, 5); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE

  if (bgPromise) await bgPromise;

  assert.ok(postedPayload, 'Message must be posted to alert channel');
  assert.equal(postedPayload.content, '', 'Content MUST be empty so no roles or users are pinged');
  assert.deepEqual(postedPayload.allowed_mentions, { parse: [] }, 'allowed_mentions parse must be empty array');
  assert.match(postedPayload.embeds[0].title, /HCPSS Status for Today \(Test - No Pings\)/);

  globalThis.fetch = origFetch;
});

test('Simulated weather alert sends zero pings (empty content and empty allowed_mentions)', async () => {
  const kv = mockKv({
    'config:g1': JSON.stringify({
      alert_channel_id: 'chan-weather',
      ping_role_ids: ['role-everyone']
    })
  });
  const env = {
    STATUS_KV: kv,
    DISCORD_BOT_TOKEN: 'fake-token'
  };

  let postedPayload = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('/channels/chan-weather/messages')) {
      postedPayload = JSON.parse(opts.body);
    }
    return { ok: true, json: async () => ({ id: 'msg-weather-1' }), text: async () => '' };
  };

  const body = {
    guild_id: 'g1',
    token: 'tok-weather-test',
    member: { user: { id: 'staff-1' }, permissions: '8' },
    data: {
      custom_id: 'panel_btn_debug_simulate_weather'
    }
  };

  let bgPromise = null;
  const ctx = {
    waitUntil: (p) => { bgPromise = p; }
  };

  const resp = await handlePanelComponent(body, env, ctx, 'g1');
  const json = await resp.json();
  assert.equal(json.type, 5);

  if (bgPromise) await bgPromise;

  assert.ok(postedPayload, 'Message must be posted to weather channel');
  assert.equal(postedPayload.content, '', 'Content MUST be empty');
  assert.deepEqual(postedPayload.allowed_mentions, { parse: [] });
  assert.match(postedPayload.embeds[0].title, /Winter Storm Warning.*Simulated Test - No Pings/);

  globalThis.fetch = origFetch;
});

test('Dashboard renders both Quick Actions and Debug & Diagnostics dropdown rows', async () => {
  const kv = mockKv();
  const env = { STATUS_KV: kv };

  const payload = await buildControlPanelPayload(env, 'g1', null, 'dashboard');
  const customIds = payload.components
    .flatMap(row => row.components || [])
    .map(c => c.custom_id);

  assert.ok(customIds.includes('panel_action_select'), 'Must have Quick Actions dropdown');
  assert.ok(customIds.includes('panel_debug_select'), 'Must have Debug & Diagnostics dropdown');
  assert.ok(customIds.includes('panel_trigger_test_alert'), 'Must have Simulate Status Alert dropdown');
});

test('staff can test weather voice alert with EAS notice', async () => {
  const kv = mockKv({
    'config:g1': JSON.stringify({ music_channel_id: 'chan-123' })
  });
  const env = {
    STATUS_KV: kv,
    DISCORD_BOT_TOKEN: 'fake-token'
  };
  const ctx = { waitUntil: (p) => {} };

  let voicePosted = false;
  let postedContent = '';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.body && opts.body.includes('GREET_BOT_COMMAND: ANNOUNCE_VOICE')) {
      voicePosted = true;
      postedContent = JSON.parse(opts.body).content;
    }
    return { ok: true, json: async () => ({ id: '1' }), text: async () => '' };
  };

  const staffWeatherVoiceBody = {
    guild_id: 'g1',
    token: 'tok-staff',
    member: { user: { id: 'staff-user' }, permissions: '8' },
    data: { custom_id: 'panel_btn_debug_test_weather_voice' }
  };

  const resp = await handlePanelComponent(staffWeatherVoiceBody, env, ctx, 'g1');
  const json = await resp.json();
  assert.match(json.data.content, /Weather Voice Alert Dispatched/);
  assert.ok(voicePosted);
  assert.match(postedContent, /Winter Storm Warning/);

  globalThis.fetch = origFetch;
});
