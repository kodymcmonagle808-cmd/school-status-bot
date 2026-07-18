// Slash command runners and control-panel quick-action handlers.

import { EPHEMERAL_FLAG, ALL_STATUS_LABELS, STATUS_LABELS, SCHOOL_CALENDAR_EVENTS } from './constants.js';
import { formatCheckedAt, formatStatusDate, formatYmdNY } from './timeutil.js';
import { HCPSS_URL } from './scraper.js';
import { getStatusHistory, computeIncidentStats, getYearlyStats, schoolYearLabel, INCIDENT_KEYS } from './history.js';
import { getDistrictStatuses, formatDistrictLines } from './districts.js';
import { getCommandOption, getInvokerId, updateInteractionOriginal } from './discord.js';
import { getConfig, getEffectiveConfig, setOverride, clearOverride } from './config.js';
import { postLog } from './panel.js';
import { doCheckAndPost } from './check.js';
import { footerWithCheckedAt } from './embeds.js';
import { getCalendarEvent, putCalendarEvent, deleteCalendarEvent, listCalendarEvents } from './calendar.js';

export async function runCalendarCommand(env, guildId = '') {
  const checkedAt = new Date();
  const events = [];

  // This server's dynamic events overlay the built-in school calendar.
  const dynamicByDate = {};
  if (env && env.STATUS_KV) {
    try {
      for (const e of await listCalendarEvents(env, guildId)) dynamicByDate[e.dateStr] = e.eventStr;
    } catch {}
  }

  for (let i = 0; i < 7; i++) {
    const d = new Date(checkedAt.getTime() + i * 24 * 60 * 60 * 1000);
    const ymd = formatYmdNY(d);
    const event = dynamicByDate[ymd] || SCHOOL_CALENDAR_EVENTS[ymd];
    if (event) {
      events.push({ ymd, dateStr: formatStatusDate(d), event });
    }
  }

  const embed = {
    title: '🗓️ HCPSS Upcoming Calendar Events (Next 7 Days)',
    color: 3066993,
    timestamp: checkedAt.toISOString(),
    footer: { text: 'HCPSS Status Monitor' }
  };

  if (events.length === 0) {
    embed.description = 'No scheduled closures or events in the next 7 days.';
  } else {
    embed.description = events.map(e => `**${e.dateStr}**\n${e.event}`).join('\n\n');
  }

  return {
    embeds: [embed],
    flags: EPHEMERAL_FLAG
  };
}

// Condensed from HCPSS_Status_Terms_and_Conditions.md at the repo root —
// keep the two in sync when the full document changes.
export function runTermsCommand() {
  return {
    embeds: [{
      title: '📄 HCPSS Status — Terms and Conditions',
      color: 0x5865F2,
      description:
        '**Last Updated: July 10, 2026**\n\n' +
        'By adding HCPSS Status to a server or using its commands, you agree to these Terms.\n\n' +
        '**1. Service** — The bot monitors publicly available HCPSS information (delays, closures, alerts) and posts automated status updates. It is an **independent, unofficial project** — not created, operated, endorsed, or affiliated with HCPSS or Howard County Government.\n\n' +
        '**2. Acceptance** — Inviting the bot, using its commands, or remaining in a server where it is active constitutes acceptance of these Terms and the Privacy Policy (see `/privacy`). If you do not agree, remove the bot and stop using it.\n\n' +
        '**3. No Guarantee of Accuracy** — Status updates are for **convenience only** and are never an official or authoritative source. Always confirm closures, delays, or emergency information through official HCPSS channels (hcpss.org, official social media, or direct school communication). We are not responsible for delayed, missed, incorrect, or outdated updates.\n\n' +
        "**4. Acceptable Use** — Do not use the bot to violate Discord's Terms of Service or Community Guidelines; exploit, reverse-engineer, spam, or abuse it; spread misinformation; or interfere with its operation.\n\n" +
        '**5. Server Owner Responsibilities** — Configure the bot appropriately for your community, inform members it is unofficial, and remove it if you no longer wish to use it (removal deletes server configuration data as described in the Privacy Policy).\n\n' +
        '**6. Availability** — Provided "as-is" and "as-available" with no uptime guarantee. Features may change or be removed, and the bot may be suspended or discontinued, at any time without notice.\n\n' +
        '**7. Limitation of Liability** — To the fullest extent permitted by law, the developers are not liable for damages arising from reliance on the bot, missed or inaccurate status information, downtime, bugs, or data loss. **Use for time-sensitive or safety-related decisions is at your own risk — always verify with official HCPSS sources.**\n\n' +
        '**8. Termination** — Any server or user may be blocked from the bot at any time, for any reason, including violation of these Terms.\n\n' +
        '**9. Changes** — These Terms may be updated periodically; continued use after changes constitutes acceptance of the revised Terms.\n\n' +
        "**10. Contact** — Questions can be directed to the bot developer through the support server or the contact method on the bot's official listing page.",
      timestamp: new Date().toISOString(),
      footer: { text: 'HCPSS Status Monitor' }
    }],
    flags: EPHEMERAL_FLAG
  };
}

// Condensed from HCPSS_Status_Privacy_Policy.md at the repo root — keep the
// two in sync when the full document changes.
export function runPrivacyCommand() {
  return {
    embeds: [{
      title: '🔒 HCPSS Status — Privacy Policy',
      color: 0x5865F2,
      description:
        '**Last Updated: July 10, 2026**\n\n' +
        '**1. What We Collect** — The minimum needed to function: server (guild) ID, configured channel IDs, optional ping role IDs, server-specific settings, and the user/channel ID at the time a command is run (used only to process that command).\n\n' +
        '**We do NOT collect** message content outside of command interactions, private messages, personal information (names, emails, school enrollment data), or voice/audio data.\n\n' +
        '**2. How It Is Used** — Solely to deliver status updates to configured channels, ping configured roles, respond to commands, and maintain/troubleshoot the bot. Data is never sold, rented, or shared with third parties for advertising or marketing.\n\n' +
        "**3. Storage & Security** — Configuration data is stored in a secure database on the bot's hosting infrastructure with reasonable technical protections. No system is 100% secure; data is stored and processed at your own risk.\n\n" +
        "**4. Retention & Deletion** — Server data is kept only while the bot remains in your server; removing the bot deletes it automatically or within a reasonable period. Admins may also request manual deletion at any time through the bot's support channel.\n\n" +
        "**5. Third-Party Services** — The bot reads publicly available HCPSS information one-way; none of your Discord data is shared with HCPSS or any third party. Discord's own Privacy Policy and Terms of Service apply to data Discord itself collects.\n\n" +
        "**6. Children's Privacy** — The bot does not knowingly collect personal information from anyone and does not target children. Discord's own minimum age requirements apply.\n\n" +
        "**7. Your Rights** — Server admins may request a summary of stored data for their server, request deletion (removing the bot also accomplishes this), and reach out with questions about data handling.\n\n" +
        '**8. Changes** — This policy may be updated periodically; continued use after updates constitutes acceptance.\n\n' +
        "**9. Contact** — For questions or data deletion requests, reach out through the bot's support server or the contact method on its official listing page.",
      timestamp: new Date().toISOString(),
      footer: { text: 'HCPSS Status Monitor' }
    }],
    flags: EPHEMERAL_FLAG
  };
}

// History entries recorded before this guild was set up are hidden, so each
// server's history starts at its own setup. Guilds without a created_at
// (configured before the field existed) see the full district history.
async function getGuildJoinedAt(env, guildId) {
  if (!guildId) return 0;
  const stored = await getConfig(env, guildId);
  return Number(stored.created_at) || 0;
}

export async function runHistoryCommand(env, guildId = '') {
  const checkedAt = new Date();
  const joinedAt = await getGuildJoinedAt(env, guildId);
  const history = (await getStatusHistory(env)).filter(h => h.timestamp >= joinedAt);

  const embed = {
    title: '📜 HCPSS Recent Status History',
    color: 3066993,
    timestamp: checkedAt.toISOString(),
    footer: { text: `HCPSS Status Monitor · ${history.length} change(s) recorded${joinedAt ? ' since this server was set up' : ''}` }
  };

  if (history.length === 0) {
    embed.description = 'No status history recorded yet. History starts recording on changes.';
  } else {
    embed.description = history.slice(0, 10).map((h, index) => {
      const timeStr = formatCheckedAt(new Date(h.timestamp));
      return `**#${index + 1} - ${h.date || 'Unknown Date'}**\n*Detected at: ${timeStr}*\n${h.status}`;
    }).join('\n\n___\n\n');
  }

  return {
    embeds: [embed],
    flags: EPHEMERAL_FLAG
  };
}

export async function runDistrictsCommand(env) {
  const checkedAt = new Date();
  const districts = await getDistrictStatuses(env);

  return {
    embeds: [{
      title: '🏫 Nearby School Districts — Operating Status',
      color: 3447003,
      description: formatDistrictLines(districts, { includeDetail: true }) ||
        'No district information available right now.',
      timestamp: checkedAt.toISOString(),
      footer: { text: footerWithCheckedAt('HCPSS Status Monitor · Cached up to 10 min', checkedAt) }
    }],
    flags: EPHEMERAL_FLAG
  };
}

export async function runLogsCommand(env, guildId = '') {
  const checkedAt = new Date();
  const logKey = guildId ? `panel_logs:${guildId}` : 'panel_logs';
  const rawLogs = await env.STATUS_KV.get(logKey);
  let logs = [];
  if (rawLogs) {
    try {
      logs = JSON.parse(rawLogs);
    } catch (e) {
      logs = [];
    }
  }

  const embed = {
    title: '📋 HCPSS Status Monitor - System Logs',
    color: 10181046, // Purple
    timestamp: checkedAt.toISOString(),
    footer: { text: 'HCPSS Status Monitor' }
  };

  if (logs.length === 0) {
    embed.description = 'No system logs recorded yet.';
  } else {
    embed.description = logs.map(line => {
      const match = line.match(/^\[(.*?)\] (.*)$/);
      if (match) {
        return `\`[${match[1]}]\` ${match[2]}`;
      }
      return line;
    }).join('\n');
  }

  return {
    embeds: [embed],
    flags: EPHEMERAL_FLAG
  };
}

export async function runStatsCommand(env, guildId = '') {
  const checkedAt = new Date();
  const joinedAt = await getGuildJoinedAt(env, guildId);
  let stats = {};
  try {
    const rawStats = await env.STATUS_KV.get('status_stats');
    if (rawStats) {
      stats = JSON.parse(rawStats) || {};
    }
  } catch (e) {
    stats = {};
  }

  const scrapesTotal = stats.scrapes_total || 0;
  const scrapesFailed = stats.scrapes_failed || 0;
  const scrapesSuccess = Math.max(0, scrapesTotal - scrapesFailed);
  const uptimePct = scrapesTotal > 0 ? ((scrapesSuccess / scrapesTotal) * 100).toFixed(2) : '100.00';

  const incidentLabels = Object.fromEntries(INCIDENT_KEYS.map(k => [k, ALL_STATUS_LABELS[k]]));

  const fullHistory = await getStatusHistory(env);
  const history = fullHistory.filter(h => h.timestamp >= joinedAt);

  // All-time counts: servers set up after tracking began only count changes
  // they were around for; the original deployment keeps the global counters
  // (which include entries that have rolled off the capped history).
  const countsDisplay = Object.entries(incidentLabels).map(([key, label]) => {
    const count = joinedAt
      ? history.filter(h => h.status_key === key).length
      : (stats[key] || 0);
    return `• **${label}**: ${count}`;
  }).join('\n');

  const yearStats = computeIncidentStats(history, checkedAt);
  const yearCountsDisplay = Object.entries(incidentLabels).map(([key, label]) => {
    return `• **${label}**: ${yearStats.year[key] || 0}`;
  }).join('\n');
  const lastIncidentStr = yearStats.lastIncident
    ? `<t:${Math.floor(yearStats.lastIncident.timestamp / 1000)}:D> — *${yearStats.lastIncident.date || 'Unknown date'}*`
    : '*None recorded*';

  // Previous school years from the persistent archive (current year excluded —
  // it's already shown above). District-wide, so it uses the unfiltered history.
  const yearly = await getYearlyStats(env, fullHistory);
  const currentLabel = schoolYearLabel(checkedAt);
  const pastYearLines = Object.keys(yearly)
    .filter(label => label !== currentLabel)
    .sort()
    .reverse()
    .slice(0, 3)
    .map(label => {
      const y = yearly[label];
      const closures = (y.schools_closed || 0) + (y.schools_and_offices_closed || 0);
      const delays = y.schools_open_2_hours_late || 0;
      const early = y.schools_close_3_hours_early || 0;
      return `• **${label}**: ❄️ ${closures} closure(s) · 🕑 ${delays} delay(s) · 🏃 ${early} early closing(s)`;
    });
  const pastYearsSection = pastYearLines.length
    ? `\n\n**Previous School Years (district-wide):**\n${pastYearLines.join('\n')}`
    : '';

  const embed = {
    title: '📊 HCPSS Status Monitor - Statistics',
    color: 0x34495E,
    description: `**Scraper Diagnostics (all servers):**\n` +
                 `• Total Checks: \`${scrapesTotal}\`\n` +
                 `• Scraper Success Rate: \`${uptimePct}%\` (\`${scrapesSuccess}/${scrapesTotal}\` successful)\n\n` +
                 `**This School Year (${currentLabel}):**\n` +
                 `• ❄️ **Closure Days**: \`${yearStats.snowDays}\`\n` +
                 `• 🕑 **2-Hour Delays**: \`${yearStats.delays}\`\n` +
                 `• 🏃 **Early Closings**: \`${yearStats.earlyCloses}\`\n` +
                 `• 📌 **Last Incident**: ${lastIncidentStr}` +
                 pastYearsSection + `\n\n` +
                 `**Status Changes (This School Year):**\n` +
                 `${yearCountsDisplay}\n\n` +
                 `**Status Changes (${joinedAt ? 'Since Server Setup' : 'All-Time'}):**\n` +
                 `${countsDisplay}`,
    timestamp: checkedAt.toISOString(),
    footer: { text: 'HCPSS Status Monitor' }
  };

  return {
    embeds: [embed],
    flags: EPHEMERAL_FLAG
  };
}

export async function runEventsCommand(body, env) {
  const options = body && body.data && body.data.options;
  const sub = Array.isArray(options) && options[0] && options[0].type === 1 ? options[0] : null;
  const subName = sub && sub.name ? String(sub.name) : '';
  const subOptions = sub && Array.isArray(sub.options) ? sub.options : [];
  const guildId = body.guild_id || '';
  const invokerId = getInvokerId(body);

  if (subName === 'add') {
    const dateRaw = getCommandOption(subOptions, 'date');
    const eventRaw = getCommandOption(subOptions, 'event');

    const dateStr = (dateRaw ? String(dateRaw) : '').trim();
    const eventStr = (eventRaw ? String(eventRaw) : '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      await updateInteractionOriginal(env, body.token, {
        content: '❌ Invalid date format. Please use `YYYY-MM-DD` (e.g. `2026-12-25`).',
        embeds: []
      });
      return;
    }

    await putCalendarEvent(env, guildId, dateStr, eventStr);

    const cfg = getEffectiveConfig(await getConfig(env, guildId));
    await postLog(env, cfg.log_channel_id, `Calendar event added: **${dateStr}** - *${eventStr}*${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);

    await updateInteractionOriginal(env, body.token, {
      content: `✅ Added calendar event for **${dateStr}**: *${eventStr}*`,
      embeds: []
    });
    return;
  }

  if (subName === 'remove') {
    const dateRaw = getCommandOption(subOptions, 'date');
    const dateStr = (dateRaw ? String(dateRaw) : '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      await updateInteractionOriginal(env, body.token, {
        content: '❌ Invalid date format. Please use `YYYY-MM-DD` (e.g. `2026-12-25`).',
        embeds: []
      });
      return;
    }

    const existing = await getCalendarEvent(env, guildId, dateStr);
    if (!existing) {
      await updateInteractionOriginal(env, body.token, {
        content: `⚠️ No dynamic calendar event found for date **${dateStr}**.`,
        embeds: []
      });
      return;
    }

    await deleteCalendarEvent(env, guildId, dateStr);

    const cfg = getEffectiveConfig(await getConfig(env, guildId));
    await postLog(env, cfg.log_channel_id, `Calendar event removed for date: **${dateStr}**${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);

    await updateInteractionOriginal(env, body.token, {
      content: `✅ Removed calendar event for **${dateStr}** (was: *${existing}*)`,
      embeds: []
    });
    return;
  }

  if (subName === 'list') {
    let events;
    try {
      events = await listCalendarEvents(env, guildId);
    } catch (e) {
      await updateInteractionOriginal(env, body.token, {
        content: `❌ Failed to list calendar events: ${e.message}`,
        embeds: []
      });
      return;
    }

    const embed = {
      title: '🗓️ Dynamic School Calendar Events',
      color: 3066993,
      timestamp: new Date().toISOString(),
      footer: { text: 'HCPSS Status Monitor' }
    };

    if (events.length === 0) {
      embed.description = 'No dynamic calendar events configured. Events added via `/events add` will show up here.';
    } else {
      embed.description = events.map(e => `• **${e.dateStr}**: ${e.eventStr}`).join('\n');
    }

    await updateInteractionOriginal(env, body.token, {
      content: '',
      embeds: [embed]
    });
    return;
  }

  await updateInteractionOriginal(env, body.token, { content: 'Invalid events command.', embeds: [] });
}

export async function runPostStatusCommand(body, env) {
  const invokerId = getInvokerId(body);
  const guildId = body.guild_id || '';
  const result = await doCheckAndPost(env, { source: 'command', invokerId, guildId });
  if (result.ok) {
    await updateInteractionOriginal(env, body.token, {
      content: result.isError ? 'Posted the HCPSS error status embed.' : 'Posted the latest HCPSS status.',
      embeds: []
    });
    return;
  }

  await updateInteractionOriginal(env, body.token, {
    content: `Could not post status: ${result.error || result.status}`,
    embeds: []
  });
}

export async function runOverrideCommand(body, env) {
  const options = body && body.data && body.data.options;
  const invokerId = getInvokerId(body);
  const guildId = body.guild_id || '';

  const sub = Array.isArray(options) && options[0] && options[0].type === 1 ? options[0] : null;
  const subName = sub && sub.name ? String(sub.name) : '';
  const subOptions = sub && Array.isArray(sub.options) ? sub.options : [];

  if (subName === 'clear') {
    await clearOverride(env, guildId);
    const result = await doCheckAndPost(env, { source: 'override-clear', invokerId, guildId });
    const message = result && result.ok
      ? 'Override cleared. Posted the current live HCPSS status.'
      : `Override cleared, but could not post live status: ${result.error || result.status || 'unknown error'}`;
    await updateInteractionOriginal(env, body.token, { content: message, embeds: [] });
    return;
  }

  if (subName !== 'set') {
    await updateInteractionOriginal(env, body.token, { content: 'Invalid override command.', embeds: [] });
    return;
  }

  const daysRaw = getCommandOption(subOptions, 'days');
  const statusRaw = getCommandOption(subOptions, 'status');
  const titleRaw = getCommandOption(subOptions, 'title');
  const detailsRaw = getCommandOption(subOptions, 'details');

  const daysParsed = Number.isFinite(Number(daysRaw)) ? Math.trunc(Number(daysRaw)) : 1;
  const days = Math.max(1, Math.min(30, daysParsed));
  const statusKey = statusRaw ? String(statusRaw) : '';

  const statusLabel = STATUS_LABELS[statusKey];
  if (!statusLabel) {
    await updateInteractionOriginal(env, body.token, { content: 'Invalid status selection.', embeds: [] });
    return;
  }

  const title = (titleRaw ? String(titleRaw) : '').trim();
  const details = (detailsRaw ? String(detailsRaw) : '').trim();

  const now = Date.now();
  const until = now + days * 24 * 60 * 60 * 1000;
  await setOverride(env, guildId, {
    status_key: statusKey,
    status_label: statusLabel,
    title: title || null,
    details: details || null,
    created_at: now,
    created_by: invokerId || null,
    until
  });

  const cfg = getEffectiveConfig(await getConfig(env, guildId));
  await postLog(env, cfg.log_channel_id, `Override set (status: ${statusLabel}, days: ${days}${invokerId ? `, by: <@${invokerId}>` : ''}).`, {}, guildId);

  await updateInteractionOriginal(env, body.token, {
    content: `Override enabled for ${days} day(s). All status updates will use it until it expires or is cleared.`,
    embeds: []
  });
}

export async function handlePanelSpeed(body, env) {
  const start = Date.now();
  let ok = false;
  let statusText = '';
  let responseSize = 0;
  let redirected = false;
  try {
    const r = await fetch(HCPSS_URL);
    ok = r.ok;
    statusText = `${r.status} ${r.statusText}`;
    redirected = r.redirected;
    const txt = await r.text();
    responseSize = txt.length;
  } catch (e) {
    statusText = e.message;
  }
  const duration = Date.now() - start;
  await updateInteractionOriginal(env, body.token, {
    content: `⚡ **Scraper Speed Test Results:**\n` +
             `• HTTP Status: \`${statusText}\`\n` +
             `• Fetch Time: \`${duration}ms\`\n` +
             `• Response Size: \`${responseSize.toLocaleString()} bytes\`\n` +
             `• Redirected: \`${redirected ? 'Yes' : 'No'}\`\n` +
             `• Result: ${ok ? '🟢 OK' : '🔴 Failed'}`,
    embeds: []
  });
}

export async function handlePanelKvDebug(body, env) {
  const guildId = body.guild_id || '';
  const lines = [];

  const kvKeys = [
    `config:${guildId || env.DISCORD_GUILD_ID}`,
    `panel_logs:${guildId}`,
    `last_check_latency:${guildId}`,
    `last_check_time:${guildId}`,
    `last_message_id:${guildId}`,
    `last_channel_id:${guildId}`,
    `override:${guildId || env.DISCORD_GUILD_ID}`,
    `status_stats`,
    `status_history`,
    `yearly_stats`,
    `last_known_status`,
    `last_good_scrape`,
    `weather_alerts_cache`,
    `news_signal_cache`,
    `dm_subscribers:${guildId}`,
    `scraper_failures_count`,
    `scraper_failure_alerted`,
    `log_panel_message_id:${guildId}`,
    `setup_done:${guildId}`
  ];

  for (const key of kvKeys) {
    const val = await env.STATUS_KV.get(key);
    if (val !== null) {
      const preview = val.length > 80 ? val.slice(0, 80) + '…' : val;
      lines.push(`\`${key}\`\n  → \`${preview}\``);
    } else {
      lines.push(`\`${key}\`\n  → *(not set)*`);
    }
  }

  await updateInteractionOriginal(env, body.token, {
    content: `🗄️ **KV Store Diagnostic Snapshot**\n\n${lines.join('\n')}`,
    embeds: []
  });
}

export async function handlePanelCheck(body, env) {
  const invokerId = getInvokerId(body);
  const guildId = body.guild_id || '';
  const result = await doCheckAndPost(env, { source: 'panel-trigger', invokerId, guildId });
  const content = result.ok
    ? (result.isError ? '⚠️ Posted the HCPSS error status embed.' : '✅ Posted the latest HCPSS status.')
    : `❌ Could not post status: ${result.error || result.status}`;
  await updateInteractionOriginal(env, body.token, {
    content,
    embeds: []
  });
}

export async function handlePanelRefresh(body, env) {
  const guildId = body.guild_id || '';
  const stored = await getConfig(env, guildId);
  const config = getEffectiveConfig(stored);
  const logChannelId = config.log_channel_id;
  if (logChannelId) {
    await postLog(env, logChannelId, null, {}, guildId);
  }
  await updateInteractionOriginal(env, body.token, {
    content: '✅ Control panel updated.',
    embeds: []
  });
}

export async function handlePanelClearLogs(body, env) {
  const guildId = body.guild_id || '';
  const stored = await getConfig(env, guildId);
  const config = getEffectiveConfig(stored);
  const logChannelId = config.log_channel_id;

  const logKey = guildId ? `panel_logs:${guildId}` : 'panel_logs';
  await env.STATUS_KV.put(logKey, JSON.stringify([]));

  if (logChannelId) {
    await postLog(env, logChannelId, null, {}, guildId);
  }

  await updateInteractionOriginal(env, body.token, {
    content: '✅ System logs cleared.',
    embeds: []
  });
}
