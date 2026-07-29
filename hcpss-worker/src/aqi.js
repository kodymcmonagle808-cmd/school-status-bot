// Air quality alerts from AirNow (the keyless endpoint airnow.gov's own site
// uses). Code Orange+ days trigger outdoor-activity restrictions and athletics
// cancellations in fall and spring — a season the winter/heat pipeline never
// covers. One post per guild per day, at the first cron tick from 6:30 AM ET,
// when today's observed or forecast AQI reaches Unhealthy for Sensitive
// Groups (101) or worse for the guild's county.

import { getEasternTimeStr, formatYmdNY } from './timeutil.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { getDistrictMeta } from './districts.js';
import { discordFetch } from './discord.js';
import { logAction } from './actionlog.js';
import { contextCacheTtl } from './hookmode.js';

const AQI_API_URL = 'https://airnowgovapi.com/reportingarea/get_state';
const AQI_CACHE_KEY = 'aqi_cache';
const AQI_CACHE_TTL_SECONDS = 3600;

// Both state feeds the reporting areas map to. Drops the cached records so
// the next reader fetches live. Used by the /context-hook push path. Never
// throws.
export async function clearAqiCaches(env) {
  if (!env || !env.STATUS_KV) return;
  for (const state of ['MD', 'DC']) {
    try { await env.STATUS_KV.delete(`${AQI_CACHE_KEY}:${state}`); } catch {}
  }
}
const FETCH_TIMEOUT_MS = 8000;
const UA = 'school-status-bot (github.com/kodymcmonagle808-cmd/school-status-bot)';

// Post from 6:30 AM ET — after the morning forecast is out, before school
// (and morning practice) starts.
export const AQI_ALERT_FROM_MIN = 6 * 60 + 30;
export const AQI_ALERT_UNTIL_MIN = 20 * 60;

export const AQI_ALERT_THRESHOLD = 101; // Unhealthy for Sensitive Groups

// The cron fires every minute; scan on one fixed minute of every fifteen. A
// clock gate costs zero KV ops, unlike the old cooldown key (~50 writes/day).
// Offset staggers this scan away from the other watchers' gate minutes.
export const SCAN_MINUTE_OFFSET = 4;

// AirNow reporting area for each county the bot can follow (verified against
// AirNow's own point lookups). Prince George's reports under the DC area, so
// both MD and DC state feeds are fetched.
export const COUNTY_REPORTING_AREAS = {
  'Howard': { area: 'Suburban DC', state: 'MD' },
  'Anne Arundel': { area: 'Metro Baltimore', state: 'MD' },
  'Baltimore': { area: 'Metro Baltimore', state: 'MD' },
  'Carroll': { area: 'Maryland Piedmont', state: 'MD' },
  'Frederick': { area: 'Maryland Piedmont', state: 'MD' },
  'Montgomery': { area: 'Suburban DC', state: 'MD' },
  "Prince George's": { area: 'Northern Virginia and DC', state: 'DC' }
};

export function aqiCategoryEmoji(aqi) {
  if (aqi >= 301) return '🟤';
  if (aqi >= 201) return '🟣';
  if (aqi >= 151) return '🔴';
  if (aqi >= 101) return '🟠';
  if (aqi >= 51) return '🟡';
  return '🟢';
}

// The worst of today's observations and today's forecasts for one reporting
// area, or null when the area has no records for today. Records look like
// { validDate: 'MM/DD/YY', dataType: 'O'|'F', reportingArea, parameter, aqi,
//   category, isActionDay, discussion }. Pure; exported for tests.
export function worstAqiToday(records, areaName, todayMdy) {
  let worst = null;
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || r.reportingArea !== areaName || r.validDate !== todayMdy) continue;
    const aqi = Number(r.aqi);
    if (!Number.isFinite(aqi) || aqi <= 0) continue;
    if (!worst || aqi > worst.aqi) {
      worst = {
        aqi,
        category: r.category || '',
        parameter: r.parameter || '',
        forecast: r.dataType === 'F',
        actionDay: r.isActionDay === true,
        discussion: typeof r.discussion === 'string' ? r.discussion : ''
      };
    } else if (r.isActionDay === true) {
      worst.actionDay = true;
    }
  }
  return worst;
}

// AirNow uses MM/DD/YY validDate strings.
export function toMdy(ymd) {
  const [y, m, d] = String(ymd).split('-');
  return `${m}/${d}/${y.slice(2)}`;
}

async function fetchStateRecords(env, stateCode) {
  const cacheKey = `${AQI_CACHE_KEY}:${stateCode}`;
  if (env && env.STATUS_KV) {
    try {
      const cached = await env.STATUS_KV.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
  }

  let records = null;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const r = await fetch(AQI_API_URL, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `state_code=${stateCode}`,
      signal: controller.signal
    });
    if (!r.ok) throw new Error('AirNow fetch failed ' + r.status);
    const data = await r.json();
    if (Array.isArray(data)) records = data;
  } catch {
    return null;
  }

  if (env && env.STATUS_KV && records) {
    await env.STATUS_KV.put(cacheKey, JSON.stringify(records), { expirationTtl: contextCacheTtl(env, AQI_CACHE_TTL_SECONDS) }).catch(() => {});
  }
  return records;
}

// Runs from the per-minute cron. Never throws.
export async function maybeSendAqiAlerts(env, now = new Date()) {
  if (!env || !env.STATUS_KV) return { sent: 0 };
  const [h, m] = getEasternTimeStr(now).split(':').map(Number);
  const nowMin = h * 60 + m;
  if (nowMin < AQI_ALERT_FROM_MIN || nowMin >= AQI_ALERT_UNTIL_MIN) return { sent: 0 };
  if (m % 15 !== SCAN_MINUTE_OFFSET) return { sent: 0 };

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

  // Cheap pass: guilds that want AQI alerts and haven't had today's.
  const todayYmd = formatYmdNY(now);
  const wanting = [];
  for (const gid of guildIds) {
    const cfg = getEffectiveConfig(await getConfig(env, gid));
    if (cfg.toggle_aqi_alerts === false || !cfg.alert_channel_id) continue;
    if (await env.STATUS_KV.get(`last_aqi_day:${gid}`) === todayYmd) continue;
    wanting.push({ gid, cfg });
  }
  if (!wanting.length) return { sent: 0 };

  const todayMdy = toMdy(todayYmd);
  const recordsByState = new Map();
  const worstByArea = new Map();

  let sent = 0;
  const token = env.DISCORD_BOT_TOKEN;
  for (const { gid, cfg } of wanting) {
    try {
      const meta = cfg.primary_district && cfg.primary_district !== 'hcpss' ? getDistrictMeta(cfg.primary_district) : null;
      const county = meta ? meta.county : 'Howard';
      const mapping = COUNTY_REPORTING_AREAS[county];
      if (!mapping) continue;

      if (!worstByArea.has(mapping.area)) {
        if (!recordsByState.has(mapping.state)) {
          recordsByState.set(mapping.state, await fetchStateRecords(env, mapping.state));
        }
        const records = recordsByState.get(mapping.state);
        worstByArea.set(mapping.area, records ? worstAqiToday(records, mapping.area, todayMdy) : null);
      }
      const worst = worstByArea.get(mapping.area);
      if (!worst || worst.aqi < AQI_ALERT_THRESHOLD) continue;

      // Mark before posting so a delayed cron tick can't double-post.
      await env.STATUS_KV.put(`last_aqi_day:${gid}`, todayYmd);

      const emoji = aqiCategoryEmoji(worst.aqi);
      const lines = [
        `${emoji} **AQI ${worst.aqi} — ${worst.category}** (${worst.parameter}${worst.forecast ? ', forecast' : ', observed'})`,
        '',
        `Outdoor activities, recess, and athletics are often modified or cancelled at this level — sensitive groups (including children) should limit prolonged outdoor exertion.`
      ];
      if (worst.actionDay) {
        lines.splice(1, 0, `⚠️ **Air Quality Action Day** declared for the ${mapping.area} area.`);
      }
      if (worst.discussion) {
        lines.push('', `> ${worst.discussion.slice(0, 400)}`);
      }

      const resp = await discordFetch(`https://discord.com/api/v10/channels/${cfg.alert_channel_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: `😷 Air Quality Alert — ${mapping.area}`,
            url: 'https://www.airnow.gov',
            color: worst.aqi >= 151 ? 0xE74C3C : 0xE67E22,
            description: lines.join('\n'),
            timestamp: now.toISOString(),
            footer: { text: `${cfg.alert_embed_footer || 'School Status'} · via AirNow` }
          }],
          allowed_mentions: { parse: [] }
        })
      });
      if (resp.ok) {
        sent++;
        logAction(`😷 Air quality alert (AQI ${worst.aqi}) posted to <#${cfg.alert_channel_id}>.`, { guildId: gid });
      } else {
        console.error(`AQI alert post failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error(`AQI alert failed for guild ${gid}:`, e);
    }
  }
  return { sent };
}
