// Per-school subscriptions: members register their building with /myschool
// and get a DM when a School-Specific Notice mentions it. The channel posts
// already cover everyone; this is for the family that only cares about one
// school and would otherwise miss a low-key no-ping notice.

import { discordFetch } from './discord.js';

const MAX_SUBSCRIPTIONS = 500;
export const MAX_SCHOOL_NAME_LENGTH = 80;

function subsKey(guildId) {
  return `school_subs:${guildId || 'default'}`;
}

// { userId: schoolName } for the guild.
export async function getSchoolSubscriptions(env, guildId) {
  const raw = await env.STATUS_KV.get(subsKey(guildId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Returns { ok, full } — full when the guild map is at capacity and the user
// isn't already in it (updating an existing entry always works).
export async function setSchoolSubscription(env, guildId, userId, schoolName) {
  const subs = await getSchoolSubscriptions(env, guildId);
  if (!(userId in subs) && Object.keys(subs).length >= MAX_SUBSCRIPTIONS) {
    return { ok: false, full: true };
  }
  subs[userId] = String(schoolName).slice(0, MAX_SCHOOL_NAME_LENGTH);
  await env.STATUS_KV.put(subsKey(guildId), JSON.stringify(subs));
  return { ok: true, full: false };
}

// Returns the removed school name, or null if the user had none.
export async function clearSchoolSubscription(env, guildId, userId) {
  const subs = await getSchoolSubscriptions(env, guildId);
  if (!(userId in subs)) return null;
  const removed = subs[userId];
  delete subs[userId];
  await env.STATUS_KV.put(subsKey(guildId), JSON.stringify(subs));
  return removed;
}

// A notice matches when every meaningful word of the stored school name
// appears in it. Generic school-type words are ignored so "Centennial High
// School" still matches a notice that just says "Centennial High", but a name
// that is ONLY generic words ("Elementary School") never matches everything.
const GENERIC_WORDS = new Set(['school', 'schools', 'the', 'of', 'at']);

export function noticeMatchesSchool(noticeText, schoolName) {
  const text = String(noticeText || '').toLowerCase();
  if (!text) return false;
  const tokens = String(schoolName || '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(t => t.length > 1 && !GENERIC_WORDS.has(t));
  if (!tokens.length) return false;
  return tokens.every(t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
}

// DMs every subscriber (across the given guilds) whose school appears in the
// notice, deduped by user so someone in two servers gets one DM. Individual
// failures are ignored. Returns the number of DMs delivered.
export async function notifySchoolSubscribers(env, guildIds, noticeEmbed, noticeText) {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token || !noticeText) return 0;

  const matchedUsers = new Set();
  for (const gid of Array.isArray(guildIds) ? guildIds : []) {
    try {
      const subs = await getSchoolSubscriptions(env, gid);
      for (const [userId, school] of Object.entries(subs)) {
        if (noticeMatchesSchool(noticeText, school)) matchedUsers.add(userId);
      }
    } catch {}
  }

  let sent = 0;
  for (const userId of matchedUsers) {
    try {
      const chRes = await discordFetch('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: userId })
      });
      if (!chRes.ok) continue;
      const ch = await chRes.json();

      const msgRes = await discordFetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '🏫 A notice mentions your school (set with `/myschool`):',
          embeds: [noticeEmbed]
        })
      });
      if (msgRes.ok) sent++;
    } catch {}
  }
  return sent;
}
