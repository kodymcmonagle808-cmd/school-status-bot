// Optional daily morning digest: one summary embed per opted-in guild at
// 6:00 AM ET — current operating status, today's calendar event, and any
// active weather alerts. Off by default (toggle_digest in Feature Toggles).

import { getEasternTimeStr, matchesScheduleTime, formatYmdNY, formatStatusDate } from './timeutil.js';
import { SCHOOL_CALENDAR_EVENTS, getDefaultStatusColor } from './constants.js';
import { HCPSS_URL, getStatusCards, determineStatusKey } from './scraper.js';
import { getActiveWeatherAlerts, formatWeatherAlertLines } from './weather.js';
import { getCalendarEvent } from './calendar.js';
import { getConfig, getEffectiveConfig, getActiveOverride } from './config.js';
import { postLog } from './panel.js';

export const DIGEST_TIME = '6:00';

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

  const fetched = await getStatusCards(env);
  const cards = fetched.cards;
  const statusKey = cards ? determineStatusKey(cards) : 'unknown_alert';
  const statusTitle = cards && cards[0] && cards[0].title ? cards[0].title : 'Status unavailable — check the HCPSS website';
  const alertLines = formatWeatherAlertLines(await getActiveWeatherAlerts(env));

  let sent = 0;
  const token = env.DISCORD_BOT_TOKEN;
  for (const { gid, cfg } of wanting) {
    // Mark before posting so a delayed cron tick can't double-post.
    await env.STATUS_KV.put(`last_digest_day:${gid}`, todayYmd);

    let calEvent = null;
    try { calEvent = await getCalendarEvent(env, gid, todayYmd); } catch {}
    if (!calEvent) calEvent = SCHOOL_CALENDAR_EVENTS[todayYmd] || null;

    const override = await getActiveOverride(env, gid);
    const statusLine = override
      ? `🛠️ **${override.status_label || override.status_key}** *(override active)*`
      : `**${statusTitle}**${fetched.stale ? ' *(cached — live page unreachable)*' : ''}`;

    const lines = [
      `☀️ **Today's Operating Status:** ${statusLine}`,
      calEvent ? `📅 **Today's Calendar:** ${calEvent}` : null,
      alertLines ? `⛅ **Weather Alerts — Howard County:**\n${alertLines}` : null
    ].filter(Boolean);

    const embed = {
      title: `🌅 Good Morning — HCPSS Daily Digest (${formatStatusDate(now)})`,
      url: HCPSS_URL,
      color: override ? 0xF1C40F : getDefaultStatusColor(statusKey),
      description: lines.join('\n\n'),
      timestamp: now.toISOString(),
      footer: { text: `${cfg.alert_embed_footer || 'HCPSS Status Monitor'} · Morning Digest` }
    };

    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${cfg.alert_channel_id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } })
      });
      if (resp.ok) {
        sent++;
        await postLog(env, cfg.log_channel_id, `🌅 Morning digest posted to <#${cfg.alert_channel_id}>.`, {}, gid);
      } else {
        console.error(`Digest post failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error('Digest post failed:', e);
    }
  }
  return { sent };
}
