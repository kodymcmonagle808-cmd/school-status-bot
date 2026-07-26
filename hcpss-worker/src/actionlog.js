// "Everything the Worker did" — one batched Discord log post per invocation,
// and a permanent copy in Cloudflare's own log store, at zero KV cost.
//
// The existing postLog() in panel.js is the *control panel* logger: it keeps a
// 25-line history array in KV and re-renders the dashboard message. That costs
// two to three KV writes per call, which is fine for the handful of
// user-visible events it was built for and completely unaffordable as a
// general "log every action" mechanism — the free plan allows 1,000 writes a
// day and the panel logger alone would eat it.
//
// So this module writes nothing to KV. Every line goes two places:
//
//   1. console.log with an ACT| prefix. Workers Logs (observability.logs in
//      wrangler.toml) already persists these, they cost nothing, and they are
//      queryable from outside Cloudflare — which is what gas/showLogs() reads.
//      This is the authoritative record: it is written the instant the action
//      happens and survives the Discord post failing, the guild having no log
//      channel, or the whole flush being skipped.
//   2. An in-memory buffer, flushed as a single Discord message at the end of
//      the invocation. One API call per invocation that did something, and
//      nothing at all on a quiet tick.
//
// The buffer is module-level rather than threaded through every watcher as a
// parameter. Workers reuses an isolate across invocations, so in principle two
// overlapping invocations could interleave lines into one batch. That is
// acceptable here precisely because the console.log copy is authoritative and
// exact — the worst case for the Discord copy is a line appearing in an
// adjacent batch, never a line being lost.

import { getConfig, getEffectiveConfig } from './config.js';
import { discordFetch } from './discord.js';

const MAX_BUFFERED_LINES = 60;
const DISCORD_MESSAGE_LIMIT = 1900; // 2000, minus room for the code fence

let buffer = [];

// Starts a fresh batch. Called at the top of the cron tick and of each hook.
export function beginActionLog() {
  buffer = [];
}

// Records one action. `guildId` scopes the line to a single server's log
// channel; omit it for Worker-wide actions, which go to every log channel.
// Never throws — logging must never be able to break the thing it is logging.
export function logAction(message, { guildId = '', level = 'info' } = {}) {
  const text = String(message || '').trim();
  if (!text) return;
  try {
    // Authoritative copy: free, immediate, and queryable from Apps Script.
    console.log(`ACT|${new Date().toISOString()}|${level}|${guildId || '-'}|${text}`);
  } catch {}
  if (buffer.length < MAX_BUFFERED_LINES) {
    buffer.push({ text, guildId, level, at: Date.now() });
  } else if (buffer.length === MAX_BUFFERED_LINES) {
    buffer.push({ text: '… further lines omitted from this batch', guildId: '', level: 'info', at: Date.now() });
  }
}

// Convenience wrapper so failures read differently in Discord and can be
// filtered in the Apps Script viewer.
export function logActionError(message, { guildId = '' } = {}) {
  logAction(message, { guildId, level: 'error' });
}

export function getBufferedActions() {
  return buffer.slice();
}

function timeStr(ms) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(ms));
  } catch {
    return '--:--:--';
  }
}

// Renders a guild's slice of the batch into Discord code blocks, each within
// the message limit. Pure and exported for tests.
export function formatActionBatch(lines) {
  const rendered = lines.map(l => `${timeStr(l.at)} ${l.level === 'error' ? '✖' : '·'} ${l.text}`);
  const chunks = [];
  let current = '';
  for (const line of rendered) {
    const piece = line.length > DISCORD_MESSAGE_LIMIT
      ? `${line.slice(0, DISCORD_MESSAGE_LIMIT - 1)}…`
      : line;
    if (current && current.length + piece.length + 1 > DISCORD_MESSAGE_LIMIT) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks.map(c => '```\n' + c + '\n```');
}

// Posts the batch to every guild that has a log channel and has not turned
// the feed off, then clears the buffer. Costs zero KV writes; the only KV
// reads are the guild index and each guild's config, and only when there is
// something to say. Never throws.
export async function flushActionLog(env) {
  const lines = buffer;
  buffer = [];
  if (!lines.length) return { posted: 0 };
  if (!env || !env.STATUS_KV || !env.DISCORD_BOT_TOKEN) return { posted: 0 };

  let guildIds = [];
  try {
    const rawIndex = await env.STATUS_KV.get('guild_index');
    const parsed = rawIndex ? JSON.parse(rawIndex) : [];
    if (Array.isArray(parsed)) guildIds = parsed.filter(Boolean);
  } catch {}
  if (env.DISCORD_GUILD_ID && !guildIds.includes(env.DISCORD_GUILD_ID)) {
    guildIds.push(env.DISCORD_GUILD_ID);
  }

  let posted = 0;
  for (const gid of guildIds) {
    try {
      const cfg = getEffectiveConfig(await getConfig(env, gid));
      if (!cfg.log_channel_id) continue;
      if (cfg.toggle_action_log === false) continue;

      // Worker-wide lines plus this guild's own.
      const mine = lines.filter(l => !l.guildId || l.guildId === gid);
      if (!mine.length) continue;

      for (const chunk of formatActionBatch(mine)) {
        const resp = await discordFetch(`https://discord.com/api/v10/channels/${cfg.log_channel_id}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ content: chunk, allowed_mentions: { parse: [] } })
        });
        if (resp.ok) posted++;
      }
    } catch (e) {
      console.error(`Action log flush failed for guild ${gid}:`, e);
    }
  }
  return { posted };
}
