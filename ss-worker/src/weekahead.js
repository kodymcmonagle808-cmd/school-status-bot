// Sunday evening week-ahead preview: automatically posts a summary of the
// upcoming Monday–Friday school week (A/B days, scheduled closures, early dismissals)
// to each opted-in guild's alert channel on Sunday at 7:00 PM Eastern.

import { getSessionInfo } from './session.js';
import { getABDay, closureDatesFromHistory } from './abday.js';
import { getStatusHistory } from './history.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { postMessageToChannel } from './discord.js';
import { logAction } from './actionlog.js';

/**
 * Returns true if the given date is Sunday in America/New_York and within
 * the 19:00 (7:00 PM) hour window.
 */
export function isSundayEvening(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    hour12: false
  }).formatToParts(date);

  const weekday = parts.find(p => p.type === 'weekday')?.value;
  const hour = Number(parts.find(p => p.type === 'hour')?.value);

  return weekday === 'Sun' && hour === 19;
}

/**
 * Returns an array of YYYY-MM-DD date strings for Monday through Friday
 * of the upcoming school week following the given date.
 */
export function getUpcomingWeekDays(date = new Date()) {
  // Find upcoming Monday
  const d = new Date(date);
  const easternFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  
  // Format current date in Eastern
  const parts = easternFormatter.formatToParts(d);
  const year = Number(parts.find(p => p.type === 'year')?.value);
  const month = Number(parts.find(p => p.type === 'month')?.value) - 1;
  const day = Number(parts.find(p => p.type === 'day')?.value);
  
  const estDate = new Date(Date.UTC(year, month, day));
  const dayOfWeek = estDate.getUTCDay(); // 0 = Sun, 1 = Mon ...
  const daysUntilMonday = (dayOfWeek === 0 ? 1 : (8 - dayOfWeek));

  const monday = new Date(estDate.getTime() + daysUntilMonday * 24 * 60 * 60 * 1000);

  const weekDays = [];
  for (let i = 0; i < 5; i++) {
    const cur = new Date(monday.getTime() + i * 24 * 60 * 60 * 1000);
    const ymd = cur.toISOString().split('T')[0];
    weekDays.push(ymd);
  }
  return weekDays;
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/**
 * Builds the week-ahead embed for a guild.
 */
export function buildWeekAheadEmbed(weekDays, opts = {}) {
  const {
    closureDates = new Set(),
    calendarEvents = [],
    district = 'hcpss',
    footer = 'School Status'
  } = opts;

  const lines = [];

  for (let i = 0; i < weekDays.length; i++) {
    const ymd = weekDays[i];
    const dayName = DAY_NAMES[i];
    const [, m, d] = ymd.split('-');
    const dateLabel = `${Number(m)}/${Number(d)}`;

    const session = getSessionInfo(ymd, district);
    const customEvents = calendarEvents.filter(e => e && e.date === ymd);

    let statusLine = '';
    if (!session.inSession) {
      const reason = session.reason || (customEvents[0]?.title) || 'Schools Closed';
      statusLine = `🔴 **${dayName} (${dateLabel}):** Schools Closed · *${reason}*`;
    } else {
      const ab = getABDay(ymd, closureDates);
      const abEmoji = ab === 'A' ? '🅰️' : (ab === 'B' ? '🅱️' : '🏫');
      const abText = ab ? `${ab} Day` : 'School Day';
      const detail = customEvents.length ? ` · *${customEvents.map(e => e.title).join(', ')}*` : ' · Regular Schedule';
      statusLine = `${abEmoji} **${dayName} (${dateLabel}):** **${abText}**${detail}`;
    }

    lines.push(statusLine);
  }

  const mondayYmd = weekDays[0];
  const [, startM, startD] = mondayYmd.split('-');

  return {
    title: `📅 School Week Outlook — Week of ${Number(startM)}/${Number(startD)}`,
    color: 0x3498DB,
    description: `### 🗓️ Upcoming Schedule & A/B Day Rotation\n\n` +
      lines.join('\n\n') +
      `\n\n*Use \`/status\` anytime for live announcements or \`/snowday\` for weather outlook.*`,
    footer: { text: `${footer} · Sunday Evening Preview` },
    timestamp: new Date().toISOString()
  };
}

/**
 * Checks and delivers Sunday evening week-ahead previews to all opted-in guilds.
 */
export async function maybeSendWeekAheadPreviews(env, now = new Date()) {
  if (!isSundayEvening(now) && !env.__FORCE_WEEK_AHEAD) return null;

  let guildIds = [];
  try {
    const raw = await env.STATUS_KV.get('guild_index');
    if (raw) guildIds = (JSON.parse(raw) || []).filter(Boolean);
  } catch {}
  if (env.DISCORD_GUILD_ID && !guildIds.includes(env.DISCORD_GUILD_ID)) {
    guildIds.push(env.DISCORD_GUILD_ID);
  }

  if (!guildIds.length) return null;

  const weekDays = getUpcomingWeekDays(now);
  const sundayYmd = now.toISOString().split('T')[0];

  let hist = [];
  try {
    hist = await getStatusHistory(env, 'hcpss');
  } catch {}
  const closureDates = closureDatesFromHistory(hist);

  let sent = 0;

  for (const gid of guildIds) {
    try {
      const stored = await getConfig(env, gid);
      const cfg = getEffectiveConfig(stored);

      if (cfg.toggle_weekahead === false) continue;
      const channelId = cfg.alert_channel_id;
      if (!channelId) continue;

      const lastSent = await env.STATUS_KV.get(`last_weekahead_date:${gid}`);
      if (lastSent === sundayYmd && !env.__FORCE_WEEK_AHEAD) continue;

      const embed = buildWeekAheadEmbed(weekDays, {
        closureDates,
        calendarEvents: Array.isArray(cfg.calendar_events) ? cfg.calendar_events : [],
        district: cfg.primary_district || 'hcpss',
        footer: cfg.alert_embed_footer || 'School Status'
      });

      await postMessageToChannel(env, {
        __channelId: channelId,
        embeds: [embed]
      });

      await env.STATUS_KV.put(`last_weekahead_date:${gid}`, sundayYmd);
      sent++;
      logAction(`📅 Sunday week-ahead preview posted to <#${channelId}>.`, { guildId: gid });
    } catch (e) {
      console.error(`Week-ahead post failed for guild ${gid}:`, e);
    }
  }

  return { ok: true, sent };
}
