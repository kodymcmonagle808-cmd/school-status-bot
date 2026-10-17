// Owner-controlled server lockdown. Blocked guilds get no posts (they are
// removed from guild_index, which every cron watcher reads) and no
// interactions (interactions.js refuses them; the owner is exempt so they
// can still investigate). Managed from the owner-only Worker Updates panel
// page. The home guild (env.DISCORD_GUILD_ID) can never be blocked — several
// cron paths force-include it.

const BLOCKLIST_KEY = 'guild_blocklist';

export async function getBlockedGuilds(env) {
  try {
    const raw = await env.STATUS_KV.get(BLOCKLIST_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
}

export async function isGuildBlocked(env, guildId) {
  if (!guildId) return false;
  return (await getBlockedGuilds(env)).includes(String(guildId));
}

export async function setGuildBlocked(env, guildId, blocked) {
  const gid = String(guildId || '');
  if (!gid) return;
  if (blocked && env.DISCORD_GUILD_ID && gid === env.DISCORD_GUILD_ID) return;

  const list = await getBlockedGuilds(env);
  const next = blocked
    ? (list.includes(gid) ? list : [...list, gid])
    : list.filter(id => id !== gid);
  await env.STATUS_KV.put(BLOCKLIST_KEY, JSON.stringify(next));

  // Keep guild_index in sync: blocked guilds must vanish from it (it's what
  // every per-minute watcher iterates), and unblocked guilds come back.
  try {
    let index = [];
    const rawIndex = await env.STATUS_KV.get('guild_index');
    if (rawIndex) {
      try { index = JSON.parse(rawIndex); } catch {}
    }
    if (!Array.isArray(index)) index = [];
    const updated = blocked
      ? index.filter(id => id !== gid)
      : (index.includes(gid) ? index : [...index, gid]);
    if (updated.length !== index.length) {
      await env.STATUS_KV.put('guild_index', JSON.stringify(updated));
    }
  } catch {}
}

export async function removeFromBlocklist(env, guildId) {
  const gid = String(guildId || '');
  try {
    const list = await getBlockedGuilds(env);
    if (list.includes(gid)) {
      await env.STATUS_KV.put(BLOCKLIST_KEY, JSON.stringify(list.filter(id => id !== gid)));
    }
  } catch {}
}
