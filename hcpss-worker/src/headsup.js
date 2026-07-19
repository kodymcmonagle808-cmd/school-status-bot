// Night-before heads-up: a 7:00 PM ET post when the Closure Outlook reaches
// High or Very High while the guild's district still shows Normal Operations —
// so families hear "tomorrow looks rough" the evening before instead of at 5 AM.
// On by default (it only ever fires on high-outlook storm evenings);
// toggle_heads_up in Feature Toggles turns it off.
// Guilds following a neighboring district get a heads-up built from that
// district's own weather zone, county, and announcement source.

import { getEasternTimeStr, matchesScheduleTime, formatYmdNY } from './timeutil.js';
import { getActiveWeatherAlerts, hasStormAlert, formatWeatherAlertLines } from './weather.js';
import {
  getDistrictStatuses,
  formatDistrictLines,
  getDistrictMeta,
  DISTRICT_STATUS_TO_KEY,
  statusKeyToDistrictStatus,
  HCPSS_COUNTY
} from './districts.js';
import { computeClosureOutlook, formatOutlookLines } from './outlook.js';
import { getSnowfallForecast, formatSnowfallLines } from './snowfall.js';
import { getBgeOutages, formatOutageLine, getCountyOutage, outagePercent } from './outages.js';
import { getChartIncidents, formatRoadLines } from './roads.js';
import { getStatusCards, determineStatusKey, HCPSS_URL } from './scraper.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { discordFetch } from './discord.js';
import { postLog } from './panel.js';

export const HEADS_UP_TIME = '19:00';
export const HEADS_UP_LEVELS = ['high', 'very_high'];

export function shouldSendHeadsUp(outlook, statusKey) {
  return !!outlook &&
    HEADS_UP_LEVELS.includes(outlook.level) &&
    statusKey === 'normal_operations';
}

// Builds everything one district's heads-up needs (outlook, embed fields,
// link), or null when that district's evening doesn't warrant one. The data
// getters are all KV-cached, so sharing across districts is free.
async function buildHeadsUpContext(env, districtId) {
  const isHcpss = districtId === 'hcpss';
  const meta = isHcpss ? null : getDistrictMeta(districtId);
  if (!isHcpss && !meta) return null;

  const zone = isHcpss ? undefined : meta.nwsZone;
  const county = isHcpss ? HCPSS_COUNTY : meta.county;
  const name = isHcpss ? 'Howard County' : meta.name;

  const alerts = zone ? await getActiveWeatherAlerts(env, zone) : await getActiveWeatherAlerts(env);
  if (!hasStormAlert(alerts)) return null;

  const districtStatuses = await getDistrictStatuses(env);

  // The neighbor list for the outlook: everyone but this district, plus HCPSS
  // itself when the primary district is a neighbor.
  let statusKey = 'normal_operations';
  let neighbors;
  if (isHcpss) {
    neighbors = districtStatuses;
    const fetched = await getStatusCards(env);
    statusKey = fetched.cards ? determineStatusKey(fetched.cards) : 'normal_operations';
  } else {
    const mine = districtStatuses.find(d => d.id === districtId);
    if (!mine || mine.status === 'unavailable') return null;
    statusKey = DISTRICT_STATUS_TO_KEY[mine.status] || 'unknown_alert';
    neighbors = districtStatuses.filter(d => d.id !== districtId);
    try {
      const fetched = await getStatusCards(env);
      if (fetched.cards) {
        neighbors = [
          { id: 'hcpss', name: 'Howard Co.', status: statusKeyToDistrictStatus(determineStatusKey(fetched.cards)), detail: '' },
          ...neighbors
        ];
      }
    } catch {}
  }

  const outageSummary = await getBgeOutages(env);
  const outlook = computeClosureOutlook(alerts, neighbors, {
    outagePercent: outagePercent(getCountyOutage(outageSummary, county))
  });
  if (!shouldSendHeadsUp(outlook, statusKey)) return null;

  const outageCounty = getCountyOutage(outageSummary, county);
  return {
    outlook,
    name,
    // The snowfall forecast comes from the Howard County gridpoint, so label
    // it honestly for guilds following a neighboring district.
    snowName: isHcpss ? name : 'Region',
    url: isHcpss ? HCPSS_URL : meta.url,
    snowLines: formatSnowfallLines(await getSnowfallForecast(env)),
    alertLines: formatWeatherAlertLines(alerts),
    districtLines: formatDistrictLines(neighbors),
    outageLine: outageCounty && outageCounty.out > 0 ? formatOutageLine(outageSummary, county) : '',
    roadLines: formatRoadLines(await getChartIncidents(env), county)
  };
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

  // One context per distinct primary district; null means "no heads-up tonight".
  const contexts = new Map();

  let sent = 0;
  const token = env.DISCORD_BOT_TOKEN;
  for (const { gid, cfg } of wanting) {
    const primary = cfg.primary_district && cfg.primary_district !== 'hcpss' ? cfg.primary_district : 'hcpss';
    if (!contexts.has(primary)) {
      try {
        contexts.set(primary, await buildHeadsUpContext(env, primary));
      } catch (e) {
        console.error(`Heads-up context failed for district ${primary}:`, e);
        contexts.set(primary, null);
      }
    }
    const ctx = contexts.get(primary);
    if (!ctx) continue;

    // Mark before posting so a delayed cron tick can't double-post.
    await env.STATUS_KV.put(`last_headsup_day:${gid}`, todayYmd);

    const embed = {
      title: '🌙 Heads-Up: Possible Closing or Delay Tomorrow',
      url: ctx.url,
      color: ctx.outlook.level === 'very_high' ? 0xE74C3C : 0xE67E22,
      description: `${formatOutlookLines(ctx.outlook)}\n\n` +
        `Districts usually announce weather closings and delays by early morning. ` +
        `Storm mode will check every 15 minutes from 4:30–7:30 AM ET and post the moment anything changes.`,
      timestamp: now.toISOString(),
      footer: { text: `${cfg.alert_embed_footer || 'School Status'} · Night-Before Heads-Up` }
    };
    const fields = [];
    if (ctx.snowLines) fields.push({ name: `🌨️ Snowfall Forecast — ${ctx.snowName}`, value: ctx.snowLines });
    if (ctx.alertLines) fields.push({ name: '⛅ Active Weather Alerts', value: ctx.alertLines });
    if (ctx.outageLine) fields.push({ name: `🔌 Power Outages — ${ctx.name}`, value: ctx.outageLine });
    if (ctx.roadLines) fields.push({ name: `🛣️ Road Conditions — ${ctx.name}`, value: ctx.roadLines });
    if (ctx.districtLines) fields.push({ name: '🏫 Nearby Districts', value: ctx.districtLines });
    if (fields.length) embed.fields = fields;

    const pingsEnabled = cfg.toggle_pings !== false;
    const roleIds = pingsEnabled && Array.isArray(cfg.ping_role_ids) ? cfg.ping_role_ids : [];
    const content = roleIds.length ? roleIds.map(id => `<@&${id}>`).join(' ') : '';

    try {
      const resp = await discordFetch(`https://discord.com/api/v10/channels/${cfg.alert_channel_id}/messages`, {
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
        await postLog(env, cfg.log_channel_id, `🌙 Night-before heads-up (${ctx.outlook.level}) posted to <#${cfg.alert_channel_id}>.`, {}, gid);
      } else {
        console.error(`Heads-up post failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error('Heads-up post failed:', e);
    }
  }
  return { sent };
}
