import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_COMMANDS_META,
  getCommandTier,
  canMemberExecuteCommand
} from '../src/config.js';

import { buildOwnerPermsPayload } from '../src/panelcomponents.js';

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
});
