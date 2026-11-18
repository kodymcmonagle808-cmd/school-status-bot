import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_COMMANDS_META,
  getCommandTier,
  canMemberExecuteCommand
} from '../src/config.js';

import { buildOwnerPermsPayload, buildOwnerDisablePayload, handlePanelComponent } from '../src/panelcomponents.js';
import { buildControlPanelPayload, applyConfigUpdate } from '../src/panel.js';

function makeKv(store = {}) {
  const map = new Map(Object.entries(store));
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async delete(key) { map.delete(key); }
  };
}

test('ALL_COMMANDS_META includes all major commands', () => {
  const names = ALL_COMMANDS_META.map(c => c.name);
  assert.ok(names.includes('status'));
  assert.ok(names.includes('snowday'));
  assert.ok(names.includes('calendar'));
  assert.ok(names.includes('searchemails'));
  assert.ok(names.includes('emailchannel'));
  assert.ok(names.includes('post-status'));
  assert.ok(names.includes('override'));
  assert.ok(names.includes('events'));
});

test('getCommandTier: respects defaults, disabled_commands, and custom command_permissions', () => {
  const emptyConfig = {};
  assert.equal(getCommandTier(emptyConfig, 'status'), 'everyone');
  assert.equal(getCommandTier(emptyConfig, 'post-status'), 'staff');

  const customConfig = {
    command_permissions: {
      status: 'staff',
      'post-status': 'everyone'
    }
  };
  assert.equal(getCommandTier(customConfig, 'status'), 'staff');
  assert.equal(getCommandTier(customConfig, 'post-status'), 'everyone');

  const disabledConfig = {
    disabled_commands: ['snowday']
  };
  assert.equal(getCommandTier(disabledConfig, 'snowday'), 'disabled');
});

test('canMemberExecuteCommand: allows everyone when tier is everyone', async () => {
  const env = { STATUS_KV: makeKv({ 'config:g1': JSON.stringify({}) }) };
  const plainMember = { user: { id: 'user-1' }, permissions: '0', roles: [] };

  const res = await canMemberExecuteCommand('status', plainMember, env, 'g1');
  assert.equal(res.allowed, true);
});

test('canMemberExecuteCommand: denies plain members when command is staff-only', async () => {
  const env = { STATUS_KV: makeKv({ 'config:g1': JSON.stringify({ staff_role_id: 'role-staff' }) }) };
  const plainMember = { user: { id: 'user-1' }, permissions: '0', roles: [] };

  const res = await canMemberExecuteCommand('post-status', plainMember, env, 'g1');
  assert.equal(res.allowed, false);
  assert.match(res.reason, /permission/i);
});

test('canMemberExecuteCommand: allows plain members if owner flipped staff command to everyone', async () => {
  const env = {
    STATUS_KV: makeKv({
      'config:g1': JSON.stringify({
        command_permissions: { 'post-status': 'everyone' }
      })
    })
  };
  const plainMember = { user: { id: 'user-1' }, permissions: '0', roles: [] };

  const res = await canMemberExecuteCommand('post-status', plainMember, env, 'g1');
  assert.equal(res.allowed, true);
});

test('canMemberExecuteCommand: denies plain member if owner flipped general command to staff', async () => {
  const env = {
    STATUS_KV: makeKv({
      'config:g1': JSON.stringify({
        command_permissions: { snowday: 'staff' },
        staff_role_id: 'role-staff'
      })
    })
  };
  const plainMember = { user: { id: 'user-1' }, permissions: '0', roles: [] };

  const res = await canMemberExecuteCommand('snowday', plainMember, env, 'g1');
  assert.equal(res.allowed, false);
  assert.match(res.reason, /permission/i);

  // Staff member can still run it
  const staffMember = { user: { id: 'staff-1' }, permissions: '0', roles: ['role-staff'] };
  const staffRes = await canMemberExecuteCommand('snowday', staffMember, env, 'g1');
  assert.equal(staffRes.allowed, true);
});

test('canMemberExecuteCommand: bot owner can always execute even disabled commands', async () => {
  const env = {
    OWNER_ID: 'owner-999',
    STATUS_KV: makeKv({
      'config:g1': JSON.stringify({
        disabled_commands: ['status']
      })
    })
  };
  const ownerMember = { user: { id: 'owner-999' }, permissions: '0', roles: [] };

  const res = await canMemberExecuteCommand('status', ownerMember, env, 'g1');
  assert.equal(res.allowed, true);
});

test('buildOwnerPermsPayload: builds rich embed with select menus and action buttons', () => {
  const config = {
    command_permissions: {
      status: 'staff',
      'post-status': 'everyone'
    }
  };
  const payload = buildOwnerPermsPayload('guild-123', config);
  assert.ok(payload.embeds && payload.embeds.length === 1);
  assert.match(payload.embeds[0].title, /Command Access & Permissions/);
  assert.ok(payload.components.length >= 3);

  // CRITICAL: Ensure every component custom_id is completely unique (Discord rejects duplicates)
  const customIds = [];
  for (const row of payload.components) {
    for (const comp of row.components) {
      assert.ok(comp.custom_id, 'Component must have custom_id');
      assert.ok(!customIds.includes(comp.custom_id), `Duplicate custom_id found: ${comp.custom_id}`);
      customIds.push(comp.custom_id);
    }
  }
  assert.ok(customIds.includes('cfg_owner_perm_toggle_g1:guild-123'));
  assert.ok(customIds.includes('cfg_owner_perm_toggle_g2:guild-123'));
  assert.ok(customIds.includes('cfg_owner_perms_refresh:guild-123'));
});

test('handlePanelComponent: cfg_owner_perms_refresh refreshes the permission panel', async () => {
  const env = {
    OWNER_ID: 'owner-123',
    STATUS_KV: makeKv({ 'config:guild-123': JSON.stringify({}) })
  };
  const body = {
    member: { user: { id: 'owner-123' } },
    data: {
      custom_id: 'cfg_owner_perms_refresh:guild-123'
    }
  };

  const resp = await handlePanelComponent(body, env, null, 'guild-123');
  assert.ok(resp);
  const json = await resp.json();
  assert.equal(json.type, 7);
  assert.ok(json.data.embeds);
  assert.match(json.data.embeds[0].title, /guild-123/);
});

test('handlePanelComponent: panel_owner_perms_select returns type 7 and updates message', async () => {
  const env = {
    OWNER_ID: 'owner-123',
    STATUS_KV: makeKv({ 'config:guild-123': JSON.stringify({}) })
  };
  const body = {
    member: { user: { id: 'owner-123' } },
    data: {
      custom_id: 'panel_owner_perms_select',
      values: ['guild-123']
    }
  };

  const resp = await handlePanelComponent(body, env, null, 'guild-123');
  assert.ok(resp);
  const json = await resp.json();
  assert.equal(json.type, 7, 'Must return type 7 (UPDATE_MESSAGE) to edit ephemeral message in-place');
  assert.ok(json.data.embeds);
  assert.match(json.data.embeds[0].title, /guild-123/);
});

test('handlePanelComponent: toggling general command g1 flips tier and returns type 7', async () => {
  const env = {
    OWNER_ID: 'owner-123',
    STATUS_KV: makeKv({ 'config:guild-123': JSON.stringify({}) })
  };
  const body = {
    member: { user: { id: 'owner-123' } },
    data: {
      custom_id: 'cfg_owner_perm_toggle_g1:guild-123',
      values: ['status'] // general default is everyone -> next tier is staff
    }
  };

  const resp = await handlePanelComponent(body, env, null, 'guild-123');
  const json = await resp.json();
  assert.equal(json.type, 7);

  // Check KV was updated
  const saved = JSON.parse(await env.STATUS_KV.get('config:guild-123'));
  assert.equal(saved.command_permissions.status, 'staff');
});

test('handlePanelComponent: toggling admin command g2 flips tier and returns type 7', async () => {
  const env = {
    OWNER_ID: 'owner-123',
    STATUS_KV: makeKv({ 'config:guild-123': JSON.stringify({}) })
  };
  const body = {
    member: { user: { id: 'owner-123' } },
    data: {
      custom_id: 'cfg_owner_perm_toggle_g2:guild-123',
      values: ['post-status'] // admin default is staff -> next tier is everyone
    }
  };

  const resp = await handlePanelComponent(body, env, null, 'guild-123');
  const json = await resp.json();
  assert.equal(json.type, 7);

  const saved = JSON.parse(await env.STATUS_KV.get('config:guild-123'));
  assert.equal(saved.command_permissions['post-status'], 'everyone');
});

test('handlePanelComponent: quick action buttons (all staff, reset) return type 7', async () => {
  const env = {
    OWNER_ID: 'owner-123',
    STATUS_KV: makeKv({ 'config:guild-123': JSON.stringify({}) })
  };

  // Lock all to staff
  const staffBody = {
    member: { user: { id: 'owner-123' } },
    data: { custom_id: 'cfg_owner_perms_all_staff:guild-123' }
  };
  const staffResp = await handlePanelComponent(staffBody, env, null, 'guild-123');
  const staffJson = await staffResp.json();
  assert.equal(staffJson.type, 7);
  let saved = JSON.parse(await env.STATUS_KV.get('config:guild-123'));
  assert.equal(saved.command_permissions.status, 'staff');

  // Reset defaults
  const resetBody = {
    member: { user: { id: 'owner-123' } },
    data: { custom_id: 'cfg_owner_perms_reset_defaults:guild-123' }
  };
  const resetResp = await handlePanelComponent(resetBody, env, null, 'guild-123');
  const resetJson = await resetResp.json();
  assert.equal(resetJson.type, 7);
  saved = JSON.parse(await env.STATUS_KV.get('config:guild-123'));
  assert.equal(saved.command_permissions, undefined);
});

test('buildOwnerDisablePayload: builds disable embed with select menus and back button', () => {
  const config = {
    disabled_commands: ['snowday']
  };
  const payload = buildOwnerDisablePayload('guild-123', config);
  assert.ok(payload.embeds && payload.embeds.length === 1);
  assert.match(payload.embeds[0].title, /Disable Commands/);
  assert.match(payload.embeds[0].description, /`\/snowday`/);

  const customIds = [];
  for (const row of payload.components) {
    for (const comp of row.components) {
      assert.ok(comp.custom_id, 'Component must have custom_id');
      assert.ok(!customIds.includes(comp.custom_id), `Duplicate custom_id found: ${comp.custom_id}`);
      customIds.push(comp.custom_id);
    }
  }
  assert.ok(customIds.includes('cfg_owner_perm_toggle_disable_g1:guild-123'));
  assert.ok(customIds.includes('cfg_owner_perm_toggle_disable_g2:guild-123'));
  assert.ok(customIds.includes('cfg_owner_perms_enable_all:guild-123'));
  assert.ok(customIds.includes('cfg_owner_perms_refresh:guild-123'));
});

test('handlePanelComponent: cfg_owner_perms_page_disable opens disable page', async () => {
  const env = {
    OWNER_ID: 'owner-123',
    STATUS_KV: makeKv({ 'config:guild-123': JSON.stringify({}) })
  };
  const body = {
    member: { user: { id: 'owner-123' } },
    data: { custom_id: 'cfg_owner_perms_page_disable:guild-123' }
  };

  const resp = await handlePanelComponent(body, env, null, 'guild-123');
  const json = await resp.json();
  assert.equal(json.type, 7);
  assert.match(json.data.embeds[0].title, /Disable Commands/);
});

test('handlePanelComponent: toggling command in disable menu disables and then re-enables it', async () => {
  const env = {
    OWNER_ID: 'owner-123',
    STATUS_KV: makeKv({ 'config:guild-123': JSON.stringify({}) })
  };

  // 1. Toggle snowday to disabled
  const disableBody = {
    member: { user: { id: 'owner-123' } },
    data: {
      custom_id: 'cfg_owner_perm_toggle_disable_g1:guild-123',
      values: ['snowday']
    }
  };
  const resp1 = await handlePanelComponent(disableBody, env, null, 'guild-123');
  const json1 = await resp1.json();
  assert.equal(json1.type, 7);
  let saved = JSON.parse(await env.STATUS_KV.get('config:guild-123'));
  assert.equal(saved.command_permissions.snowday, 'disabled');
  assert.ok(saved.disabled_commands.includes('snowday'));

  // 2. Toggle snowday again to re-enable
  const enableBody = {
    member: { user: { id: 'owner-123' } },
    data: {
      custom_id: 'cfg_owner_perm_toggle_disable_g1:guild-123',
      values: ['snowday']
    }
  };
  const resp2 = await handlePanelComponent(enableBody, env, null, 'guild-123');
  const json2 = await resp2.json();
  assert.equal(json2.type, 7);
  saved = JSON.parse(await env.STATUS_KV.get('config:guild-123'));
  assert.equal(saved.command_permissions.snowday, 'everyone');
  assert.ok(!saved.disabled_commands.includes('snowday'));
});

test('handlePanelComponent: cfg_owner_perms_enable_all re-enables all disabled commands', async () => {
  const env = {
    OWNER_ID: 'owner-123',
    STATUS_KV: makeKv({
      'config:guild-123': JSON.stringify({
        disabled_commands: ['snowday', 'calendar'],
        command_permissions: { snowday: 'disabled', calendar: 'disabled' }
      })
    })
  };

  const body = {
    member: { user: { id: 'owner-123' } },
    data: { custom_id: 'cfg_owner_perms_enable_all:guild-123' }
  };

  const resp = await handlePanelComponent(body, env, null, 'guild-123');
  const json = await resp.json();
  assert.equal(json.type, 7);
  const saved = JSON.parse(await env.STATUS_KV.get('config:guild-123'));
  assert.deepEqual(saved.disabled_commands, []);
  assert.equal(saved.command_permissions.snowday, 'everyone');
  assert.equal(saved.command_permissions.calendar, 'everyone');
});

test('canMemberExecuteCommand: allows member matching any role in staff_role_ids', async () => {
  const env = {
    STATUS_KV: makeKv({
      'config:g1': JSON.stringify({
        staff_role_ids: ['role-lead', 'role-mod']
      })
    })
  };

  const plainMember = { user: { id: 'plain-1' }, permissions: '0', roles: ['role-student'] };
  const leadMember = { user: { id: 'lead-1' }, permissions: '0', roles: ['role-lead'] };
  const modMember = { user: { id: 'mod-1' }, permissions: '0', roles: ['role-mod'] };

  const plainRes = await canMemberExecuteCommand('post-status', plainMember, env, 'g1');
  assert.equal(plainRes.allowed, false);

  const leadRes = await canMemberExecuteCommand('post-status', leadMember, env, 'g1');
  assert.equal(leadRes.allowed, true);

  const modRes = await canMemberExecuteCommand('post-status', modMember, env, 'g1');
  assert.equal(modRes.allowed, true);
});

test('buildControlPanelPayload: config_commands page renders staff roles and role select menu', async () => {
  const env = { STATUS_KV: makeKv({}) };
  const config = {
    staff_role_ids: ['role-111', 'role-222']
  };
  const payload = await buildControlPanelPayload(env, 'g1', config, 'config_commands');
  assert.ok(payload.embeds && payload.embeds.length === 1);
  assert.match(payload.embeds[0].title, /Command Permissions & Roles/);
  assert.match(payload.embeds[0].description, /<@&role-111>, <@&role-222>/);

  const roleSelectRow = payload.components.find(r => r.components && r.components.some(c => c.custom_id === 'cfg_staff_role'));
  assert.ok(roleSelectRow, 'Must include cfg_staff_role component');
  const roleSelect = roleSelectRow.components.find(c => c.custom_id === 'cfg_staff_role');
  assert.equal(roleSelect.type, 6);
  assert.equal(roleSelect.max_values, 10);
});

test('applyConfigUpdate: cfg_staff_role saves array to staff_role_ids and first role to staff_role_id', async () => {
  const env = {
    STATUS_KV: makeKv({
      'config:g1': JSON.stringify({})
    })
  };
  const body = {
    guild_id: 'g1',
    data: {
      custom_id: 'cfg_staff_role',
      values: ['role-alpha', 'role-beta']
    }
  };

  const updatedConfig = await applyConfigUpdate(body, env);
  assert.ok(updatedConfig);
  assert.equal(updatedConfig.staff_role_id, 'role-alpha');
  assert.deepEqual(updatedConfig.staff_role_ids, ['role-alpha', 'role-beta']);

  const saved = JSON.parse(await env.STATUS_KV.get('config:g1'));
  assert.equal(saved.staff_role_id, 'role-alpha');
  assert.deepEqual(saved.staff_role_ids, ['role-alpha', 'role-beta']);
});
