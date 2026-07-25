// Hook-armed caching: when the Apps Script watcher is configured
// (NWS_HOOK_SECRET is set), it fingerprints every external source on its
// 5-minute trigger and pings a hook the moment something really changes,
// which deletes the matching KV cache. Freshness is then push-based, so the
// Worker can trust its context caches for much longer — the long TTL is only
// a safety net for a dead watcher. Without the secret there is no watcher and
// the short TTL is the only freshness mechanism, so it stays as-is.

// Six hours, not one. Every expiry is a write: the next reader refetches and
// re-puts the same unchanged bytes, and the sources that get read on a fixed
// schedule (districts and the news feed hourly via sourcehealth.js, AQI every
// 15 minutes inside its alert window) were each spending ~24 writes/day doing
// exactly that on days nothing changed. With the watcher armed the TTL isn't
// what keeps the cache fresh — /context-hook deletes the key within minutes
// of a real change — it's only the fallback for a watcher that has died, so
// it should be long. The cost of the longer window is that sourcehealth.js
// probes through these same caches, so a source that goes silently empty can
// look healthy for up to a TTL longer than its staleAfterHours threshold;
// scripts/canary.mjs fetches live daily and is the backstop for that.
export const HOOK_ARMED_TTL_SECONDS = 6 * 3600;

export function contextCacheTtl(env, baseTtlSeconds) {
  if (env && env.NWS_HOOK_SECRET) {
    return Math.max(baseTtlSeconds, HOOK_ARMED_TTL_SECONDS);
  }
  return baseTtlSeconds;
}

// Rejecting rapid repeats caps how much KV churn a misbehaving fingerprint
// can cause: an accepted ping deletes caches that the next reader re-fetches
// and re-writes, so unthrottled pings would eat the KV write budget.
export const CONTEXT_HOOK_COOLDOWN_SECONDS = 600;

export function contextHookCooldownKey(source) {
  return `context_hook_cooldown:${source}`;
}
