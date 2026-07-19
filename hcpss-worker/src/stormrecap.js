// Storm recap: at noon ET after a Decision Watch morning, one summary post
// per guild closing the loop on the event — what the evening outlook
// predicted, what this guild's district actually did, and how every district
// decided (with detection times). Runs after the outlook accuracy grader in
// the cron sequence, so the prediction's hit/miss is already settled.

import { getEasternTimeStr, matchesScheduleTime, formatYmdNY, formatStatusDate } from './timeutil.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { getStatusHistory } from './history.js';
import { getOutlookPredictions } from './outlookaccuracy.js';
import { OUTLOOK_LEVELS } from './outlook.js';
import { buildDecisionWatchEntries, buildDecisionWatchDescription } from './decisionwatch.js';
import { discordFetch } from './discord.js';
import { postLog } from './panel.js';

export const RECAP_TIME = '12:00';

// The guild's own outcome line from its district's history: the most severe
// morning-call entry recorded today, or a quiet-day line. Pure; exported for
// tests.
export function summarizeDayOutcome(history, todayYmd) {
  const todays = (Array.isArray(history) ? history : []).filter(h =>
    h && h.status_key && h.status_key !== 'normal_operations' &&
    formatYmdNY(new Date(h.timestamp)) === todayYmd
  );
  if (!todays.length) {
    return { incident: false, line: '🟢 **Schools opened on time** — no closing or delay was announced.' };
  }
  const order = ['schools_and_offices_closed', 'schools_closed', 'schools_open_2_hours_late', 'schools_close_3_hours_early', 'unknown_alert'];
  const worst = todays.reduce((a, b) => (order.indexOf(b.status_key) < order.indexOf(a.status_key) ? b : a));
  const labels = {
    schools_and_offices_closed: '🔴 **Schools and offices closed**',
    schools_closed: '🔴 **Schools closed**',
    schools_open_2_hours_late: '🟠 **Schools opened 2 hours late**',
    schools_close_3_hours_early: '🟡 **Schools closed 3 hours early**',
    unknown_alert: 'ℹ️ **An alert was posted**'
  };
  return {
    incident: true,
    line: `${labels[worst.status_key] || 'ℹ️ **Status changed**'} — announced <t:${Math.floor(worst.timestamp / 1000)}:t>.`
  };
}

// The outlook's self-grade line for the prediction made last evening about
// today, or '' when no prediction was recorded. Pure; exported for tests.
export function formatPredictionLine(predictions, todayYmd) {
  const p = (Array.isArray(predictions) ? predictions : []).find(x => x && x.date === todayYmd);
  if (!p) return '';
  const meta = OUTLOOK_LEVELS[p.level];
  const label = meta ? meta.label : p.level;
  const emoji = meta ? meta.emoji : '⚪';
  if (!p.graded) {
    return `${emoji} Last evening's Closure Outlook: **${label}**.`;
  }
  return p.hit
    ? `${emoji} Last evening's Closure Outlook said **${label}** — and a closing or delay followed. ✅`
    : `${emoji} Last evening's Closure Outlook said **${label}** — but schools ran normally. ❌`;
}

// Runs from the per-minute cron; sends at most one recap per guild per storm
// day. Never throws.
export async function maybeSendStormRecap(env) {
  if (!env || !env.STATUS_KV) return { sent: 0 };
  const now = new Date();
  if (!matchesScheduleTime(getEasternTimeStr(now), RECAP_TIME)) return { sent: 0 };

  // Only after a morning the Decision Watch actually ran.
  const todayYmd = formatYmdNY(now);
  let watchData = null;
  try {
    const raw = await env.STATUS_KV.get('decision_watch_data');
    if (raw) watchData = JSON.parse(raw);
  } catch {}
  if (!watchData || watchData.ymd !== todayYmd) return { sent: 0 };

  let times = {};
  try {
    const raw = await env.STATUS_KV.get('decision_watch_times');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.ymd === todayYmd && parsed.times) times = parsed.times;
    }
  } catch {}

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

  const predictions = await getOutlookPredictions(env);
  const outcomeByDistrict = new Map();

  let sent = 0;
  const token = env.DISCORD_BOT_TOKEN;
  for (const gid of guildIds) {
    try {
      const cfg = getEffectiveConfig(await getConfig(env, gid));
      if (cfg.toggle_storm_recap === false || !cfg.alert_channel_id) continue;
      if (await env.STATUS_KV.get(`last_storm_recap:${gid}`) === todayYmd) continue;

      const primaryId = cfg.primary_district || 'hcpss';
      if (!outcomeByDistrict.has(primaryId)) {
        const districtId = primaryId !== 'hcpss' ? primaryId : '';
        outcomeByDistrict.set(primaryId, summarizeDayOutcome(await getStatusHistory(env, districtId), todayYmd));
      }
      const outcome = outcomeByDistrict.get(primaryId);

      // Mark before posting so a delayed cron tick can't double-post.
      await env.STATUS_KV.put(`last_storm_recap:${gid}`, todayYmd);

      const entries = buildDecisionWatchEntries(watchData.districts, watchData.hcpss, primaryId);
      const sections = [outcome.line];
      // The outlook prediction is HCPSS-based, so district guilds skip it.
      if (primaryId === 'hcpss') {
        const predictionLine = formatPredictionLine(predictions, todayYmd);
        if (predictionLine) sections.push(predictionLine);
      }
      if (entries.length) {
        sections.push(`**How every district decided:**\n${buildDecisionWatchDescription(entries, primaryId, times)}`);
      }

      const resp = await discordFetch(`https://discord.com/api/v10/channels/${cfg.alert_channel_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: `🌤️ Storm Recap — ${formatStatusDate(now)}`,
            color: outcome.incident ? 0xE67E22 : 0x2ECC71,
            description: sections.join('\n\n'),
            timestamp: now.toISOString(),
            footer: { text: `${cfg.alert_embed_footer || 'School Status'} · Storm Recap` }
          }],
          allowed_mentions: { parse: [] }
        })
      });
      if (resp.ok) {
        sent++;
        await postLog(env, cfg.log_channel_id, `🌤️ Storm recap posted to <#${cfg.alert_channel_id}>.`, {}, gid);
      } else {
        console.error(`Storm recap post failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error(`Storm recap failed for guild ${gid}:`, e);
    }
  }
  return { sent };
}
