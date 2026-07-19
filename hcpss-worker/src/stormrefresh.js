// While a power-threatening storm warning is active (ice storm, blizzard,
// winter storm, high wind, severe thunderstorm, ...), refresh each guild's
// posted status message every 15 minutes so the live extras (power outages,
// road conditions, nearby districts, weather alerts) stay current. Edits the
// existing message in place — no new posts, no pings. Advisory-level events
// don't trigger it.

import { getActiveWeatherAlerts, hasPowerThreatAlert } from './weather.js';
import { getDistrictMeta } from './districts.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { buildStatusPayload } from './embeds.js';
import { discordFetch } from './discord.js';

const SLOT_KEY = 'last_storm_refresh_slot';
const PROBE_SLOT_KEY = 'last_storm_probe_slot';
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

async function readGuildIds(env) {
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
  return guildIds;
}

// Runs from the per-minute cron; the first tick of each 15-minute bucket does
// the refresh, so cron drift can't cause skips or doubles. Never throws.
export async function maybeRefreshStormEmbeds(env) {
  if (!env || !env.STATUS_KV) return { updated: 0 };

  const slot = String(Math.floor(Date.now() / REFRESH_INTERVAL_MS));
  if (await env.STATUS_KV.get(SLOT_KEY) === slot) return { updated: 0 };

  // Weather is checked before claiming the slot so quiet days cost one cached
  // read, and the first storm-time tick still runs the refresh.
  const alerts = await getActiveWeatherAlerts(env);
  let threat = hasPowerThreatAlert(alerts);

  let guildIds = null;
  if (!threat) {
    // No threat in the default (Howard) zone: probe the zones of guilds whose
    // primary district is a neighboring county. This costs config reads, so it
    // runs at most once per 15-minute bucket via its own slot key.
    if (await env.STATUS_KV.get(PROBE_SLOT_KEY) === slot) return { updated: 0 };
    await env.STATUS_KV.put(PROBE_SLOT_KEY, slot);

    guildIds = await readGuildIds(env);
    const zones = new Set();
    for (const gid of guildIds) {
      const meta = getDistrictMeta(getEffectiveConfig(await getConfig(env, gid)).primary_district);
      if (meta && meta.nwsZone) zones.add(meta.nwsZone);
    }
    for (const zone of zones) {
      if (hasPowerThreatAlert(await getActiveWeatherAlerts(env, zone))) {
        threat = true;
        break;
      }
    }
    if (!threat) return { updated: 0 };
  }
  await env.STATUS_KV.put(SLOT_KEY, slot);

  if (!guildIds) guildIds = await readGuildIds(env);

  let updated = 0;
  const token = env.DISCORD_BOT_TOKEN;
  for (const gid of guildIds) {
    try {
      const cfg = getEffectiveConfig(await getConfig(env, gid));

      // Skip guilds showing none of the storm-dynamic sections.
      const showsStormExtras = cfg.toggle_outages !== false || cfg.toggle_roads !== false ||
        cfg.toggle_districts !== false || cfg.toggle_weather !== false;
      if (!showsStormExtras) continue;

      const messageId = await env.STATUS_KV.get(`last_message_id:${gid}`);
      const channelId = await env.STATUS_KV.get(`last_channel_id:${gid}`);
      if (!messageId || !channelId) continue;

      const built = await buildStatusPayload(env, { includeComponents: true, guildId: gid });

      // PATCH only embeds/components: the original post's content (role
      // mentions) must stay untouched, and an edit never re-pings anyway.
      const resp = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          embeds: built.payload.embeds,
          components: built.payload.components || []
        })
      });
      if (resp.ok) {
        updated++;
      } else if (resp.status !== 404) {
        // 404 just means the tracked message was deleted — the next scheduled
        // check reposts it. Anything else is worth a log line.
        console.error(`Storm refresh edit failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error(`Storm refresh failed for guild ${gid}:`, e);
    }
  }

  return { updated };
}
