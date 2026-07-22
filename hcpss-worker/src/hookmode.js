// Hook-armed caching: when the Apps Script watcher is configured
// (NWS_HOOK_SECRET is set), it fingerprints every external source on its
// 5-minute trigger and pings a hook the moment something really changes,
// which deletes the matching KV cache. Freshness is then push-based, so the
// Worker can trust its context caches for much longer — the long TTL is only
// a safety net for a dead watcher. Without the secret there is no watcher and
// the short TTL is the only freshness mechanism, so it stays as-is.

export const HOOK_ARMED_TTL_SECONDS = 3600;

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
