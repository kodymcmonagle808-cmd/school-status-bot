// Night-before heads-up: a 7:00 PM ET post when the Closure Outlook reaches
// High or Very High while HCPSS still shows Normal Operations — so families
// hear "tomorrow looks rough" the evening before instead of at 5 AM.
// On by default (it only ever fires on high-outlook storm evenings);
// toggle_heads_up in Feature Toggles turns it off.

import { getEasternTimeStr, matchesScheduleTime, formatYmdNY } from './timeutil.js';
import { getActiveWeatherAlerts, hasStormAlert, formatWeatherAlertLines } from './weather.js';
import { getDistrictStatuses, formatDistrictLines, HCPSS_COUNTY } from './districts.js';
import { computeClosureOutlook, formatOutlookLines } from './outlook.js';
import { getSnowfallForecast, formatSnowfallLines } from './snowfall.js';
import { getBgeOutages, formatOutageLine, getCountyOutage, outagePercent } from './outages.js';
import { getChartIncidents, formatRoadLines } from './roads.js';
import { getStatusCards, determineStatusKey, HCPSS_URL } from './scraper.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { postLog } from './panel.js';

export const HEADS_UP_TIME = '19:00';
export const HEADS_UP_LEVELS = ['high', 'very_high'];

export function shouldSendHeadsUp(outlook, statusKey) {
  return !!outlook &&
    HEADS_UP_LEVELS.includes(outlook.level) &&
    statusKey === 'normal_operations';
}

// Runs from the per-minute cron; sends at most one heads-up per guild per day.
// Never throws.
export async function maybeSendHeadsUp(env) {
  if (!env || !env.STATUS_KV) return { sent: 0 };
  const now = new Date();
  if (!matchesScheduleTime(getEasternTimeStr(now), HEADS_UP_TIME)) return { sent: 0 };

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

  // Cheap pass first: only guilds that want a heads-up and haven't had today's.
  const todayYmd = formatYmdNY(now);
  const wanting = [];
  for (const gid of guildIds) {
    const cfg = getEffectiveConfig(await getConfig(env, gid));
    if (cfg.toggle_heads_up === false || !cfg.alert_channel_id) continue;
    if (await env.STATUS_KV.get(`last_headsup_day:${gid}`) === todayYmd) continue;
    wanting.push({ gid, cfg });
  }
  if (!wanting.length) return { sent: 0 };

  const alerts = await getActiveWeatherAlerts(env);
  if (!hasStormAlert(alerts)) return { sent: 0 };

  const districts = await getDistrictStatuses(env);
  const outageSummary = await getBgeOutages(env);
  const outlook = computeClosureOutlook(alerts, districts, {
    outagePercent: outagePercent(getCountyOutage(outageSummary, HCPSS_COUNTY))
  });

  // If HCPSS has already announced something, the status post says it better.
  const fetched = await getStatusCards(env);
  const statusKey = fetched.cards ? determineStatusKey(fetched.cards) : 'normal_operations';
  if (!shouldSendHeadsUp(outlook, statusKey)) return { sent: 0 };

  const snowLines = formatSnowfallLines(await getSnowfallForecast(env));
  const alertLines = formatWeatherAlertLines(alerts);
  const districtLines = formatDistrictLines(districts);
  const outageCounty = getCountyOutage(outageSummary, HCPSS_COUNTY);
  const outageLine = outageCounty && outageCounty.out > 0 ? formatOutageLine(outageSummary, HCPSS_COUNTY) : '';
  const roadLines = formatRoadLines(await getChartIncidents(env), HCPSS_COUNTY);

  let sent = 0;
  const token = env.DISCORD_BOT_TOKEN;
  for (const { gid, cfg } of wanting) {
    // Mark before posting so a delayed cron tick can't double-post.
    await env.STATUS_KV.put(`last_headsup_day:${gid}`, todayYmd);

    const embed = {
      title: '🌙 Heads-Up: Possible Closing or Delay Tomorrow',
      url: HCPSS_URL,
      color: outlook.level === 'very_high' ? 0xE74C3C : 0xE67E22,
      description: `${formatOutlookLines(outlook)}\n\n` +
        `HCPSS usually announces weather closings and delays by early morning. ` +
        `Storm mode will check every 15 minutes from 4:30–7:30 AM ET and post the moment anything changes.`,
      timestamp: now.toISOString(),
      footer: { text: `${cfg.alert_embed_footer || 'HCPSS Status Monitor'} · Night-Before Heads-Up` }
    };
    const fields = [];
    if (snowLines) fields.push({ name: '🌨️ Snowfall Forecast — Howard County', value: snowLines });
    if (alertLines) fields.push({ name: '⛅ Active Weather Alerts', value: alertLines });
    if (outageLine) fields.push({ name: '🔌 Power Outages — Howard County', value: outageLine });
    if (roadLines) fields.push({ name: '🛣️ Road Conditions — Howard County', value: roadLines });
    if (districtLines) fields.push({ name: '🏫 Nearby Districts', value: districtLines });
    if (fields.length) embed.fields = fields;

    const pingsEnabled = cfg.toggle_pings !== false;
    const roleIds = pingsEnabled && Array.isArray(cfg.ping_role_ids) ? cfg.ping_role_ids : [];
    const content = roleIds.length ? roleIds.map(id => `<@&${id}>`).join(' ') : '';

    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${cfg.alert_channel_id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content,
          embeds: [embed],
          allowed_mentions: roleIds.length ? { roles: roleIds } : { parse: [] }
        })
      });
      if (resp.ok) {
        sent++;
        await postLog(env, cfg.log_channel_id, `🌙 Night-before heads-up (${outlook.level}) posted to <#${cfg.alert_channel_id}>.`, {}, gid);
      } else {
        console.error(`Heads-up post failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error('Heads-up post failed:', e);
    }
  }
  return { sent };
}
