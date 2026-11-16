import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createD1KvAdapter,
  initEnv,
  getD1Stats,
  buildD1Section,
  formatBytes,
  recordEmailToD1,
  searchEmailsInD1,
  getEmailStats
} from '../src/db.js';

function createMockD1() {
  const store = new Map(); // key -> { value, expires_at }
  const emailStore = new Map(); // `${id}:${guild_id}` -> emailRecord

  return {
    _store: store,
    _emailStore: emailStore,
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...args) {
          bound = args;
          return stmt;
        },
        async first() {
          if (sql.includes('SELECT value, expires_at FROM kv_store WHERE key = ?')) {
            const key = bound[0];
            const item = store.get(key);
            return item ? { value: item.value, expires_at: item.expires_at } : null;
          }
          if (sql.includes('SELECT count(*) AS total_keys')) {
            let totalBytes = 0;
            for (const [, v] of store) {
              totalBytes += (v.value || '').length;
            }
            return { total_keys: store.size, total_bytes: totalBytes };
          }
          if (sql.includes('COUNT(*) AS total')) {
            const [, , guildId] = bound;
            let total = 0;
            let past7Days = 0;
            let past30Days = 0;
            const now = Date.now();
            const sevenDays = now - (7 * 24 * 60 * 60 * 1000);
            const thirtyDays = now - (30 * 24 * 60 * 60 * 1000);
            for (const [, e] of emailStore) {
              if (e.guild_id === guildId) {
                total++;
                if (e.ts >= sevenDays) past7Days++;
                if (e.ts >= thirtyDays) past30Days++;
              }
            }
            return { total, past_7_days: past7Days, past_30_days: past30Days };
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO kv_store')) {
            const [key, value, expiresAt] = bound;
            store.set(key, { value, expires_at: expiresAt ?? null });
            return { success: true };
          }
          if (sql.includes('DELETE FROM kv_store WHERE key = ?')) {
            const [key] = bound;
            store.delete(key);
            return { success: true };
          }
          if (sql.includes('INSERT INTO emails')) {
            const [id, guildId, subject, body, channelId, messageId, ts, url, imageUrl, aiSummary] = bound;
            emailStore.set(`${id}:${guildId}`, {
              id,
              guild_id: guildId,
              subject,
              body,
              channel_id: channelId,
              message_id: messageId,
              ts,
              url,
              image_url: imageUrl,
              ai_summary: aiSummary
            });
            return { success: true };
          }
          return { success: true };
        },
        async all() {
          if (sql.includes('WHERE substr(key, 1, ?) = ?')) {
            const [, prefix, nowSec, limit] = bound;
            const results = [];
            for (const [k, v] of Array.from(store.entries()).sort(([a], [b]) => a.localeCompare(b))) {
              if (k.startsWith(prefix) && (v.expires_at == null || v.expires_at > nowSec)) {
                results.push({ key: k });
                if (results.length >= limit) break;
              }
            }
            return { results, success: true };
          }
          if (sql.includes('SELECT key FROM kv_store')) {
            const [nowSec, limit] = bound;
            const results = [];
            for (const [k, v] of Array.from(store.entries()).sort(([a], [b]) => a.localeCompare(b))) {
              if (v.expires_at == null || v.expires_at > nowSec) {
                results.push({ key: k });
                if (results.length >= limit) break;
              }
            }
            return { results, success: true };
          }
          if (sql.includes('FROM emails') && sql.includes('guild_id = ?')) {
            const [guildId, searchPattern, , limit] = bound;
            const cleanPattern = searchPattern.replace(/%/g, '').toLowerCase();
            const results = [];
            for (const [, e] of emailStore) {
              if (e.guild_id === guildId) {
                const subMatch = (e.subject || '').toLowerCase().includes(cleanPattern);
                const bodyMatch = (e.body || '').toLowerCase().includes(cleanPattern);
                if (subMatch || bodyMatch) {
                  results.push(e);
                  if (results.length >= limit) break;
                }
              }
            }
            return { results, success: true };
          }
          return { results: [], success: true };
        }
      };
      return stmt;
    }
  };
}

function createMockKv(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    _map: map,
    async get(key, options) {
      if (!map.has(key)) return null;
      const val = map.get(key);
      if (options === 'json' || options?.type === 'json') {
        try { return JSON.parse(val); } catch { return null; }
      }
      return val;
    },
    async put(key, value) {
      map.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async list(options = {}) {
      const prefix = options.prefix || '';
      const keys = [];
      for (const k of map.keys()) {
        if (!prefix || k.startsWith(prefix)) {
          keys.push({ name: k });
        }
      }
      return { keys, list_complete: true };
    }
  };
}

test('createD1KvAdapter: put and get work with strings and json', async () => {
  const d1 = createMockD1();
  const adapter = createD1KvAdapter(d1);

  await adapter.put('test_key', 'hello_world');
  const res = await adapter.get('test_key');
  assert.equal(res, 'hello_world');

  await adapter.put('json_key', JSON.stringify({ school: 'Centennial' }));
  const jsonRes = await adapter.get('json_key', 'json');
  assert.deepEqual(jsonRes, { school: 'Centennial' });
});

test('createD1KvAdapter: respects expiration TTL', async () => {
  const d1 = createMockD1();
  const adapter = createD1KvAdapter(d1);

  await adapter.put('expired_key', 'old_val', { expiration: 1000 });
  const expired = await adapter.get('expired_key');
  assert.equal(expired, null);

  await adapter.put('active_key', 'new_val', { expirationTtl: 3600 });
  const active = await adapter.get('active_key');
  assert.equal(active, 'new_val');
});

test('createD1KvAdapter: falls back to legacy KV and backfills D1', async () => {
  const d1 = createMockD1();
  const fallbackKv = createMockKv({ legacy_item: 'from_kv_store' });
  const adapter = createD1KvAdapter(d1, fallbackKv);

  const res = await adapter.get('legacy_item');
  assert.equal(res, 'from_kv_store');

  assert.ok(d1._store.has('legacy_item'));
  assert.equal(d1._store.get('legacy_item').value, 'from_kv_store');
});

test('createD1KvAdapter: delete removes from both D1 and fallback', async () => {
  const d1 = createMockD1();
  const fallbackKv = createMockKv({ item_to_del: 'val' });
  const adapter = createD1KvAdapter(d1, fallbackKv);

  await adapter.put('item_to_del', 'val_in_d1');
  await adapter.delete('item_to_del');

  assert.equal(await adapter.get('item_to_del'), null);
  assert.equal(fallbackKv._map.has('item_to_del'), false);
});

test('createD1KvAdapter: list merges D1 and fallback keys', async () => {
  const d1 = createMockD1();
  const fallbackKv = createMockKv({ 'guild_cfg:111': 'a', 'guild_cfg:222': 'b' });
  const adapter = createD1KvAdapter(d1, fallbackKv);

  await adapter.put('guild_cfg:333', 'c');
  await adapter.put('other_key', 'd');

  const listRes = await adapter.list({ prefix: 'guild_cfg:' });
  const names = listRes.keys.map(k => k.name).sort();
  assert.deepEqual(names, ['guild_cfg:111', 'guild_cfg:222', 'guild_cfg:333']);
});

test('initEnv: wraps env.STATUS_KV when env.DB is present', () => {
  const d1 = createMockD1();
  const originalKv = createMockKv();
  const env = { DB: d1, STATUS_KV: originalKv };

  initEnv(env);
  assert.ok(env._d1_wrapped);
  assert.notEqual(env.STATUS_KV, originalKv);
});

test('initEnv: does nothing when env.DB is missing', () => {
  const originalKv = createMockKv();
  const env = { STATUS_KV: originalKv };

  initEnv(env);
  assert.equal(env._d1_wrapped, undefined);
  assert.equal(env.STATUS_KV, originalKv);
});

test('getD1Stats: returns record count and byte count', async () => {
  const d1 = createMockD1();
  const adapter = createD1KvAdapter(d1);

  await adapter.put('k1', 'value_one');
  await adapter.put('k2', 'value_two');

  const stats = await getD1Stats(d1);
  assert.equal(stats.ok, true);
  assert.equal(stats.totalKeys, 2);
  assert.equal(stats.totalBytes, 18);
});

test('buildD1Section: formats human-readable embed string', () => {
  const stats = { ok: true, totalKeys: 42, totalBytes: 1024 * 1024 };
  const text = buildD1Section(stats);
  assert.match(text, /100,000 \/ day/);
  assert.match(text, /5,000,000 \/ day/);
  assert.match(text, /42 keys/);
  assert.match(text, /1.00 MB \/ 5 GB/);
});

test('formatBytes: handles B, KB, MB', () => {
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
});

test('recordEmailToD1 and searchEmailsInD1: stores and queries announcements', async () => {
  const d1 = createMockD1();
  await recordEmailToD1(d1, {
    id: 'msg-1',
    guildId: 'g1',
    subject: 'Centennial High School Field Trip Information',
    body: 'Please submit your permission slips by Friday.',
    channelId: 'c1',
    messageId: 'm1',
    ts: Date.now(),
    url: 'https://hcpss.org/view/1'
  });

  await recordEmailToD1(d1, {
    id: 'msg-2',
    guildId: 'g1',
    subject: 'Winter Weather Advisory - Two Hour Delay',
    body: 'HCPSS schools opening 2 hours late.',
    channelId: 'c1',
    messageId: 'm2',
    ts: Date.now(),
    url: 'https://hcpss.org/view/2'
  });

  const tripResults = await searchEmailsInD1(d1, 'g1', 'field trip');
  assert.equal(tripResults.length, 1);
  assert.equal(tripResults[0].subject, 'Centennial High School Field Trip Information');

  const weatherResults = await searchEmailsInD1(d1, 'g1', 'delay');
  assert.equal(weatherResults.length, 1);
  assert.equal(weatherResults[0].subject, 'Winter Weather Advisory - Two Hour Delay');

  const stats = await getEmailStats(d1, 'g1');
  assert.equal(stats.total, 2);
  assert.equal(stats.past7Days, 2);
});
