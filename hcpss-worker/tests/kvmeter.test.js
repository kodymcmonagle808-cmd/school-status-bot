import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  wrapKv,
  flushKvUsage,
  foldUsage,
  makeCounts,
  utcDay,
  USAGE_KEY,
  KV_FREE_LIMITS
} from '../src/kvmeter.js';
import { buildKvUsageSection } from '../src/panel.js';

// KV stub whose real ops are counted independently of the meter, so tests can
// assert the meter's tally matches actual usage.
function makeKv(store = new Map()) {
  const real = { reads: 0, writes: 0, deletes: 0, lists: 0 };
  return {
    store,
    real,
    async get(key) { real.reads++; return store.has(key) ? store.get(key) : null; },
    async put(key, val) { real.writes++; store.set(key, val); },
    async delete(key) { real.deletes++; store.delete(key); },
    async list() { real.lists++; return { keys: [], list_complete: true }; }
  };
}

test('wrapKv tallies each op class and passes calls through', async () => {
  const kv = wrapKv(makeKv());
  await kv.put('a', '1');
  await kv.put('b', '2');
  await kv.get('a');
  await kv.delete('b');
  await kv.list();
  assert.deepEqual(kv.__counts, { reads: 1, writes: 2, deletes: 1, lists: 1 });
  assert.equal(await kv.get('a'), '1');
});

test('wrapKv is idempotent and leaves a falsy binding alone', () => {
  const kv = wrapKv(makeKv());
  assert.equal(wrapKv(kv), kv, 'already-wrapped namespace returned unchanged');
  assert.equal(wrapKv(null), null);
  assert.equal(wrapKv(undefined), undefined);
});

test('flushKvUsage skips the write on a write-free invocation', async () => {
  const raw = makeKv();
  const kv = wrapKv(raw);
  await kv.get('x');
  await kv.list();
  await flushKvUsage(kv);
  assert.equal(raw.store.has(USAGE_KEY), false, 'no counter written');
  // Only the two reads the test made — the flush itself did nothing.
  assert.equal(raw.real.writes, 0);
});

test('flushKvUsage records writes exactly and counts its own read+write', async () => {
  const raw = makeKv();
  const kv = wrapKv(raw);
  await kv.put('a', '1');
  await kv.put('b', '2');
  await kv.get('a');
  await flushKvUsage(kv);

  const usage = JSON.parse(raw.store.get(USAGE_KEY));
  // 2 puts + the flush's own put = 3 writes.
  assert.equal(usage.writes, 3);
  // 1 get + the flush's own get of USAGE_KEY = 2 reads.
  assert.equal(usage.reads, 2);
  assert.equal(usage.deletes, 0);
  assert.equal(usage.day, utcDay());
});

test('flushKvUsage accumulates across invocations within the same day', async () => {
  const store = new Map();
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);

  const kv1 = wrapKv(makeKv(store));
  await kv1.put('a', '1');
  await flushKvUsage(kv1, now);

  const kv2 = wrapKv(makeKv(store));
  await kv2.put('b', '2');
  await kv2.delete('a');
  await flushKvUsage(kv2, now);

  const usage = JSON.parse(store.get(USAGE_KEY));
  assert.equal(usage.writes, 1 + 1 + 1 + 1); // two puts + two flush puts
  assert.equal(usage.deletes, 1);
});

test('foldUsage resets when the stored day is stale', () => {
  const stored = { day: '2026-01-14', reads: 500, writes: 900, deletes: 3, lists: 0, since: 1 };
  const now = Date.UTC(2026, 0, 15, 0, 30, 0);
  const add = { reads: 2, writes: 1, deletes: 0, lists: 0 };
  const folded = foldUsage(stored, add, now);
  assert.equal(folded.day, '2026-01-15');
  assert.equal(folded.writes, 1, 'yesterday total dropped');
  assert.equal(folded.reads, 2);
});

test('foldUsage adds onto a same-day total', () => {
  const now = Date.UTC(2026, 0, 15, 6, 0, 0);
  const stored = { day: utcDay(now), reads: 10, writes: 20, deletes: 1, lists: 0, since: 111 };
  const folded = foldUsage(stored, { reads: 5, writes: 2, deletes: 0, lists: 1 }, now);
  assert.equal(folded.reads, 15);
  assert.equal(folded.writes, 22);
  assert.equal(folded.lists, 1);
  assert.equal(folded.since, 111, 'day start preserved');
});

test('makeCounts starts at zero', () => {
  assert.deepEqual(makeCounts(), { reads: 0, writes: 0, deletes: 0, lists: 0 });
});

test('buildKvUsageSection shows an empty state when no usage today', () => {
  const out = buildKvUsageSection(null);
  assert.match(out, /No KV activity recorded yet today/);
  // All bars empty (0 filled segments) → no ■ characters.
  assert.ok(!out.includes('■'));
});

test('buildKvUsageSection renders bars and the exact/best-effort note', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const usage = { day: utcDay(now), reads: 5000, writes: 300, deletes: 0, lists: 0 };
  const out = buildKvUsageSection(usage, now);
  assert.match(out, /Writes.*300 \/ 1,000 · 30%/);
  assert.match(out, /Reads.*5,000 \/ 100,000 · 5\.0%/);
  assert.match(out, /Writes\/deletes exact/);
  assert.ok(out.includes('■'), 'writes bar has filled segments');
});

test('buildKvUsageSection warns as the write budget fills', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const day = utcDay(now);
  const high = buildKvUsageSection({ day, writes: 750, reads: 0, deletes: 0, lists: 0 }, now);
  assert.match(high, /running high/);
  const crit = buildKvUsageSection({ day, writes: 950, reads: 0, deletes: 0, lists: 0 }, now);
  assert.match(crit, /nearly exhausted/);
  assert.match(crit, /🔴/);
});

test('KV_FREE_LIMITS matches the documented Cloudflare free plan', () => {
  assert.deepEqual(KV_FREE_LIMITS, { reads: 100000, writes: 1000, deletes: 1000, lists: 1000 });
});
