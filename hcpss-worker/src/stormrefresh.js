// While a power-threatening storm warning is active (ice storm, blizzard,
// winter storm, high wind, severe thunderstorm, ...), refresh each guild's
// posted status message every 15 minutes so the live extras (power outages,
// road conditions, nearby districts, weather alerts) stay current. Edits the
// existing message in place — no new posts, no pings. Advisory-level events
// don't trigger it.

import { getActiveWeatherAlerts, getCachedWeatherAlerts, hasPowerThreatAlert, hasStormAlert, DEFAULT_NWS_ZONE } from './weather.js';
import { getDistrictMeta } from './districts.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { buildStatusPayload } from './embeds.js';
import { discordFetch } from './discord.js';
import { clearOutageCaches, getCachedOutageTotal } from './outages.js';
import { clearRoadsCache } from './roads.js';

const SLOT_KEY = 'last_storm_refresh_slot';
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
// Push-hook (forced) refreshes dedupe on a finer bucket: a storm's outage
// numbers move constantly, and the external watcher pings on every real
// change — this caps embed edits at one per 5 minutes.
const FORCED_INTERVAL_MS = 5 * 60 * 1000;
// After the last refresh, forced pings keep refreshing for this long even
// without a power threat in the cache, so the ping that follows an alert's
// expiry still clears the embed's storm sections instead of leaving them
// frozen at the storm's peak.
const TRAILING_REFRESH_MS = 60 * 60 * 1000;

// Approximate time of the refresh a stored slot value represents. Forced
// slots are `f<5-min bucket>`, cron slots a bare 15-min bucket. 0 when the
// value is missing or unparseable (treated as "no recent refresh").
export function slotTimestampMs(slotVal) {
  if (typeof slotVal !== 'string' || !slotVal) return 0;
  const bucket = slotVal.split('@')[0];
  const forced = bucket.startsWith('f');
  const n = Number(forced ? bucket.slice(1) : bucket);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n * (forced ? FORCED_INTERVAL_MS : REFRESH_INTERVAL_MS);
}

// A stored slot is `<bucket>` (or `f<bucket>`) optionally followed by
// `@<ms>` — the last time a refresh was actually *warranted* by live weather.
//
// That timestamp is why the suffix exists. The trailing window used to be
// measured from the stored slot itself, i.e. from the last refresh that ran —
// but every trailing refresh rewrites the slot, so each one re-armed the
// window it was supposed to be running out. One storm therefore kept the
// cascade firing on every push indefinitely: a single Severe alert on the
// evening of 2026-07-28 left it refreshing every 5 minutes for days with no
// alert active anywhere, which is what pushed KV writes from ~300/day to
// ~900/day against a 1,000/day cap. Anchoring the window to the storm instead
// of to the refresh makes it a real one-hour tail.
//
// Legacy values carry no `@`, so they fall back to the old meaning for at most
// one hour and then self-correct.
export function parseSlot(slotVal) {
  const raw = typeof slotVal === 'string' ? slotVal : '';
  const cut = raw.indexOf('@');
  const bucket = cut === -1 ? raw : raw.slice(0, cut);
  const armed = cut === -1 ? NaN : Number(raw.slice(cut + 1));
  return {
    bucket,
    armedAt: Number.isFinite(armed) && armed > 0 ? armed : slotTimestampMs(bucket)
  };
}

// Customers out (across every county the bot serves) below which a storm-level
// alert alone is not worth a refresh. The gate below opens for any storm
// alert, and "storm" matches heat events by name — without a floor, a July
// heat advisory would run the refresh cascade all day for nothing, which is
// the exact regression the warning-only gate was introduced to stop. The
// collector buckets outage counts to the nearest 100, so anything under a few
// hundred is noise it would never have pushed anyway.
export const MIN_OUTAGE_CUSTOMERS_FOR_REFRESH = 500;

// Is a refresh worth doing for this alert set?
//
// The embed renders its live storm sections (outages, roads, districts) under
// hasStormAlert — advisories and watches included — but this module used to
// refresh only under hasPowerThreatAlert, which is warning-level only. Under a
// Winter Weather Advisory the embed therefore showed an outage line that
// nothing ever updated: it stayed frozen at the number from when the post went
// out, while a manual check showed the real one. Aligning the gate with what
// the embed actually renders is the fix; the outage floor is what keeps the
// wider gate from costing anything on a quiet advisory day.
export function refreshWarranted(alerts, outageCustomers) {
  if (hasPowerThreatAlert(alerts)) return true;
  return hasStormAlert(alerts) && Number(outageCustomers || 0) >= MIN_OUTAGE_CUSTOMERS_FOR_REFRESH;
}

// The alerts for every zone the bot currently serves: the caller's
// already-read default zone plus each guild's primary district. `read` is the
// zone reader — cache-only for the forced path (a push-triggered gate must
// never fetch), live-with-cache for the cron path, which is the fallback
// detector when the collector is dead.
async function alertsForServedZones(env, guildIds, read, defaultAlerts) {
  const alerts = [...defaultAlerts];
  const zones = new Set();
  for (const gid of guildIds) {
    const meta = getDistrictMeta(getEffectiveConfig(await getConfig(env, gid)).primary_district);
    // The default zone is already in `alerts` — a guild following Howard must
    // not cost a second read of it.
    if (meta && meta.nwsZone && meta.nwsZone !== DEFAULT_NWS_ZONE) zones.add(meta.nwsZone);
  }
  for (const zone of zones) {
    alerts.push(...(await read(env, zone)));
  }
  return alerts;
}

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
// outage, or road data actually change) skips the minute gate but keeps the
// power-threat gate, using cache-only reads: the embed only shows live storm
// sections during a power-threat warning, so refreshing outside one is pure
// KV churn (a July heat advisory used to keep this cascade running all day).
// For up to an hour after the last refresh the gate stays open even without
// a cached threat, so the ping that follows an alert's expiry clears the
// embed. Forced runs dedupe on a 5-minute bucket, capping the edit rate
// during a busy storm. Never throws.
export async function maybeRefreshStormEmbeds(env, now = new Date(), opts = {}) {
  if (!env || !env.STATUS_KV) return { updated: 0 };
  const force = opts.force === true;
  if (!force && now.getUTCMinutes() % 15 !== 0) return { updated: 0 };

  const slot = force
    ? `f${Math.floor(now.getTime() / FORCED_INTERVAL_MS)}`
    : String(Math.floor(now.getTime() / REFRESH_INTERVAL_MS));
  // Compare the bucket only — the stored value also carries the armed-at
  // timestamp, and comparing the raw string would never match, defeating the
  // dedupe and refreshing on every single push.
  const { bucket: lastBucket, armedAt: lastArmedAt } = parseSlot(await env.STATUS_KV.get(SLOT_KEY));
  if (lastBucket === slot && !opts.bypassDedupe) return { updated: 0 };

  let guildIds = null;
  let warranted = opts.bypassGate === true;
  if (force) {
    if (!warranted) {
      // Cache-only probe (the weather cache only exists while alerts are active,
      // and hook-armed freshness keeps it current): a quiet-day ping costs a
      // couple of KV reads and no fetches, edits, or cache churn. A
      // warning-level threat in the default zone short-circuits before any
      // guild config is read.
      const defaultAlerts = await getCachedWeatherAlerts(env);
      warranted = hasPowerThreatAlert(defaultAlerts);
      if (!warranted) {
        guildIds = await readGuildIds(env);
        const alerts = await alertsForServedZones(env, guildIds, getCachedWeatherAlerts, defaultAlerts);
        warranted = refreshWarranted(alerts, await getCachedOutageTotal(env));
      }
    }
    // Measured from the last *warranted* refresh, so the tail actually runs
    // out. See parseSlot.
    if (!warranted && now.getTime() - lastArmedAt > TRAILING_REFRESH_MS) {
      return { updated: 0 };
    }
  } else {
    // Cron path: same gate, but reading alerts live-with-cache — this is the
    // fallback detector when the collector is dead. Weather is checked before
    // claiming the slot so quiet days cost no writes, and the first storm-time
    // tick still runs the refresh.
    const defaultAlerts = await getActiveWeatherAlerts(env);
    warranted = hasPowerThreatAlert(defaultAlerts);

    if (!warranted) {
      // No warning-level threat in the default (Howard) zone: widen to the
      // zones of guilds whose primary district is a neighboring county.
      guildIds = await readGuildIds(env);
      const alerts = await alertsForServedZones(env, guildIds, getActiveWeatherAlerts, defaultAlerts);
      warranted = refreshWarranted(alerts, await getCachedOutageTotal(env));
      if (!warranted) return { updated: 0 };
    }
  }
  // A warranted refresh re-arms the trailing window; a trailing one carries
  // the original arm time forward untouched, so the tail expires an hour after
  // the storm rather than an hour after the last push.
  await env.STATUS_KV.put(SLOT_KEY, `${slot}@${warranted ? now.getTime() : lastArmedAt}`);

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
