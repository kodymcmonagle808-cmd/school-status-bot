import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildKvOpsQuery,
  parseKvOperations,
  getKvUsage,
  utcDayStartMs,
  KV_FREE_LIMITS
} from '../src/kvanalytics.js';
import { buildKvUsageSection } from '../src/panel.js';

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); }
  };
}

// A Cloudflare GraphQL response shaped like the real kvOperationsAdaptiveGroups.
function cfResponse(counts) {
  const groups = Object.entries(counts).map(([actionType, requests]) => ({
    sum: { requests },
    dimensions: { actionType }
  }));
  return { data: { viewer: { accounts: [{ kvOperationsAdaptiveGroups: groups }] } } };
}

test('buildKvOpsQuery embeds the account, namespace, and window', () => {
  const { query } = buildKvOpsQuery('acct1', 'ns1', '2026-07-20T00:00:00.000Z', '2026-07-20T17:00:00.000Z');
  assert.match(query, /accountTag: "acct1"/);
  assert.match(query, /namespaceId: "ns1"/);
  assert.match(query, /datetime_geq: "2026-07-20T00:00:00\.000Z"/);
  assert.match(query, /datetime_leq: "2026-07-20T17:00:00\.000Z"/);
  assert.match(query, /kvOperationsAdaptiveGroups/);
});

test('parseKvOperations sums requests per action type', () => {
  const counts = parseKvOperations(cfResponse({ read: 5000, write: 300, delete: 2, list: 1 }));
  assert.deepEqual(counts, { reads: 5000, writes: 300, deletes: 2, lists: 1 });
});

test('parseKvOperations tolerates missing/partial shapes', () => {
  assert.deepEqual(parseKvOperations(null), { reads: 0, writes: 0, deletes: 0, lists: 0 });
  assert.deepEqual(parseKvOperations({}), { reads: 0, writes: 0, deletes: 0, lists: 0 });
  assert.deepEqual(
    parseKvOperations(cfResponse({ write: 10, bogus: 99 })),
    { reads: 0, writes: 10, deletes: 0, lists: 0 }
  );
});

test('utcDayStartMs returns midnight UTC of the given instant', () => {
  const start = utcDayStartMs(Date.UTC(2026, 6, 20, 17, 30, 0));
  assert.equal(new Date(start).toISOString(), '2026-07-20T00:00:00.000Z');
});

test('getKvUsage reports not-configured without CF creds and writes nothing', async () => {
  const kv = makeKv();
  const env = { STATUS_KV: kv, KV_NAMESPACE_ID: 'ns1' }; // token/account missing
  const out = await getKvUsage(env);
  assert.equal(out.configured, false);
  assert.equal(kv.store.size, 0, 'no cache write when unconfigured');
});

test('getKvUsage fetches, parses, and caches on success', async (t) => {
  const kv = makeKv();
  const env = { STATUS_KV: kv, CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', KV_NAMESPACE_ID: 'ns1' };

  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => cfResponse({ read: 100, write: 900 }) };
  });

  const out = await getKvUsage(env, Date.UTC(2026, 6, 20, 12, 0, 0));
  assert.equal(out.configured, true);
  assert.equal(out.writes, 900);
  assert.equal(out.reads, 100);
  assert.ok(kv.store.has('kv_usage_cache'), 'result cached');

  // Second call within the TTL is served from cache — no second fetch.
  const again = await getKvUsage(env, Date.UTC(2026, 6, 20, 12, 1, 0));
  assert.equal(again.writes, 900);
  assert.equal(calls, 1, 'cache hit avoided a second API call');
});

test('getKvUsage surfaces a GraphQL error without throwing or caching', async (t) => {
  const kv = makeKv();
  const env = { STATUS_KV: kv, CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', KV_NAMESPACE_ID: 'ns1' };
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ errors: [{ message: 'not entitled to analytics' }] })
  }));
  const out = await getKvUsage(env);
  assert.equal(out.configured, true);
  assert.match(out.error, /not entitled/);
  assert.equal(kv.store.has('kv_usage_cache'), false, 'errors are not cached');
});

test('getKvUsage survives a fetch that throws', async (t) => {
  const kv = makeKv();
  const env = { STATUS_KV: kv, CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', KV_NAMESPACE_ID: 'ns1' };
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
  const out = await getKvUsage(env);
  assert.equal(out.configured, true);
  assert.match(out.error, /network down/);
});

test('buildKvUsageSection renders a not-configured state', () => {
  const out = buildKvUsageSection({ configured: false, reason: 'Set CF_API_TOKEN.' });
  assert.match(out, /not configured/);
  assert.match(out, /no KV writes/i);
  assert.ok(!out.includes('■'));
});

test('buildKvUsageSection renders an error state', () => {
  const out = buildKvUsageSection({ configured: true, error: 'HTTP 403' });
  assert.match(out, /unavailable: HTTP 403/);
});

test('buildKvUsageSection renders bars from analytics counts', () => {
  const now = Date.UTC(2026, 6, 20, 12, 0, 0);
  const out = buildKvUsageSection({ configured: true, reads: 5000, writes: 300, deletes: 0, lists: 0 }, now);
  assert.match(out, /Writes.*300 \/ 1,000 · 30%/);
  assert.match(out, /Reads.*5,000 \/ 100,000 · 5\.0%/);
  assert.match(out, /Source: Cloudflare analytics/);
  assert.ok(out.includes('■'), 'writes bar has filled segments');
});

test('buildKvUsageSection shows the reset in Eastern time, DST-aware', () => {
  const summer = buildKvUsageSection({ configured: true, writes: 1, reads: 0, deletes: 0, lists: 0 }, Date.UTC(2026, 6, 15, 18, 0, 0));
  assert.match(summer, /resets 8:00\sPM EDT/);
  const winter = buildKvUsageSection({ configured: true, writes: 1, reads: 0, deletes: 0, lists: 0 }, Date.UTC(2026, 0, 15, 18, 0, 0));
  assert.match(winter, /resets 7:00\sPM EST/);
  assert.ok(!summer.includes('UTC:'));
});

test('buildKvUsageSection warns as the write budget fills', () => {
  const now = Date.UTC(2026, 6, 20, 12, 0, 0);
  const high = buildKvUsageSection({ configured: true, writes: 750, reads: 0, deletes: 0, lists: 0 }, now);
  assert.match(high, /running high/);
  const crit = buildKvUsageSection({ configured: true, writes: 950, reads: 0, deletes: 0, lists: 0 }, now);
  assert.match(crit, /nearly exhausted/);
  assert.match(crit, /🔴/);
});

test('KV_FREE_LIMITS matches the documented Cloudflare free plan', () => {
  assert.deepEqual(KV_FREE_LIMITS, { reads: 100000, writes: 1000, deletes: 1000, lists: 1000 });
});
