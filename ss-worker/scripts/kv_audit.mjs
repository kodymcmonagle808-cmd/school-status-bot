// Audits the KV namespace for orphaned per-guild keys: keys ending in
// `:<guild snowflake>` whose guild is no longer in guild_index. Orphans mean
// a purge missed something (a key not registered in cleanup.js guildKeys())
// — evidence the Privacy Policy purge promise needs attention. Report-only:
// this script never deletes; exits 1 when orphans are found so CI can open
// an issue. Run monthly by .github/workflows/kv_audit.yml.
//
// Usage: CF_API_TOKEN=... CF_ACCOUNT_ID=... [DISCORD_GUILD_ID=...] node scripts/kv_audit.mjs

const API = 'https://api.cloudflare.com/client/v4';
const NAMESPACE_TITLE = 'hcpss-status-kv';

const token = process.env.CF_API_TOKEN;
const accountId = process.env.CF_ACCOUNT_ID;

async function cf(path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) }
  });
  if (!r.ok) throw new Error(`Cloudflare API ${r.status} for ${path}`);
  return r;
}

// Same namespace resolution as deploy_worker.sh and kv_backup.mjs.
async function findNamespaceId() {
  const data = await (await cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`)).json();
  const namespaces = data.result || [];
  const exact = namespaces.find(n => n.title === NAMESPACE_TITLE);
  if (exact) return exact.id;
  const legacy = namespaces
    .filter(n => /^hcpss-status-kv-\d+$/.test(n.title))
    .sort((a, b) => a.title.localeCompare(b.title))
    .pop();
  if (!legacy) throw new Error('KV namespace not found.');
  return legacy.id;
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

// Pure so tests can exercise the classification without the API. A per-guild
// key is `<base>:<17-20 digit snowflake>`; anything else (config:default,
// slot keys, global keys) is out of scope.
export function findOrphanedKeys(keys, knownGuildIds) {
  const known = new Set((knownGuildIds || []).map(String).filter(Boolean));
  const orphans = new Map();
  for (const key of keys || []) {
    const m = /^(.+):(\d{17,20})$/.exec(key);
    if (!m) continue;
    const guildId = m[2];
    if (known.has(guildId)) continue;
    if (!orphans.has(guildId)) orphans.set(guildId, []);
    orphans.get(guildId).push(key);
  }
  return orphans;
}

// Only audit when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('kv_audit.mjs')) {
  if (!token || !accountId) {
    console.error('CF_API_TOKEN and CF_ACCOUNT_ID must be set.');
    process.exit(1);
  }
  const nsId = await findNamespaceId();
  const keys = await listAllKeys(nsId);
  console.log(`Namespace ${nsId}: ${keys.length} keys.`);

  let index = [];
  try {
    const r = await fetch(
      `${API}/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/guild_index`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (r.ok) {
      const parsed = JSON.parse(await r.text());
      if (Array.isArray(parsed)) index = parsed.filter(Boolean);
    }
  } catch {}
  if (index.length === 0) {
    console.error('guild_index is missing or empty — refusing to audit (everything would look orphaned).');
    process.exit(1);
  }
  if (process.env.DISCORD_GUILD_ID) index.push(process.env.DISCORD_GUILD_ID);

  const orphans = findOrphanedKeys(keys, index);
  if (orphans.size === 0) {
    console.log(`No orphaned per-guild keys. ${index.length} known guild(s).`);
    process.exit(0);
  }

  console.log(`ORPHANS FOUND — per-guild keys for ${orphans.size} guild(s) not in guild_index:`);
  for (const [guildId, guildKeys] of orphans) {
    console.log(`  guild ${guildId} (${guildKeys.length} key(s)):`);
    for (const k of guildKeys) console.log(`    ${k}`);
  }
  console.log('These keys were NOT deleted. If a base key name is missing from guildKeys() in cleanup.js, add it there; then purge manually.');
  process.exit(1);
}
