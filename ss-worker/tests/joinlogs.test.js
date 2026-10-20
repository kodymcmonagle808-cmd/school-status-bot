// Join-logs remove-role: setup stores it, the control panel page renders
// and saves it, and the approval modal path reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSetupJoinLogsCommand } from '../src/commands.js';
import { buildControlPanelPayload, applyConfigUpdate, applyJoinlogsUpdate } from '../src/panel.js';

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); }
  };
}
const envFor = (kv) => ({ STATUS_KV: kv });

test('setupjoinlogs stores remove_role when provided', async () => {
  const kv = makeKv();
  const env = envFor(kv);
  const body = { guild_id: 'g1', data: { options: [
    { name: 'channel', value: 'chan-1' },
    { name: 'ping_role', value: 'role-ping' },
    { name: 'give_role', value: 'role-give' },
    { name: 'remove_role', value: 'role-remove' }
  ] } };
  const res = await runSetupJoinLogsCommand(body, env);
  assert.match(res.content, /role-remove/);
  const stored = JSON.parse(kv.store.get('joinlogs_config:g1'));
  assert.equal(stored.removeRole, 'role-remove');
});

test('setupjoinlogs leaves removeRole null when omitted (backward compatible)', async () => {
  const kv = makeKv();
  const env = envFor(kv);
  const body = { guild_id: 'g1', data: { options: [
    { name: 'channel', value: 'chan-1' },
    { name: 'ping_role', value: 'role-ping' },
    { name: 'give_role', value: 'role-give' }
  ] } };
  await runSetupJoinLogsCommand(body, env);
  const stored = JSON.parse(kv.store.get('joinlogs_config:g1'));
  assert.equal(stored.removeRole, null);
});

test('joinlogs panel page renders current settings as valid Discord payload', async () => {
  const kv = makeKv();
  kv.store.set('joinlogs_config:g1', JSON.stringify({
    channel: 'chan-1', pingRole: 'role-ping', giveRole: 'role-give', removeRole: 'role-remove'
  }));
  const payload = await buildControlPanelPayload(envFor(kv), 'g1', null, 'config_joinlogs');
  assert.equal(payload.embeds.length, 1);
  assert.match(payload.embeds[0].description, /<#chan-1>/);
  assert.match(payload.embeds[0].description, /<@&role-give>/);
  assert.match(payload.embeds[0].description, /<@&role-remove>/);
  assert.ok(payload.components.length <= 5, 'too many action rows');
});

test('joinlogs panel page shows (not set) and (none) when unconfigured', async () => {
  const kv = makeKv();
  const payload = await buildControlPanelPayload(envFor(kv), 'g1', null, 'config_joinlogs');
  assert.match(payload.embeds[0].description, /\(not set\)/);
  assert.match(payload.embeds[0].description, /\(none\)/);
});

test('cfg_joinlogs_remove saves a role and clears it when blank', async () => {
  const kv = makeKv();
  kv.store.set('joinlogs_config:g1', JSON.stringify({ channel: 'chan-1', pingRole: 'p', giveRole: 'g' }));
  const env = envFor(kv);
  await applyJoinlogsUpdate({ guild_id: 'g1', data: { custom_id: 'cfg_joinlogs_remove', values: ['role-x'] } }, env);
  assert.equal(JSON.parse(kv.store.get('joinlogs_config:g1')).removeRole, 'role-x');
  await applyJoinlogsUpdate({ guild_id: 'g1', data: { custom_id: 'cfg_joinlogs_remove', values: [] } }, env);
  assert.equal(JSON.parse(kv.store.get('joinlogs_config:g1')).removeRole, null);
});

test('cfg_joinlogs_* routes through applyConfigUpdate without touching guild config', async () => {
  const kv = makeKv();
  kv.store.set('joinlogs_config:g1', JSON.stringify({ channel: 'chan-1' }));
  const env = envFor(kv);
  await applyConfigUpdate({ guild_id: 'g1', data: { custom_id: 'cfg_joinlogs_give', values: ['role-g'] } }, env);
  const stored = JSON.parse(kv.store.get('joinlogs_config:g1'));
  assert.equal(stored.giveRole, 'role-g');
  assert.equal(stored.channel, 'chan-1');
});
