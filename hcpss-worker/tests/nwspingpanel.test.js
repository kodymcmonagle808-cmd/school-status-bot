// Smoke-validates the config_nws_pings panel page against Discord limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildControlPanelPayload } from '../src/panel.js';

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

// Discord hard limits for a message payload
function validateDiscordPayload(payload, label) {
  assert.ok(Array.isArray(payload.embeds) && payload.embeds.length >= 1, `${label}: needs embeds`);
  assert.ok(payload.embeds.length <= 10, `${label}: too many embeds`);
  for (const e of payload.embeds) {
    assert.ok((e.title || '').length <= 256, `${label}: title too long`);
    assert.ok((e.description || '').length <= 4096, `${label}: description too long (got ${(e.description || '').length})`);
    assert.ok(!/\\\\n/.test(e.description || ''), `${label}: description contains literal backslash-n`);
  }
  assert.ok(Array.isArray(payload.components), `${label}: needs components`);
  assert.ok(payload.components.length <= 5, `${label}: too many action rows (got ${payload.components.length})`);
  for (const row of payload.components) {
    assert.equal(row.type, 1, `${label}: top-level components must be action rows`);
    assert.ok(row.components.length <= 5, `${label}: too many components in a row`);
    for (const c of row.components) {
      assert.ok((c.custom_id || '').length <= 100, `${label}: custom_id too long`);
      assert.ok((c.placeholder || '').length <= 150, `${label}: placeholder too long`);
      if (c.type === 3) {
        assert.ok((c.options || []).length <= 25, `${label}: too many select options`);
        for (const o of c.options) {
          assert.ok((o.label || '').length <= 100, `${label}: option label too long`);
          assert.ok((o.value || '').length <= 100, `${label}: option value too long`);
        }
      }
    }
  }
}

for (const [label, pingRoles] of [
  ['empty config', undefined],
  ['empty object', {}],
  ['legacy flat array', ['111']],
  ['full object', { winter: ['111'], heat: ['222'], default: ['333'] }]
]) {
  test(`config_nws_pings page renders valid Discord payload (${label})`, async () => {
    const kv = kvStub({
      'config:g1': JSON.stringify(pingRoles === undefined ? {} : { ping_role_ids: pingRoles })
    });
    const payload = await buildControlPanelPayload(envFor(kv), 'g1', null, 'config_nws_pings');
    validateDiscordPayload(payload, label);
  });
}

test('config_nws_pings page shows the configured roles', async () => {
  const kv = kvStub({
    'config:g1': JSON.stringify({ ping_role_ids: { winter: ['111'], heat: ['222'], default: ['333'] } })
  });
  const payload = await buildControlPanelPayload(envFor(kv), 'g1', null, 'config_nws_pings');
  const desc = payload.embeds[0].description;
  assert.match(desc, /<@&111>/);
  assert.match(desc, /<@&222>/);
  assert.match(desc, /<@&333>/);
});

test('config_nws_pings page shows (none) when nothing is configured', async () => {
  const kv = kvStub({ 'config:g1': JSON.stringify({}) });
  const payload = await buildControlPanelPayload(envFor(kv), 'g1', null, 'config_nws_pings');
  assert.match(payload.embeds[0].description, /\(none\)/);
});
