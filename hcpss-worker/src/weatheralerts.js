// NWS alert issuance notices: posts within ~15 minutes when the National
// Weather Service issues a school-impacting alert (winter/heat watch,
// warning, or advisory) for the guild's county — the moment parents start
// wondering about tomorrow. Uses the same 10-minute alert cache as the
// status embeds; quiet zones are fetched live (the cache only stores
// active alerts, so a quiet scan costs an NWS fetch and no KV writes).
//
// Dedupe is per guild by event name: each event posts once and is considered
// "seen" until that alert's end time passes (24h fallback when NWS gives no
// end), so extensions and updates of the same alert stay quiet but the next
// storm's alert posts again.

import { getEasternTimeStr } from './timeutil.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { getDistrictMeta } from './districts.js';
import { getActiveWeatherAlerts, isSchoolImpactIssuance, isEmergencyAlert, DEFAULT_NWS_ZONE } from './weather.js';
import { discordFetch } from './discord.js';
import { logAction, logActionError } from './actionlog.js';

const SEEN_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

// The cron fires every minute; scan on one fixed minute of every ten. A clock
// gate costs zero KV ops, unlike the old cooldown key (~100 writes/day).
// Offset staggers this scan away from the other watchers' gate minutes.
export const SCAN_MINUTE_OFFSET = 6;

// When the external push poller is wired up (NWS_HOOK_SECRET set, see
// gas/nws-alert-watcher.js and the /nws-hook route), it detects changes within
// minutes and this cron scan becomes an hourly safety net; without it, the
// scan is the only detector and keeps its 10-minute cadence. Pure for tests.
export function shouldScanThisMinute(minuteOfHour, hookConfigured) {
  return hookConfigured
    ? minuteOfHour === SCAN_MINUTE_OFFSET
    : minuteOfHour % 10 === SCAN_MINUTE_OFFSET;
}

// Quiet hours: alerts issued overnight wait for 6 AM ET (storm mode already
// covers the early-morning window; a 3 AM ping helps nobody sleep).
const POST_FROM_MIN = 6 * 60;
const POST_UNTIL_MIN = 22 * 60;

// One entry in the seen map, normalized. Entries written before notices were
// deletable are a bare expiry number and carry no message to clean up — they
// still dedupe correctly, they just can't be deleted.
// `tier` is 'e' (announced as an emergency) or 'r' (announced as a routine
// notice), and is absent on entries written before the tiers existed. Absent
// is deliberately not the same as 'r': it means "unknown", and only a known
// 'r' can escalate, so a deploy mid-alert can't re-announce everything active.
//
// `msgs` is a *list* of the messages this alert has produced, as {m, c} pairs.
// One alert can produce two: the quiet notice, and then the emergency post
// when NWS upgrades it to the phone tier under the same event name. A single
// msg/ch pair meant the second post overwrote the first one's id and orphaned
// that message in the channel — the same leak as the pruning one, one level
// down. Entries written before this are a bare msg/ch pair and normalize in.
function seenEntry(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? { until: value, msgs: [] } : null;
  }
  if (value && typeof value === 'object' && Number(value.until) > 0) {
    const entry = { until: Number(value.until), msgs: [] };
    if (value.tier === 'e' || value.tier === 'r') entry.tier = value.tier;
    for (const m of Array.isArray(value.msgs) ? value.msgs : []) {
      if (m && m.m && m.c) entry.msgs.push({ m: String(m.m), c: String(m.c) });
    }
    // Falls back rather than branching on which key is present: an empty
    // `msgs` must not shadow a legacy pair sitting beside it.
    if (!entry.msgs.length && value.msg && value.ch) {
      entry.msgs.push({ m: String(value.msg), c: String(value.ch) });
    }
    return entry;
  }
  return null;
}

// Adds a posted message to every alert it announced, so all of them are
// deleted when the alert is over. Returns whether anything was recorded.
export function recordNotice(updatedSeen, alerts, messageId, channelId) {
  if (!messageId || !channelId) return false;
  let recorded = false;
  for (const a of Array.isArray(alerts) ? alerts : []) {
    const entry = a && a.event ? updatedSeen[a.event] : null;
    if (!entry) continue;
    entry.msgs = [...(entry.msgs || []), { m: String(messageId), c: String(channelId) }];
    recorded = true;
  }
  return recorded;
}

// Splits currently active school-impact alerts into ones not yet announced for
// this guild, and returns the pruned+updated seen map to store plus the
// entries that just aged out. Pure for tests.
//
// seen: { [event]: { until, msg, ch } }, where msg/ch locate the posted notice
// so it can be deleted once the alert is over. `expired` carries the entries
// dropped by this call that still have a message to remove — passing an empty
// alert list therefore turns this into a pure "what should be cleaned up now?"
// query, which is how the cleanup pass reuses it.
export function pickNewAlerts(alerts, seen, nowMs) {
  const cleaned = {};
  const expired = [];
  for (const [event, raw] of Object.entries(seen && typeof seen === 'object' ? seen : {})) {
    const entry = seenEntry(raw);
    if (!entry) continue;
    if (entry.until > nowMs) {
      cleaned[event] = entry;
    } else if (entry.msgs.length) {
      // `until` rides along so a failed delete can be put back in the map and
      // retried, instead of leaving a message nothing knows about any more.
      expired.push({ event, until: entry.until, msgs: entry.msgs });
    }
  }

  const newAlerts = [];
  for (const a of Array.isArray(alerts) ? alerts : []) {
    if (!a || !a.event) continue;
    const until = a.endsMs && a.endsMs > nowMs ? a.endsMs : nowMs + SEEN_FALLBACK_TTL_MS;
    if (cleaned[a.event]) {
      const prev = cleaned[a.event];
      // Already announced, so stay quiet — but NWS routinely extends an alert
      // instead of reissuing it. Carry the later end time forward, or the
      // notice would be deleted while the alert is still running.
      const next = until > prev.until ? { ...prev, until } : prev;

      // The exception: NWS also *upgrades* a warning in place. An ordinary
      // Severe Thunderstorm Warning becomes a DESTRUCTIVE one tagged for
      // phones, and it is still called "Severe Thunderstorm Warning" — which
      // is how dedupe-by-event-name ends up swallowing precisely the version
      // worth pinging for. It happened on 2026-08-10: ordinary warnings at
      // 3:55 and 3:57 PM, then the 80 mph destructive one at 4:10.
      //
      // The already-posted quiet notice stays in `msgs`, and the emergency
      // post appends to it rather than replacing it, so both come down when
      // the alert ends.
      if (prev.tier === 'r' && isEmergencyAlert(a)) {
        cleaned[a.event] = { ...next, tier: 'e' };
        newAlerts.push(a);
        continue;
      }
      cleaned[a.event] = next;
      continue;
    }
    cleaned[a.event] = { until, tier: isEmergencyAlert(a) ? 'e' : 'r', msgs: [] };
    newAlerts.push(a);
  }
  return { newAlerts, updatedSeen: cleaned, expired };
}

export function formatIssuanceLines(alerts, emoji = '⚠️') {
  return (Array.isArray(alerts) ? alerts : []).map(a => {
    const from = a.onsetMs ? ` from <t:${Math.floor(a.onsetMs / 1000)}:f>` : '';
    const until = a.endsMs ? ` until <t:${Math.floor(a.endsMs / 1000)}:f>` : '';
    const headline = a.headline ? `\n> ${a.headline}` : '';
    return `${emoji} **${a.event}**${from}${until}${headline}`;
  }).join('\n\n');
}

export function issuanceEmbedColor(alerts) {
  const severities = (Array.isArray(alerts) ? alerts : []).map(a => a && a.severity);
  if (severities.includes('Extreme')) return 0xE74C3C;
  if (severities.includes('Severe')) return 0xE67E22;
  return 0xF1C40F;
}

// --- The emergency tier ---
//
// isEmergencyAlert (weather.js) picks these out; they get their own message
// rather than riding the routine notice, because everything about that notice
// is wrong for them: it is deliberately quiet ("no decision has been
// announced"), it never pings, and it is deleted once the alert ends. A
// batched scan can turn up a Tornado Warning and a Winter Weather Advisory in
// the same pass, and folding the first into the second is how a life-safety
// alert ends up as the second bullet of a forecast summary.

// Gold rather than the 0xF1C40F the advisory-tier issuance notice uses — the
// two sit next to each other in the same channel, so the emergency needs to be
// the brighter of the two at a glance.
const EMERGENCY_COLOR = 0xFFD700;
const DISCORD_CONTENT_LIMIT = 2000;
const EMBED_FIELD_LIMIT = 1024;

// One line someone can act on before reading anything else. NWS ships its own
// instruction text and it is included below when present, but it is long,
// occasionally missing, and buried under boilerplate — so the message always
// leads with this. Order matters: the first pattern to match wins, so the
// events that share vocabulary ("Extreme Wind Warning" during a hurricane) are
// ordered most specific first.
const EMERGENCY_ACTIONS = [
  [/tornado/i, 'TAKE SHELTER NOW — lowest floor, interior room, away from windows.'],
  [/extreme wind|hurricane/i, 'TAKE SHELTER NOW — interior room on the lowest floor, away from windows.'],
  [/flood/i, 'MOVE TO HIGHER GROUND NOW — never walk or drive through flood water.'],
  [/evacuation/i, 'EVACUATE NOW — follow the route given by local officials.'],
  [/fire/i, 'BE READY TO LEAVE NOW — follow instructions from local officials.']
];

export function emergencyActionLine(event) {
  const text = event || '';
  for (const [re, line] of EMERGENCY_ACTIONS) {
    if (re.test(text)) return line;
  }
  return 'TAKE SHELTER NOW and follow instructions from local emergency officials.';
}

// Splits a batch into the alerts that get the loud treatment and the ones that
// get the routine notice. Pure for tests.
export function splitEmergencyAlerts(alerts) {
  const emergency = [];
  const routine = [];
  for (const a of Array.isArray(alerts) ? alerts : []) {
    if (!a) continue;
    (isEmergencyAlert(a) ? emergency : routine).push(a);
  }
  return { emergency, routine };
}

// The full Discord message payload for an emergency alert. Pure for tests.
//
// Deliberately loud: an @everyone ping, an H1 banner and an H2 action line in
// the message content (Discord renders markdown headings there, which is the
// only way to make text physically larger than a normal post), and a pure-red
// embed under it. The heading text carries the event and the action even for
// anyone whose client collapses the embed.
export function buildEmergencyMessage(alerts, opts = {}) {
  const list = (Array.isArray(alerts) ? alerts : []).filter(a => a && a.event);
  if (!list.length) return null;

  const {
    county = '',
    footer = 'School Status',
    ping = true,
    nowIso = new Date().toISOString()
  } = opts;

  const where = county ? `${county} County` : 'your area';
  const banner = list.length === 1 ? list[0].event.toUpperCase() : `${list.length} EMERGENCY ALERTS`;
  const action = emergencyActionLine(list.map(a => a.event).join(' '));

  const content =
    (ping ? '@everyone\n' : '') +
    `# 🚨 ${banner}\n` +
    `## ${where} — ${action}`;

  const embed = {
    title: `🚨 ${banner} — ${where}`,
    url: 'https://alerts.weather.gov',
    color: EMERGENCY_COLOR,
    description: `${formatIssuanceLines(list, '🚨')}\n\n**${action}**`,
    timestamp: nowIso,
    footer: { text: `${footer} · via National Weather Service` }
  };

  const instructions = list.map(a => (a.instruction || '').trim()).filter(Boolean).join('\n\n');
  if (instructions) {
    embed.fields = [{
      name: '📋 National Weather Service instructions',
      value: instructions.slice(0, EMBED_FIELD_LIMIT)
    }];
  }

  return {
    content: content.slice(0, DISCORD_CONTENT_LIMIT),
    embeds: [embed],
    // The ping only lands if the bot itself holds Mention Everyone in that
    // channel; without it Discord delivers the message unpinged rather than
    // erroring, so there is nothing to detect here.
    allowed_mentions: ping ? { parse: ['everyone'] } : { parse: [] }
  };
}

// Read the cached guild index, never KV.list() — this runs from per-minute
// paths and list ops are capped at 1,000/day on the free plan.
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

// Posts one message and returns its id ('' when Discord gave no body back, or
// null when the post failed). Never throws.
async function postNotice(env, channelId, payload) {
  try {
    const resp = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      console.error(`NWS notice post failed for channel ${channelId}: ${resp.status}`);
      return null;
    }
    try {
      const posted = await resp.json();
      return posted && posted.id ? String(posted.id) : '';
    } catch {
      // The message is up; not learning its id only means it can't be deleted
      // later. Never let that turn into a failure.
      return '';
    }
  } catch (e) {
    console.error(`NWS notice post threw for channel ${channelId}:`, e);
    return null;
  }
}

// Runs from the per-minute cron, or with { force: true } from the /push-data
// and /nws-hook push endpoints (skips the minute gate; quiet hours and the
// per-guild seen map still apply, so a repeated ping can't double-post).
// Never throws.
export async function maybeSendWeatherAlertNotices(env, now = new Date(), opts = {}) {
  if (!env || !env.STATUS_KV) return { sent: 0 };
  const [h, m] = getEasternTimeStr(now).split(':').map(Number);
  const nowMin = h * 60 + m;
  if (!opts.force && !shouldScanThisMinute(m, !!env.NWS_HOOK_SECRET)) return { sent: 0 };

  // Quiet hours hold back routine notices only — the scan itself now runs
  // around the clock, because a tornado warning at 2 AM is the one thing worth
  // waking a server for. A quiet night still costs zero KV writes (an empty
  // alert set is deliberately never cached), and a storm night costs the same
  // cache refreshes the daytime scan already spends.
  const quiet = nowMin < POST_FROM_MIN || nowMin >= POST_UNTIL_MIN;

  const guildIds = await readGuildIds(env);

  const alertsByZone = new Map();
  const nowMs = now.getTime();
  let sent = 0;
  let deletedByScan = 0;

  for (const gid of guildIds) {
    try {
      const cfg = getEffectiveConfig(await getConfig(env, gid));
      if (!cfg.alert_channel_id) continue;

      // Two independent switches: a server that has turned off routine
      // issuance notices (a lot of forecast chatter over a winter) still gets
      // tornado warnings, which is the only default that makes sense for an
      // alert whose whole point is that it is rare.
      const emergencyOn = cfg.toggle_emergency_alerts !== false;
      const routineOn = cfg.toggle_nws_alerts !== false && !quiet;
      if (!emergencyOn && !routineOn) continue;

      const meta = cfg.primary_district && cfg.primary_district !== 'hcpss' ? getDistrictMeta(cfg.primary_district) : null;
      const zone = meta && meta.nwsZone ? meta.nwsZone : DEFAULT_NWS_ZONE;
      const county = meta ? meta.county : 'Howard';

      if (!alertsByZone.has(zone)) {
        const active = await getActiveWeatherAlerts(env, zone);
        alertsByZone.set(zone, active.filter(isSchoolImpactIssuance));
      }
      const impact = alertsByZone.get(zone);
      if (!impact.length) continue;

      // Filter before pickNewAlerts, never after: anything held back here also
      // stays out of the seen map, so a Winter Storm Warning issued at 3 AM is
      // still waiting to be announced at 6. Marking it seen overnight and then
      // dropping it at the post step would silence it for good.
      const eligible = impact.filter(a => (isEmergencyAlert(a) ? emergencyOn : routineOn));
      if (!eligible.length) continue;

      let seen = {};
      try {
        const rawSeen = await env.STATUS_KV.get(`nws_alerts_seen:${gid}`);
        if (rawSeen) seen = JSON.parse(rawSeen) || {};
      } catch {}

      const { newAlerts, updatedSeen, expired } = pickNewAlerts(eligible, seen, nowMs);
      // Nothing to announce: leave the map alone. Any aged-out entries stay
      // put and the cleanup pass takes them, which is why this returns before
      // touching `expired` rather than after.
      if (!newAlerts.length) continue;

      // The write below drops the aged-out entries — and their message ids with
      // them — so their notices have to come down first or they are orphaned in
      // the channel with nothing left that knows they exist.
      if (expired.length) {
        deletedByScan += (await removeExpiredNotices(env, expired, updatedSeen)).deleted;
      }

      // Mark before posting so a delayed cron tick can't double-post.
      await env.STATUS_KV.put(`nws_alerts_seen:${gid}`, JSON.stringify(updatedSeen));

      const { emergency, routine } = splitEmergencyAlerts(newAlerts);
      // Both branches below may amend the map that was just written; they share
      // one rewrite at the end so a scan still costs at most two writes.
      let seenDirty = false;

      if (emergency.length) {
        const posted = await postNotice(env, cfg.alert_channel_id, buildEmergencyMessage(emergency, {
          county,
          footer: cfg.alert_embed_footer || 'School Status',
          ping: cfg.toggle_emergency_ping !== false,
          nowIso: now.toISOString()
        }));
        const events = emergency.map(a => a.event).join(', ');
        if (posted === null) {
          // Unmark, so the next scan retries. Mark-before-post exists to stop a
          // delayed tick double-posting, and everywhere else that trade is
          // right — but here it would trade a duplicate tornado warning for a
          // missing one on a single transient 500 (discordFetch has already
          // retried by this point). A duplicate is the better failure.
          for (const a of emergency) delete updatedSeen[a.event];
          seenDirty = true;
          // The one posting failure worth surfacing beyond the console — still
          // through the free logger, not a panel write, per the KV budget.
          logActionError(`🚨 EMERGENCY alert (${events}) FAILED to post to <#${cfg.alert_channel_id}> — retrying next scan.`, { guildId: gid });
        } else {
          sent++;
          // Recorded for cleanup like any other notice, so it comes down when
          // the alert ends. A live "TAKE SHELTER NOW" banner still sitting at
          // the top of the channel an hour after the tornado passed is its own
          // kind of wrong, and the alert history lives in the logs regardless.
          if (recordNotice(updatedSeen, emergency, posted, cfg.alert_channel_id)) seenDirty = true;
          logAction(`🚨 EMERGENCY alert (${events}) posted to <#${cfg.alert_channel_id}>${cfg.toggle_emergency_ping !== false ? ' with @everyone' : ''}.`, { guildId: gid });
        }
      }

      if (routine.length) {
        const title = routine.length === 1
          ? `⚠️ ${routine[0].event} — ${county} County`
          : `⚠️ NWS Alerts Issued — ${county} County`;
        const posted = await postNotice(env, cfg.alert_channel_id, {
          embeds: [{
            title,
            url: 'https://alerts.weather.gov',
            color: issuanceEmbedColor(routine),
            description: formatIssuanceLines(routine) +
              '\n\nNo decision has been announced — this is the weather alert schools watch. Status posts will follow if anything changes.',
            timestamp: now.toISOString(),
            footer: { text: `${cfg.alert_embed_footer || 'School Status'} · via National Weather Service` }
          }],
          allowed_mentions: { parse: [] }
        });
        if (posted === null) {
          console.error(`NWS issuance post failed for guild ${gid}`);
        } else {
          sent++;
          // Remember where the notice landed so maybeCleanupExpiredAlertNotices
          // can delete it once the alert is over. A second write, but only on a
          // real post (a handful per storm) — it cannot replace the
          // mark-before-post write above without reopening the double-post hole.
          if (recordNotice(updatedSeen, routine, posted, cfg.alert_channel_id)) seenDirty = true;
          logAction(`⚠️ NWS issuance notice (${routine.map(a => a.event).join(', ')}) posted to <#${cfg.alert_channel_id}>.`, { guildId: gid });
        }
      }

      if (seenDirty) {
        try {
          await env.STATUS_KV.put(`nws_alerts_seen:${gid}`, JSON.stringify(updatedSeen));
        } catch (e) {
          // Everything that was going to post has posted; failing here only
          // costs a notice its cleanup, or an emergency its retry.
          console.error(`NWS seen-map rewrite failed for guild ${gid}:`, e);
        }
      }
    } catch (e) {
      console.error(`NWS issuance notice failed for guild ${gid}:`, e);
    }
  }
  if (deletedByScan) logAction(`Deleted ${deletedByScan} expired NWS notice(s) while announcing new ones.`);
  return { sent, deleted: deletedByScan };
}

// --- Deleting notices once their alert is over ---
//
// This has to be its own cron pass rather than a branch of the scan above,
// because every gate on that scan is wrong for cleanup: it returns early
// during quiet hours (an alert ending at 10 PM would never be cleaned), and it
// skips a guild entirely when no school-impact alert is active — which is
// exactly the state a just-expired alert leaves behind.
//
// Every 5 minutes, so a notice outlives its alert by at most that. A clock
// gate costs zero KV ops; the per-guild reads only happen on the gate minute
// (a read, not a write — 288/day/guild against a 100,000/day read budget), and
// nothing is written unless something was actually deleted.
export const CLEANUP_MINUTE_OFFSET = 4;

export function isNoticeCleanupMinute(minuteOfHour) {
  return minuteOfHour % 5 === CLEANUP_MINUTE_OFFSET;
}

// Removes one posted notice. A 404 means it is already gone (deleted by hand,
// or the channel was cleared) — that is success as far as cleanup is
// concerned, so the entry gets dropped rather than retried forever.
async function deleteNotice(env, channelId, messageId) {
  try {
    const resp = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
    });
    if (resp.ok || resp.status === 404) return true;
    console.error(`NWS notice delete failed (${channelId}/${messageId}): ${resp.status}`);
    return false;
  } catch (e) {
    console.error('NWS notice delete threw:', e);
    return false;
  }
}

// Deletes the notices for entries that just aged out of the seen map, and puts
// any that could not be deleted back into it so the next pass retries rather
// than losing the message id.
//
// Shared by both writers of `nws_alerts_seen`, which is the whole point:
// **every path that drops an aged-out entry must delete its message first.**
// The scan used to prune entries and write the pruned map without ever looking
// at `expired`, so any notice that expired between two scans was orphaned —
// its id gone from KV, the message left in the channel forever. On 2026-08-10
// the 4:49 PM scan silently orphaned the tornado warning notice that had
// expired at 4:45, four minutes before the cleanup pass would have removed it.
async function removeExpiredNotices(env, expired, updatedSeen) {
  // One message can announce several alerts at once. Don't delete it while any
  // alert still riding on it is active — otherwise a notice covering a watch
  // until 10 PM and a warning until 6 AM vanishes at 10 PM.
  const stillLive = new Set();
  for (const entry of Object.values(updatedSeen)) {
    for (const m of (entry && entry.msgs) || []) stillLive.add(m.m);
  }

  const handled = new Set();
  let deleted = 0;
  for (const e of expired) {
    const failed = [];
    for (const m of e.msgs || []) {
      if (stillLive.has(m.m) || handled.has(m.m)) continue;
      if (await deleteNotice(env, m.c, m.m)) {
        handled.add(m.m);
        deleted++;
      } else {
        failed.push(m);
      }
    }
    // Keep whatever wouldn't delete. Its `until` is already in the past, so it
    // is pruned and retried immediately next time — and because it stays out
    // of the live map, a re-issued alert of the same name still announces.
    if (failed.length) updatedSeen[e.event] = { until: e.until, msgs: failed };
  }
  return { deleted };
}

// Runs from the per-minute cron. Deletes each guild's issuance notices whose
// alert has ended. Never throws.
export async function maybeCleanupExpiredAlertNotices(env, now = new Date()) {
  if (!env || !env.STATUS_KV) return { deleted: 0 };
  if (!isNoticeCleanupMinute(now.getUTCMinutes())) return { deleted: 0 };

  const guildIds = await readGuildIds(env);
  const nowMs = now.getTime();
  let deleted = 0;

  for (const gid of guildIds) {
    try {
      const raw = await env.STATUS_KV.get(`nws_alerts_seen:${gid}`);
      if (!raw) continue;
      let seen = {};
      try {
        seen = JSON.parse(raw) || {};
      } catch {
        continue;
      }

      // An empty alert list makes this a pure "what aged out?" query.
      const { updatedSeen, expired } = pickNewAlerts([], seen, nowMs);
      if (!expired.length) continue;

      // Puts anything it couldn't delete back into updatedSeen, so the write
      // below never loses a message id.
      deleted += (await removeExpiredNotices(env, expired, updatedSeen)).deleted;

      if (Object.keys(updatedSeen).length) {
        await env.STATUS_KV.put(`nws_alerts_seen:${gid}`, JSON.stringify(updatedSeen));
      } else {
        await env.STATUS_KV.delete(`nws_alerts_seen:${gid}`);
      }
    } catch (e) {
      console.error(`NWS notice cleanup failed for guild ${gid}:`, e);
    }
  }

  if (deleted) logAction(`Deleted ${deleted} expired NWS issuance notice(s).`);
  return { deleted };
}
