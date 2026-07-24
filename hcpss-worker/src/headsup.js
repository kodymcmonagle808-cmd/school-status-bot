// Night-before heads-up: a 7:00 PM ET post when the Closure Outlook reaches
// High or Very High while the guild's district still shows Normal Operations —
// so families hear "tomorrow looks rough" the evening before instead of at 5 AM.
// The watch keeps running every 15 minutes until 11:45 PM: if the outlook
// climbs a tier after the first post (or first reaches High later in the
// evening), an escalation update goes out — one post per tier per night.
// On by default (it only ever fires on high-outlook storm evenings);
// toggle_heads_up in Feature Toggles turns it off.
// Guilds following a neighboring district get a heads-up built from that
// district's own weather zone, county, and announcement source.

import { getEasternTimeStr, eveningTickSlot, formatYmdNY } from './timeutil.js';
import { getActiveWeatherAlerts, hasStormAlert, formatWeatherAlertLines } from './weather.js';
import {
  getDistrictStatuses,
  formatDistrictLines,
  getDistrictMeta,
  DISTRICT_STATUS_TO_KEY,
  statusKeyToDistrictStatus,
  HCPSS_COUNTY
} from './districts.js';
import { computeClosureOutlook, formatOutlookLines, OUTLOOK_LEVELS } from './outlook.js';
import { getSnowfallForecast, formatSnowfallLines } from './snowfall.js';
import { getCountyOutagePicture } from './outages.js';
import { getChartIncidents, formatRoadLines } from './roads.js';
import { getStatusCards, determineStatusKey, HCPSS_URL } from './scraper.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { discordFetch } from './discord.js';
import { postLog } from './panel.js';
import { noSchoolReason, addDaysYmd } from './session.js';

export const HEADS_UP_TIME = '19:00';
export const HEADS_UP_LEVELS = ['high', 'very_high'];

export const OUTLOOK_RANK = { none: 0, low: 1, moderate: 2, high: 3, very_high: 4 };

export function shouldSendHeadsUp(outlook, statusKey) {
  return !!outlook &&
    HEADS_UP_LEVELS.includes(outlook.level) &&
    statusKey === 'normal_operations';
}

// A guild's per-night state is "<ymd>|<level>" — the highest tier already
// announced that evening. A new post goes out only for a strictly higher tier.
export function parseHeadsUpState(raw) {
  const [ymd, level] = String(raw || '').split('|');
  // Entries written before escalation existed are a bare ymd: treat them as
  // already announced at the top tier so a deploy never double-posts.
  return { ymd: ymd || '', level: level || (ymd ? 'very_high' : 'none') };
}

export function shouldEscalate(state, todayYmd, newLevel) {
  if (state.ymd !== todayYmd) return true;
  return (OUTLOOK_RANK[newLevel] || 0) > (OUTLOOK_RANK[state.level] || 0);
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

  const outagePicture = await getCountyOutagePicture(env, county);
  const outlook = computeClosureOutlook(alerts, neighbors, {
    outagePercent: outagePicture.percent
  });
  if (!shouldSendHeadsUp(outlook, statusKey)) return null;

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
    outageLine: outagePicture.line,
    roadLines: formatRoadLines(await getChartIncidents(env), county)
  };
}

// Runs from the per-minute cron on evening quarter-hour ticks; sends at most
// one post per outlook tier per guild per night. Never throws.
export async function maybeSendHeadsUp(env) {
  if (!env || !env.STATUS_KV) return { sent: 0 };
  const now = new Date();
  const slot = eveningTickSlot(getEasternTimeStr(now));
  if (!slot) return { sent: 0 };

  const todayYmd = formatYmdNY(now);
  const slotVal = `${todayYmd} ${slot}`;
  if (await env.STATUS_KV.get('last_headsup_slot') === slotVal) return { sent: 0 };
  await env.STATUS_KV.put('last_headsup_slot', slotVal);

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

  // The heads-up is about *tomorrow*, so that is the day the session gate has
  // to ask about — a Sunday-evening post is about Monday, and a Dec 26 post
  // about a day inside winter break shouldn't go out at all.
  const tomorrowYmd = addDaysYmd(todayYmd, 1);

  // Cheap pass first: only guilds that want a heads-up and could still climb
  // a tier tonight (very_high is the ceiling — nothing left to announce).
  const wanting = [];
  for (const gid of guildIds) {
    const cfg = getEffectiveConfig(await getConfig(env, gid));
    if (cfg.toggle_heads_up === false || !cfg.alert_channel_id) continue;
    if (cfg.toggle_session_gate !== false &&
        noSchoolReason(tomorrowYmd, cfg.primary_district || 'hcpss')) continue;
    const state = parseHeadsUpState(await env.STATUS_KV.get(`last_headsup_day:${gid}`));
    if (state.ymd === todayYmd && state.level === 'very_high') continue;
    wanting.push({ gid, cfg, state });
  }
  if (!wanting.length) return { sent: 0 };

  // One context per distinct primary district; null means "no heads-up tonight".
  const contexts = new Map();

  let sent = 0;
  const token = env.DISCORD_BOT_TOKEN;
  for (const { gid, cfg, state } of wanting) {
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
    if (!shouldEscalate(state, todayYmd, ctx.outlook.level)) continue;

    // A repeat post tonight is an escalation update, not the first heads-up.
    const isEscalation = state.ymd === todayYmd;

    // Mark before posting so a delayed cron tick can't double-post.
    await env.STATUS_KV.put(`last_headsup_day:${gid}`, `${todayYmd}|${ctx.outlook.level}`);

    const levelMeta = OUTLOOK_LEVELS[ctx.outlook.level];
    const embed = {
      title: isEscalation
        ? `🌙 Outlook Update: Now ${levelMeta ? levelMeta.label : 'Higher'}`
        : '🌙 Heads-Up: Possible Closing or Delay Tomorrow',
      url: ctx.url,
      color: ctx.outlook.level === 'very_high' ? 0xE74C3C : 0xE67E22,
      description: (isEscalation
          ? `The Closure Outlook has climbed since this evening's heads-up.\n\n`
          : '') +
        `${formatOutlookLines(ctx.outlook)}\n\n` +
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
        await postLog(env, cfg.log_channel_id, `🌙 Night-before ${isEscalation ? 'outlook escalation' : 'heads-up'} (${ctx.outlook.level}) posted to <#${cfg.alert_channel_id}>.`, {}, gid);
      } else {
        console.error(`Heads-up post failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error('Heads-up post failed:', e);
    }
  }
  return { sent };
}
