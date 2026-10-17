// /context-hook: the Apps Script watcher's push path for context sources
// with no dedicated hook (district feeds, news RSS, snowfall, AQI), plus the
// hook-armed cache TTL helper the fetchers use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { contextCacheTtl, HOOK_ARMED_TTL_SECONDS, contextHookCooldownKey } from '../src/hookmode.js';

function kvStub(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, val) { map.set(key, val); },
    async delete(key) { map.delete(key); },
    async list() { return { keys: [], list_complete: true }; }
  };
}

function hookRequest(token, body) {
  return new Request('https://worker.example/context-hook', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {},
    body: JSON.stringify(body)
  });
}

function ctxStub(waited = []) {
  return { waitUntil(p) { waited.push(Promise.resolve(p).catch(() => {})); } };
}

test('contextCacheTtl extends TTLs only when the push hooks are armed', () => {
  assert.equal(contextCacheTtl(null, 600), 600);
  assert.equal(contextCacheTtl({}, 600), 600);
  assert.equal(contextCacheTtl({ NWS_HOOK_SECRET: 's' }, 600), HOOK_ARMED_TTL_SECONDS);
  assert.equal(contextCacheTtl({ NWS_HOOK_SECRET: 's' }, 7200), HOOK_ARMED_TTL_SECONDS);
  // A base TTL already past the armed floor is left alone.
  assert.equal(contextCacheTtl({ NWS_HOOK_SECRET: 's' }, HOOK_ARMED_TTL_SECONDS + 1200), HOOK_ARMED_TTL_SECONDS + 1200);
});

test('/context-hook rejects when the secret is missing or wrong', async () => {
  const ctx = ctxStub();
  const disabled = await worker.fetch(hookRequest('anything', { source: 'districts' }), { STATUS_KV: kvStub() }, ctx);
  assert.equal(disabled.status, 403);

  const env = { NWS_HOOK_SECRET: 'right', STATUS_KV: kvStub() };
  const wrong = await worker.fetch(hookRequest('wrong', { source: 'districts' }), env, ctx);
  assert.equal(wrong.status, 403);
});

test('/context-hook validates the source name', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kvStub() };
  const bad = await worker.fetch(hookRequest('s3cret', { source: 'nonsense' }), env, ctxStub());
  assert.equal(bad.status, 400);
  const missing = await worker.fetch(hookRequest('s3cret', {}), env, ctxStub());
  assert.equal(missing.status, 400);
});

test('/context-hook clears each source\'s caches', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const kv = kvStub({
    district_status_cache: '{}',
    news_signal_cache: '{}',
    snowfall_forecast_cache: '{}',
    'aqi_cache:MD': '[]',
    'aqi_cache:DC': '[]'
  });
  const waited = [];
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv };

  const cases = [
    ['districts', ['district_status_cache']],
    ['news', ['news_signal_cache']],
    ['snowfall', ['snowfall_forecast_cache']],
    ['aqi', ['aqi_cache:MD', 'aqi_cache:DC']]
  ];
  for (const [source, keys] of cases) {
    const resp = await worker.fetch(hookRequest('s3cret', { source }), env, ctxStub(waited));
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true, source });
    for (const key of keys) {
      assert.ok(!kv.map.has(key), `${key} cleared for ${source}`);
    }
  }
  // The storm-embed refresh runs in waitUntil; with an empty guild index it
  // must finish without needing the (offline) network.
  await Promise.all(waited);
});

test('/context-hook throttles repeat pings for the same source', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const kv = kvStub({ district_status_cache: '{}' });
  const waited = [];
  const env = { NWS_HOOK_SECRET: 's3cret', STATUS_KV: kv };

  const first = await worker.fetch(hookRequest('s3cret', { source: 'districts' }), env, ctxStub(waited));
  assert.deepEqual(await first.json(), { ok: true, source: 'districts' });
  assert.ok(kv.map.has(contextHookCooldownKey('districts')));

  // The cache refills, then a second ping lands inside the cooldown: acked
  // (so the watcher advances its fingerprint) but nothing is cleared.
  kv.map.set('district_status_cache', '{}');
  const second = await worker.fetch(hookRequest('s3cret', { source: 'districts' }), env, ctxStub(waited));
  assert.deepEqual(await second.json(), { ok: true, source: 'districts', throttled: true });
  assert.ok(kv.map.has('district_status_cache'), 'throttled ping clears nothing');

  // A different source is not caught by districts' cooldown.
  kv.map.set('news_signal_cache', '{}');
  const other = await worker.fetch(hookRequest('s3cret', { source: 'news' }), env, ctxStub(waited));
  assert.deepEqual(await other.json(), { ok: true, source: 'news' });
  assert.ok(!kv.map.has('news_signal_cache'));

  await Promise.all(waited);
});
