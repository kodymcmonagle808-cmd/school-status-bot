// Opt-in DM notifications: users toggle via the 🔔 Notify Me button on status
// messages, and get a DM only when the operating status actually changes
// (not on every scheduled repost).
import { discordFetch } from './discord.js';

const MAX_SUBSCRIBERS = 500;

function subsKey(guildId) {
  return `dm_subscribers:${guildId || 'default'}`;
}

export async function getSubscribers(env, guildId) {
  const raw = await env.STATUS_KV.get(subsKey(guildId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Adds the user if absent, removes them if present.
// Returns { subscribed, count } reflecting the new state.
export async function toggleSubscriber(env, guildId, userId) {
  const subs = await getSubscribers(env, guildId);
  const idx = subs.indexOf(userId);
  let subscribed;
  if (idx >= 0) {
    subs.splice(idx, 1);
    subscribed = false;
  } else {
    if (subs.length >= MAX_SUBSCRIBERS) {
      return { subscribed: false, count: subs.length, full: true };
    }
    subs.push(userId);
    subscribed = true;
  }
  await env.STATUS_KV.put(subsKey(guildId), JSON.stringify(subs));
  return { subscribed, count: subs.length };
}

// DMs every subscriber of the guild the given embeds. Individual failures
// (closed DMs, blocked bot) are ignored so one user can't stall the rest.
export async function notifySubscribers(env, guildId, embeds) {
  const subs = await getSubscribers(env, guildId);
  const token = env.DISCORD_BOT_TOKEN;
  if (!subs.length || !token || !Array.isArray(embeds) || !embeds.length) return 0;

  let sent = 0;
  for (const userId of subs) {
    try {
      const chRes = await discordFetch('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ recipient_id: userId })
      });
      if (!chRes.ok) continue;
      const ch = await chRes.json();

      const msgRes = await discordFetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: '🔔 The HCPSS operating status just changed:',
          embeds
        })
      });
      if (msgRes.ok) sent++;
    } catch {}
  }
  return sent;
}
