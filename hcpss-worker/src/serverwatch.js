// Server membership watch: tells the owner (via the home guild's log
// channel) when the bot is added to or removed from a server, so a
// stranger's server can be vetted and locked down the day it appears
// instead of whenever the panel next gets opened.
//
// Polls the bot's own guild list from the Discord API (authoritative — a
// fresh join shows up here before the guild ever runs /setup) every 30
// minutes and diffs it against the stored snapshot. The first run just
// seeds the snapshot silently.

import { discordFetch } from './discord.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { postLog } from './panel.js';

const KNOWN_GUILDS_KEY = 'known_guilds';

// The cron fires every minute; poll on one fixed minute of every thirty. A
// clock gate costs zero KV ops, unlike a TTL cooldown key (~48 writes/day).
// Offset staggers this poll away from the other watchers' gate minutes.
export const SCAN_MINUTE_OFFSET = 11;

// Pure diff for tests. current: [{id, name}], known: { [id]: name }.
export function diffGuilds(current, known) {
  const cur = Array.isArray(current) ? current : [];
  const prev = known && typeof known === 'object' ? known : {};
  const curIds = new Set(cur.map(g => g.id));
  const joined = cur.filter(g => !(g.id in prev));
  const left = Object.entries(prev)
    .filter(([id]) => !curIds.has(id))
    .map(([id, name]) => ({ id, name }));
  return { joined, left };
}

// Runs from the per-minute cron. Never throws.
export async function maybeWatchServerMembership(env, now = new Date()) {
  if (!env || !env.STATUS_KV || !env.DISCORD_BOT_TOKEN) return { changes: 0 };
  if (now.getUTCMinutes() % 30 !== SCAN_MINUTE_OFFSET) return { changes: 0 };

  let current = [];
  try {
    const r = await discordFetch('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
    });
    if (!r.ok) return { changes: 0 };
    const data = await r.json();
    if (!Array.isArray(data)) return { changes: 0 };
    current = data.map(g => ({ id: String(g.id), name: String(g.name || '(unknown)').replace(/`/g, "'") }));
  } catch {
    return { changes: 0 };
  }

  let known = null;
  try {
    const raw = await env.STATUS_KV.get(KNOWN_GUILDS_KEY);
    if (raw) known = JSON.parse(raw);
  } catch {}

  const snapshot = {};
  for (const g of current) snapshot[g.id] = g.name;

  if (!known || typeof known !== 'object') {
    await env.STATUS_KV.put(KNOWN_GUILDS_KEY, JSON.stringify(snapshot));
    return { changes: 0 };
  }

  const { joined, left } = diffGuilds(current, known);
  if (!joined.length && !left.length) return { changes: 0 };

  // Mark before posting so a delayed tick can't double-announce.
  await env.STATUS_KV.put(KNOWN_GUILDS_KEY, JSON.stringify(snapshot));

  const cfg = getEffectiveConfig(await getConfig(env, env.DISCORD_GUILD_ID || ''));
  const channelId = cfg.log_channel_id;
  if (channelId) {
    const lines = [
      ...joined.map(g => `➕ **Bot added to** ${g.name} · \`${g.id}\` — review it on the Worker Updates page (lockdown available).`),
      ...left.map(g => `➖ **Bot removed from** ${g.name} · \`${g.id}\` — its stored data will be purged automatically.`)
    ];
    await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n'), allowed_mentions: { parse: [] } })
    }).catch(() => {});
    await postLog(env, channelId, `🌐 Server membership change: +${joined.length} / −${left.length}.`, {}, env.DISCORD_GUILD_ID || '');
  }

  return { changes: joined.length + left.length };
}
