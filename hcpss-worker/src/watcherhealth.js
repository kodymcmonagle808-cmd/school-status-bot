// Per-watcher failure counters. Watchers are deliberately wrapped in
// try/catch so a broken side feature can never block the status post — the
// tradeoff is that breakage is silent. Each catch calls recordWatcherError,
// and the owner-only Worker Updates panel page surfaces the counters.
//
// Writes are throttled to one per watcher per hour so a persistently broken
// watcher on the every-minute cron can't drain the KV free-plan write budget;
// `count` is therefore "distinct failure hours", not raw error count.

const WATCHER_ERRORS_KEY = 'watcher_errors';
const WRITE_THROTTLE_MS = 60 * 60 * 1000;

export async function recordWatcherError(env, name, error) {
  try {
    if (!env || !env.STATUS_KV || !name) return;

    let data = {};
    try {
      const raw = await env.STATUS_KV.get(WATCHER_ERRORS_KEY);
      if (raw) data = JSON.parse(raw) || {};
    } catch {}

    const now = Date.now();
    const entry = data[name] && typeof data[name] === 'object' ? data[name] : { count: 0, last: 0 };
    if (now - Number(entry.last || 0) < WRITE_THROTTLE_MS) return;

    data[name] = {
      count: Number(entry.count || 0) + 1,
      last: now,
      msg: String((error && error.message) || error || '').slice(0, 120)
    };
    await env.STATUS_KV.put(WATCHER_ERRORS_KEY, JSON.stringify(data));
  } catch {}
}

export async function getWatcherErrors(env) {
  try {
    const raw = await env.STATUS_KV.get(WATCHER_ERRORS_KEY);
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

// Pure formatter for the owner stats page: most recent failures first.
export function formatWatcherErrors(data, maxLines = 6) {
  const entries = Object.entries(data && typeof data === 'object' ? data : {})
    .filter(([, v]) => v && Number(v.count) > 0)
    .sort((a, b) => Number(b[1].last || 0) - Number(a[1].last || 0));
  if (entries.length === 0) return '✅ No watcher errors recorded.';
  return entries.slice(0, maxLines).map(([name, v]) => {
    const when = Number(v.last) > 0 ? `<t:${Math.floor(Number(v.last) / 1000)}:R>` : 'unknown';
    const msg = v.msg ? ` — \`${v.msg}\`` : '';
    return `⚠️ **${name}** · ${Number(v.count)} failure hour(s) · last ${when}${msg}`;
  }).join('\n');
}
