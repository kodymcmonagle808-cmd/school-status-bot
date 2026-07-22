// Decision Watch: one live board per guild during the early-morning decision
// window (4:30–7:30 AM ET) on storm mornings, showing what every district has
// announced so far — the thing families refresh Twitter for at 5 AM. The board
// posts once (no pings) on the first storm tick of the morning and is edited
// in place every 15 minutes; storm mode still handles the actual status posts.

import { getEasternTimeStr, formatYmdNY, formatStatusDate, stormTickSlot } from './timeutil.js';
import { getActiveWeatherAlerts, hasStormAlert } from './weather.js';
import {
  getDistrictStatuses,
  formatDistrictLines,
  getDistrictMeta,
  statusKeyToDistrictStatus
} from './districts.js';
import { getStatusCards, determineStatusKey, HCPSS_URL } from './scraper.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { discordFetch } from './discord.js';
import { postLog } from './panel.js';

const SLOT_KEY = 'last_decision_watch_slot';
const CLEANUP_DAY_KEY = 'last_decision_watch_cleanup_day';

function boardKey(guildId) {
  return `decision_watch:${guildId}`;
}

// Orders the full board for one guild: its own primary district pinned first,
// then everyone else. `hcpssEntry` is the status-page scrape reduced to a
// district-style entry (null when the scrape failed). Exported for tests.
export function buildDecisionWatchEntries(districts, hcpssEntry, primaryId = 'hcpss') {
  const all = [];
  if (hcpssEntry) all.push(hcpssEntry);
  for (const d of Array.isArray(districts) ? districts : []) all.push(d);
  all.sort((a, b) => (a.id === primaryId ? -1 : 0) - (b.id === primaryId ? -1 : 0));
  return all;
}

// Records when each district's announcement was first seen this morning
// ("detected", not "announced" — the feeds are polled every 15 minutes).
// Pure: returns a new { id: ms } map; a district's first non-quiet status
// claims its time and keeps it even if the status is upgraded later.
export function updateAnnouncementTimes(times, entries, nowMs) {
  const next = { ...(times || {}) };
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.id || next[e.id]) continue;
    if (e.status && e.status !== 'none' && e.status !== 'unavailable') {
      next[e.id] = nowMs;
    }
  }
  return next;
}

export function buildDecisionWatchDescription(entries, primaryId = 'hcpss', times = {}) {
  const lines = (Array.isArray(entries) ? entries : []).map(e => {
    const rendered = formatDistrictLines([e], { includeDetail: true }).split('\n');
    if (times && times[e.id]) {
      rendered[0] += ` — detected <t:${Math.floor(times[e.id] / 1000)}:t>`;
    }
    return rendered.join('\n');
  });
  // Pin marker on the guild's own district — always the first line when the
  // entries came from buildDecisionWatchEntries.
  if (lines.length && entries[0] && entries[0].id === primaryId) {
    lines[0] = `📍 ${lines[0]}`;
  }
  return lines.join('\n');
}

// Runs from the per-minute cron. Never throws.
export async function maybeUpdateDecisionWatch(env) {
  if (!env || !env.STATUS_KV) return { updated: 0 };
  const now = new Date();
  const slot = stormTickSlot(getEasternTimeStr(now));
  if (!slot) return { updated: 0 };

  const todayYmd = formatYmdNY(now);
  const slotVal = `${todayYmd} ${slot}`;
  if (await env.STATUS_KV.get(SLOT_KEY) === slotVal) return { updated: 0 };
  await env.STATUS_KV.put(SLOT_KEY, slotVal);

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

  // Cheap pass: which guilds want a board this morning?
  const wanting = [];
  for (const gid of guildIds) {
    const cfg = getEffectiveConfig(await getConfig(env, gid));
    if (cfg.toggle_decision_watch === false || cfg.toggle_storm_mode === false) continue;
    if (!cfg.alert_channel_id) continue;
    wanting.push({ gid, cfg });
  }
  if (!wanting.length) return { updated: 0 };

  // The window opens when any relevant zone has a storm alert — same probe as
  // storm mode, so the board and the extra checks always run together.
  let stormActive = hasStormAlert(await getActiveWeatherAlerts(env));
  if (!stormActive) {
    const zones = new Set();
    for (const { cfg } of wanting) {
      const meta = getDistrictMeta(cfg.primary_district);
      if (meta && meta.nwsZone) zones.add(meta.nwsZone);
    }
    for (const zone of zones) {
      if (hasStormAlert(await getActiveWeatherAlerts(env, zone))) {
        stormActive = true;
        break;
      }
    }
  }
  if (!stormActive) return { updated: 0 };

  const districts = await getDistrictStatuses(env);
  let hcpssEntry = null;
  try {
    const fetched = await getStatusCards(env);
    if (fetched.cards) {
      hcpssEntry = {
        id: 'hcpss',
        name: 'Howard Co. (HCPSS)',
        status: statusKeyToDistrictStatus(determineStatusKey(fetched.cards)),
        detail: ''
      };
    }
  } catch {}

  // Track first-detection times for every district's announcement across the
  // morning's ticks, so the board shows when each call was first seen.
  let times = {};
  try {
    const raw = await env.STATUS_KV.get('decision_watch_times');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.ymd === todayYmd && parsed.times) times = parsed.times;
    }
  } catch {}
  times = updateAnnouncementTimes(times, buildDecisionWatchEntries(districts, hcpssEntry), now.getTime());
  await env.STATUS_KV.put('decision_watch_times', JSON.stringify({ ymd: todayYmd, times })).catch(() => {});

  let updated = 0;
  const token = env.DISCORD_BOT_TOKEN;
  for (const { gid, cfg } of wanting) {
    try {
      const primaryId = cfg.primary_district || 'hcpss';
      const entries = buildDecisionWatchEntries(districts, hcpssEntry, primaryId);
      const primaryMeta = primaryId !== 'hcpss' ? getDistrictMeta(primaryId) : null;

      const embed = {
        title: `🌅 Decision Watch — ${formatStatusDate(now)}`,
        url: primaryMeta ? primaryMeta.url : HCPSS_URL,
        color: 0x3498DB,
        description:
          `Live board of this morning's closing and delay announcements. ` +
          `Updates every 15 minutes until 7:30 AM ET; the board is removed after 8 AM.\n\n` +
          buildDecisionWatchDescription(entries, primaryId, times),
        timestamp: now.toISOString(),
        footer: { text: `${cfg.alert_embed_footer || 'School Status'} · Decision Watch` }
      };

      // One board per day: edit today's message in place, post a fresh one on
      // the first tick (or if the tracked message was deleted).
      let board = null;
      try {
        const raw = await env.STATUS_KV.get(boardKey(gid));
        if (raw) board = JSON.parse(raw);
      } catch {}

      if (board && board.ymd === todayYmd && board.messageId && board.channelId) {
        const resp = await discordFetch(`https://discord.com/api/v10/channels/${board.channelId}/messages/${board.messageId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [embed] })
        });
        if (resp.ok) {
          updated++;
          continue;
        }
        if (resp.status !== 404) {
          console.error(`Decision watch edit failed for guild ${gid}: ${resp.status}`);
          continue;
        }
        // 404: the board was deleted — fall through and repost.
      }

      const resp = await discordFetch(`https://discord.com/api/v10/channels/${cfg.alert_channel_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } })
      });
      if (!resp.ok) {
        console.error(`Decision watch post failed for guild ${gid}: ${resp.status}`);
        continue;
      }
      const posted = await resp.json();
      await env.STATUS_KV.put(boardKey(gid), JSON.stringify({
        ymd: todayYmd,
        channelId: cfg.alert_channel_id,
        messageId: posted.id
      }));
      updated++;
      await postLog(env, cfg.log_channel_id, `🌅 Decision Watch board posted to <#${cfg.alert_channel_id}>.`, {}, gid);
    } catch (e) {
      console.error(`Decision watch failed for guild ${gid}:`, e);
    }
  }
  return { updated };
}

// The board is live morning coverage, not a permanent record — once the
// window is over it's channel clutter, so it's deleted. The status history
// (/history) is the durable record. True from 8:00 through 10:00 AM ET; the
// wide window covers missed ticks.
export function decisionWatchCleanupDue(etStr) {
  const [h, m] = String(etStr).split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return false;
  const mins = h * 60 + m;
  return mins >= 8 * 60 && mins <= 10 * 60;
}

// Runs from the per-minute cron; deletes every guild's board message on the
// first tick at/after 8 AM ET. Never throws.
export async function maybeCleanupDecisionWatch(env) {
  if (!env || !env.STATUS_KV) return { deleted: 0 };
  const now = new Date();
  if (!decisionWatchCleanupDue(getEasternTimeStr(now))) return { deleted: 0 };
  const todayYmd = formatYmdNY(now);
  if (await env.STATUS_KV.get(CLEANUP_DAY_KEY) === todayYmd) return { deleted: 0 };
  await env.STATUS_KV.put(CLEANUP_DAY_KEY, todayYmd);

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

  let deleted = 0;
  const token = env.DISCORD_BOT_TOKEN;
  for (const gid of guildIds) {
    try {
      const raw = await env.STATUS_KV.get(boardKey(gid));
      if (!raw) continue;
      let board = null;
      try { board = JSON.parse(raw); } catch {}
      if (board && board.channelId && board.messageId) {
        const resp = await discordFetch(`https://discord.com/api/v10/channels/${board.channelId}/messages/${board.messageId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bot ${token}` }
        });
        if (!resp.ok && resp.status !== 404) {
          // Keep the KV record so a later morning's cleanup retries the delete.
          console.error(`Decision watch cleanup failed for guild ${gid}: ${resp.status}`);
          continue;
        }
        deleted++;
      }
      await env.STATUS_KV.delete(boardKey(gid));
    } catch (e) {
      console.error(`Decision watch cleanup failed for guild ${gid}:`, e);
    }
  }
  return { deleted };
}
