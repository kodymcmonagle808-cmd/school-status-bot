import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PANEL_NAV_TABS,
  getMainGuildId,
  setMainGuildId,
  isMainGuild,
  getDisabledPanelTabs,
  setDisabledPanelTabs,
  applyPanelDefaultsToAllServers,
  savePanelDefaultsForNewServers,
  getNavBarRow,
  buildControlPanelPayload,
  buildOwnerFeaturesPayload
} from '../src/panel.js';
import { handlePanelComponent } from '../src/panelcomponents.js';

function createMockEnv(initialKv = {}) {
  const store = new Map(Object.entries(initialKv));
  return {
    STATUS_KV: {
      get: async key => store.has(key) ? store.get(key) : null,
      put: async (key, val) => { store.set(key, String(val)); },
      delete: async key => { store.delete(key); }
    },
    OWNER_ID: 'owner-123',
    DISCORD_GUILD_ID: 'home-guild-999'
  };
}

test('getMainGuildId, setMainGuildId, isMainGuild', async () => {
  const env = createMockEnv();

  // Initially fallback to DISCORD_GUILD_ID
  const initial = await getMainGuildId(env);
  assert.strictEqual(initial, 'home-guild-999');

  // Set explicit CHS main guild
  await setMainGuildId(env, 'chs-guild-1234');
  assert.strictEqual(await getMainGuildId(env), 'chs-guild-1234');

  assert.strictEqual(await isMainGuild(env, 'chs-guild-1234'), true);
  assert.strictEqual(await isMainGuild(env, 'normal-guild-5678'), false);
  assert.strictEqual(await isMainGuild(env, null), false);

  // Clear main guild
  await setMainGuildId(env, null);
  assert.strictEqual(await getMainGuildId(env), 'home-guild-999');
});

test('getDisabledPanelTabs and setDisabledPanelTabs', async () => {
  const env = createMockEnv();
  await setMainGuildId(env, 'chs-main');

  // Main guild never has disabled tabs
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'chs-main'), []);

  // Normal server defaults to empty
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'normal'), []);

  // Save disabled tabs for normal servers
  await setDisabledPanelTabs(env, 'normal', ['config_music', 'config_joinlogs']);
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'normal'), ['config_music', 'config_joinlogs']);

  // Normal guild inherits normal default
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'normal-guild-2'), ['config_music', 'config_joinlogs']);

  // Main guild still returns []
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'chs-main'), []);

  // Per-guild override
  await setDisabledPanelTabs(env, 'custom-guild', ['config_autoreply']);
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'custom-guild'), ['config_autoreply']);
});

test('getNavBarRow filters out disabled tabs', () => {
  const fullNav = getNavBarRow('dashboard', []);
  assert.strictEqual(fullNav.components[0].options.length, PANEL_NAV_TABS.length);

  // Disable music and joinlogs
  const filteredNav = getNavBarRow('dashboard', ['config_music', 'config_joinlogs']);
  assert.strictEqual(filteredNav.components[0].options.length, PANEL_NAV_TABS.length - 2);

  const values = filteredNav.components[0].options.map(o => o.value);
  assert.strictEqual(values.includes('config_music'), false);
  assert.strictEqual(values.includes('config_joinlogs'), false);
  assert.strictEqual(values.includes('dashboard'), true);
  assert.strictEqual(values.includes('config_general'), true);
});

test('buildControlPanelPayload uses CHS CONTROLS for main server and Control Panel for normal servers', async () => {
  const env = createMockEnv();
  await setMainGuildId(env, 'chs-main-guild');

  // Main server panel
  const chsPayload = await buildControlPanelPayload(env, 'chs-main-guild');
  assert.match(chsPayload.embeds[0].title, /CHS CONTROLS — Dashboard/);
  assert.strictEqual(chsPayload.embeds[0].footer.text, 'CHS CONTROLS · HCPSS School Status');

  // Main server has all tabs
  const chsNavOptions = chsPayload.components[0].components[0].options;
  assert.strictEqual(chsNavOptions.length, PANEL_NAV_TABS.length);
  assert.strictEqual(chsNavOptions.some(o => o.value === 'config_music'), true);

  // Normal server panel
  const normalPayload = await buildControlPanelPayload(env, 'other-guild');
  assert.match(normalPayload.embeds[0].title, /Control Panel — Dashboard/);
  assert.strictEqual(normalPayload.embeds[0].footer.text, 'School Status · Control Panel');
});

test('buildControlPanelPayload hides disabled tabs on normal servers but preserves them on CHS main server', async () => {
  const env = createMockEnv();
  await setMainGuildId(env, 'chs-main-guild');
  await setDisabledPanelTabs(env, 'normal', ['config_music']);

  // Normal server nav does NOT contain config_music
  const normalPayload = await buildControlPanelPayload(env, 'other-guild');
  const normalNav = normalPayload.components[0].components[0].options;
  assert.strictEqual(normalNav.some(o => o.value === 'config_music'), false);

  // CHS Main server nav DOES contain config_music
  const chsPayload = await buildControlPanelPayload(env, 'chs-main-guild');
  const chsNav = chsPayload.components[0].components[0].options;
  assert.strictEqual(chsNav.some(o => o.value === 'config_music'), true);

  // If a normal server tries to load disabled config_music directly, it falls back to dashboard with notice
  const forcedPayload = await buildControlPanelPayload(env, 'other-guild', null, 'config_music');
  assert.match(forcedPayload.embeds[0].title, /Control Panel — Dashboard/);
  assert.match(forcedPayload.embeds[0].description, /disabled for this server by the bot administrator/);
});

test('buildOwnerFeaturesPayload renders feature toggles and actions', async () => {
  const env = createMockEnv();
  await setMainGuildId(env, 'chs-main-guild');
  await setDisabledPanelTabs(env, 'normal', ['config_music']);

  const payload = await buildOwnerFeaturesPayload(env, 'normal', [{ id: 'g1', name: 'Server 1' }]);
  assert.match(payload.embeds[0].title, /Control Panel Features — All Normal Servers/);
  assert.match(payload.embeds[0].description, /Music Settings/);

  // Component 1 is toggle dropdown
  const select = payload.components[0].components[0];
  assert.strictEqual(select.custom_id, 'cfg_owner_toggle_panel_feature:normal');
  const musicOpt = select.options.find(o => o.value === 'config_music');
  assert.match(musicOpt.description, /DISABLED/);

  // Component 3 has quick action buttons
  const btnRow = payload.components[2].components;
  assert.strictEqual(btnRow.some(b => b.custom_id === 'cfg_owner_features_enable_all:normal'), true);
  assert.strictEqual(btnRow.some(b => b.custom_id === 'cfg_owner_features_disable_extras:normal'), true);
});

test('handlePanelComponent: owner can set CHS main server and toggle features', async () => {
  const env = createMockEnv();

  // Set CHS main server
  const setMainResp = await handlePanelComponent({
    type: 3,
    member: { user: { id: 'owner-123' } },
    data: { custom_id: 'panel_owner_set_main_server', values: ['my-chs-guild'] }
  }, env, { waitUntil: () => {} }, 'my-chs-guild');

  const setMainData = await setMainResp.json();
  assert.strictEqual(setMainData.type, 7);
  assert.strictEqual(await getMainGuildId(env), 'my-chs-guild');

  // Toggle feature (music)
  const toggleResp = await handlePanelComponent({
    type: 3,
    member: { user: { id: 'owner-123' } },
    data: { custom_id: 'cfg_owner_toggle_panel_feature:normal', values: ['config_music'] }
  }, env, { waitUntil: () => {} }, 'normal');

  const toggleData = await toggleResp.json();
  assert.strictEqual(toggleData.type, 7);
  const disabled = await getDisabledPanelTabs(env, 'normal');
  assert.deepStrictEqual(disabled, ['config_music']);

  // Disable extras preset
  const extrasResp = await handlePanelComponent({
    type: 3,
    member: { user: { id: 'owner-123' } },
    data: { custom_id: 'cfg_owner_features_disable_extras:normal' }
  }, env, { waitUntil: () => {} }, 'normal');

  const extrasData = await extrasResp.json();
  assert.strictEqual(extrasData.type, 7);
  const disabledAfterExtras = await getDisabledPanelTabs(env, 'normal');
  assert.strictEqual(disabledAfterExtras.includes('config_music'), true);
  assert.strictEqual(disabledAfterExtras.includes('config_joinlogs'), true);
  assert.strictEqual(disabledAfterExtras.includes('config_autoreply'), true);

  // Enable all preset
  const enableAllResp = await handlePanelComponent({
    type: 3,
    member: { user: { id: 'owner-123' } },
    data: { custom_id: 'cfg_owner_features_enable_all:normal' }
  }, env, { waitUntil: () => {} }, 'normal');

  const enableAllData = await enableAllResp.json();
  assert.strictEqual(enableAllData.type, 7);
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'normal'), []);
});

test('apply to all new servers as default & apply to all servers as default', async () => {
  const env = createMockEnv({
    guild_index: JSON.stringify(['chs-main', 'guild-1', 'guild-2', 'guild-3'])
  });
  await setMainGuildId(env, 'chs-main');

  // Test savePanelDefaultsForNewServers directly
  await savePanelDefaultsForNewServers(env, ['config_music', 'config_emails']);
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'normal'), ['config_music', 'config_emails']);

  // Set individual override on guild-1
  await setDisabledPanelTabs(env, 'guild-1', ['config_joinlogs']);
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'guild-1'), ['config_joinlogs']);

  // Test applyPanelDefaultsToAllServers
  const updatedCount = await applyPanelDefaultsToAllServers(env, ['config_music']);
  assert.strictEqual(updatedCount, 4); // all 4 known guilds except chs-main
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'normal'), ['config_music']);
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'guild-1'), ['config_music']);
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'guild-2'), ['config_music']);
  assert.deepStrictEqual(await getDisabledPanelTabs(env, 'chs-main'), []); // main server preserved

  // Test via handlePanelComponent buttons
  // 1. Apply to all new servers as default
  const newDefaultResp = await handlePanelComponent({
    type: 3,
    member: { user: { id: 'owner-123' } },
    data: { custom_id: 'cfg_owner_features_save_new_default:normal' }
  }, env, { waitUntil: () => {} }, 'normal');

  const newDefaultData = await newDefaultResp.json();
  assert.strictEqual(newDefaultData.type, 7);
  assert.match(newDefaultData.data.content, /Saved as Default for All New Servers/);

  // 2. Apply to all servers as default
  const applyAllResp = await handlePanelComponent({
    type: 3,
    member: { user: { id: 'owner-123' } },
    data: { custom_id: 'cfg_owner_features_apply_all_existing:normal' }
  }, env, { waitUntil: () => {} }, 'normal');

  const applyAllData = await applyAllResp.json();
  assert.strictEqual(applyAllData.type, 7);
  assert.match(applyAllData.data.content, /Applied to ALL Servers as Default/);
});
