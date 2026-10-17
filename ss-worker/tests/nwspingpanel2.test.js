// Validates the NWS page's place in the full panel: nav size limits,
// per-interaction payload size, and the cfg_nws_ping_* save handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_NAV_TABS, buildControlPanelPayload, applyConfigUpdate } from '../src/panel.js';

function kvStub(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); }
  };
}
const envFor = (kv) => ({ STATUS_KV: kv });

test('nav tabs stay within Discord select limits', () => {
  // One nav dropdown renders every tab: max 25 options.
  assert.ok(PANEL_NAV_TABS.length <= 25, `too many nav tabs (${PANEL_NAV_TABS.length})`);
  for (const t of PANEL_NAV_TABS) {
    assert.ok((t.label || '').length <= 100, `nav label too long: ${t.value}`);
    assert.ok((t.value || '').length <= 100, `nav value too long: ${t.value}`);
    assert.ok((t.description || '').length <= 100, `nav description too long: ${t.value}`);
  }
  assert.ok(PANEL_NAV_TABS.some(t => t.value === 'config_nws_pings'), 'NWS tab is registered');
});

test('every panel interaction payload stays under Discord size limits', async () => {
  const kv = kvStub({ 'config:g1': JSON.stringify({ ping_role_ids: { winter: ['111'], heat: ['222'], default: ['333'] } }) });
  const env = envFor(kv);
  for (const tab of PANEL_NAV_TABS) {
    const payload = await buildControlPanelPayload(env, 'g1', null, tab.value);
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    // Interaction responses must fit well under ~1MB; keep a wide margin.
    assert.ok(bytes < 200_000, `${tab.value}: payload too large (${bytes} bytes)`);
    assert.ok(Array.isArray(payload.components) && payload.components.length <= 5, `${tab.value}: too many rows`);
  }
});

test('cfg_nws_ping_* handlers save one role per category', async () => {
  const kv = kvStub({ 'config:g1': JSON.stringify({}) });
  const env = envFor(kv);
  const body = (cid, vals) => ({ guild_id: 'g1', data: { custom_id: cid, values: vals } });

  let next = await applyConfigUpdate(body('cfg_nws_ping_winter', ['111']), env);
  assert.deepEqual(next.ping_role_ids.winter, ['111']);

  next = await applyConfigUpdate(body('cfg_nws_ping_heat', ['222']), env);
  assert.deepEqual(next.ping_role_ids.heat, ['222']);

  next = await applyConfigUpdate(body('cfg_nws_ping_default', ['333']), env);
  assert.deepEqual(next.ping_role_ids.default, ['333']);

  // Clearing a role empties the category instead of leaving a stale id.
  next = await applyConfigUpdate(body('cfg_nws_ping_winter', []), env);
  assert.deepEqual(next.ping_role_ids.winter, []);
});

test('cfg_nws_ping_* handlers recover from legacy flat-array configs', async () => {
  const kv = kvStub({ 'config:g1': JSON.stringify({ ping_role_ids: ['999'] }) });
  const env = envFor(kv);
  const next = await applyConfigUpdate({ guild_id: 'g1', data: { custom_id: 'cfg_nws_ping_winter', values: ['111'] } }, env);
  assert.ok(!Array.isArray(next.ping_role_ids), 'flat array must be replaced by an object');
  assert.deepEqual(next.ping_role_ids.winter, ['111']);
});
