import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordWatcherError, getWatcherErrors, formatWatcherErrors } from '../src/watcherhealth.js';
import { findOrphanedKeys } from '../scripts/kv_audit.mjs';

function kvStub() {
  const store = new Map();
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); }
  };
}

test('recordWatcherError counts a first failure with the error message', async () => {
  const kv = kvStub();
  await recordWatcherError({ STATUS_KV: kv }, 'digest', new Error('boom'));
  const data = await getWatcherErrors({ STATUS_KV: kv });
  assert.equal(data.digest.count, 1);
  assert.equal(data.digest.msg, 'boom');
  assert.ok(data.digest.last > 0);
});

test('recordWatcherError throttles writes within the hour', async () => {
  const kv = kvStub();
  const env = { STATUS_KV: kv };
  await recordWatcherError(env, 'digest', new Error('first'));
  await recordWatcherError(env, 'digest', new Error('second'));
  const data = await getWatcherErrors(env);
  assert.equal(data.digest.count, 1);
  assert.equal(data.digest.msg, 'first');
});

test('recordWatcherError tracks watchers independently and never throws', async () => {
  const kv = kvStub();
  const env = { STATUS_KV: kv };
  await recordWatcherError(env, 'digest', new Error('a'));
  await recordWatcherError(env, 'aqi', 'plain string error');
  const data = await getWatcherErrors(env);
  assert.equal(Object.keys(data).length, 2);
  assert.equal(data.aqi.msg, 'plain string error');

  await recordWatcherError(null, 'digest', new Error('no env'));
  await recordWatcherError({}, 'digest', new Error('no kv'));
});

test('formatWatcherErrors renders healthy and failing states', () => {
  assert.match(formatWatcherErrors({}), /No watcher errors/);
  assert.match(formatWatcherErrors(null), /No watcher errors/);

  const out = formatWatcherErrors({
    digest: { count: 3, last: 1752940800000, msg: 'boom' },
    aqi: { count: 1, last: 1752940900000 }
  });
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /aqi/); // most recent first
  assert.match(lines[1], /digest.*3 failure hour\(s\).*`boom`/);
});

test('findOrphanedKeys classifies per-guild keys against the index', () => {
  const keys = [
    'config:11111111111111111',
    'config:22222222222222222',
    'panel_logs:22222222222222222',
    'config:default',
    'guild_index',
    'last_digest_day:11111111111111111',
    'status_history'
  ];
  const orphans = findOrphanedKeys(keys, ['11111111111111111']);
  assert.equal(orphans.size, 1);
  assert.deepEqual(orphans.get('22222222222222222').sort(), [
    'config:22222222222222222',
    'panel_logs:22222222222222222'
  ]);
});

test('findOrphanedKeys returns empty when everything is known or global', () => {
  const orphans = findOrphanedKeys(
    ['config:11111111111111111', 'status_stats', 'config:default'],
    ['11111111111111111']
  );
  assert.equal(orphans.size, 0);
});
