// KV usage metering for the Cloudflare free-plan budget.
//
// The whole codebase rations KV writes (per-minute cron, ~100-write/day
// heartbeat, "read guild_index never KV.list()") because the free plan caps
// writes/deletes/lists at 1,000/day and reads at 100,000/day. Nothing surfaced
// *how close* we run to those ceilings — this meter does, feeding the bars on
// the owner-only Worker Updates page.
//
// It works by wrapping the KV namespace in a counter (wrapKv) at the top of
// every Worker invocation, so all downstream `env.STATUS_KV.*` calls tally
// automatically, then folding the tally into one daily counter key at the end
// (flushKvUsage).
//
// The catch: persisting the tally is itself a write, and one write per minute
// would blow the very budget it measures. So the flush only spends a write on
// invocations that ALREADY performed one. That makes write/delete usage — the
// binding free-plan constraint — counted exactly, while reads/lists that occur
// on write-free minutes go uncounted. Reads are the abundant resource
// (100k/day) and lists are avoided in per-minute paths, so under-counting them
// is acceptable; the display labels them best-effort.

export const USAGE_KEY = 'kv_usage';

// Cloudflare KV free-plan daily limits (reset at 00:00 UTC).
export const KV_FREE_LIMITS = { reads: 100000, writes: 1000, deletes: 1000, lists: 1000 };

const WRAPPED = Symbol.for('kvMeterWrapped');

export function makeCounts() {
  return { reads: 0, writes: 0, deletes: 0, lists: 0 };
}

// UTC day string, matching when Cloudflare resets the daily quota.
export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// Returns a metering wrapper around a KV namespace. Idempotent: an already
// wrapped namespace (or a falsy binding) is returned untouched, so re-wrapping
// a reused `env` across invocations can't stack proxies. The live tally is on
// `.__counts`.
export function wrapKv(kv) {
  if (!kv || kv[WRAPPED]) return kv;
  const counts = makeCounts();
  return {
    [WRAPPED]: true,
    __counts: counts,
    get: (...a) => { counts.reads++; return kv.get(...a); },
    getWithMetadata: (...a) => { counts.reads++; return kv.getWithMetadata(...a); },
    put: (...a) => { counts.writes++; return kv.put(...a); },
    delete: (...a) => { counts.deletes++; return kv.delete(...a); },
    list: (...a) => { counts.lists++; return kv.list(...a); }
  };
}

// Folds today's UTC counts into the running daily total. Pure math, split out
// so tests can exercise rollover without KV. `add` is this invocation's counts
// including the flush's own read+write.
export function foldUsage(stored, add, now = Date.now()) {
  const day = utcDay(now);
  const base = stored && typeof stored === 'object' && stored.day === day
    ? stored
    : { day, reads: 0, writes: 0, deletes: 0, lists: 0, since: now };
  return {
    day,
    reads: (Number(base.reads) || 0) + (Number(add.reads) || 0),
    writes: (Number(base.writes) || 0) + (Number(add.writes) || 0),
    deletes: (Number(base.deletes) || 0) + (Number(add.deletes) || 0),
    lists: (Number(base.lists) || 0) + (Number(add.lists) || 0),
    since: Number(base.since) || now
  };
}

// Persists the invocation's tally. Call once at the end of an invocation.
// Never throws. Skips the write entirely on write-free invocations so the
// meter stays inside the budget it is guarding.
export async function flushKvUsage(kv, now = Date.now()) {
  try {
    const counts = kv && kv.__counts;
    if (!counts) return;
    if (counts.writes + counts.deletes === 0) return;

    // Account for this flush's own read (of USAGE_KEY) and write before they
    // happen, so the meter counts itself — erring high, which is the safe
    // direction for a budget warning.
    const add = {
      reads: counts.reads + 1,
      writes: counts.writes + 1,
      deletes: counts.deletes,
      lists: counts.lists
    };

    let stored = null;
    try {
      const raw = await kv.get(USAGE_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch {}

    const usage = foldUsage(stored, add, now);
    await kv.put(USAGE_KEY, JSON.stringify(usage));
  } catch {}
}
