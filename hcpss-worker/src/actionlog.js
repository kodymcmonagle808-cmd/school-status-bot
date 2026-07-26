// "Everything the Worker did", recorded in Cloudflare's own log store at zero
// KV cost and zero Discord noise.
//
// There are exactly two places a human-readable record of the Worker's actions
// lives, and neither is a chat message:
//
//   1. The control panel's Recent Activity list. postLog() in panel.js keeps a
//      25-line history array in KV and re-renders the panel message in place.
//      That is the user-facing log, and it is the only thing the bot puts in
//      the log channel.
//   2. console.log with an ACT| prefix. Workers Logs (observability.logs in
//      wrangler.toml) already persists these, they cost nothing, and they are
//      queryable from outside Cloudflare — which is what gas/showLogs() reads.
//      This is the authoritative record: it is written the instant the action
//      happens and survives the panel render failing, the guild having no log
//      channel, or Discord being down entirely.
//
// This module owns (2). It deliberately sends nothing to Discord. An earlier
// version buffered lines and flushed them as a batched code-block message into
// each guild's log channel; that turned the log channel into a firehose of
// `07:20:02 · ✅ HCPSS status check posted …` lines restating what the control
// panel above them already said. The panel is the log now — if a line belongs
// in front of a human, it goes through postLog().

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
// omit it for Worker-wide actions. The level is what showLogs() filters on.
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
