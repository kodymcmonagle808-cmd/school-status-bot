// NWS alert issuance notices: posts within ~15 minutes when the National
// Weather Service issues a school-impacting alert (winter/heat watch,
// warning, or advisory) for the guild's county — the moment parents start
// wondering about tomorrow. Uses the same 10-minute alert cache as the
// status embeds, so quiet days cost one cached KV read per scan.
//
// Dedupe is per guild by event name: each event posts once and is considered
// "seen" until that alert's end time passes (24h fallback when NWS gives no
// end), so extensions and updates of the same alert stay quiet but the next
// storm's alert posts again.

import { getEasternTimeStr } from './timeutil.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { getDistrictMeta } from './districts.js';
import { getActiveWeatherAlerts, isSchoolImpactIssuance, DEFAULT_NWS_ZONE } from './weather.js';
import { discordFetch } from './discord.js';
import { postLog } from './panel.js';

const SCAN_COOLDOWN_KEY = 'nws_alert_scan_cooldown';
const SCAN_COOLDOWN_TTL_SECONDS = 600;
const SEEN_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

// Quiet hours: alerts issued overnight wait for 6 AM ET (storm mode already
// covers the early-morning window; a 3 AM ping helps nobody sleep).
const POST_FROM_MIN = 6 * 60;
const POST_UNTIL_MIN = 22 * 60;

// Splits currently active school-impact alerts into ones not yet announced
// for this guild, and returns the pruned+updated seen map to store. Pure for
// tests. seen: { [event]: expiresMs }.
export function pickNewAlerts(alerts, seen, nowMs) {
  const cleaned = {};
  for (const [event, expires] of Object.entries(seen && typeof seen === 'object' ? seen : {})) {
    if (Number(expires) > nowMs) cleaned[event] = Number(expires);
  }

  const newAlerts = [];
  for (const a of Array.isArray(alerts) ? alerts : []) {
    if (!a || !a.event || cleaned[a.event]) continue;
    cleaned[a.event] = a.endsMs && a.endsMs > nowMs ? a.endsMs : nowMs + SEEN_FALLBACK_TTL_MS;
    newAlerts.push(a);
  }
  return { newAlerts, updatedSeen: cleaned };
}

export function formatIssuanceLines(alerts) {
  return (Array.isArray(alerts) ? alerts : []).map(a => {
    const from = a.onsetMs ? ` from <t:${Math.floor(a.onsetMs / 1000)}:f>` : '';
    const until = a.endsMs ? ` until <t:${Math.floor(a.endsMs / 1000)}:f>` : '';
    const headline = a.headline ? `\n> ${a.headline}` : '';
    return `⚠️ **${a.event}**${from}${until}${headline}`;
  }).join('\n\n');
}

export function issuanceEmbedColor(alerts) {
  const severities = (Array.isArray(alerts) ? alerts : []).map(a => a && a.severity);
  if (severities.includes('Extreme')) return 0xE74C3C;
  if (severities.includes('Severe')) return 0xE67E22;
  return 0xF1C40F;
}

// Runs from the per-minute cron. Never throws.
export async function maybeSendWeatherAlertNotices(env) {
  if (!env || !env.STATUS_KV) return { sent: 0 };
  const now = new Date();
  const [h, m] = getEasternTimeStr(now).split(':').map(Number);
  const nowMin = h * 60 + m;
  if (nowMin < POST_FROM_MIN || nowMin >= POST_UNTIL_MIN) return { sent: 0 };

  if (await env.STATUS_KV.get(SCAN_COOLDOWN_KEY)) return { sent: 0 };
  await env.STATUS_KV.put(SCAN_COOLDOWN_KEY, '1', { expirationTtl: SCAN_COOLDOWN_TTL_SECONDS }).catch(() => {});

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

  const alertsByZone = new Map();
  const nowMs = now.getTime();
  let sent = 0;
  const token = env.DISCORD_BOT_TOKEN;

  for (const gid of guildIds) {
    try {
      const cfg = getEffectiveConfig(await getConfig(env, gid));
      if (cfg.toggle_nws_alerts === false || !cfg.alert_channel_id) continue;

      const meta = cfg.primary_district && cfg.primary_district !== 'hcpss' ? getDistrictMeta(cfg.primary_district) : null;
      const zone = meta && meta.nwsZone ? meta.nwsZone : DEFAULT_NWS_ZONE;
      const county = meta ? meta.county : 'Howard';

      if (!alertsByZone.has(zone)) {
        const active = await getActiveWeatherAlerts(env, zone);
        alertsByZone.set(zone, active.filter(isSchoolImpactIssuance));
      }
      const impact = alertsByZone.get(zone);
      if (!impact.length) continue;

      let seen = {};
      try {
        const rawSeen = await env.STATUS_KV.get(`nws_alerts_seen:${gid}`);
        if (rawSeen) seen = JSON.parse(rawSeen) || {};
      } catch {}

      const { newAlerts, updatedSeen } = pickNewAlerts(impact, seen, nowMs);
      if (!newAlerts.length) continue;

      // Mark before posting so a delayed cron tick can't double-post.
      await env.STATUS_KV.put(`nws_alerts_seen:${gid}`, JSON.stringify(updatedSeen));

      const title = newAlerts.length === 1
        ? `⚠️ ${newAlerts[0].event} — ${county} County`
        : `⚠️ NWS Alerts Issued — ${county} County`;
      const resp = await discordFetch(`https://discord.com/api/v10/channels/${cfg.alert_channel_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title,
            url: 'https://alerts.weather.gov',
            color: issuanceEmbedColor(newAlerts),
            description: formatIssuanceLines(newAlerts) +
              '\n\nNo decision has been announced — this is the weather alert schools watch. Status posts will follow if anything changes.',
            timestamp: now.toISOString(),
            footer: { text: `${cfg.alert_embed_footer || 'School Status'} · via National Weather Service` }
          }],
          allowed_mentions: { parse: [] }
        })
      });
      if (resp.ok) {
        sent++;
        await postLog(env, cfg.log_channel_id, `⚠️ NWS issuance notice (${newAlerts.map(a => a.event).join(', ')}) posted to <#${cfg.alert_channel_id}>.`, {}, gid);
      } else {
        console.error(`NWS issuance post failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error(`NWS issuance notice failed for guild ${gid}:`, e);
    }
  }
  return { sent };
}
