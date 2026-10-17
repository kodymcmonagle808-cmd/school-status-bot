// Restores a KV backup produced by kv_backup.mjs (after decrypting the
// artifact: openssl enc -d -aes-256-cbc -pbkdf2 -in kv_backup.json.enc -out
// kv_backup.json). Writes in bulk batches of 100. Defaults to a dry run —
// pass --write to actually modify the namespace, and it always targets the
// same namespace resolution as deploys.
//
// Usage:
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/kv_restore.mjs kv_backup.json           # dry run
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/kv_restore.mjs kv_backup.json --write   # restore

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const NAMESPACE_TITLE = 'hcpss-status-kv';
const BATCH_SIZE = 100;

const token = process.env.CF_API_TOKEN;
const accountId = process.env.CF_ACCOUNT_ID;
const file = process.argv[2];
const write = process.argv.includes('--write');

if (!token || !accountId || !file) {
  console.error('Usage: CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/kv_restore.mjs <backup.json> [--write]');
  process.exit(1);
}

let backup;
try {
  backup = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`Could not read backup file: ${e.message}`);
  process.exit(1);
}
if (!backup || typeof backup.entries !== 'object' || !backup.exportedAt) {
  console.error('File does not look like a kv_backup.mjs export (missing entries/exportedAt).');
  process.exit(1);
}

const keys = Object.keys(backup.entries);
console.log(`Backup from ${backup.exportedAt}: ${keys.length} entries (namespace ${backup.namespaceId} at export time).`);

async function cf(path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) }
  });
  if (!r.ok) throw new Error(`Cloudflare API ${r.status} for ${path}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

async function findNamespaceId() {
  const data = await (await cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`)).json();
  const namespaces = data.result || [];
  const exact = namespaces.find(n => n.title === NAMESPACE_TITLE);
  if (exact) return exact.id;
  const legacy = namespaces
    .filter(n => /^hcpss-status-kv-\d+$/.test(n.title))
    .sort((a, b) => a.title.localeCompare(b.title))
    .pop();
  if (legacy) return legacy.id;
  throw new Error(`No KV namespace titled ${NAMESPACE_TITLE} found.`);
}

const nsId = await findNamespaceId();

if (!write) {
  console.log(`DRY RUN — would write ${keys.length} keys to namespace ${nsId}. Sample keys:`);
  for (const k of keys.slice(0, 15)) console.log(`  ${k}`);
  if (keys.length > 15) console.log(`  ... and ${keys.length - 15} more`);
  console.log('\nRe-run with --write to restore. Existing values for these keys will be OVERWRITTEN.');
  process.exit(0);
}

console.log(`Restoring ${keys.length} keys to namespace ${nsId}...`);
for (let i = 0; i < keys.length; i += BATCH_SIZE) {
  const batch = keys.slice(i, i + BATCH_SIZE).map(key => ({ key, value: backup.entries[key] }));
  await cf(`/accounts/${accountId}/storage/kv/namespaces/${nsId}/bulk`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch)
  });
  console.log(`  ${Math.min(i + BATCH_SIZE, keys.length)}/${keys.length}`);
}
console.log('Restore complete.');
