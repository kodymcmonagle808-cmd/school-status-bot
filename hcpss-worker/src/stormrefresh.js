// While a power-threatening storm warning is active (ice storm, blizzard,
// winter storm, high wind, severe thunderstorm, ...), refresh each guild's
// posted status message every 15 minutes so the live extras (power outages,
// road conditions, nearby districts, weather alerts) stay current. Edits the
// existing message in place — no new posts, no pings. Advisory-level events
// don't trigger it.

import { getActiveWeatherAlerts, getCachedWeatherAlerts, hasPowerThreatAlert } from './weather.js';
import { getDistrictMeta } from './districts.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { buildStatusPayload } from './embeds.js';
import { discordFetch } from './discord.js';
import { clearOutageCaches } from './outages.js';
import { clearRoadsCache } from './roads.js';

const SLOT_KEY = 'last_storm_refresh_slot';
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
// Push-hook (forced) refreshes dedupe on a finer bucket: a storm's outage
// numbers move constantly, and the external watcher pings on every real
// change — this caps embed edits at one per 5 minutes.
const FORCED_INTERVAL_MS = 5 * 60 * 1000;

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

// Runs from the per-minute cron, gated to the :00/:15/:30/:45 minute of each
// hour — a clock gate costs zero KV ops, where the old probe-slot key spent
// ~96 writes/day pacing the quiet-weather path year-round. The slot key still
// dedupes the refresh itself in case a delayed tick lands in the same bucket.
// { force: true } (the push-hook paths — the external watcher saw alert,
// outage, or road data actually change) skips both the minute gate and the
// power-threat probe: something on the embed is known-stale, so refresh it
// whatever the weather. Forced runs dedupe on a 5-minute bucket, capping the
// edit rate during a busy storm. Never throws.
export async function maybeRefreshStormEmbeds(env, now = new Date(), opts = {}) {
  if (!env || !env.STATUS_KV) return { updated: 0 };
  const force = opts.force === true;
  if (!force && now.getUTCMinutes() % 15 !== 0) return { updated: 0 };

  const slot = force
    ? `f${Math.floor(now.getTime() / FORCED_INTERVAL_MS)}`
    : String(Math.floor(now.getTime() / REFRESH_INTERVAL_MS));
  if (await env.STATUS_KV.get(SLOT_KEY) === slot) return { updated: 0 };

  let guildIds = null;
  if (force && opts.requireActiveAlerts) {
    // Data-context pings (outages, roads) only matter while some alert is
    // active — that's when the embed shows those sections. Cache-only reads:
    // the weather cache exists only while alerts are active, so a quiet day
    // costs a couple of KV reads and no fetches, edits, or cache churn.
    let active = (await getCachedWeatherAlerts(env)).length > 0;
    if (!active) {
      guildIds = await readGuildIds(env);
      const zones = new Set();
      for (const gid of guildIds) {
        const meta = getDistrictMeta(getEffectiveConfig(await getConfig(env, gid)).primary_district);
        if (meta && meta.nwsZone) zones.add(meta.nwsZone);
      }
      for (const zone of zones) {
        if ((await getCachedWeatherAlerts(env, zone)).length > 0) {
          active = true;
          break;
        }
      }
    }
    if (!active) return { updated: 0 };
  }
  if (!force) {
    // Cron path: refresh only while a power-threatening storm is active.
    // Weather is checked before claiming the slot so quiet days cost no
    // writes, and the first storm-time tick still runs the refresh.
    const alerts = await getActiveWeatherAlerts(env);
    let threat = hasPowerThreatAlert(alerts);

    if (!threat) {
      // No threat in the default (Howard) zone: probe the zones of guilds whose
      // primary district is a neighboring county.
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
  }
  await env.STATUS_KV.put(SLOT_KEY, slot);

  // Only once a refresh is definitely happening: drop the data caches the
  // caller flagged as stale, so the rebuild fetches live. Clearing before
  // the gates would churn writes on refreshes that never run.
  if (opts.refreshContextCaches) {
    await clearOutageCaches(env);
    await clearRoadsCache(env);
  }

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
