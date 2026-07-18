// End-of-school-year recap: one celebratory summary post per guild in
// mid-June — closure days, delays, early closings, and how the year compared
// to the previous one. On by default (toggle_year_recap in Feature Toggles).

import { getEasternTimeStr, matchesScheduleTime, formatYmdNY } from './timeutil.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { getStatusHistory, computeIncidentStats, getYearlyStats, schoolYearLabel } from './history.js';
import { postLog } from './panel.js';

export const RECAP_MONTH_DAY = '06-15';
export const RECAP_TIME = '12:00';

// Exported for tests: builds the recap description from this year's stats and
// the (possibly missing) previous year's archive entry.
export function buildRecapLines(yearStats, prevLabel, prevYear) {
  const lines = [
    `❄️ **Closure Days**: ${yearStats.snowDays}`,
    `🕑 **2-Hour Delays**: ${yearStats.delays}`,
    `🏃 **Early Closings**: ${yearStats.earlyCloses}`
  ];

  if (prevYear) {
    const prevClosures = (prevYear.schools_closed || 0) + (prevYear.schools_and_offices_closed || 0);
    const prevDelays = prevYear.schools_open_2_hours_late || 0;
    const prevEarly = prevYear.schools_close_3_hours_early || 0;
    lines.push('');
    lines.push(`**vs. ${prevLabel}**: ❄️ ${prevClosures} closure(s) · 🕑 ${prevDelays} delay(s) · 🏃 ${prevEarly} early closing(s)`);

    const thisTotal = yearStats.snowDays + yearStats.delays + yearStats.earlyCloses;
    const prevTotal = prevClosures + prevDelays + prevEarly;
    if (thisTotal > prevTotal) lines.push(`*A wilder year than last — ${thisTotal} incidents vs. ${prevTotal}.*`);
    else if (thisTotal < prevTotal) lines.push(`*A calmer year than last — ${thisTotal} incidents vs. ${prevTotal}.*`);
    else lines.push(`*Dead even with last year at ${thisTotal} incidents.*`);
  }

  return lines.join('\n');
}

// Runs from the per-minute cron; posts at most once per school year per guild.
// Never throws.
export async function maybeSendYearRecap(env) {
  if (!env || !env.STATUS_KV) return { sent: 0 };
  const now = new Date();
  if (!formatYmdNY(now).endsWith(RECAP_MONTH_DAY)) return { sent: 0 };
  if (!matchesScheduleTime(getEasternTimeStr(now), RECAP_TIME)) return { sent: 0 };

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
  if (!guildIds.length) return { sent: 0 };

  const currentLabel = schoolYearLabel(now);
  const wanting = [];
  for (const gid of guildIds) {
    const cfg = getEffectiveConfig(await getConfig(env, gid));
    if (cfg.toggle_year_recap === false || !cfg.alert_channel_id) continue;
    if (await env.STATUS_KV.get(`last_recap_year:${gid}`) === currentLabel) continue;
    wanting.push({ gid, cfg });
  }
  if (!wanting.length) return { sent: 0 };

  const history = await getStatusHistory(env);
  const yearStats = computeIncidentStats(history, now);
  const yearly = await getYearlyStats(env, history);
  const prevLabel = Object.keys(yearly).filter(l => l < currentLabel).sort().pop() || null;
  const prevYear = prevLabel ? yearly[prevLabel] : null;

  const description =
    `School's (almost) out — here's how **${currentLabel}** went:\n\n` +
    buildRecapLines(yearStats, prevLabel, prevYear) +
    `\n\nHave a great summer! ☀️ The bot keeps watching year-round.`;

  let sent = 0;
  const token = env.DISCORD_BOT_TOKEN;
  for (const { gid, cfg } of wanting) {
    // Mark before posting so a delayed cron tick can't double-post.
    await env.STATUS_KV.put(`last_recap_year:${gid}`, currentLabel);

    const embed = {
      title: `🎓 School Year Recap — ${currentLabel}`,
      color: 0xF1C40F,
      description,
      timestamp: now.toISOString(),
      footer: { text: `${cfg.alert_embed_footer || 'School Status'} · Year Recap` }
    };

    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${cfg.alert_channel_id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } })
      });
      if (resp.ok) {
        sent++;
        await postLog(env, cfg.log_channel_id, `🎓 School year recap posted to <#${cfg.alert_channel_id}>.`, {}, gid);
      } else {
        console.error(`Recap post failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error('Recap post failed:', e);
    }
  }
  return { sent };
}
