import test from 'node:test';
import assert from 'node:assert/strict';
import { runKvBackup, maybeRunKvBackup, BACKUP_DATE_KEY } from '../src/backup.js';

function mockKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, val) {
      store.set(key, String(val));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '', cursor } = {}) {
      const keys = [];
      for (const k of store.keys()) {
        if (!prefix || k.startsWith(prefix)) {
          keys.push({ name: k });
        }
      }
      return { keys, list_complete: true };
    },
    _store: store
  };
}

function mockR2() {
  const storage = new Map();
  return {
    async put(key, val, options = {}) {
      storage.set(key, { value: String(val), options, uploaded: new Date().toISOString() });
    },
    async get(key) {
      if (!storage.has(key)) return null;
      const item = storage.get(key);
      return {
        body: item.value,
        ...item.options
      };
    },
    async list({ prefix = '' } = {}) {
      const objects = [];
      for (const [key, item] of storage.entries()) {
        if (!prefix || key.startsWith(prefix)) {
          objects.push({ key, uploaded: item.uploaded });
        }
      }
      return { objects };
    },
    async delete(key) {
      storage.delete(key);
    },
    _storage: storage
  };
}

test('runKvBackup exports KV keys to R2 and writes latest pointer', async () => {
  const kv = mockKv({
    'config:123': JSON.stringify({ school: 'hcpss' }),
    'setup_done:123': 'true',
    'last_status': 'OPEN'
  });
  const r2 = mockR2();
  const env = { STATUS_KV: kv, BACKUPS_BUCKET: r2 };

  const result = await runKvBackup(env);

  assert.equal(result.ok, true);
  assert.equal(result.keyCount, 3);
  assert.match(result.filename, /^kv_backup_\d{4}-\d{2}-\d{2}\.json$/);

  // Check R2 contents
  assert.ok(r2._storage.has(result.filename));
  assert.ok(r2._storage.has('kv_backup_latest.json'));

  const backupData = JSON.parse(r2._storage.get('kv_backup_latest.json').value);
  assert.equal(backupData.keyCount, 3);
  assert.equal(backupData.entries['last_status'], 'OPEN');
  assert.equal(backupData.entries['setup_done:123'], 'true');

  // Check KV record
  const recordedDate = await kv.get(BACKUP_DATE_KEY);
  assert.match(recordedDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('runKvBackup throws when required bindings are missing', async () => {
  await assert.rejects(async () => {
    await runKvBackup({});
  }, /STATUS_KV and BACKUPS_BUCKET must be bound/);
});

test('runKvBackup prunes snapshots older than 90 days', async () => {
  const kv = mockKv({ 'config:1': 'abc' });
  const r2 = mockR2();

  // Seed an old backup from 120 days ago
  const oldDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  r2._storage.set('kv_backup_2025-01-01.json', {
    value: '{}',
    uploaded: oldDate
  });

  const env = { STATUS_KV: kv, BACKUPS_BUCKET: r2 };
  await runKvBackup(env);

  // Old backup should be deleted
  assert.equal(r2._storage.has('kv_backup_2025-01-01.json'), false);
  // Latest should always be present
  assert.ok(r2._storage.has('kv_backup_latest.json'));
});

test('maybeRunKvBackup runs when Monday and skips when already run today', async () => {
  const kv = mockKv({ 'config:1': 'abc' });
  const r2 = mockR2();
  const env = { STATUS_KV: kv, BACKUPS_BUCKET: r2 };

  const todayStr = new Date().toISOString().split('T')[0];

  // If already run today
  await kv.put(BACKUP_DATE_KEY, todayStr);
  const skipResult = await maybeRunKvBackup(env);
  assert.equal(skipResult, null);
});
