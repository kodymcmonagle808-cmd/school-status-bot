// Per-guild dynamic calendar events stored in KV.
//
// Keys are `calendar_event:<guildId>:<YYYY-MM-DD>`. Events written before
// they were per-server live at the legacy `calendar_event:<YYYY-MM-DD>` key;
// reads fall back to it so old events stay visible, and deletes clear both.

const LEGACY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function getCalendarEvent(env, guildId, ymd) {
  if (guildId) {
    const scoped = await env.STATUS_KV.get(`calendar_event:${guildId}:${ymd}`);
    if (scoped) return scoped;
  }
  return await env.STATUS_KV.get(`calendar_event:${ymd}`);
}

export async function putCalendarEvent(env, guildId, ymd, description) {
  const key = guildId ? `calendar_event:${guildId}:${ymd}` : `calendar_event:${ymd}`;
  await env.STATUS_KV.put(key, description);
}

export async function deleteCalendarEvent(env, guildId, ymd) {
  if (guildId) {
    await env.STATUS_KV.delete(`calendar_event:${guildId}:${ymd}`);
  }
  // Also clear any legacy global event for the date so it doesn't reappear
  // through the read fallback.
  await env.STATUS_KV.delete(`calendar_event:${ymd}`);
}

// Returns [{ dateStr, eventStr }] for this guild, including legacy global
// events, sorted by date. A guild-scoped event wins over a legacy one on the
// same date.
export async function listCalendarEvents(env, guildId) {
  const listResult = await env.STATUS_KV.list({ prefix: 'calendar_event:' });
  const byDate = new Map();

  for (const key of listResult.keys) {
    const rest = key.name.slice('calendar_event:'.length);
    let dateStr = null;
    let scoped = false;

    if (LEGACY_DATE_RE.test(rest)) {
      dateStr = rest;
    } else if (guildId && rest.startsWith(`${guildId}:`)) {
      dateStr = rest.slice(guildId.length + 1);
      scoped = true;
    } else {
      continue; // another guild's event
    }

    if (!scoped && byDate.has(dateStr)) continue;
    const eventStr = await env.STATUS_KV.get(key.name);
    if (eventStr) byDate.set(dateStr, eventStr);
  }

  return [...byDate.entries()]
    .map(([dateStr, eventStr]) => ({ dateStr, eventStr }))
    .sort((a, b) => a.dateStr.localeCompare(b.dateStr));
}
