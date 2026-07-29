// Optional daily morning digest: one summary embed per opted-in guild at
// 6:00 AM ET — current operating status, today's calendar event, and any
// active weather alerts. Off by default (toggle_digest in Feature Toggles).
// Guilds following a neighboring district get that district's status, weather
// zone, and name instead of HCPSS's.

import { getEasternTimeStr, matchesScheduleTime, formatYmdNY, formatStatusDate } from './timeutil.js';
import { SCHOOL_CALENDAR_EVENTS, getDefaultStatusColor } from './constants.js';
import { HCPSS_URL, getStatusCards, determineStatusKey } from './scraper.js';
import { getActiveWeatherAlerts, formatWeatherAlertLines } from './weather.js';
import {
  getDistrictStatuses,
  getDistrictMeta,
  DISTRICT_STATUS_TO_KEY,
  DISTRICT_STATUS_LABELS
} from './districts.js';
import { getCalendarEvent } from './calendar.js';
import { getConfig, getEffectiveConfig, getActiveOverride } from './config.js';
import { discordFetch } from './discord.js';
import { logAction } from './actionlog.js';

export const DIGEST_TIME = '6:00';

// Status line, key, title, and weather for one district's digest. The data
// getters are KV-cached, so sharing across guilds of the same district is free.
async function buildDigestContext(env, districtId) {
  if (districtId === 'hcpss') {
    const fetched = await getStatusCards(env);
    const cards = fetched.cards;
    return {
      name: 'HCPSS',
      county: 'Howard County',
      url: HCPSS_URL,
      statusKey: cards ? determineStatusKey(cards) : 'unknown_alert',
      statusTitle: cards && cards[0] && cards[0].title ? cards[0].title : 'Status unavailable — check the HCPSS website',
      stale: !!fetched.stale,
      alertLines: formatWeatherAlertLines(await getActiveWeatherAlerts(env)),
      builtinCalendar: true
    };
  }

  const meta = getDistrictMeta(districtId);
  if (!meta) return null;
  const mine = (await getDistrictStatuses(env)).find(d => d.id === districtId);
  const status = mine && mine.status !== 'unavailable' ? mine.status : null;
  return {
    name: meta.name,
    county: `${meta.county} County`,
    url: meta.url,
    statusKey: status ? (DISTRICT_STATUS_TO_KEY[status] || 'unknown_alert') : 'unknown_alert',
    statusTitle: status
      ? (status === 'none' ? 'Normal Operations' : (DISTRICT_STATUS_LABELS[status] || 'Announcement'))
      : `Status unavailable — check the ${meta.name} website`,
    stale: false,
    alertLines: formatWeatherAlertLines(await getActiveWeatherAlerts(env, meta.nwsZone)),
    // The built-in calendar is HCPSS's; district guilds only get their own events.
    builtinCalendar: false
  };
}

export async function maybeSendMorningDigests(env) {
  const now = new Date();
  if (!matchesScheduleTime(getEasternTimeStr(now), DIGEST_TIME)) return { sent: 0 };

  let guildIds = [];
  const rawIndex = await env.STATUS_KV.get('guild_index');
  if (rawIndex) {
    try {
      const parsed = JSON.parse(rawIndex);
      if (Array.isArray(parsed)) guildIds = parsed.filter(Boolean);
    } catch {}
  }
  if (env.DISCORD_GUILD_ID && !guildIds.includes(env.DISCORD_GUILD_ID)) {
    guildIds.push(env.DISCORD_GUILD_ID);
  }
  if (!guildIds.length) return { sent: 0 };

  // Cheap pass first: find opted-in guilds that haven't had today's digest,
  // so quiet mornings don't scrape or hit the weather API at all.
  const todayYmd = formatYmdNY(now);
  const wanting = [];
  for (const gid of guildIds) {
    const cfg = getEffectiveConfig(await getConfig(env, gid));
    if (cfg.toggle_digest !== true || !cfg.alert_channel_id) continue;
    if (await env.STATUS_KV.get(`last_digest_day:${gid}`) === todayYmd) continue;
    wanting.push({ gid, cfg });
  }
  if (!wanting.length) return { sent: 0 };

  // One context per distinct primary district.
  const contexts = new Map();

  let sent = 0;
  const token = env.DISCORD_BOT_TOKEN;
  for (const { gid, cfg } of wanting) {
    const primary = cfg.primary_district && cfg.primary_district !== 'hcpss' ? cfg.primary_district : 'hcpss';
    if (!contexts.has(primary)) {
      try {
        contexts.set(primary, await buildDigestContext(env, primary));
      } catch (e) {
        console.error(`Digest context failed for district ${primary}:`, e);
        contexts.set(primary, null);
      }
    }
    const ctx = contexts.get(primary);
    if (!ctx) continue;

    // Mark before posting so a delayed cron tick can't double-post.
    await env.STATUS_KV.put(`last_digest_day:${gid}`, todayYmd);

    let calEvent = null;
    try { calEvent = await getCalendarEvent(env, gid, todayYmd); } catch {}
    if (!calEvent && ctx.builtinCalendar) calEvent = SCHOOL_CALENDAR_EVENTS[todayYmd] || null;

    const override = await getActiveOverride(env, gid);
    const statusLine = override
      ? `🛠️ **${override.status_label || override.status_key}** *(override active)*`
      : `**${ctx.statusTitle}**${ctx.stale ? ' *(cached — live page unreachable)*' : ''}`;

    const lines = [
      `☀️ **Today's Operating Status:** ${statusLine}`,
      calEvent ? `📅 **Today's Calendar:** ${calEvent}` : null,
      ctx.alertLines ? `⛅ **Weather Alerts — ${ctx.county}:**\n${ctx.alertLines}` : null
    ].filter(Boolean);

    const embed = {
      title: `🌅 Good Morning — ${ctx.name} Daily Digest (${formatStatusDate(now)})`,
      url: ctx.url,
      color: override ? 0xF1C40F : getDefaultStatusColor(ctx.statusKey),
      description: lines.join('\n\n'),
      timestamp: now.toISOString(),
      footer: { text: `${cfg.alert_embed_footer || 'School Status'} · Morning Digest` }
    };

    try {
      const resp = await discordFetch(`https://discord.com/api/v10/channels/${cfg.alert_channel_id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } })
      });
      if (resp.ok) {
        sent++;
        logAction(`🌅 Morning digest posted to <#${cfg.alert_channel_id}>.`, { guildId: gid });
      } else {
        console.error(`Digest post failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error('Digest post failed:', e);
    }
  }
  return { sent };
}
