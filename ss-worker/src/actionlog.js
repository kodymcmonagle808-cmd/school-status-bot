// "Everything the Worker did", recorded in Cloudflare's own log store at zero
// KV cost and zero Discord noise.
//
// There are exactly two places a human-readable record of the Worker's actions
// lives, and neither is a chat message:
//
//   1. console.log with an ACT| prefix. Workers Logs (observability.logs in
//      wrangler.toml) already persists these, they cost nothing, and they are
//      queryable from outside Cloudflare — which is what the control panel's
//      System Logs page (src/workerlogs.js) and gas/showLogs() both read. This
//      is the authoritative record of everything the Worker did: it is written
//      the instant the action happens and survives the panel render failing,
//      the guild having no log channel, or Discord being down entirely.
//   2. The control panel's Recent Activity list. postLog() in panel.js keeps a
//      25-line history array in KV and re-renders the panel message in place.
//      A line there costs a KV write against a 1,000/day cap, so it is
//      reserved for what a server's staff must see in Discord itself: status
//      posts, and failures that stop updates reaching members.
//
// This module owns (1) and is where every other action goes. It deliberately
// sends nothing to Discord. An earlier version buffered lines and flushed them
// as a batched code-block message into each guild's log channel; that turned
// the log channel into a firehose of `07:20:02 · ✅ HCPSS status check posted …`
// lines restating what the control panel above them already said.

const LEVELS = new Set(['info', 'error', 'detail']);

// Writes one line to Cloudflare's log store. Free, immediate, survives
// everything downstream failing, and queryable from Apps Script via
// showLogs(). Every level goes here — this is the firehose.
function writeConsole(level, guildId, text) {
  try {
    console.log(`ACT|${new Date().toISOString()}|${level}|${guildId || '-'}|${text}`);
  } catch {}
}

// Records one action worth a human's attention: a post that went out, a status
// change, a configuration edit. `guildId` scopes the line to a single server;
// omit it for Worker-wide actions. Scoping matters for more than tidiness — the
// System Logs page shows a guild only its own lines plus the unscoped ones, so
// a line about server A tagged with no guild is visible to server B.
// The level is what the page's filters and showLogs() key off.
// Never throws — logging must never be able to break the thing it is logging.
export function logAction(message, { guildId = '', level = 'info' } = {}) {
  const text = String(message || '').trim();
  if (!text) return;
  writeConsole(LEVELS.has(level) ? level : 'info', guildId, text);
}

// Records routine plumbing — a stored feed, a cache write. Same destination as
// logAction, tagged 'detail' so the Apps Script viewer can filter it out of a
// day's stream: the collector hands over changed feeds every few minutes all
// day, and those lines would otherwise bury the ones that mattered.
export function logDetail(message, { guildId = '' } = {}) {
  logAction(message, { guildId, level: 'detail' });
}

// Convenience wrapper so failures can be filtered in the Apps Script viewer.
// Watcher failures are also counted in watcherhealth.js and surfaced on the
// owner-only Worker Updates panel page, which is where they reach a human.
export function logActionError(message, { guildId = '' } = {}) {
  logAction(message, { guildId, level: 'error' });
}
