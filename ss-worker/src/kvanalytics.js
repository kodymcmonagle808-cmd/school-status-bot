// KV usage gauge for the owner-only Worker Updates page.
//
// This reads Cloudflare's own GraphQL Analytics API for the day's KV operation
// counts instead of tallying them ourselves. The earlier approach persisted a
// counter to KV, which meant one extra WRITE per already-writing cron tick —
// on the free plan (1,000 writes/day) that roughly doubled the write load it
// was meant to protect and could tip the account over its cap. Reading the
// analytics API costs zero KV writes.
//
// Everything degrades to a described state ({configured:false} / {error}) and
// never throws — the panel must render regardless. The only KV write here is a
// 5-minute cache of a successful result, and only when the owner views the
// page, so it is effectively free.

const CACHE_KEY = 'kv_usage_cache';
const CACHE_TTL_SECONDS = 300;
const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

// Cloudflare KV free-plan daily limits (reset at 00:00 UTC).
export const KV_FREE_LIMITS = { reads: 100000, writes: 1000, deletes: 1000, lists: 1000 };

// Start of the current UTC day in ms — the quota's reset boundary.
export function utcDayStartMs(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
}

// The GraphQL body for the day's KV operations on one namespace, grouped by
// operation type. Pure and inlined (no variables) so it's trivially testable
// and free of scalar-type mismatches.
export function buildKvOpsQuery(accountTag, namespaceId, startIso, endIso) {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        kvOperationsAdaptiveGroups(
          limit: 100,
          filter: { datetime_geq: "${startIso}", datetime_leq: "${endIso}", namespaceId: "${namespaceId}" }
        ) {
          sum { requests }
          dimensions { actionType }
        }
      }
    }
  }`;
  return { query };
}

// Folds a CF GraphQL response into { reads, writes, deletes, lists }. Unknown
// action types are ignored. Tolerant of missing/partial shapes.
export function parseKvOperations(json) {
  const counts = { reads: 0, writes: 0, deletes: 0, lists: 0 };
  const map = { read: 'reads', write: 'writes', delete: 'deletes', list: 'lists' };
  const groups = json?.data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups;
  if (!Array.isArray(groups)) return counts;
  for (const g of groups) {
    const key = map[g?.dimensions?.actionType];
    if (key) counts[key] += Number(g?.sum?.requests) || 0;
  }
  return counts;
}

// Returns the day's KV usage for the panel. Shapes:
//   { configured: false, reason }            — secrets/binding not set
//   { configured: true, error }              — API/query failed
//   { configured: true, reads, writes, ... } — success
// Never throws.
export async function getKvUsage(env, now = Date.now()) {
  try {
    const raw = await env.STATUS_KV.get(CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (c && typeof c.at === 'number' && now - c.at < CACHE_TTL_SECONDS * 1000 && c.data) {
        return c.data;
      }
    }
  } catch {}

  const token = env.CF_API_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  const nsId = env.KV_NAMESPACE_ID;
  if (!token || !account || !nsId) {
    return { configured: false, reason: 'Set CF_API_TOKEN, CF_ACCOUNT_ID, and KV_NAMESPACE_ID.' };
  }

  let data;
  try {
    const startIso = new Date(utcDayStartMs(now)).toISOString();
    const endIso = new Date(now).toISOString();
    const r = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildKvOpsQuery(account, nsId, startIso, endIso))
    });
    let json = null;
    try { json = await r.json(); } catch {}
    const gqlError = json?.errors?.[0]?.message;
    if (!r.ok || gqlError) {
      return { configured: true, error: String(gqlError || `HTTP ${r.status}`).slice(0, 140) };
    }
    data = { configured: true, ...parseKvOperations(json) };
  } catch (e) {
    return { configured: true, error: String(e?.message || 'analytics fetch failed').slice(0, 140) };
  }

  await env.STATUS_KV.put(CACHE_KEY, JSON.stringify({ at: now, data }), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => {});
  return data;
}
