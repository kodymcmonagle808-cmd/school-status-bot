// Slash command runners and control-panel quick-action handlers.

import { EPHEMERAL_FLAG, ALL_STATUS_LABELS, STATUS_LABELS, SCHOOL_CALENDAR_EVENTS } from './constants.js';
import { formatCheckedAt, formatStatusDate, formatYmdNY, getEasternTimeStr, isInStormWindow, nextScheduledTime, formatScheduleTimeLabel } from './timeutil.js';
import { HCPSS_URL, getStatusCards, determineStatusKey } from './scraper.js';
import { getStatusHistory, computeIncidentStats, getYearlyStats, schoolYearLabel, INCIDENT_KEYS } from './history.js';
import { getDistrictStatuses, formatDistrictLines, getDistrictMeta, statusKeyToDistrictStatus, HCPSS_COUNTY } from './districts.js';
import { buildDecisionWatchEntries, buildDecisionWatchDescription } from './decisionwatch.js';
import { getCommandOption, getInvokerId, updateInteractionOriginal } from './discord.js';
import { getConfig, getEffectiveConfig, setOverride, clearOverride } from './config.js';
import { postLog } from './panel.js';
import { doCheckAndPost } from './check.js';
import { footerWithCheckedAt, buildStatusPayload } from './embeds.js';
import { getCalendarEvent, putCalendarEvent, deleteCalendarEvent, listCalendarEvents } from './calendar.js';
import { getActiveWeatherAlerts, getCachedWeatherAlerts, formatWeatherAlertLines, hasStormAlert, DEFAULT_NWS_ZONE } from './weather.js';
import { computeClosureOutlook, formatOutlookLines, OUTLOOK_LEVELS } from './outlook.js';
import { getBgeOutages, getCountyOutage, outagePercent, getCountyOutagePicture, getKubraUtilitySummaries } from './outages.js';
import { getSnowfallForecast, formatSnowfallLines } from './snowfall.js';
import { getOutlookPredictions, summarizeOutlookAccuracy, formatOutlookAccuracyLines } from './outlookaccuracy.js';
import { computeSnowDayBudget } from './snowbudget.js';
import { toggleSubscriber, getSubscribers } from './subscriptions.js';
import { getSchoolSubscriptions, setSchoolSubscription, clearSchoolSubscription, MAX_SCHOOL_NAME_LENGTH } from './schoolsubs.js';
import { getGreetedUserIds } from './greeter.js';
import { TERMS_MD, PRIVACY_MD } from './legal.js';

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
    footer: { text: 'School Status' }
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

// The shared text lives in legal.js, which also serves it as web pages at
// GET /terms and GET /privacy.
export function runTermsCommand() {
  return {
    embeds: [{
      title: '📄 School Status — Terms and Conditions',
      color: 0x5865F2,
      description: TERMS_MD,
      timestamp: new Date().toISOString(),
      footer: { text: 'School Status' }
    }],
    flags: EPHEMERAL_FLAG
  };
}

export function runPrivacyCommand() {
  return {
    embeds: [{
      title: '🔒 School Status — Privacy Policy',
      color: 0x5865F2,
      description: PRIVACY_MD,
      timestamp: new Date().toISOString(),
      footer: { text: 'School Status' }
    }],
    flags: EPHEMERAL_FLAG
  };
}

// Deferred: scrapes the live status page and edits the ephemeral response.
export async function runStatusCommand(body, env) {
  const guildId = body.guild_id || '';
  const builtStatus = await buildStatusPayload(env, {
    footer: 'School Status - Only you can see this',
    guildId
  });
  await updateInteractionOriginal(env, body.token, {
    content: '',
    embeds: builtStatus.payload.embeds
  });
}

export function runHelpCommand() {
  return {
    embeds: [{
      title: '📖 School Status — Commands & Features',
      color: 0x5865F2,
      description:
        '**For everyone:**\n' +
        '• `/status` — check the current operating status (only you see it)\n' +
        '• `/snowday` — closing/delay outlook from weather alerts, nearby districts, and outages\n' +
        '• `/calendar` — scheduled closures and events in the next 7 days\n' +
        '• `/history` — the last 10 operating status changes\n' +
        '• `/districts` — what neighboring school districts have announced\n' +
        '• `/outages` — current BGE power outage counts by county\n' +
        '• `/stats` — closure days, delays, and scraper statistics\n' +
        '• `/notify` — get a DM whenever the operating status changes (run again to stop)\n' +
        '• `/myschool` — register your school to get DMed when a notice mentions it\n' +
        '• `/terms` · `/privacy` — the bot\'s Terms and Privacy Policy\n\n' +
        '**Buttons on status posts:**\n' +
        '• **Check again** — re-check privately · **🔔 Notify Me** — same as `/notify`\n' +
        '• **Role dropdown** — pick which status changes ping you\n\n' +
        '**For bot staff:**\n' +
        '• `/post-status` — publish a fresh status post now\n' +
        '• `/override` — force a displayed status for 1–30 days\n' +
        '• `/events` — add/remove custom calendar events\n' +
        '• `/announce` — post a custom announcement embed\n' +
        '• `/health` — scraper, posting, and storm-mode health at a glance\n' +
        '• `/refresh-panel` — refresh the control panel in the log channel\n\n' +
        '**For administrators:**\n' +
        '• `/setup` — first-time setup wizard (channels, roles, notifications)\n' +
        '• `/mydata` — view or delete everything the bot stores for this server\n\n' +
        '*Automatic features (storm mode, morning digest, night-before heads-up, bus alerts, and more) are configured in the control panel in your log channel.*',
      timestamp: new Date().toISOString(),
      footer: { text: 'School Status · Unofficial — always verify with hcpss.org' }
    }],
    flags: EPHEMERAL_FLAG
  };
}

// Deferred: fetches weather, district, and outage signals, then edits the
// ephemeral response with the on-demand Closure Outlook.
export async function runSnowdayCommand(body, env) {
  const checkedAt = new Date();
  const alerts = await getActiveWeatherAlerts(env);
  const districts = await getDistrictStatuses(env);
  const outageSummary = await getBgeOutages(env);
  const outlook = computeClosureOutlook(alerts, districts, {
    outagePercent: outagePercent(getCountyOutage(outageSummary, HCPSS_COUNTY))
  });

  const embed = {
    title: '❄️ Snow Day Outlook',
    color: outlook.level === 'very_high' ? 0xE74C3C
      : outlook.level === 'high' ? 0xE67E22
      : outlook.level === 'moderate' ? 0xF1C40F
      : 0x95A5A6,
    timestamp: checkedAt.toISOString(),
    footer: { text: footerWithCheckedAt('School Status · Unofficial estimate', checkedAt) }
  };

  if (outlook.level === 'none') {
    embed.description = '⚪ **No storm signals right now.**\n\n' +
      'No active winter weather alerts for Howard County, and no nearby districts have announced closings or delays. ' +
      'Sorry — looks like a regular school day. 📚';
  } else {
    const meta = OUTLOOK_LEVELS[outlook.level] || OUTLOOK_LEVELS.low;
    embed.description = formatOutlookLines(outlook);
    const fields = [];
    const snowLines = formatSnowfallLines(await getSnowfallForecast(env));
    const alertLines = formatWeatherAlertLines(alerts);
    const districtLines = formatDistrictLines(districts);
    if (snowLines) fields.push({ name: '🌨️ Snowfall Forecast', value: snowLines });
    if (alertLines) fields.push({ name: '⛅ Active Weather Alerts', value: alertLines });
    if (districtLines) fields.push({ name: '🏫 Nearby Districts', value: districtLines });
    if (fields.length) embed.fields = fields;
    embed.title = `❄️ Snow Day Outlook — ${meta.label}`;
  }

  await updateInteractionOriginal(env, body.token, { content: '', embeds: [embed] });
}

export async function runNotifyCommand(body, env) {
  const guildId = body.guild_id || '';
  const userId = getInvokerId(body);
  if (!userId) {
    return { content: '❌ Could not determine your user ID.', flags: EPHEMERAL_FLAG };
  }
  const result = await toggleSubscriber(env, guildId, userId);
  if (result.full) {
    return { content: '❌ The subscriber list for this server is full.', flags: EPHEMERAL_FLAG };
  }
  return {
    content: result.subscribed
      ? "🔔 **Subscribed!** I'll DM you whenever the HCPSS operating status changes (not on every scheduled repost). Make sure DMs from this server's members are enabled. Run `/notify` again to unsubscribe."
      : '🔕 **Unsubscribed.** You will no longer get DMs when the status changes.',
    flags: EPHEMERAL_FLAG
  };
}

// /myschool — register (or clear) the school whose School-Specific Notices
// should be DMed to you. Open to everyone; only affects the invoker.
export async function runMySchoolCommand(body, env) {
  const guildId = body.guild_id || '';
  const userId = getInvokerId(body);
  if (!userId) {
    return { content: '❌ Could not determine your user ID.', flags: EPHEMERAL_FLAG };
  }

  const options = body && body.data && Array.isArray(body.data.options) ? body.data.options : [];
  const sub = options[0] && options[0].type === 1 ? options[0] : null;
  const subName = sub && sub.name ? String(sub.name) : '';
  const subOptions = sub && Array.isArray(sub.options) ? sub.options : [];

  if (subName === 'set') {
    const nameRaw = getCommandOption(subOptions, 'name');
    const name = (nameRaw ? String(nameRaw) : '').replace(/\s+/g, ' ').trim();
    if (name.length < 3 || name.length > MAX_SCHOOL_NAME_LENGTH) {
      return {
        content: `❌ Please give a school name between 3 and ${MAX_SCHOOL_NAME_LENGTH} characters (e.g. \`Centennial High\`).`,
        flags: EPHEMERAL_FLAG
      };
    }
    const result = await setSchoolSubscription(env, guildId, userId, name);
    if (result.full) {
      return { content: '❌ The school subscription list for this server is full.', flags: EPHEMERAL_FLAG };
    }
    return {
      content: `🏫 **Got it!** I'll DM you when a School-Specific Notice mentions **${name}**. ` +
        'Make sure DMs from this server\'s members are enabled. Run `/myschool clear` to stop.',
      flags: EPHEMERAL_FLAG
    };
  }

  if (subName === 'clear') {
    const removed = await clearSchoolSubscription(env, guildId, userId);
    return {
      content: removed
        ? `🔕 Cleared — you'll no longer get DMs about **${removed}**.`
        : 'You don\'t have a school registered here. Use `/myschool set` to pick one.',
      flags: EPHEMERAL_FLAG
    };
  }

  const subs = await getSchoolSubscriptions(env, guildId);
  const mine = subs[userId];
  return {
    content: mine
      ? `🏫 You're subscribed to notices mentioning **${mine}**. Use \`/myschool set\` to change it or \`/myschool clear\` to stop.`
      : 'You don\'t have a school registered here. Use `/myschool set` to pick one and get DMed when a notice mentions it.',
    flags: EPHEMERAL_FLAG
  };
}

// /mydata view — fulfills the Privacy Policy's promise that admins can see a
// summary of what the bot stores for their server.
export async function runMyDataViewCommand(env, guildId) {
  const stored = await getConfig(env, guildId);
  const cfg = getEffectiveConfig(stored);
  const subscribers = await getSubscribers(env, guildId);
  let schoolSubCount = 0;
  try { schoolSubCount = Object.keys(await getSchoolSubscriptions(env, guildId)).length; } catch {}
  let calendarCount = 0;
  try { calendarCount = (await listCalendarEvents(env, guildId)).length; } catch {}
  let greetedCount = 0;
  try { greetedCount = (await getGreetedUserIds(env, guildId)).size; } catch {}
  const setupDone = await env.STATUS_KV.get(`setup_done:${guildId}`);
  const rawLogs = await env.STATUS_KV.get(`panel_logs:${guildId}`);
  let logCount = 0;
  if (rawLogs) {
    try { logCount = JSON.parse(rawLogs).length; } catch {}
  }

  const pingRoleCount = Object.values(cfg.status_ping_roles || {}).filter(Boolean).length;

  return {
    embeds: [{
      title: '🗄️ Data Stored for This Server',
      color: 0x34495E,
      description:
        'Everything the bot keeps for this server, per the Privacy Policy (`/privacy`):\n\n' +
        `• **Server ID**: \`${guildId || '(unknown)'}\`\n` +
        `• **Setup completed**: ${setupDone === 'true' ? 'Yes' : 'No'}\n` +
        `• **Configured channels**: alerts ${cfg.alert_channel_id ? `<#${cfg.alert_channel_id}>` : '*(not set)*'} · logs ${cfg.log_channel_id ? `<#${cfg.log_channel_id}>` : '*(not set)*'}\n` +
        `• **Staff role**: ${stored.staff_role_id ? `<@&${stored.staff_role_id}>` : '*(none — Administrators only)*'}\n` +
        `• **Notification ping roles**: ${pingRoleCount} configured\n` +
        `• **Server settings**: feature toggles, check schedule, embed colors/footer\n` +
        `• **DM subscribers**: ${subscribers.length} user ID(s) (opted in via 🔔 or \`/notify\`)\n` +
        `• **School subscriptions**: ${schoolSubCount} user(s) registered a school via \`/myschool\`\n` +
        `• **Welcomed members**: ${greetedCount} user ID(s) (so nobody is greeted twice)\n` +
        `• **Custom calendar events**: ${calendarCount}\n` +
        `• **System log lines**: ${logCount}\n` +
        `• **Bookkeeping**: last posted message/channel IDs, last check timestamps\n\n` +
        'No message content, names, or other personal information is stored.\n' +
        'Use `/mydata delete` to erase all of it, or simply remove the bot — departed servers are purged automatically within a day.',
      timestamp: new Date().toISOString(),
      footer: { text: 'School Status' }
    }],
    flags: EPHEMERAL_FLAG
  };
}

// /mydata delete — a destructive action, so it asks for confirmation first.
export function runMyDataDeletePrompt() {
  return {
    content: '⚠️ **Delete all server data?**\n\n' +
      'This permanently erases everything the bot stores for this server: configuration, ' +
      'notification role mappings, DM subscriber list, school subscriptions, custom calendar events, ' +
      'welcomed-member records, and system logs. The bot will stop posting here until `/setup` is run again.\n\n' +
      'Are you sure?',
    components: [{
      type: 1,
      components: [
        { type: 2, style: 4, label: 'Yes, delete everything', custom_id: 'mydata_delete_confirm' },
        { type: 2, style: 2, label: 'Cancel', custom_id: 'mydata_delete_cancel' }
      ]
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

// Guilds following a neighboring district read that district's own history and
// yearly stats; everyone else gets the HCPSS ones. Returns '' for HCPSS.
async function getGuildHistoryDistrict(env, guildId) {
  if (!guildId) return '';
  const cfg = getEffectiveConfig(await getConfig(env, guildId));
  return cfg.primary_district && cfg.primary_district !== 'hcpss' ? cfg.primary_district : '';
}

export async function runHistoryCommand(env, guildId = '') {
  const checkedAt = new Date();
  const joinedAt = await getGuildJoinedAt(env, guildId);
  const districtId = await getGuildHistoryDistrict(env, guildId);
  const meta = districtId ? getDistrictMeta(districtId) : null;
  const history = (await getStatusHistory(env, districtId)).filter(h => h.timestamp >= joinedAt);

  const embed = {
    title: meta ? `📜 ${meta.name} Schools — Recent Status History` : '📜 HCPSS Recent Status History',
    color: 3066993,
    timestamp: checkedAt.toISOString(),
    footer: { text: `School Status · ${history.length} change(s) recorded${joinedAt ? ' since this server was set up' : ''}` }
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

export async function runDistrictsCommand(env, guildId = '') {
  const checkedAt = new Date();
  const districts = await getDistrictStatuses(env);

  // The neighbor list only covers the six surrounding counties, so add HCPSS
  // itself from the status page and pin the guild's own district to the top.
  let primaryId = 'hcpss';
  try {
    const cfg = getEffectiveConfig(await getConfig(env, guildId));
    if (cfg.primary_district) primaryId = cfg.primary_district;
  } catch {}

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

  const entries = buildDecisionWatchEntries(districts, hcpssEntry, primaryId);

  return {
    embeds: [{
      title: '🏫 School Districts — Operating Status',
      color: 3447003,
      description: buildDecisionWatchDescription(entries, primaryId) ||
        'No district information available right now.',
      timestamp: checkedAt.toISOString(),
      footer: { text: footerWithCheckedAt('School Status · 📍 your district · Cached up to 10 min', checkedAt) }
    }],
    flags: EPHEMERAL_FLAG
  };
}

// Member command: current BGE outage counts for every county in the feed,
// any time — not just when storm embeds happen to show them. The guild's own
// county (from its primary district) is pinned to the top.
export async function runOutagesCommand(env, guildId = '') {
  const checkedAt = new Date();
  let county = HCPSS_COUNTY;
  try {
    const cfg = getEffectiveConfig(await getConfig(env, guildId));
    const meta = cfg.primary_district && cfg.primary_district !== 'hcpss' ? getDistrictMeta(cfg.primary_district) : null;
    if (meta) county = meta.county;
  } catch {}

  const summary = await getBgeOutages(env);
  const kubraSummaries = await getKubraUtilitySummaries(env);
  if (!summary && !kubraSummaries.length) {
    return {
      embeds: [{
        title: '🔌 Power Outages',
        color: 0xE67E22,
        description: 'The utility outage feeds are unavailable right now — try again in a few minutes, or check [BGE\'s outage map](https://outagemap.bge.com).',
        timestamp: checkedAt.toISOString(),
        footer: { text: 'School Status' }
      }],
      flags: EPHEMERAL_FLAG
    };
  }

  let totalOut = 0;
  const sections = [];

  // The guild's own county first, merged across every utility serving it.
  const picture = await getCountyOutagePicture(env, county);
  if (picture.entry) {
    const pinnedLine = picture.line ||
      `🔌 **0** of ${picture.entry.served.toLocaleString('en-US')} customers without power in ${county} County`;
    sections.push(`📍 ${pinnedLine}`);
  }

  const countyLine = (name, c) => {
    const pct = outagePercent(c);
    const pctStr = c.out > 0 ? ` (${pct >= 0.1 ? pct.toFixed(1) : pct.toFixed(2)}%)` : '';
    const emoji = c.out === 0 ? '🟢' : pct >= 5 ? '🔴' : '🟠';
    return `${emoji} **${name}**: ${c.out.toLocaleString('en-US')} of ${c.served.toLocaleString('en-US')} customers out${pctStr}`;
  };

  // BGE's counties by most customers out, then the other utilities' counties.
  if (summary) {
    const names = Object.keys(summary.counties).sort((a, b) =>
      (summary.counties[b].out - summary.counties[a].out) || a.localeCompare(b));
    const lines = names.map(name => {
      totalOut += summary.counties[name].out;
      return countyLine(name, summary.counties[name]);
    });
    const stormNote = summary.stormMode
      ? '\n⚡ *BGE has activated storm mode — restoration estimates may be delayed.*'
      : '';
    sections.push(`**BGE**\n${lines.join('\n')}${stormNote}`);
  }

  for (const { label, summary: s } of kubraSummaries) {
    const names = Object.keys(s.counties).sort((a, b) =>
      (s.counties[b].out - s.counties[a].out) || a.localeCompare(b));
    if (!names.length) continue;
    const lines = names.map(name => {
      totalOut += s.counties[name].out;
      return countyLine(name, s.counties[name]);
    });
    sections.push(`**${label}**\n${lines.join('\n')}`);
  }

  return {
    embeds: [{
      title: '🔌 Power Outages by County',
      url: 'https://outagemap.bge.com',
      color: totalOut > 0 ? 0xE67E22 : 0x2ECC71,
      description: `${sections.join('\n\n')}\n\n**Total**: ${totalOut.toLocaleString('en-US')} customers without power`,
      timestamp: checkedAt.toISOString(),
      footer: { text: footerWithCheckedAt('School Status · Cached up to 10 min', checkedAt) }
    }],
    flags: EPHEMERAL_FLAG
  };
}

// /health — staff-facing operational snapshot: scraper health, this server's
// last check and post, the next scheduled slot, and storm-mode state. All
// reads are KV or cache so the reply fits inside the interaction deadline.
export async function runHealthCommand(env, guildId = '') {
  const checkedAt = new Date();
  const cfg = getEffectiveConfig(await getConfig(env, guildId));

  let stats = {};
  try {
    const rawStats = await env.STATUS_KV.get('status_stats');
    if (rawStats) stats = JSON.parse(rawStats) || {};
  } catch {}
  const scrapesTotal = stats.scrapes_total || 0;
  const scrapesFailed = stats.scrapes_failed || 0;
  const uptimePct = scrapesTotal > 0 ? (((scrapesTotal - scrapesFailed) / scrapesTotal) * 100).toFixed(2) : '100.00';
  const failureStreak = Number(await env.STATUS_KV.get('scraper_failures_count') || 0);

  const lastCheckMs = Number(await env.STATUS_KV.get(`last_check_time:${guildId}`)) || 0;
  const latency = await env.STATUS_KV.get(`last_check_latency:${guildId}`);
  const lastMsgId = await env.STATUS_KV.get(`last_message_id:${guildId}`);
  const lastChanId = await env.STATUS_KV.get(`last_channel_id:${guildId}`);
  const alertFailures = Number(await env.STATUS_KV.get(`alert_post_failures:${guildId}`)) || 0;

  let guildCount = null;
  try {
    const rawIndex = await env.STATUS_KV.get('guild_index');
    if (rawIndex) {
      const parsed = JSON.parse(rawIndex);
      if (Array.isArray(parsed)) guildCount = parsed.filter(Boolean).length;
    }
  } catch {}

  // Storm state from the cached weather read — never waits on an NWS fetch.
  const meta = cfg.primary_district && cfg.primary_district !== 'hcpss' ? getDistrictMeta(cfg.primary_district) : null;
  const alerts = await getCachedWeatherAlerts(env, meta && meta.nwsZone ? meta.nwsZone : DEFAULT_NWS_ZONE);
  const stormAlert = hasStormAlert(alerts);
  const etStr = getEasternTimeStr(checkedAt);
  const inWindow = isInStormWindow(etStr);

  const schedule = Array.isArray(cfg.check_schedule) ? cfg.check_schedule : [];
  const next = nextScheduledTime(schedule, etStr);

  const scraperEmoji = failureStreak >= 3 ? '🔴' : failureStreak > 0 ? '🟠' : '🟢';
  const lines = [
    `**Scraper (all servers):**`,
    `• ${scraperEmoji} Consecutive failures: \`${failureStreak}\``,
    `• Success rate: \`${uptimePct}%\` over \`${scrapesTotal}\` checks`,
    guildCount !== null ? `• Serving \`${guildCount}\` server(s)` : null,
    ``,
    `**This server:**`,
    `• Last check: ${lastCheckMs ? `<t:${Math.floor(lastCheckMs / 1000)}:R>` : '*none recorded*'}${latency ? ` (\`${latency}ms\`)` : ''}`,
    `• Last status post: ${lastMsgId && lastChanId ? `[jump to message](https://discord.com/channels/${guildId}/${lastChanId}/${lastMsgId})` : '*none tracked*'}`,
    alertFailures > 0 ? `• 🔴 Alert channel: \`${alertFailures}\` consecutive failed post(s) — check permissions on <#${cfg.alert_channel_id}>` : `• 🟢 Alert channel: ${cfg.alert_channel_id ? `<#${cfg.alert_channel_id}>` : '*(not set)*'}`,
    `• Next scheduled check: ${next ? `**${formatScheduleTimeLabel(next.time)} ET**${next.tomorrow ? ' (tomorrow)' : ''}` : '*no schedule configured*'}`,
    ``,
    `**Storm mode:**`,
    `• ${cfg.toggle_storm_mode !== false ? '🟢 Enabled' : '🔴 Disabled'} — windows 4:30–7:30 AM & 10 AM–2 PM ET`,
    `• Storm alert active${meta ? ` (${meta.name})` : ' (Howard Co.)'}: ${stormAlert ? '🌨️ **Yes**' : 'No'}${inWindow && stormAlert ? ' — extra checks running now' : ''}`
  ].filter(l => l !== null);

  return {
    embeds: [{
      title: '🩺 School Status — Health Check',
      color: failureStreak >= 3 || alertFailures >= 3 ? 0xE74C3C : 0x2ECC71,
      description: lines.join('\n'),
      timestamp: checkedAt.toISOString(),
      footer: { text: 'School Status · Weather state from cache (≤10 min old)' }
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
    title: '📋 School Status - System Logs',
    color: 10181046, // Purple
    timestamp: checkedAt.toISOString(),
    footer: { text: 'School Status' }
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
  const districtId = await getGuildHistoryDistrict(env, guildId);
  const meta = districtId ? getDistrictMeta(districtId) : null;
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

  const fullHistory = await getStatusHistory(env, districtId);
  const history = fullHistory.filter(h => h.timestamp >= joinedAt);

  // All-time counts: servers set up after tracking began only count changes
  // they were around for; the original deployment keeps the global counters
  // (which include entries that have rolled off the capped history). District
  // guilds always count from their district's history.
  const countsDisplay = Object.entries(incidentLabels).map(([key, label]) => {
    const count = (joinedAt || districtId)
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

  // Inclement weather day budget (HCPSS-specific: the budget number comes from
  // the HCPSS calendar, so district guilds don't see it). District-wide, so it
  // uses the unfiltered history rather than the since-setup view.
  let budgetLine = '';
  if (!districtId) {
    const budget = computeSnowDayBudget(fullHistory, checkedAt);
    budgetLine = `\n• ❄️ **Inclement Weather Budget**: \`${budget.used}/${budget.budget}\` built-in days used` +
      (budget.over > 0 ? ` (**${budget.over} over** — makeup days likely)` : '');
  }

  // Previous school years from the persistent archive (current year excluded —
  // it's already shown above). District-wide, so it uses the unfiltered history.
  const yearly = await getYearlyStats(env, fullHistory, districtId);
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

  // Closure Outlook track record (HCPSS-based; graded the day after each
  // storm-evening prediction). Only shown once at least one night is graded.
  let outlookSection = '';
  try {
    const accuracyLines = formatOutlookAccuracyLines(summarizeOutlookAccuracy(await getOutlookPredictions(env)));
    if (accuracyLines) {
      outlookSection = `\n\n**🔮 Closure Outlook Track Record:**\n${accuracyLines}`;
    }
  } catch {}

  const embed = {
    title: meta ? `📊 School Status — ${meta.name} Statistics` : '📊 School Status - Statistics',
    color: 0x34495E,
    description: `**Scraper Diagnostics (all servers):**\n` +
                 `• Total Checks: \`${scrapesTotal}\`\n` +
                 `• Scraper Success Rate: \`${uptimePct}%\` (\`${scrapesSuccess}/${scrapesTotal}\` successful)\n\n` +
                 `**This School Year (${currentLabel}):**\n` +
                 `• ❄️ **Closure Days**: \`${yearStats.snowDays}\`\n` +
                 `• 🕑 **2-Hour Delays**: \`${yearStats.delays}\`\n` +
                 `• 🏃 **Early Closings**: \`${yearStats.earlyCloses}\`\n` +
                 `• 📌 **Last Incident**: ${lastIncidentStr}` +
                 budgetLine +
                 pastYearsSection + outlookSection + `\n\n` +
                 `**Status Changes (This School Year):**\n` +
                 `${yearCountsDisplay}\n\n` +
                 `**Status Changes (${joinedAt ? 'Since Server Setup' : 'All-Time'}):**\n` +
                 `${countsDisplay}`,
    timestamp: checkedAt.toISOString(),
    footer: { text: 'School Status' }
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
      footer: { text: 'School Status' }
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
    `school_subs:${guildId}`,
    `decision_watch:${guildId}`,
    `scraper_failures_count`,
    `scraper_failure_alerted`,
    `log_panel_message_id:${guildId}`,
    `setup_done:${guildId}`,
    `outlook_predictions`
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
