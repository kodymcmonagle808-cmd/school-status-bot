// Exports every key/value in the Worker's KV namespace to kv_backup.json.
// The namespace holds irreplaceable data (multi-year closure history, yearly
// stats archives, outlook track record, every server's config) — this is the
// only copy outside Cloudflare. Run weekly by .github/workflows/kv_backup.yml,
// which encrypts the file before uploading it as an artifact.
//
// Usage: CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/kv_backup.mjs

import { writeFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const NAMESPACE_TITLE = 'hcpss-status-kv';
const CONCURRENCY = 10;

const token = process.env.CF_API_TOKEN;
const accountId = process.env.CF_ACCOUNT_ID;
if (!token || !accountId) {
  console.error('CF_API_TOKEN and CF_ACCOUNT_ID must be set.');
  process.exit(1);
}

async function cf(path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) }
  });
  if (!r.ok) throw new Error(`Cloudflare API ${r.status} for ${path}`);
  return r;
}

// Same namespace resolution as deploy_worker.sh: exact title first, then the
// newest legacy numbered namespace.
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

async function listAllKeys(nsId) {
  const keys = [];
  let cursor = '';
  do {
    const qs = cursor ? `?limit=1000&cursor=${encodeURIComponent(cursor)}` : '?limit=1000';
    const data = await (await cf(`/accounts/${accountId}/storage/kv/namespaces/${nsId}/keys${qs}`)).json();
    for (const k of data.result || []) keys.push(k.name);
    cursor = (data.result_info && data.result_info.cursor) || '';
  } while (cursor);
  return keys;
}

const nsId = await findNamespaceId();
const keys = await listAllKeys(nsId);
console.log(`Namespace ${nsId}: ${keys.length} keys.`);

const entries = {};
let fetched = 0;
const queue = [...keys];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (;;) {
    const key = queue.shift();
    if (key === undefined) return;
    // Values are stored as text; a 404 means the key expired between the
    // list and the read (cache TTL keys do this) — skip it.
    const r = await fetch(
      `${API}/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`Value fetch ${r.status} for key ${key}`);
    entries[key] = await r.text();
    if (++fetched % 100 === 0) console.log(`  ${fetched} values...`);
  }
}));

writeFileSync('kv_backup.json', JSON.stringify({
  exportedAt: new Date().toISOString(),
  namespaceId: nsId,
  keyCount: Object.keys(entries).length,
  entries
}, null, 1));
console.log(`Wrote kv_backup.json with ${Object.keys(entries).length} entries.`);
