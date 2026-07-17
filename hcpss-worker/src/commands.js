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

export function runCalendarCommand() {
  const checkedAt = new Date();
  const events = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(checkedAt.getTime() + i * 24 * 60 * 60 * 1000);
    const ymd = formatYmdNY(d);
    const event = SCHOOL_CALENDAR_EVENTS[ymd];
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

export async function runHistoryCommand(env) {
  const checkedAt = new Date();
  const history = await getStatusHistory(env);

  const embed = {
    title: '📜 HCPSS Recent Status History',
    color: 3066993,
    timestamp: checkedAt.toISOString(),
    footer: { text: `HCPSS Status Monitor · ${history.length} change(s) recorded` }
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

export async function runStatsCommand(env) {
  const checkedAt = new Date();
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

  const countsDisplay = Object.entries(incidentLabels).map(([key, label]) => {
    const count = stats[key] || 0;
    return `• **${label}**: ${count}`;
  }).join('\n');

  const history = await getStatusHistory(env);
  const yearStats = computeIncidentStats(history, checkedAt);
  const yearCountsDisplay = Object.entries(incidentLabels).map(([key, label]) => {
    return `• **${label}**: ${yearStats.year[key] || 0}`;
  }).join('\n');
  const lastIncidentStr = yearStats.lastIncident
    ? `<t:${Math.floor(yearStats.lastIncident.timestamp / 1000)}:D> — *${yearStats.lastIncident.date || 'Unknown date'}*`
    : '*None recorded*';

  // Previous school years from the persistent archive (current year excluded —
  // it's already shown above). Newest first, capped at 3.
  const yearly = await getYearlyStats(env, history);
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
    ? `\n\n**Previous School Years:**\n${pastYearLines.join('\n')}`
    : '';

  const embed = {
    title: '📊 HCPSS Status Monitor - Statistics',
    color: 0x34495E,
    description: `**Scraper Diagnostics:**\n` +
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
                 `**Status Changes (All-Time):**\n` +
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

    await env.STATUS_KV.put(`calendar_event:${dateStr}`, eventStr);

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

    const existing = await env.STATUS_KV.get(`calendar_event:${dateStr}`);
    if (!existing) {
      await updateInteractionOriginal(env, body.token, {
        content: `⚠️ No dynamic calendar event found for date **${dateStr}**.`,
        embeds: []
      });
      return;
    }

    await env.STATUS_KV.delete(`calendar_event:${dateStr}`);

    const cfg = getEffectiveConfig(await getConfig(env, guildId));
    await postLog(env, cfg.log_channel_id, `Calendar event removed for date: **${dateStr}**${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);

    await updateInteractionOriginal(env, body.token, {
      content: `✅ Removed calendar event for **${dateStr}** (was: *${existing}*)`,
      embeds: []
    });
    return;
  }

  if (subName === 'list') {
    let listResult;
    try {
      listResult = await env.STATUS_KV.list({ prefix: 'calendar_event:' });
    } catch (e) {
      await updateInteractionOriginal(env, body.token, {
        content: `❌ Failed to list calendar events: ${e.message}`,
        embeds: []
      });
      return;
    }

    const events = [];
    for (const key of listResult.keys) {
      const dateStr = key.name.replace(/^calendar_event:/, '');
      const eventStr = await env.STATUS_KV.get(key.name);
      if (eventStr) {
        events.push({ dateStr, eventStr });
      }
    }

    events.sort((a, b) => a.dateStr.localeCompare(b.dateStr));

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
