// Control panel: page rendering, the persistent log-channel panel message,
// and config updates driven by panel components.

import { ALL_STATUS_LABELS, STATUS_LABELS, DEFAULT_CHECK_SCHEDULE, SCHOOL_CALENDAR_EVENTS, getDefaultStatusColor } from './constants.js';
import {
  getEasternTimeStr,
  clockEmojiForTime,
  formatScheduleTimeLabel,
  formatStatusDate,
  formatYmdNY,
  isInStormWindow
} from './timeutil.js';
import { hasStormAlert } from './weather.js';
import { getStatusHistory } from './history.js';
import { getConfig, setConfig, getEffectiveConfig, getActiveOverride } from './config.js';
import { listCalendarEvents } from './calendar.js';

const BAR_SEGMENTS = 20;

function filledCount(value, max, segments = BAR_SEGMENTS) {
  return Math.min(segments, Math.max(0, Math.round((value / max) * segments)));
}

function filledCountInverse(value, max, segments = BAR_SEGMENTS) {
  return Math.min(segments, Math.max(0, Math.round(((max - value) / max) * segments)));
}

function barFromFilled(filled, segments = BAR_SEGMENTS) {
  const f = Math.max(0, Math.min(segments, filled));
  return '`' + '■'.repeat(f) + ' '.repeat(segments - f) + '`';
}

export const PANEL_NAV_TABS = [
  { label: 'Dashboard', value: 'dashboard', emoji: '🏠', description: 'System status overview and quick actions' },
  { label: 'Recent Logs', value: 'dashboard_logs', emoji: '📋', description: 'Recent bot activity logs' },
  { label: 'Bot Health', value: 'dashboard_bot_status', emoji: '📡', description: 'Ping, uptime, and health metric bars' },
  { label: 'Settings', value: 'config_general', emoji: '⚙️', description: 'Channels, staff role, and embed footer' },
  { label: 'Check Schedule', value: 'config_schedule', emoji: '🗓️', description: 'Daily status check times' },
  { label: 'Feature Toggles', value: 'config_toggles', emoji: '🔔', description: 'Turn bot features on or off' },
  { label: 'Status Theme', value: 'config_status', emoji: '🎨', description: 'Embed colors and ping roles per status' },
  { label: 'Calendar', value: 'config_calendar', emoji: '📅', description: 'Upcoming closures and custom events' },
  { label: 'Stats & Override', value: 'config_stats', emoji: '📈', description: 'Check statistics and status overrides' },
  { label: 'Command List', value: 'config_commands', emoji: '📜', description: 'List of available slash commands' }
];

function getNavTabForPage(page) {
  if (page === 'config_override_select') return 'config_stats';
  if (page === 'config_schedule_add') return 'config_schedule';
  return PANEL_NAV_TABS.some(t => t.value === page) ? page : 'dashboard';
}

// Per-page actions dropdown. Option values are dispatched by the
// panel_action_select handler as if a component with that custom_id was used.
function actionSelectRow(options, placeholder = '⚡ Actions...', disabled = false) {
  return {
    type: 1,
    components: [{
      type: 3,
      custom_id: 'panel_action_select',
      placeholder,
      options,
      min_values: 1,
      max_values: 1,
      ...(disabled ? { disabled: true } : {})
    }]
  };
}

function getNavBarRow(activeTab) {
  const activeValue = getNavTabForPage(activeTab);

  return {
    type: 1,
    components: [{
      type: 3,
      custom_id: 'panel_nav_select',
      placeholder: '🧭 Go to panel page...',
      options: PANEL_NAV_TABS.map(tab => ({
        label: tab.label,
        value: tab.value,
        description: tab.description,
        emoji: { name: tab.emoji },
        default: tab.value === activeValue
      })),
      min_values: 1,
      max_values: 1
    }]
  };
}

export async function buildBotStatusPayload(env, guildId, fraction = 1) {
  const latencyKey = guildId ? `last_check_latency:${guildId}` : 'last_check_latency';
  const checkTimeKey = guildId ? `last_check_time:${guildId}` : 'last_check_time';

  const latencyRaw = await env.STATUS_KV.get(latencyKey);
  const latencyMs = latencyRaw ? Number(latencyRaw) : null;
  const lastCheckTime = Number(await env.STATUS_KV.get(checkTimeKey)) || Date.now();

  const rawStats = await env.STATUS_KV.get('status_stats');
  let stats = {};
  try { if (rawStats) stats = JSON.parse(rawStats) || {}; } catch {}
  const scrapesTotal = stats.scrapes_total || 0;
  const scrapesFailed = stats.scrapes_failed || 0;
  const successRate = scrapesTotal > 0 ? ((scrapesTotal - scrapesFailed) / scrapesTotal * 100) : 100;
  const scraperFailures = Number(await env.STATUS_KV.get('scraper_failures_count') || 0);

  let pingLabel, pingFilled, pingEmoji;
  if (latencyMs === null) {
    pingLabel = 'N/A';
    pingFilled = 0;
    pingEmoji = '⚪';
  } else {
    pingLabel = `${latencyMs}ms`;
    pingFilled = filledCountInverse(Math.min(latencyMs, 2000), 2000);
    pingEmoji = latencyMs <= 300 ? '🟢' : latencyMs <= 800 ? '🟡' : latencyMs <= 1500 ? '🟠' : '🔴';
  }

  const scraperHealthFilled = filledCountInverse(scraperFailures, 5);
  const scraperHealthEmoji = scraperFailures === 0 ? '🟢' : scraperFailures < 3 ? '🟡' : '🔴';
  const scraperHealthLabel = scraperFailures === 0 ? 'Healthy' : `${scraperFailures} failure(s)`;

  const successFilled = filledCount(successRate, 100);
  const successEmoji = successRate >= 95 ? '🟢' : successRate >= 80 ? '🟡' : '🔴';

  const uptimeVal = successRate;
  const uptimeFilled = filledCount(uptimeVal, 100);
  const uptimeEmoji = uptimeVal >= 99 ? '🟢' : uptimeVal >= 90 ? '🟡' : '🔴';

  const minutesSinceCheck = Math.round((Date.now() - lastCheckTime) / 60000);
  const freshnessFilled = filledCountInverse(minutesSinceCheck, 120);
  const freshnessEmoji = minutesSinceCheck <= 10 ? '🟢' : minutesSinceCheck <= 60 ? '🟡' : '🔴';
  const freshnessLabel = minutesSinceCheck === 0 ? 'Just now' : `${minutesSinceCheck}m ago`;

  const totalIncidents = Object.entries(stats)
    .filter(([k]) => !['scrapes_total', 'scrapes_failed'].includes(k))
    .reduce((acc, [, v]) => acc + (Number(v) || 0), 0);
  const incidentFilled = filledCount(Math.min(totalIncidents, 50), 50);
  const incidentEmoji = totalIncidents === 0 ? '🟢' : totalIncidents < 10 ? '🟡' : '🔴';

  const f = Math.max(0, Math.min(1, fraction));
  const scale = n => Math.round(n * f);
  const isFinal = f >= 1;
  const refreshHint = isFinal ? '' : '⏳ *Refreshing…*\n\n';

  const embed = {
    title: '📡 Control Panel — Bot Health',
    color: 0x5865F2,
    description:
      `${refreshHint}### 📡 Live Bot Health Metrics\n\n` +
      `${pingEmoji} **Scraper Ping / Latency** — ${isFinal ? pingLabel : '…'}\n` +
      `${barFromFilled(scale(pingFilled))}\n` +
      `> Full bar = fast (≤0ms) · Empty = 2000ms+\n\n` +
      `${scraperHealthEmoji} **Scraper Health** — ${isFinal ? scraperHealthLabel : '…'}\n` +
      `${barFromFilled(scale(scraperHealthFilled))}\n` +
      `> Full bar = no failures · Empties per consecutive error\n\n` +
      `${successEmoji} **Scraper Success Rate** — ${isFinal ? successRate.toFixed(1) + '%' : '…'}\n` +
      `${barFromFilled(scale(successFilled))}\n` +
      `> \`${scrapesTotal - scrapesFailed}/${scrapesTotal}\` successful checks\n\n` +
      `${uptimeEmoji} **Overall Uptime Score** — ${isFinal ? uptimeVal.toFixed(1) + '%' : '…'}\n` +
      `${barFromFilled(scale(uptimeFilled))}\n` +
      `> Based on full scrape history\n\n` +
      `${freshnessEmoji} **Data Freshness** — ${isFinal ? freshnessLabel : '…'}\n` +
      `${barFromFilled(scale(freshnessFilled))}\n` +
      `> Full bar = checked just now · Empty = 2h+ ago\n\n` +
      `${incidentEmoji} **Incident Load (all-time)** — ${isFinal ? totalIncidents + ' event(s)' : '…'}\n` +
      `${barFromFilled(scale(incidentFilled))}\n` +
      `> Filled = more non-normal status events recorded`,
    timestamp: new Date().toISOString(),
    footer: { text: 'HCPSS Status Monitor · Bot Status  •  ■ = filled  · space = empty' }
  };

  const components = [
    getNavBarRow('dashboard_bot_status'),
    actionSelectRow([
      { label: 'Refresh Metrics', value: 'panel_to_dashboard_bot_status', description: 'Re-measure and animate the health bars', emoji: { name: '🔄' } },
      { label: 'View Recent Logs', value: 'panel_to_dashboard_logs', description: 'Switch to the recent activity logs page', emoji: { name: '📋' } }
    ], '⚡ Actions...', !isFinal)
  ];

  return { embeds: [embed], components };
}

export async function buildControlPanelPayload(env, guildId, configOverride = null, pageOverride = null) {
  // configOverride/pageOverride let callers that just wrote to KV render with the
  // fresh values — KV does not guarantee read-your-own-writes, so re-reading here
  // right after a save can return stale cached data for up to 60 seconds.
  const stored = configOverride || await getConfig(env, guildId);
  const config = getEffectiveConfig(stored);
  const page = pageOverride || await env.STATUS_KV.get(`panel_page:${guildId}`) || 'dashboard';

  if (page === 'config_general') {
    const channel = config.alert_channel_id ? `<#${config.alert_channel_id}>` : '(not set)';
    const logChannel = config.log_channel_id ? `<#${config.log_channel_id}>` : '(not set)';
    const staffRole = config.staff_role_id ? `<@&${config.staff_role_id}>` : '(not set)';
    const embedFooter = config.alert_embed_footer || '(default)';

    const embed = {
      title: '⚙️ Control Panel — Settings',
      color: 0x3498DB,
      description: `### 🔧 Server Settings\n` +
                   `• **Alerts Destination**: ${channel}\n` +
                   `• **System Logs Destination**: ${logChannel}\n` +
                   `• **Moderator Staff Role**: ${staffRole}\n` +
                   `• **Alert Embed Footer**: \`${embedFooter}\`\n\n` +
                   `*Pick a channel or role below to change it — saves instantly.*\n` +
                   `*Check times and feature toggles have their own pages in the 🧭 navigation menu.*`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_general'),
      {
        type: 1,
        components: [{
          type: 8,
          custom_id: 'cfg_channel',
          placeholder: 'Select alert channel',
          min_values: 1,
          max_values: 1,
          channel_types: [0, 5]
        }]
      },
      {
        type: 1,
        components: [{
          type: 8,
          custom_id: 'cfg_log_channel',
          placeholder: 'Select log channel',
          min_values: 1,
          max_values: 1,
          channel_types: [0, 5]
        }]
      },
      {
        type: 1,
        components: [{
          type: 6,
          custom_id: 'cfg_staff_role',
          placeholder: 'Select staff role',
          min_values: 1,
          max_values: 1
        }]
      },
      actionSelectRow([
        { label: 'Set Embed Footer Text', value: 'panel_btn_set_footer', description: 'Customize the footer shown on status embeds', emoji: { name: '✍️' } }
      ])
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_toggles') {
    const pings = config.toggle_pings !== false;
    const errorAlerts = config.toggle_error_alerts !== false;
    const weather = config.toggle_weather !== false;
    const stormMode = config.toggle_storm_mode !== false;
    const districts = config.toggle_districts !== false;
    const outlook = config.toggle_outlook !== false;
    const crosscheck = config.toggle_crosscheck !== false;
    const digest = config.toggle_digest === true; // opt-in, off by default

    const embed = {
      title: '🔔 Control Panel — Feature Toggles',
      color: 0x3498DB,
      description: `### 🚨 Feature Toggles\n` +
                   `Select which features are **enabled** from the dropdown. Deselected options are automatically **disabled**.\n\n` +
                   `• ${pings ? '🟢' : '🔴'} **Role Mentions** — ping roles on status changes\n` +
                   `• ${errorAlerts ? '🟢' : '🔴'} **Scraper Failure Alerts** — warn staff on consecutive scraper errors\n` +
                   `• ${weather ? '🟢' : '🔴'} **Weather Alerts** — show active NWS alerts for Howard County on status embeds\n` +
                   `• ${stormMode ? '🟢' : '🔴'} **Storm Mode** — extra checks every 15 min (4:30–7:30 AM ET) during storm alerts, posting only on changes\n` +
                   `• ${districts ? '🟢' : '🔴'} **Nearby Districts** — show neighboring districts' status on embeds during storm alerts\n` +
                   `• ${outlook ? '🟢' : '🔴'} **Closure Outlook** — estimate closing/delay likelihood during storm alerts\n` +
                   `• ${crosscheck ? '🟢' : '🔴'} **Source Cross-Check** — warn when HCPSS News disagrees with the status page\n` +
                   `• ${digest ? '🟢' : '🔴'} **Morning Digest** — daily 6:00 AM ET summary post (status, calendar, weather)\n\n` +
                   `*Select the toggles you want **ON** in the dropdown and submit. Unselected = OFF.*`,
      timestamp: new Date().toISOString()
    };

    const toggleOptions = [
      {
        label: 'Role Mentions',
        value: 'toggle_pings',
        description: 'Ping configured roles when a status change occurs',
        emoji: { name: '🔔' },
        default: pings
      },
      {
        label: 'Scraper Failure Alerts',
        value: 'toggle_error_alerts',
        description: 'Notify staff if the scraper fails 3+ consecutive times',
        emoji: { name: '⚠️' },
        default: errorAlerts
      },
      {
        label: 'Weather Alerts',
        value: 'toggle_weather',
        description: 'Show active NWS weather alerts on status embeds',
        emoji: { name: '⛅' },
        default: weather
      },
      {
        label: 'Storm Mode',
        value: 'toggle_storm_mode',
        description: 'Extra early-morning checks during storm alerts, post on change only',
        emoji: { name: '🌨️' },
        default: stormMode
      },
      {
        label: 'Nearby Districts',
        value: 'toggle_districts',
        description: "Show neighboring districts' status during storm alerts",
        emoji: { name: '🏫' },
        default: districts
      },
      {
        label: 'Closure Outlook',
        value: 'toggle_outlook',
        description: 'Estimate closing/delay likelihood during storm alerts',
        emoji: { name: '❄️' },
        default: outlook
      },
      {
        label: 'Source Cross-Check',
        value: 'toggle_crosscheck',
        description: 'Warn when the HCPSS News feed disagrees with the status page',
        emoji: { name: '🔎' },
        default: crosscheck
      },
      {
        label: 'Morning Digest',
        value: 'toggle_digest',
        description: 'Post a daily 6:00 AM ET summary (status, calendar, weather)',
        emoji: { name: '🌅' },
        default: digest
      }
    ];

    const components = [
      getNavBarRow('config_toggles'),
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'cfg_toggle_select',
          placeholder: 'Select which features are ON...',
          options: toggleOptions,
          min_values: 0,
          max_values: toggleOptions.length
        }]
      }
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_status') {
    const editingKey = config.editing_status_key || 'normal_operations';
    const editingLabel = ALL_STATUS_LABELS[editingKey] || 'Normal Operations';

    const statusPings = Object.entries(ALL_STATUS_LABELS).map(([key, label]) => {
      const roleId = config.status_ping_roles && config.status_ping_roles[key];
      const pingDisplay = roleId ? `<@&${roleId}>` : '(none)';
      let activeColor = getDefaultStatusColor(key);
      if (config.status_embed_colors && typeof config.status_embed_colors[key] === 'number') {
        activeColor = config.status_embed_colors[key];
      }
      const colorDisplay = ` [Color: #${activeColor.toString(16).toUpperCase().padStart(6, '0')}]`;
      const marker = key === editingKey ? '👉 ' : '• ';
      return `${marker}**${label}**: ${pingDisplay}${colorDisplay}`;
    }).join('\n');

    const embed = {
      title: '🎨 Control Panel — Status Theme',
      color: 0xE74C3C,
      description: `### 🔔 Roles & Embed Themes\n` +
                   `Select a status from the dropdown to edit its **mention role** and **embed color**.\n\n` +
                   `**Current Mapping:**\n${statusPings}\n\n` +
                   `👉 *Currently editing: **${editingLabel}***`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_status'),
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'cfg_status_select',
          placeholder: `Editing status: ${editingLabel}`,
          options: Object.entries(ALL_STATUS_LABELS).map(([key, label]) => ({
            label,
            value: key,
            default: key === editingKey
          })),
          min_values: 1,
          max_values: 1
        }]
      },
      {
        type: 1,
        components: [{
          type: 6,
          custom_id: 'cfg_status_role',
          placeholder: `Select ping role for ${editingLabel}`,
          min_values: 0,
          max_values: 1
        }]
      },
      actionSelectRow([
        { label: `Set Color for ${editingLabel}`, value: 'panel_btn_set_color', description: 'Enter a HEX embed color for this status', emoji: { name: '🎨' } }
      ])
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_schedule') {
    const currentSchedule = Array.isArray(config.check_schedule) ? config.check_schedule : [];
    const scheduleLines = currentSchedule
      .map(t => `> ### ${clockEmojiForTime(t)}  ${formatScheduleTimeLabel(t)}`)
      .join('\n');

    const embed = {
      title: '🗓️ Control Panel — Check Schedule',
      color: 0x2ECC71,
      description: `### ⏱️ Daily Check Times (Eastern)\n` +
                   `The bot checks the HCPSS status website at these times every day:\n\n` +
                   `${scheduleLines || '> *(no check times set)*'}\n\n` +
                   `➕ **Add Time** — pick a new check time (up to 4)\n` +
                   `🗑️ **Remove a check time** — pick it from the remove dropdown\n` +
                   `🔄 **Reset Defaults** — restore 5:20 AM, 7:20 AM, 10:00 AM & 8:00 PM`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_schedule'),
      ...(currentSchedule.length ? [{
        type: 1,
        components: [{
          type: 3,
          custom_id: 'cfg_schedremove_select',
          placeholder: '🗑️ Remove a check time...',
          options: currentSchedule.map(t => ({
            label: formatScheduleTimeLabel(t),
            value: t,
            emoji: { name: clockEmojiForTime(t) }
          })),
          min_values: 1,
          max_values: 1
        }]
      }] : []),
      actionSelectRow([
        { label: 'Add Time', value: 'panel_btn_add_time', description: 'Pick a new daily check time (up to 4)', emoji: { name: '➕' } },
        { label: 'Reset Defaults', value: 'panel_btn_reset_schedule', description: 'Restore 5:20 AM, 7:20 AM, 10:00 AM & 8:00 PM', emoji: { name: '🔄' } }
      ])
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_schedule_add') {
    const pick = config.schedule_pick || {};
    const h = Number.isInteger(pick.h) ? pick.h : 7;
    const mt = Number.isInteger(pick.mt) ? pick.mt : 0;
    const mo = Number.isInteger(pick.mo) ? pick.mo : 0;
    const pickedTime = `${h}:${mt}${mo}`;
    const pickedLabel = formatScheduleTimeLabel(pickedTime);

    const embed = {
      title: '🗓️ Control Panel — Add Check Time',
      color: 0x2ECC71,
      description: `## ${clockEmojiForTime(pickedTime)}  ${pickedLabel}\n\n` +
                   `Dial in a time with the three pickers below, then confirm with **Add** in the bottom dropdown.\n` +
                   `*All times are Eastern.*`,
      timestamp: new Date().toISOString()
    };

    const hourOptions = Array.from({ length: 24 }, (_, i) => ({
      label: `${(i % 12) || 12} ${i < 12 ? 'AM' : 'PM'}`,
      value: String(i),
      emoji: { name: clockEmojiForTime(`${i}:00`) },
      default: i === h
    }));

    const minTenOptions = Array.from({ length: 6 }, (_, t) => ({
      label: `:${t}0 - :${t}9`,
      value: String(t),
      default: t === mt
    }));

    const minOneOptions = Array.from({ length: 10 }, (_, o) => ({
      label: `:${mt}${o}`,
      value: String(o),
      default: o === mo
    }));

    const components = [
      { type: 1, components: [{ type: 3, custom_id: 'cfg_schedpick_hour', placeholder: '🕐 Hour...', options: hourOptions, min_values: 1, max_values: 1 }] },
      { type: 1, components: [{ type: 3, custom_id: 'cfg_schedpick_minten', placeholder: 'Minutes (choose the range)...', options: minTenOptions, min_values: 1, max_values: 1 }] },
      { type: 1, components: [{ type: 3, custom_id: 'cfg_schedpick_minone', placeholder: 'Minutes (exact)...', options: minOneOptions, min_values: 1, max_values: 1 }] },
      actionSelectRow([
        { label: `Add ${pickedLabel}`, value: `panel_btn_confirm_add_time:${h}:${mt}${mo}`, description: 'Save this check time to the schedule', emoji: { name: '✅' } },
        { label: 'Back to Schedule', value: 'panel_to_config_schedule', description: 'Cancel and return to the schedule page', emoji: { name: '⬅️' } }
      ], '✅ Confirm or cancel...')
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_calendar') {
    const checkedAt = new Date();
    const events = [];

    let dynamicEvents = [];
    try { dynamicEvents = await listCalendarEvents(env, guildId); } catch {}
    const dynamicByDate = {};
    for (const e of dynamicEvents) dynamicByDate[e.dateStr] = e.eventStr;

    for (let i = 0; i < 7; i++) {
      const d = new Date(checkedAt.getTime() + i * 24 * 60 * 60 * 1000);
      const ymd = formatYmdNY(d);
      const event = dynamicByDate[ymd] || SCHOOL_CALENDAR_EVENTS[ymd];
      if (event) {
        events.push(`• **${formatStatusDate(d)}** (${ymd}): *${event}*`);
      }
    }
    const calendarList = events.length ? events.join('\n') : '*No scheduled closures or events in the next 7 days.*';

    // All of this server's custom events that haven't passed yet, beyond the
    // 7-day window above.
    const todayYmd = formatYmdNY(checkedAt);
    const upcomingCustom = dynamicEvents.filter(e => e.dateStr >= todayYmd);
    const shownCustom = upcomingCustom.slice(0, 10)
      .map(e => `• **${e.dateStr}**: *${e.eventStr}*`)
      .join('\n');
    const customSection = upcomingCustom.length
      ? `\n\n### 📌 Custom Events (This Server)\n${shownCustom}` +
        (upcomingCustom.length > 10 ? `\n*…and ${upcomingCustom.length - 10} more — see \`/events list\`.*` : '')
      : '';

    const embed = {
      title: '📅 Control Panel — Calendar',
      color: 0xE67E22,
      description: `### 🗓️ Upcoming Closures (Next 7 Days)\n` +
                   `${calendarList}` +
                   customSection + `\n\n` +
                   `*Use the actions dropdown below to add or remove this server's custom events.*`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_calendar'),
      actionSelectRow([
        { label: 'Add Event', value: 'panel_btn_add_event', description: 'Add a closure or custom event for a date', emoji: { name: '➕' } },
        { label: 'Remove Event', value: 'panel_btn_remove_event', description: 'Remove a custom event by date', emoji: { name: '➖' } }
      ])
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_commands') {
    const embed = {
      title: '📜 Control Panel — Command List',
      color: 0x1ABC9C,
      description: `### 🤖 Available Slash Commands\n\n` +
                   `• **\`/post-status\`**: Post the latest HCPSS status now.\n` +
                   `• **\`/override set\`**: Enable a status override for 1-30 days.\n` +
                   `• **\`/override clear\`**: Disable the active override immediately.\n` +
                   `• **\`/calendar\`**: Show scheduled closures or events in the next 7 days.\n` +
                   `• **\`/history\`**: Show the last 10 operating status changes.\n` +
                   `• **\`/districts\`**: Show neighboring school districts' operating status.\n` +
                   `• **\`/events list\`**: List all dynamic calendar events.\n` +
                   `• **\`/events add\`**: Add a dynamic calendar event (YYYY-MM-DD).\n` +
                   `• **\`/events remove\`**: Remove a dynamic calendar event.\n` +
                   `• **\`/stats\`**: Show status check and operating status statistics.\n` +
                   `• **\`/setup\`**: Initial one-time setup for the status monitor.\n` +
                   `• **\`/announce\`**: Post a custom embed announcement in the current channel.\n` +
                   `• **\`/refresh-panel\`**: Refresh the control panel embed in the log channel.\n\n` +
                   `### 🔔 DM Notifications\n` +
                   `Anyone can click the **Notify Me** button on a status message to get a DM when the operating status changes. Click again to unsubscribe.\n\n` +
                   `*Use these commands in any channel where the bot has permission to read and send messages.*`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_commands')
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_stats') {
    const rawStats = await env.STATUS_KV.get('status_stats');
    let stats = {};
    if (rawStats) {
      try { stats = JSON.parse(rawStats) || {}; } catch {}
    }

    const scrapesTotal = stats.scrapes_total || 0;
    const scrapesFailed = stats.scrapes_failed || 0;
    const successRate = scrapesTotal > 0
      ? ((scrapesTotal - scrapesFailed) / scrapesTotal * 100).toFixed(2)
      : '100.00';

    // Servers set up after tracking began only see history from their own
    // setup onward (created_at is stamped by /setup).
    const joinedAt = Number(stored.created_at) || 0;
    const history = (await getStatusHistory(env)).filter(h => h.timestamp >= joinedAt);
    const msInStatus = {};
    let lastTs = Date.now();
    for (const h of history) {
      // Fallback for old entries without status_key
      let key = h.status_key;
      if (!key) {
        if (h.status && h.status.toLowerCase().includes('normal operations')) {
          key = 'normal_operations';
        } else {
          key = 'unknown_alert';
        }
      }
      const ms = lastTs - h.timestamp;
      msInStatus[key] = (msInStatus[key] || 0) + ms;
      lastTs = h.timestamp;
    }

    const incidentList = Object.entries(ALL_STATUS_LABELS).map(([key, label]) => {
      const ms = msInStatus[key] || 0;
      const days = Math.round(ms / (1000 * 60 * 60 * 24));
      return `• **${label}**: \`${days}\` days`;
    }).join('\n');

    const activeOverride = await getActiveOverride(env, guildId);
    let overrideInfo = '';
    let components = [
      getNavBarRow('config_stats')
    ];

    if (activeOverride) {
      const durationHours = Math.max(0, Math.ceil((activeOverride.until - Date.now()) / (1000 * 60 * 60)));
      const days = Math.ceil(durationHours / 24);
      overrideInfo = `⚠️ **Active Override Detected!**\n` +
                     `• **Status Forced**: \`${ALL_STATUS_LABELS[activeOverride.status_key] || activeOverride.status_label}\`\n` +
                     `• **Time Remaining**: \`${days} days\` (~${durationHours} hours)\n` +
                     `• **Details**: *${activeOverride.details || 'None provided.'}*\n` +
                     `• **Custom Title**: *${activeOverride.title || 'None.'}*`;

      components.push(actionSelectRow([
        { label: 'Disable Override', value: 'panel_btn_clear_override', description: 'Return to live scraper mode immediately', emoji: { name: '🛑' } }
      ]));
    } else {
      overrideInfo = `✅ **No Active Override**\n*The bot is currently running in Live Scraper Mode, showing the actual status posted on the HCPSS website.*`;
      components.push(actionSelectRow([
        { label: 'Set Status Override', value: 'panel_to_config_override_select', description: 'Force a specific status for 1-30 days', emoji: { name: '🛠️' } }
      ]));
    }

    const embed = {
      title: '📈 Control Panel — Stats & Override',
      color: 0x9B59B6,
      description: `### 📊 Scraper Diagnostics (all servers)\n` +
                   `• **Total Scrapes**: \`${scrapesTotal}\` checks\n` +
                   `• **Failed Scrapes**: \`${scrapesFailed}\` errors\n` +
                   `• **Success Rate**: \`${successRate}%\`\n\n` +
                   `### 📋 Time in Status (${joinedAt ? 'since server setup' : 'all-time'})\n` +
                   `${incidentList}\n\n` +
                   `### 🛠️ Status Override Configuration\n` +
                   `${overrideInfo}`,
      timestamp: new Date().toISOString()
    };

    return { embeds: [embed], components };
  }

  if (page === 'config_override_select') {
    const editingKey = config.editing_override_status_key || 'normal_operations';
    const editingLabel = STATUS_LABELS[editingKey] || 'Normal Operations';

    const embed = {
      title: '🛠️ Control Panel — Set Status Override',
      color: 0xF1C40F,
      description: `### ⚠️ Select Status to Override\n` +
                   `Choose the status you want to force from the select menu below, then pick **Set Duration & Details** in the actions dropdown to enter how long the override should last.\n\n` +
                   `👉 *Selected status: **${editingLabel}***`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_stats'),
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'cfg_override_status_select',
          placeholder: `Selected: ${editingLabel}`,
          options: Object.entries(STATUS_LABELS).map(([key, label]) => ({
            label,
            value: key,
            default: key === editingKey
          })),
          min_values: 1,
          max_values: 1
        }]
      },
      actionSelectRow([
        { label: 'Set Duration & Details...', value: 'panel_btn_override_details', description: 'Enter the override duration, title, and reason', emoji: { name: '✍️' } },
        { label: 'Back to Stats', value: 'panel_to_config_stats', description: 'Cancel and return to the stats page', emoji: { name: '⬅️' } }
      ], '✍️ Confirm or cancel...')
    ];

    return { embeds: [embed], components };
  }

  // Dashboard sub-page: Recent Logs
  if (page === 'dashboard_logs') {
    const logKey = guildId ? `panel_logs:${guildId}` : 'panel_logs';
    let logs = [];
    const rawLogs = await env.STATUS_KV.get(logKey);
    if (rawLogs) {
      try { logs = JSON.parse(rawLogs); } catch {}
    }

    const logsContent = logs.length ? logs.map(line => {
      const match = line.match(/^\[(.*?)\] (.*)$/);
      if (match) return `\`[${match[1]}]\` ${match[2]}`;
      return line;
    }).join('\n') : '*No logs yet.*';

    const embed = {
      title: '📋 Control Panel — Recent Logs',
      color: 0x9B59B6,
      description:
        `### 📋 Recent Logs (last 25)\n` +
        `${logsContent}`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('dashboard_logs'),
      actionSelectRow([
        { label: 'View Full Logs', value: 'panel_logs', description: 'Show all 25 stored log entries (private)', emoji: { name: '📜' } },
        { label: 'Clear Logs', value: 'panel_clear_logs', description: 'Permanently wipe the log history for this guild', emoji: { name: '🗑️' } }
      ])
    ];

    return { embeds: [embed], components };
  }

  // Dashboard sub-page: Bot Status
  if (page === 'dashboard_bot_status') {
    return await buildBotStatusPayload(env, guildId, 1);
  }

  // Otherwise, default to Dashboard Page (System Status sub-page)
  const latencyKey = guildId ? `last_check_latency:${guildId}` : 'last_check_latency';
  const checkTimeKey = guildId ? `last_check_time:${guildId}` : 'last_check_time';

  const latency = await env.STATUS_KV.get(latencyKey) || 'N/A';
  const lastCheckTime = Number(await env.STATUS_KV.get(checkTimeKey)) || Date.now();

  // Gather extra debug data
  const scraperFailures = Number(await env.STATUS_KV.get('scraper_failures_count') || 0);
  const scraperFailureAlerted = await env.STATUS_KV.get('scraper_failure_alerted') === 'true';
  const activeOverride = await getActiveOverride(env, guildId);
  const lastMessageId = await env.STATUS_KV.get(`last_message_id:${guildId}`);
  const lastChannelId = await env.STATUS_KV.get(`last_channel_id:${guildId}`);
  const rawStats = await env.STATUS_KV.get('status_stats');
  let stats = {};
  try { if (rawStats) stats = JSON.parse(rawStats) || {}; } catch {}
  const scrapesTotal = stats.scrapes_total || 0;
  const scrapesFailed = stats.scrapes_failed || 0;
  const successRate = scrapesTotal > 0 ? ((scrapesTotal - scrapesFailed) / scrapesTotal * 100).toFixed(1) : '100.0';
  const panelMsgId = await env.STATUS_KV.get(`log_panel_message_id:${guildId}`);
  const kvConnected = '`STATUS_KV` (Connected)';

  const overrideStr = activeOverride
    ? `⚠️ **${activeOverride.status_label || activeOverride.status_key}** (expires <t:${Math.floor(activeOverride.until / 1000)}:R>)`
    : '✅ None (Live Scraper Mode)';

  const scraperHealthStr = scraperFailures === 0
    ? '🟢 Healthy'
    : scraperFailures < 3
      ? `🟡 ${scraperFailures} consecutive failure(s)`
      : `🔴 ${scraperFailures} consecutive failures${scraperFailureAlerted ? ' — staff alerted' : ''}`;

  const lastPostStr = lastMessageId && lastChannelId
    ? `[Jump](https://discord.com/channels/${guildId}/${lastChannelId}/${lastMessageId}) in <#${lastChannelId}>`
    : '*(no message posted yet)*';

  // Storm-mode indicator from the cached weather alerts (no NWS call on panel render)
  let stormAlertActive = false;
  try {
    const cachedWeather = await env.STATUS_KV.get('weather_alerts_cache');
    if (cachedWeather) stormAlertActive = hasStormAlert(JSON.parse(cachedWeather));
  } catch {}
  const stormEnabled = config.toggle_storm_mode !== false;
  const inStormWindow = isInStormWindow(getEasternTimeStr(new Date()));
  const stormModeStr = !stormEnabled
    ? '🔴 Disabled (Settings > Feature Toggles)'
    : stormAlertActive
      ? (inStormWindow
        ? '🌨️ **ACTIVE** — checking every 15 min until 7:30 AM ET'
        : '🟡 Armed — storm alert active, extra checks 4:30–7:30 AM ET')
      : '⚪ Standby (no storm alerts)';

  const embed = {
    title: '🏠 Control Panel — Dashboard',
    color: 0x9B59B6,
    description:
      `### 📊 System Status\n` +
      `• **Bot**: 🟢 Online\n` +
      `• **Database**: ${kvConnected}\n` +
      `• **Last Checked**: <t:${Math.floor(lastCheckTime / 1000)}:F> (<t:${Math.floor(lastCheckTime / 1000)}:R>)\n` +
      `• **Scraper Speed**: \`${latency}ms\`\n` +
      `• **Scraper Health**: ${scraperHealthStr}\n` +
      `• **Scraper Success Rate**: \`${successRate}%\` (\`${scrapesTotal - scrapesFailed}/${scrapesTotal}\` checks)\n` +
      `• **Active Override**: ${overrideStr}\n` +
      `• **Storm Mode**: ${stormModeStr}\n` +
      `• **Last Posted Message**: ${lastPostStr}\n` +
      (panelMsgId ? `• **Panel Message ID**: \`${panelMsgId}\`\n` : '') +
      `\n🧭 *Every panel page is in the navigation dropdown below — pick one to jump straight to it.*`,
    timestamp: new Date().toISOString()
  };

  const components = [
    getNavBarRow('dashboard'),
    actionSelectRow([
      { label: 'Run Status Check', value: 'panel_check', description: 'Fetch HCPSS status and post to alert channel', emoji: { name: '🔍' } },
      { label: 'Refresh Panel', value: 'panel_refresh', description: 'Refresh the control panel embed in the log channel', emoji: { name: '🔄' } },
      { label: 'Test Scraper Speed', value: 'panel_speed', description: 'Measure HCPSS page fetch time and response size', emoji: { name: '⚡' } },
      { label: 'View Status History', value: 'panel_history', description: 'Show last 10 operating status changes (private)', emoji: { name: '📜' } },
      { label: 'View Full Logs', value: 'panel_logs', description: 'Show all 25 stored log entries (private)', emoji: { name: '📋' } },
      { label: 'KV Store Diagnostic', value: 'panel_kv_debug', description: 'Dump all KV keys and values for this guild (private)', emoji: { name: '🗄️' } },
      { label: 'Clear All Logs', value: 'panel_clear_logs', description: 'Permanently wipe the log history for this guild', emoji: { name: '🗑️' } }
    ], '⚡ Quick Actions...'),
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: 'panel_trigger_test_alert',
        placeholder: '🧪 Simulate Status Alert...',
        options: [
          { label: 'Normal Operations', value: 'normal_operations', description: 'Simulate a Normal Operations status update' },
          { label: 'Schools Closed', value: 'schools_closed', description: 'Simulate a Schools Closed status update' },
          { label: 'Schools & Offices Closed', value: 'schools_and_offices_closed', description: 'Simulate a Schools & Offices Closed status update' },
          { label: 'Schools Open 2 Hours Late', value: 'schools_open_2_hours_late', description: 'Simulate a 2-Hour Delay status update' },
          { label: 'Schools Close 3 Hours Early', value: 'schools_close_3_hours_early', description: 'Simulate a 3-Hour Early Close status update' },
          { label: 'Other/Unknown Alert', value: 'unknown_alert', description: 'Simulate an Unknown Scraper Alert' }
        ],
        min_values: 1,
        max_values: 1
      }]
    }
  ];

  return { embeds: [embed], components };
}

// Appends a line to the guild's KV log history and refreshes (or re-posts) the
// persistent control panel message in the log channel.
export async function postLog(env, logChannelId, message, stats = {}, guildId = '') {
  const logKey = guildId ? `panel_logs:${guildId}` : 'panel_logs';
  const panelMsgIdKey = guildId ? `log_panel_message_id:${guildId}` : 'log_panel_message_id';
  const latencyKey = guildId ? `last_check_latency:${guildId}` : 'last_check_latency';
  const checkTimeKey = guildId ? `last_check_time:${guildId}` : 'last_check_time';

  // Prepend the new log message to the log history array stored in KV
  let logs = [];
  const rawLogs = await env.STATUS_KV.get(logKey);
  if (rawLogs) {
    try {
      logs = JSON.parse(rawLogs);
    } catch {
      logs = [];
    }
  }

  if (message) {
    const timeStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(new Date());

    logs.unshift(`[${timeStr}] ${message}`);
    logs = logs.slice(0, 25); // keep last 25 logs
    await env.STATUS_KV.put(logKey, JSON.stringify(logs));
  }

  // Record latest latency if provided
  if (typeof stats.latency === 'number') {
    await env.STATUS_KV.put(latencyKey, String(stats.latency));
  }

  const lastCheckTime = Date.now();
  await env.STATUS_KV.put(checkTimeKey, String(lastCheckTime));

  if (!logChannelId) return;
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return;

  const currentPage = await env.STATUS_KV.get(`panel_page:${guildId}`) || 'dashboard';
  if (currentPage !== 'dashboard' && message) {
    // Skip updating the Discord message in background while user is configuring
    return;
  }

  const payload = await buildControlPanelPayload(env, guildId);

  const panelMsgId = await env.STATUS_KV.get(panelMsgIdKey);
  let success = false;

  if (panelMsgId) {
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${logChannelId}/messages/${panelMsgId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      if (resp.ok) {
        success = true;
      }
    } catch {
      // If update fails, we'll post a new one below
    }
  }

  if (!success) {
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${logChannelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      if (resp.ok) {
        const data = await resp.json();
        await env.STATUS_KV.put(panelMsgIdKey, data.id);
      }
    } catch (err) {
      console.error('Failed to post control panel:', err);
    }
  }
}

// Applies a config change from a panel select-menu interaction and saves it.
export async function applyConfigUpdate(body, env) {
  const guildId = body.guild_id || '';
  const current = await getConfig(env, guildId);
  const customId = body.data && body.data.custom_id;
  const values = body.data && body.data.values;

  const next = { ...current };
  if (!next.status_ping_roles) next.status_ping_roles = {};
  if (!next.editing_status_key) next.editing_status_key = 'normal_operations';

  if (customId === 'cfg_channel' && Array.isArray(values) && values[0]) {
    next.alert_channel_id = values[0];
  } else if (customId === 'cfg_log_channel' && Array.isArray(values) && values[0]) {
    next.log_channel_id = values[0];
  } else if (customId === 'cfg_staff_role' && Array.isArray(values) && values[0]) {
    next.staff_role_id = values[0];
  } else if (customId === 'cfg_status_select' && Array.isArray(values) && values[0]) {
    next.editing_status_key = values[0];
  } else if (customId === 'cfg_status_role') {
    const editingKey = next.editing_status_key || 'normal_operations';
    if (Array.isArray(values) && values[0]) {
      next.status_ping_roles[editingKey] = values[0];
    } else {
      next.status_ping_roles[editingKey] = null;
    }
  } else if (customId === 'cfg_schedpick_hour' && Array.isArray(values) && values[0] !== undefined) {
    const pick = next.schedule_pick || {};
    pick.h = parseInt(values[0], 10);
    next.schedule_pick = pick;
  } else if (customId === 'cfg_schedpick_minten' && Array.isArray(values) && values[0] !== undefined) {
    const pick = next.schedule_pick || {};
    pick.mt = parseInt(values[0], 10);
    next.schedule_pick = pick;
  } else if (customId === 'cfg_schedpick_minone' && Array.isArray(values) && values[0] !== undefined) {
    const pick = next.schedule_pick || {};
    pick.mo = parseInt(values[0], 10);
    next.schedule_pick = pick;
  } else if (customId === 'cfg_schedremove_select' && Array.isArray(values) && values[0]) {
    const cur = Array.isArray(next.check_schedule) ? next.check_schedule : [...DEFAULT_CHECK_SCHEDULE];
    next.check_schedule = cur.filter(t => t !== values[0]);
  } else if (customId === 'cfg_toggle_select') {
    // Multi-select: selected values = ON, absent values = OFF
    const selected = Array.isArray(values) ? values : [];
    next.toggle_pings = selected.includes('toggle_pings');
    next.toggle_error_alerts = selected.includes('toggle_error_alerts');
    next.toggle_weather = selected.includes('toggle_weather');
    next.toggle_storm_mode = selected.includes('toggle_storm_mode');
    next.toggle_districts = selected.includes('toggle_districts');
    next.toggle_outlook = selected.includes('toggle_outlook');
    next.toggle_crosscheck = selected.includes('toggle_crosscheck');
    next.toggle_digest = selected.includes('toggle_digest');
  } else if (customId === 'cfg_override_status_select' && Array.isArray(values) && values[0]) {
    next.editing_override_status_key = values[0];
  }

  await setConfig(env, guildId, next);
  return next;
}
