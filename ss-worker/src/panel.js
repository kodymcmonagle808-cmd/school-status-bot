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
import { hasStormAlert, getCachedWeatherAlerts } from './weather.js';
import { PRIMARY_DISTRICT_CHOICES } from './districts.js';
import { getStatusHistory, computeIncidentStats, schoolYearLabel } from './history.js';
import { getConfig, setConfig, getEffectiveConfig, getActiveOverride } from './config.js';
import { listCalendarEvents } from './calendar.js';
import { getWatcherErrors, formatWatcherErrors } from './watcherhealth.js';
import { getBlockedGuilds } from './blocklist.js';
import { logAction } from './actionlog.js';
import { discordFetch } from './discord.js';
import { KV_FREE_LIMITS, getKvUsage } from './kvanalytics.js';
import { getD1Stats, buildD1Section, getEmailStats } from './db.js';

// NWS alert categories for ping-role routing. Order matches the check
// order in alertCategory(): specific hazards win over the generic storm
// bucket, and minimal-severity events route to 'minimal'.
export const NWS_PING_CATEGORIES = [
  { key: 'tornado', label: 'Tornado', hint: 'Tornado watch/warning' },
  { key: 'flood', label: 'Flood', hint: 'Flood/flash flood watch/warning' },
  { key: 'winter', label: 'Winter', hint: 'Snow/ice/cold watch/warning/advisory' },
  { key: 'heat', label: 'Heat', hint: 'Heat advisory/warning' },
  { key: 'storm', label: 'Storm', hint: 'Thunderstorm/wind/hurricane' },
  { key: 'minimal', label: 'Minimal', hint: 'Minor-severity advisories' },
  { key: 'default', label: 'Default', hint: 'Everything else' }
];

const BAR_SEGMENTS = 20;

// How many stored lines the Recent Logs page shows, and the ceiling their block
// is allowed to occupy.
//
// Both numbers exist because this page had neither. It joined all 25 stored
// lines into one description; a week of `✅ HCPSS status check posted … [Jump to
// Message](…)` entries runs ~200 characters each, so the description measured
// 4,949 against Discord's 4,096 limit. Discord rejects the whole interaction
// response with a 400, which surfaces to the user as "the application did not
// respond" — a size overflow that looks exactly like a dead Worker. Clamp
// anything built from stored lines, and leave room for the surrounding copy.
export const PANEL_LOG_DISPLAY_LINES = 12;
const PANEL_LOG_BLOCK_LIMIT = 3400;

// Formats stored `[time] message` lines for an embed description, hard-capped
// on both count and characters. Exported for tests.
export function renderPanelLogLines(logs, { maxLines = PANEL_LOG_DISPLAY_LINES, maxChars = PANEL_LOG_BLOCK_LIMIT } = {}) {
  const stored = Array.isArray(logs) ? logs : [];
  if (!stored.length) return '*Nothing recorded yet.*';

  const lines = stored.slice(0, maxLines).map(line => {
    const match = String(line).match(/^\[(.*?)\] (.*)$/);
    return match ? `\`[${match[1]}]\` ${match[2]}` : String(line);
  });

  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (!kept.length) return '*Log lines too long to display — see the System Logs page.*';
  // Count against everything stored, not just the slice: lines dropped by the
  // line cap are as hidden as lines dropped by the character cap.
  const hidden = stored.length - kept.length;
  if (hidden > 0) kept.push(`*…${hidden} older line(s) — see the System Logs page.*`);
  return kept.join('\n');
}

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
  { label: 'Manual School Status', value: 'config_manual_status', emoji: '🏫', description: 'Set school operations and notes' },
  { label: 'Recent Logs', value: 'dashboard_logs', emoji: '📋', description: 'Recent bot activity logs' },
  { label: 'Bot Health', value: 'dashboard_bot_status', emoji: '📡', description: 'Ping, uptime, and health metric bars' },
  { label: 'Settings', value: 'config_general', emoji: '⚙️', description: 'Channels, staff role, and embed footer' },
  { label: 'Music Settings', value: 'config_music', emoji: '🎵', description: 'Configure music channel and controls' },
  { label: 'Check Schedule', value: 'config_schedule', emoji: '🗓️', description: 'Daily status check times' },
  { label: 'Feature Toggles', value: 'config_toggles', emoji: '🔔', description: 'Turn bot features on or off' },
  { label: 'Status Theme', value: 'config_status', emoji: '🎨', description: 'Embed colors and ping roles per status' },
  { label: 'Calendar', value: 'config_calendar', emoji: '📅', description: 'Upcoming closures and custom events' },
  { label: 'Stats & Override', value: 'config_stats', emoji: '📈', description: 'Check statistics and status overrides' },
  { label: 'Auto-Reply', value: 'config_autoreply', emoji: '💬', description: 'Keyword-triggered auto replies' },
  { label: 'Command List', value: 'config_commands', emoji: '📜', description: 'List of available slash commands' },
  { label: 'NWS Ping Roles', value: 'config_nws_pings', emoji: '⚠️', description: 'Roles pinged for winter/heat/default weather alerts' },
  { label: 'Join Logs', value: 'config_joinlogs', emoji: '👋', description: 'Join channel, ping role, give and remove roles' },
  { label: 'Announcement Requests', value: 'config_announcementrequests', emoji: '📝', description: 'Set the channel where announcement requests are posted' },
  { label: 'School Emails', value: 'config_emails', emoji: '📧', description: 'Recent HCPSS announcement emails and channel settings' },
  { label: 'Analytics & Trends', value: 'config_analytics', emoji: '📊', description: 'School closure trends, email volume, and database analytics' },
  { label: 'Debug', value: 'config_debug', emoji: '🛠️', description: 'Run bot diagnostics, voice tests, and system tests' }
];

export const MAIN_GUILD_KEY = 'main_guild_id';
export const NORMAL_DISABLED_PANEL_TABS_KEY = 'disabled_panel_tabs_normal';

export const TOGGLEABLE_PANEL_TABS = [
  { value: 'config_music', label: 'Music Settings', emoji: '🎵', description: 'Music channel and VC voice controls' },
  { value: 'config_joinlogs', label: 'Join Logs & Roles', emoji: '👋', description: 'Join channel, ping role, auto-roles' },
  { value: 'config_announcementrequests', label: 'Announcement Requests', emoji: '📝', description: 'Student announcement approval queue' },
  { value: 'config_autoreply', label: 'Keyword Auto-Reply', emoji: '💬', description: 'Triggered automated responses' },
  { value: 'config_emails', label: 'School Emails', emoji: '📧', description: 'HCPSS announcement emails & channel' },
  { value: 'config_analytics', label: 'Analytics & Trends', emoji: '📊', description: 'School closure charts & database trends' },
  { value: 'config_calendar', label: 'Calendar Events', emoji: '📅', description: 'Closures and custom school events' },
  { value: 'config_nws_pings', label: 'NWS Ping Roles', emoji: '⚠️', description: 'Per-hazard weather alert ping routing' },
  { value: 'config_status', label: 'Status Theme & Pings', emoji: '🎨', description: 'Custom embed colors and pings per status' },
  { value: 'config_schedule', label: 'Check Schedule', emoji: '🗓️', description: 'Daily check times & recurring slots' },
  { value: 'config_stats', label: 'Stats & Override', emoji: '📈', description: 'Status overrides and scrape statistics' },
  { value: 'config_manual_status', label: 'Manual School Status', emoji: '🏫', description: 'Set manual operations and custom notes' },
  { value: 'config_debug', label: 'Debug & Diagnostics', emoji: '🛠️', description: 'Staff test suite and diagnostics' },
  { value: 'dashboard_logs', label: 'Recent Logs', emoji: '📋', description: 'Recent activity logs tab' },
  { value: 'dashboard_bot_status', label: 'Bot Health Bars', emoji: '📡', description: 'Latency, uptime, and health bars' },
  { value: 'config_commands', label: 'Command Permissions List', emoji: '📜', description: 'List of slash commands and permissions' },
  { value: 'config_toggles', label: 'Feature Toggles Tab', emoji: '🔔', description: 'Turn alerts and automations on/off' },
  { value: 'config_general', label: 'General Settings', emoji: '⚙️', description: 'Alert channels and authorized staff roles' }
];

export async function getMainGuildId(env) {
  try {
    const fromKv = await env?.STATUS_KV?.get(MAIN_GUILD_KEY);
    if (fromKv && fromKv.trim()) return fromKv.trim();
  } catch {}
  return (env?.DISCORD_GUILD_ID && String(env.DISCORD_GUILD_ID).trim()) || null;
}

export async function setMainGuildId(env, guildId) {
  if (!env?.STATUS_KV) return;
  if (guildId) {
    await env.STATUS_KV.put(MAIN_GUILD_KEY, String(guildId).trim());
  } else {
    await env.STATUS_KV.delete(MAIN_GUILD_KEY);
  }
}

export async function isMainGuild(env, guildId) {
  if (!guildId) return false;
  const mainId = await getMainGuildId(env);
  return Boolean(mainId && String(guildId).trim() === String(mainId).trim());
}

export async function getDisabledPanelTabs(env, targetScope = 'normal') {
  if (targetScope && targetScope !== 'normal' && await isMainGuild(env, targetScope)) {
    return [];
  }
  if (targetScope && targetScope !== 'normal') {
    try {
      const perGuild = await env?.STATUS_KV?.get(`disabled_panel_tabs:${targetScope}`);
      if (perGuild) {
        const parsed = JSON.parse(perGuild);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
  }
  try {
    const raw = await env?.STATUS_KV?.get(NORMAL_DISABLED_PANEL_TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

export async function setDisabledPanelTabs(env, target = 'normal', disabledList = []) {
  if (!env?.STATUS_KV) return;
  const key = target === 'normal' ? NORMAL_DISABLED_PANEL_TABS_KEY : `disabled_panel_tabs:${target}`;
  await env.STATUS_KV.put(key, JSON.stringify(disabledList));
}

export async function applyPanelDefaultsToAllServers(env, disabledList = null) {
  let list = disabledList;
  if (list === null) {
    list = await getDisabledPanelTabs(env, 'normal');
  }
  await setDisabledPanelTabs(env, 'normal', list);

  const allIds = await getAllKnownGuildIds(env);
  const mainGuildId = await getMainGuildId(env);
  let updatedCount = 0;

  for (const gid of allIds) {
    if (gid && gid !== mainGuildId) {
      await setDisabledPanelTabs(env, gid, list);
      updatedCount++;
    }
  }
  return updatedCount;
}

export async function savePanelDefaultsForNewServers(env, disabledList) {
  await setDisabledPanelTabs(env, 'normal', disabledList);
  return disabledList.length;
}

function getNavTabForPage(page) {
  if (page === 'config_override_select' || page === 'config_manual_status') return 'config_manual_status';
  if (page === 'config_schedule_add') return 'config_schedule';
  if (page === 'config_debug') return 'config_debug';
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

export const STAFF_DEBUG_OPTIONS = [
  { label: 'Test Status Voice Announcement', value: 'panel_btn_debug_test_voice', description: 'Speak HCPSS status 3x in active VCs (no beeps)', emoji: { name: '🎙️' } },
  { label: 'Test Emergency Voice Alert', value: 'panel_btn_debug_test_weather_voice', description: 'Speak NWS Tornado Warning with EAS emergency beeps 3x', emoji: { name: '🌪️' } },
  { label: 'Run Health Canary', value: 'panel_btn_debug_canary', description: 'Test live response of HCPSS, NWS, and KV feeds', emoji: { name: '⚡' } },
  { label: 'Test Cloudflare R2 Backup', value: 'panel_btn_debug_backup', description: 'Trigger immediate KV snapshot to R2 bucket', emoji: { name: '💾' } },
  { label: 'Simulate Status Alert (No Pings)', value: 'panel_btn_debug_simulate_status', description: 'Post test status embed (zero pings sent)', emoji: { name: '📣' } },
  { label: 'Simulate Weather Alert (No Pings)', value: 'panel_btn_debug_simulate_weather', description: 'Post test NWS alert embed (zero pings sent)', emoji: { name: '⚠️' } }
];

export const OWNER_DEBUG_OPTIONS = [
  { label: 'Manage Server Panel Tabs', value: 'panel_owner_features_manage', description: 'Turn control panel tabs on/off for normal servers', emoji: { name: '🎛️' } },
  { label: 'Apply Panel Defaults to All Servers', value: 'panel_owner_apply_defaults_all', description: 'Sync normal panel settings across all existing servers', emoji: { name: '⚡' } },
  { label: 'Apply Panel Defaults to All New Servers', value: 'panel_owner_save_defaults_new', description: 'Lock in current settings as default for any new server', emoji: { name: '🌐' } },
  { label: 'KV Store Diagnostic', value: 'panel_kv_debug', description: 'Dump all KV keys and values for this guild', emoji: { name: '🗄️' } },
  { label: 'Purge Caches', value: 'panel_btn_debug_purge_cache', description: 'Clear weather, outage, and scraper KV caches', emoji: { name: '🧹' } },
  { label: 'View Raw Config', value: 'panel_btn_debug_raw_config', description: 'Dump complete JSON config for this guild', emoji: { name: '📄' } },
  { label: 'View KV Analytics', value: 'panel_owner_view_kv_stats', description: 'Inspect Cloudflare KV daily operation budget', emoji: { name: '📊' } },
  { label: 'Open System Logs', value: 'panel_logs', description: 'Mint signed link to Cloudflare Observability logs', emoji: { name: '📜' } }
];

// Combined for backward compat (used by debugSelectRow and owner panel)
export const DEBUG_DROPDOWN_OPTIONS = [...STAFF_DEBUG_OPTIONS, ...OWNER_DEBUG_OPTIONS];

export function debugSelectRow(options = DEBUG_DROPDOWN_OPTIONS, placeholder = '🛠️ Debug & Diagnostics...', disabled = false) {
  return {
    type: 1,
    components: [{
      type: 3,
      custom_id: 'panel_debug_select',
      placeholder,
      options,
      min_values: 1,
      max_values: 1,
      ...(disabled ? { disabled: true } : {})
    }]
  };
}

export function getNavBarRow(activeTab, disabledTabs = []) {
  const activeValue = getNavTabForPage(activeTab);
  const disabled = Array.isArray(disabledTabs) ? disabledTabs : [];
  const visibleTabs = PANEL_NAV_TABS.filter(tab => !disabled.includes(tab.value));
  const effectiveActive = visibleTabs.some(t => t.value === activeValue) ? activeValue : 'dashboard';

  return {
    type: 1,
    components: [{
      type: 3,
      custom_id: 'panel_nav_select',
      placeholder: '🧭 Go to panel page...',
      options: visibleTabs.map(tab => ({
        label: tab.label,
        value: tab.value,
        description: tab.description,
        emoji: { name: tab.emoji },
        default: tab.value === effectiveActive
      })),
      min_values: 1,
      max_values: 1
    }]
  };
}

export async function buildBotStatusPayload(env, guildId, fraction = 1) {
  const latencyKey = guildId ? `last_check_latency:${guildId}` : 'last_check_latency';
  const checkTimeKey = guildId ? `last_check_time:${guildId}` : 'last_check_time';

  // These four keys are independent — read them in one round trip so a
  // slow-KV moment doesn't stack four latencies before the panel renders.
  const [latencyRaw, checkTimeRaw, rawStats, failuresRaw] = await Promise.all([
    env.STATUS_KV.get(latencyKey),
    env.STATUS_KV.get(checkTimeKey),
    env.STATUS_KV.get('status_stats'),
    env.STATUS_KV.get('scraper_failures_count')
  ]);
  const latencyMs = latencyRaw ? Number(latencyRaw) : null;
  const lastCheckTime = Number(checkTimeRaw) || Date.now();

  let stats = {};
  try { if (rawStats) stats = JSON.parse(rawStats) || {}; } catch {}
  const scrapesTotal = stats.scrapes_total || 0;
  const scrapesFailed = stats.scrapes_failed || 0;
  const successRate = scrapesTotal > 0 ? ((scrapesTotal - scrapesFailed) / scrapesTotal * 100) : 100;
  const scraperFailures = Number(failuresRaw || 0);

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

  const isMain = await isMainGuild(env, guildId);
  const disabledTabs = isMain ? [] : await getDisabledPanelTabs(env, guildId);
  const panelPrefix = isMain ? 'CHS CONTROLS' : 'Control Panel';

  const embed = {
    title: `📡 ${panelPrefix} — Bot Health`,
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
    footer: { text: isMain ? 'CHS CONTROLS · Bot Status' : 'School Status · Bot Status  •  ■ = filled  · space = empty' }
  };

  const components = [
    getNavBarRow('dashboard_bot_status', disabledTabs),
    actionSelectRow([
      { label: 'Refresh Metrics', value: 'panel_to_dashboard_bot_status', description: 'Re-measure and animate the health bars', emoji: { name: '🔄' } },
      { label: 'View Recent Logs', value: 'panel_to_dashboard_logs', description: 'Switch to the recent activity logs page', emoji: { name: '📋' } }
    ], '⚡ Actions...', !isFinal)
  ];

  return { embeds: [embed], components };
}

// Format deploy entries for the owner updates page. Supports both Cloudflare
// Deployments (Workers Builds) and legacy worker_updates KV entries.
export function formatWorkerUpdates(list, isCloudflare = false) {
  const entries = Array.isArray(list) ? list.filter(e => e && e.sha).slice(0, 15) : [];
  if (entries.length === 0) {
    if (isCloudflare) {
      return '⚡ Active via **Cloudflare Workers Builds** (connected to GitHub `main`).\nCommits pushed to `main` automatically build and deploy live.';
    }
    return 'No worker updates recorded yet. Each deploy to `main` will appear here.';
  }
  return entries.map(e => {
    const when = Number(e.ts) > 0 ? `<t:${Math.floor(Number(e.ts) / 1000)}:f>` : 'unknown time';
    const tag = e.rollback ? ' ↩️ rollback' : '';
    const trigger = e.trigger ? ` · via \`${e.trigger}\`` : (e.isCloudflare ? ' · via `Cloudflare Builds`' : '');
    const note = e.message ? `\n> 💬 *${String(e.message).slice(0, 70)}*` : '';
    return e.ok
      ? `✅ \`${e.sha}\` — deployed ${when}${trigger}${tag}${note}`
      : `❌ \`${e.sha}\` — **failed** ${when}${trigger}${tag}${note} (previous version still running)`;
  }).join('\n');
}

// Queries Cloudflare REST API for live Worker deployments (Workers Builds)
export async function fetchCloudflareDeployments(env) {
  const token = env?.CF_API_TOKEN;
  const account = env?.CF_ACCOUNT_ID;
  const service = env?.WORKER_SERVICE_NAME || 'ss-worker';
  if (!token || !account) {
    return null;
  }

  const cacheKey = 'cf_deployments_cache';
  try {
    const cached = await env.STATUS_KV?.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {}

  try {
    let resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${service}/deployments`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (resp.status === 404) {
      resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/services/${service}/environments/production/deployments`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
    }
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json || json.success === false) return null;

    const list = Array.isArray(json.result)
      ? json.result
      : (Array.isArray(json.result?.deployments) ? json.result.deployments : []);

    const deployments = list.map(d => {
      const createdOn = d.created_on || d.created_at || '';
      const ts = createdOn ? new Date(createdOn).getTime() : 0;
      const msg = d.annotations?.['workers/message'] || d.annotations?.message || '';
      const trigger = d.annotations?.['workers/triggered_by'] || d.annotations?.triggered_by || 'Cloudflare';
      const versionId = d.versions?.[0]?.version_id || d.id || '';
      const rawId = (versionId || d.id || '').replace(/-/g, '');
      const sha = rawId.slice(0, 7);
      return {
        sha,
        id: d.id,
        ok: true,
        ts,
        message: msg,
        trigger,
        author: d.author_email || '',
        isCloudflare: true
      };
    }).filter(d => d.sha);

    if (deployments.length > 0) {
      if (env.STATUS_KV?.put) {
        await env.STATUS_KV.put(cacheKey, JSON.stringify(deployments), { expirationTtl: 120 }).catch(() => {});
      }
      return deployments;
    }
  } catch (e) {
    console.error('Failed to fetch Cloudflare deployments:', e);
  }
  return null;
}

// Owner-only operational stats shown under the deploy list. Pure so tests can
// exercise the drift warning and rate math without KV.
export function buildOwnerStatsFields({ runningSha, updates, guildCount, scrapesTotal, scrapesFailed, consecutiveFailures, lastCheckTime, lastCheckLatencyMs }) {
  const entries = Array.isArray(updates) ? updates.filter(e => e && e.sha) : [];
  const okCount = entries.filter(e => e.ok).length;
  const shortRunning = runningSha ? String(runningSha).slice(0, 7) : '';

  let versionValue = shortRunning ? `\`${shortRunning}\`` : '(unknown)';
  const latestOk = entries.find(e => e.ok);
  if (shortRunning && latestOk && latestOk.sha !== shortRunning) {
    versionValue += `\n⚠️ latest deploy is \`${latestOk.sha}\``;
  }

  const total = Number(scrapesTotal) || 0;
  const failed = Number(scrapesFailed) || 0;
  const rate = total > 0 ? ((total - failed) / total * 100).toFixed(1) : '100.0';

  const checkValue = Number(lastCheckTime) > 0
    ? `<t:${Math.floor(Number(lastCheckTime) / 1000)}:R>` +
      (Number(lastCheckLatencyMs) > 0 ? ` · ${Math.round(Number(lastCheckLatencyMs))} ms` : '')
    : '(none yet)';

  return [
    { name: '🏷️ Running version', value: versionValue, inline: true },
    { name: '🚀 Deploys recorded', value: entries.length ? `${okCount}/${entries.length} succeeded` : '(none yet)', inline: true },
    { name: '🌐 Servers', value: String(Number(guildCount) || 0), inline: true },
    { name: '🔍 Scrapes (all-time)', value: total ? `${total} total · ${failed} failed · ${rate}% ok` : '(none yet)', inline: true },
    { name: '📉 Consecutive scrape failures', value: String(Number(consecutiveFailures) || 0), inline: true },
    { name: '⏱️ Last check', value: checkValue, inline: true }
  ];
}

function commas(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// The Cloudflare quota resets at 00:00 UTC; render that instant in Eastern
// time (8:00 PM EDT / 7:00 PM EST) so it reads like the rest of the bot.
// DST is handled by Intl, so this is correct year-round.
function easternResetLabel(now) {
  const d = new Date(now);
  const nextUtcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(nextUtcMidnight);
}

// Owner-only KV free-plan budget bars for the Worker Updates page. `usage`
// comes from getKvUsage (Cloudflare analytics): either counts, a not-configured
// state, or an error. Pure so tests can pin the thresholds and the states.
export function buildKvUsageSection(usage, now = Date.now()) {
  if (!usage || usage.configured === false) {
    const reason = usage && usage.reason ? ` ${usage.reason}` : '';
    return `KV usage gauge not configured —${reason}\n> Reads Cloudflare's analytics; costs no KV writes.`;
  }
  if (usage.error) {
    return `⚠️ KV analytics unavailable: ${usage.error}`;
  }

  const val = k => Number(usage[k]) || 0;
  const rows = [
    ['✍️', 'Writes', val('writes'), KV_FREE_LIMITS.writes],
    ['🗑️', 'Deletes', val('deletes'), KV_FREE_LIMITS.deletes],
    ['📖', 'Reads', val('reads'), KV_FREE_LIMITS.reads],
    ['📃', 'Lists', val('lists'), KV_FREE_LIMITS.lists]
  ];
  const lines = rows.map(([emoji, label, used, limit]) => {
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    const dot = pct >= 90 ? '🔴' : pct >= 70 ? '🟡' : '🟢';
    const pctStr = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1);
    return `${dot} ${emoji} **${label}** — ${commas(used)} / ${commas(limit)} · ${pctStr}%\n` +
      barFromFilled(filledCount(used, limit));
  });

  const writePct = KV_FREE_LIMITS.writes > 0 ? (val('writes') / KV_FREE_LIMITS.writes) * 100 : 0;
  const header = `Free-plan budget used today (resets ${easternResetLabel(now)}):`;
  const warn = writePct >= 90
    ? '\n⚠️ **Write budget nearly exhausted** — further writes may start failing.'
    : writePct >= 70
      ? '\n🟡 Write budget running high — watch it on a busy storm day.'
      : '';
  const note = '\n> Source: Cloudflare analytics · today (UTC).';

  return `${header}\n${lines.join('\n')}${warn}${note}`;
}

// Server list line rendering, pure for tests. blockedIds: string array.
export function buildServerLines(servers, blockedIds, homeGuildId) {
  const list = Array.isArray(servers) ? servers : [];
  if (!list.length) return '(none)';
  const blocked = Array.isArray(blockedIds) ? blockedIds : [];
  return list.slice(0, 15).map(s => {
    const home = homeGuildId && s.id === homeGuildId ? ' 🏠' : '';
    return blocked.includes(s.id)
      ? `🔒 **${s.name}** · \`${s.id}\`${home} — locked down`
      : `🟢 **${s.name}** · \`${s.id}\`${home}`;
  }).join('\n');
}

// Resolves guild names via the Discord API with a 1h KV cache so the owner
// page renders inside the interaction deadline.
export async function getAllKnownGuildIds(env) {
  let indexIds = [];
  try {
    const rawIndex = await env?.STATUS_KV?.get('guild_index');
    const index = rawIndex ? JSON.parse(rawIndex) : [];
    if (Array.isArray(index)) indexIds = index.filter(Boolean);
  } catch {}

  let blockedIds = [];
  try { blockedIds = await getBlockedGuilds(env); } catch {}

  const mainGuildId = await getMainGuildId(env);

  return [...new Set([
    ...indexIds,
    ...blockedIds,
    ...(env?.DISCORD_GUILD_ID ? [env.DISCORD_GUILD_ID] : []),
    ...(mainGuildId ? [mainGuildId] : [])
  ])];
}

export async function fetchGuildSummaries(env, guildIds) {
  let cache = {};
  try {
    const raw = await env.STATUS_KV.get('guild_names_cache');
    if (raw) cache = JSON.parse(raw) || {};
  } catch {}

  const out = [];
  let cacheDirty = false;
  for (const gid of guildIds) {
    let name = cache[gid];
    if (!name) {
      try {
        const r = await discordFetch(`https://discord.com/api/v10/guilds/${gid}`, {
          headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
        });
        if (r.ok) {
          const g = await r.json();
          if (g && g.name) {
            name = g.name;
            cache[gid] = name;
            cacheDirty = true;
          }
        }
      } catch {}
    }
    out.push({ id: gid, name: name || '(name unavailable)' });
  }
  if (cacheDirty) {
    await env.STATUS_KV.put('guild_names_cache', JSON.stringify(cache), { expirationTtl: 3600 }).catch(() => {});
  }
  return out;
}

export async function buildWorkerUpdatesPayload(env) {
  let updates = [];
  try {
    const raw = await env.STATUS_KV.get('worker_updates');
    if (raw) updates = JSON.parse(raw);
  } catch {}

  // Every read degrades independently — this page must render even if a key
  // is missing or corrupt.
  let guildCount = 0;
  let indexIds = [];
  try {
    const rawIndex = await env.STATUS_KV.get('guild_index');
    const index = rawIndex ? JSON.parse(rawIndex) : [];
    if (Array.isArray(index)) {
      indexIds = index.filter(Boolean);
      guildCount = indexIds.length;
    }
  } catch {}

  // Blocked guilds are removed from the index, so the full server list is
  // index ∪ blocklist ∪ home guild.
  let blockedIds = [];
  try { blockedIds = await getBlockedGuilds(env); } catch {}
  const allIds = await getAllKnownGuildIds(env);
  let servers = allIds.map(id => ({ id, name: '(name unavailable)' }));
  try { servers = await fetchGuildSummaries(env, allIds); } catch {}

  const mainGuildId = await getMainGuildId(env);
  const disabledNormal = await getDisabledPanelTabs(env, 'normal');
  const mainServerObj = servers.find(s => s.id === mainGuildId);
  const mainServerDisplay = mainServerObj
    ? `⭐ **${mainServerObj.name}** (\`${mainGuildId}\`)`
    : (mainGuildId ? `⭐ Guild ID \`${mainGuildId}\`` : '*(none set — select below)*');

  const disabledDesc = disabledNormal.length > 0
    ? `**${disabledNormal.length} tabs hidden** (${disabledNormal.map(t => {
        const match = TOGGLEABLE_PANEL_TABS.find(x => x.value === t);
        return match ? match.label : t;
      }).join(', ')})`
    : 'All tabs visible';

  let stats = {};
  try {
    const rawStats = await env.STATUS_KV.get('status_stats');
    if (rawStats) stats = JSON.parse(rawStats) || {};
  } catch {}

  let consecutiveFailures = 0;
  let lastCheckTime = 0;
  let lastCheckLatencyMs = 0;
  try {
    consecutiveFailures = Number(await env.STATUS_KV.get('scraper_failures_count')) || 0;
    // Checks are recorded per guild (`last_check_time:${guildId}`); the old
    // global key stopped updating when checks went multi-server, so the
    // fleet-wide "last check" is the newest per-guild timestamp.
    const perGuild = await Promise.all(indexIds.map(async gid => ({
      gid,
      ts: Number(await env.STATUS_KV.get(`last_check_time:${gid}`)) || 0
    })));
    let newestGuild = '';
    for (const { gid, ts } of perGuild) {
      if (ts > lastCheckTime) {
        lastCheckTime = ts;
        newestGuild = gid;
      }
    }
    if (newestGuild) {
      lastCheckLatencyMs = Number(await env.STATUS_KV.get(`last_check_latency:${newestGuild}`)) || 0;
    }
  } catch {}

  const [watcherErrors, kvUsage, d1Stats, cfDeployments] = await Promise.all([
    getWatcherErrors(env).catch(() => []),
    getKvUsage(env).catch(() => null),
    env.DB ? getD1Stats(env.DB).catch(() => null) : Promise.resolve(null),
    fetchCloudflareDeployments(env).catch(() => null)
  ]);

  const vectorStatus = env.VECTORIZE ? '🟢 **Active** (`school-status-index` · 384d)' : '⚪ **Standby Mode**';
  const queueStatus = env.ALERT_QUEUE ? '🟢 **Active** (`ss-alerts-queue` · Decoupled)' : '⚪ **Standby Mode**';
  const browserStatus = env.BROWSER ? '🟢 **Active** (Live status screenshots)' : '⚪ **Standby Mode**';
  const analyticsStatus = env.ANALYTICS ? '🟢 **Active** (`school_status_analytics`)' : '⚪ **Standby Mode**';
  const aiGwStatus = env.AI_GATEWAY_ID ? `🟢 **Active** (\`${env.AI_GATEWAY_ID}\`)` : '⚪ **Standby Mode**';
  const r2Status = env.BACKUPS_BUCKET ? '🟢 **Active** (`ss-backups`)' : '⚪ **Standby Mode**';
  const aiStatus = env.AI ? '🟢 **Active** (Llama 3.1 & BGE)' : '⚪ **Standby Mode**';

  const cfServicesField = {
    name: '⚡ Cloudflare Free Services',
    value: `• **Browser Rendering**: ${browserStatus}\n` +
           `• **Analytics Engine**: ${analyticsStatus}\n` +
           `• **AI Gateway**: ${aiGwStatus}\n` +
           `• **Vectorize**: ${vectorStatus}\n` +
           `• **Queues**: ${queueStatus}\n` +
           `• **R2 Backups**: ${r2Status}\n` +
           `• **Workers AI**: ${aiStatus}`,
    inline: false
  };

  const storageFields = d1Stats
    ? [
        { name: '🗄️ Primary Database: Cloudflare D1', value: buildD1Section(d1Stats, kvUsage), inline: false },
        cfServicesField,
        { name: '💾 Legacy KV (Standby Fallback)', value: '🟢 **Standby Mode** — Legacy KV fallback ready; 0 writes needed.', inline: false }
      ]
    : [
        { name: '💾 KV usage (free plan)', value: buildKvUsageSection(kvUsage), inline: false },
        cfServicesField
      ];

  const activeUpdates = (cfDeployments && cfDeployments.length) ? cfDeployments : updates;
  const isCf = Boolean(cfDeployments && cfDeployments.length) || Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID);
  const sectionHeading = isCf ? '### ⛅ Cloudflare Deployments (Workers Builds)' : '### Recent deploys to `main`';

  const embed = {
    title: '🚀 Control Panel — Worker Updates',
    color: 0x9B59B6,
    description: `${sectionHeading}\n${formatWorkerUpdates(activeUpdates, isCf)}`,
    fields: buildOwnerStatsFields({
      runningSha: env.GIT_SHA || (activeUpdates?.[0]?.sha || ''),
      updates: activeUpdates,
      guildCount,
      scrapesTotal: stats.scrapes_total,
      scrapesFailed: stats.scrapes_failed,
      consecutiveFailures,
      lastCheckTime,
      lastCheckLatencyMs
    }).concat([
      ...storageFields,
      {
        name: '🏫 CHS Main Server & Server Panel Settings',
        value: `• **CHS Main Server**: ${mainServerDisplay}\n` +
               `• **CHS Panel**: Runs full **CHS CONTROLS** (all 19 tabs active)\n` +
               `• **Normal Servers**: Standard Control Panel (${disabledDesc})\n` +
               `• **Default for New Servers**: ${disabledNormal.length > 0 ? `${disabledNormal.length} tabs hidden by default` : 'All tabs enabled by default'}\n` +
               `*Set your CHS Main Server below, or click **Panel Tabs** to manage defaults.*`,
        inline: false
      },
      { name: '🩺 Watcher errors', value: formatWatcherErrors(watcherErrors), inline: false },
      { name: '🌐 Servers', value: buildServerLines(servers, blockedIds, env.DISCORD_GUILD_ID || ''), inline: false }
    ]),
    timestamp: new Date().toISOString(),
    footer: { text: 'School Status · Worker Updates  •  visible to the bot owner only' }
  };

  const components = [];

  // Lock/unlock select: every server except the home guild (several cron
  // paths force-include it, so blocking it would half-work at best).
  const lockable = servers.filter(s => s.id !== env.DISCORD_GUILD_ID && s.id !== mainGuildId).slice(0, 25);
  if (lockable.length) {
    components.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: 'panel_owner_lock_select',
        placeholder: '🔐 Lock down / unlock a server...',
        options: lockable.map(s => ({
          label: s.name.slice(0, 100),
          value: s.id,
          description: blockedIds.includes(s.id) ? 'Locked — select to unlock' : 'Select to lock down (no posts, no commands)',
          emoji: { name: blockedIds.includes(s.id) ? '🔒' : '🟢' }
        })),
        min_values: 1,
        max_values: 1
      }]
    });
  }

  // Set CHS Main Server dropdown
  const selectableServers = servers.slice(0, 25);
  if (selectableServers.length) {
    components.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: 'panel_owner_set_main_server',
        placeholder: '🏫 Set CHS Main Server (for CHS CONTROLS)...',
        options: selectableServers.map(s => ({
          label: s.name.slice(0, 100),
          value: s.id,
          description: s.id === mainGuildId ? '⭐ Currently set as CHS Main Server' : 'Set as CHS Main Server',
          emoji: { name: s.id === mainGuildId ? '⭐' : '🏫' },
          default: s.id === mainGuildId
        })),
        min_values: 1,
        max_values: 1
      }]
    });
  }

  const permServers = servers.slice(0, 25);
  if (permServers.length) {
    components.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: 'panel_owner_perms_select',
        placeholder: '⚙️ Manage Command Permissions...',
        options: permServers.map(s => ({
          label: s.name.slice(0, 100),
          value: s.id,
          description: 'View all commands & configure Staff vs Everyone',
          emoji: { name: '⚙️' }
        })),
        min_values: 1,
        max_values: 1
      }]
    });
  }

  // Owner debug & diagnostics dropdown — full suite including owner tools
  components.push(debugSelectRow(DEBUG_DROPDOWN_OPTIONS, '🛠️ Owner Diagnostics & Test Suite...'));

  // Owner action buttons (max 5 per row)
  components.push({
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        custom_id: 'panel_owner_refresh',
        label: 'Refresh Owner Panel',
        emoji: { name: '🔄' }
      },
      {
        type: 2,
        style: 1,
        custom_id: 'panel_owner_features_manage',
        label: 'Panel Tabs',
        emoji: { name: '🎛️' }
      },
      {
        type: 2,
        style: 2,
        custom_id: 'panel_owner_backup_d1',
        label: 'Backup DB',
        emoji: { name: '💾' }
      },
      {
        type: 2,
        style: 4,
        custom_id: 'panel_owner_force_check_all',
        label: 'Force Check All',
        emoji: { name: '⚡' }
      },
      {
        type: 2,
        style: 2,
        custom_id: 'panel_owner_view_kv_stats',
        label: 'KV Analytics',
        emoji: { name: '📊' }
      }
    ]
  });

  // Keep within Discord's 5 action rows ceiling
  if (components.length > 5) {
    components.length = 5;
  }

  return { embeds: [embed], components };
}

export async function buildOwnerFeaturesPayload(env, targetScope = 'normal', servers = []) {
  const isNormalDefault = targetScope === 'normal';
  const mainGuildId = await getMainGuildId(env);
  const disabledTabs = await getDisabledPanelTabs(env, targetScope);

  const targetName = isNormalDefault
    ? 'All Normal Servers (Global Default)'
    : (servers.find(s => s.id === targetScope)?.name || `Server ${targetScope}`);

  const isTargetMain = Boolean(mainGuildId && targetScope === mainGuildId);

  const enabledTabs = TOGGLEABLE_PANEL_TABS.filter(t => !disabledTabs.includes(t.value));
  const disabledList = TOGGLEABLE_PANEL_TABS.filter(t => disabledTabs.includes(t.value));

  const mainNotice = isTargetMain
    ? '\n\n⭐ **Notice**: This server is designated as the **CHS Main Server**! It always runs **CHS CONTROLS** with all 19 tabs active.'
    : '';

  const embed = {
    title: `🎛️ Server Control Panel Features — ${targetName}`,
    color: 0x9B59B6,
    description: `### 🏫 Main Server vs Normal Servers\n` +
      `• **CHS Main Server**: Uses **CHS CONTROLS** with all features permanently enabled.\n` +
      `• **Normal Servers**: Only display tabs that are marked 🟢 **ENABLED** below. Features marked 🔴 **DISABLED** are completely hidden from their control panel navigation.${mainNotice}\n\n` +
      `### 🟢 Enabled Features (${enabledTabs.length})\n` +
      (enabledTabs.length ? enabledTabs.map(t => `${t.emoji} **${t.label}**`).join(' · ') : '*(none)*') +
      `\n\n### 🔴 Disabled / Hidden Features (${disabledList.length})\n` +
      (disabledList.length ? disabledList.map(t => `${t.emoji} **${t.label}**`).join(' · ') : '*(none — all features visible)*') +
      `\n\n*Select any feature tab from the dropdown below to toggle it **Enabled ↔ Disabled**.*`,
    footer: { text: 'Owner Panel · Control Panel Feature Manager' },
    timestamp: new Date().toISOString()
  };

  const components = [
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: `cfg_owner_toggle_panel_feature:${targetScope}`,
        placeholder: '⚡ Select a feature to toggle Enabled ↔ Disabled...',
        options: TOGGLEABLE_PANEL_TABS.map(t => {
          const isDisabled = disabledTabs.includes(t.value);
          return {
            label: t.label,
            value: t.value,
            description: isDisabled ? 'Currently: DISABLED (hidden) — click to ENABLE' : 'Currently: ENABLED (visible) — click to DISABLE',
            emoji: { name: isDisabled ? '🔴' : '🟢' }
          };
        }),
        min_values: 1,
        max_values: 1
      }]
    }
  ];

  if (Array.isArray(servers) && servers.length > 0) {
    const scopeOptions = [
      {
        label: '🌐 Normal Servers (Global Default)',
        value: 'normal',
        description: 'Set default enabled/disabled tabs for all non-main servers',
        emoji: { name: '🌐' },
        default: isNormalDefault
      },
      ...servers.slice(0, 24).map(s => ({
        label: s.name.slice(0, 100),
        value: s.id,
        description: s.id === mainGuildId ? '⭐ CHS Main Server (Always full features)' : `Customize tabs for ${s.name.slice(0, 40)}`,
        emoji: { name: s.id === mainGuildId ? '⭐' : '🏫' },
        default: targetScope === s.id
      }))
    ];

    components.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: 'cfg_owner_features_scope_select',
        placeholder: '🌐 Change Server / Scope...',
        options: scopeOptions,
        min_values: 1,
        max_values: 1
      }]
    });
  }

  components.push({
    type: 1,
    components: [
      {
        type: 2,
        style: 3,
        custom_id: `cfg_owner_features_enable_all:${targetScope}`,
        label: 'Enable All Tabs',
        emoji: { name: '🟢' }
      },
      {
        type: 2,
        style: 4,
        custom_id: `cfg_owner_features_disable_extras:${targetScope}`,
        label: 'Disable Extra Features',
        emoji: { name: '🔴' }
      },
      {
        type: 2,
        style: 1,
        custom_id: `cfg_owner_features_refresh:${targetScope}`,
        label: 'Refresh',
        emoji: { name: '🔄' }
      },
      {
        type: 2,
        style: 2,
        custom_id: 'panel_owner_return',
        label: 'Back to Owner Panel',
        emoji: { name: '⬅️' }
      }
    ]
  });

  components.push({
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        custom_id: `cfg_owner_features_save_new_default:${targetScope}`,
        label: 'Apply to All New Servers as Default',
        emoji: { name: '🌐' }
      },
      {
        type: 2,
        style: 4,
        custom_id: `cfg_owner_features_apply_all_existing:${targetScope}`,
        label: 'Apply to All Servers as Default',
        emoji: { name: '⚡' }
      }
    ]
  });

  return { embeds: [embed], components };
}

export async function buildControlPanelPayload(env, guildId, configOverride = null, pageOverride = null) {
  // configOverride/pageOverride let callers that just wrote to KV render with the
  // fresh values — KV does not guarantee read-your-own-writes, so re-reading here
  // right after a save can return stale cached data for up to 60 seconds.
  const stored = configOverride || await getConfig(env, guildId);
  const config = getEffectiveConfig(stored);
  const isMain = await isMainGuild(env, guildId);
  const disabledTabs = isMain ? [] : await getDisabledPanelTabs(env, guildId);
  const panelPrefix = isMain ? 'CHS CONTROLS' : 'Control Panel';

  let page = pageOverride || await env.STATUS_KV.get(`panel_page:${guildId}`) || 'dashboard';
  let disabledNotice = '';

  if (!isMain && disabledTabs.includes(page)) {
    page = 'dashboard';
    disabledNotice = '⚠️ **Notice**: That control panel section has been disabled for this server by the bot administrator.\n\n';
  }

  if (page === 'config_general') {
    const channel = config.alert_channel_id ? `<#${config.alert_channel_id}>` : '(not set)';
    const logChannel = config.log_channel_id ? `<#${config.log_channel_id}>` : '(not set)';
    const staffRoles = (Array.isArray(config.staff_role_ids) && config.staff_role_ids.length > 0)
      ? config.staff_role_ids.map(id => `<@&${id}>`).join(', ')
      : (config.staff_role_id ? `<@&${config.staff_role_id}>` : '(not set)');
    const embedFooter = config.alert_embed_footer || '(default)';

    const embed = {
      title: `⚙️ ${panelPrefix} — Settings`,
      color: 0x3498DB,
      description: `### 🔧 Server Settings\n` +
                   `• **Alerts Destination**: ${channel}\n` +
                   `• **System Logs Destination**: ${logChannel}\n` +
                   `• **Authorized Staff Roles**: ${staffRoles}\n` +
                   `• **Alert Embed Footer**: \`${embedFooter}\`\n\n` +
                   `*Pick a channel or staff role(s) below to change it — saves instantly.*\n` +
                   `*Check times and feature toggles have their own pages in the 🧭 navigation menu.*`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_general', disabledTabs),
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
          placeholder: 'Select staff role(s)',
          min_values: 1,
          max_values: 10
        }]
      },
      actionSelectRow([
        { label: 'Set Embed Footer Text', value: 'panel_btn_set_footer', description: 'Customize the footer shown on status embeds', emoji: { name: '✍️' } }
      ])
    ];

    return { embeds: [embed], components };
  }


  if (page === 'config_autoreply') {
    const rules = Array.isArray(config.keyword_rules) ? config.keyword_rules : [];
    const ruleLines = rules.length
      ? rules.map((r, i) => {
          const ch = r.channel_id ? `<#${r.channel_id}>` : '(no channel)';
          const kws = Array.isArray(r.keywords) && r.keywords.length ? r.keywords.map(k => `\`${k}\``).join(', ') : '(none)';
          const resp = r.response ? `→ ${r.response.length > 120 ? r.response.slice(0, 117) + '…' : r.response}` : '';
          return `**${i + 1}.** ${ch}\n   • **Keywords:** ${kws}\n   • **Reply:** ${resp}`;
        }).join('\n')
      : '*No auto-reply rules yet. Add one below.*';

    const embed = {
      title: `💬 ${panelPrefix} — Keyword Auto-Reply`,
      color: 0x9B59B6,
      description: `### 💬 Keyword Auto-Reply\n` +
                   `When a user sends one of a rule's keywords **in that rule's channel**, the bot replies with the rule's message and auto-deletes it after a few seconds.\n\n` +
                   `${ruleLines}\n\n` +
                   `*Use **Add Auto-Reply Rule** to set a channel, its keywords (comma-separated), and the reply. Use the remove menu to delete a rule.*`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_autoreply', disabledTabs),
      actionSelectRow([
        { label: 'Add Auto-Reply Rule', value: 'panel_btn_add_keyword', description: 'Pick a channel, keywords, and reply message', emoji: { name: '➕' } },
        ...(rules.length
          ? [{ label: 'Remove Auto-Reply Rule', value: 'panel_btn_remove_keyword', description: 'Choose a rule to delete', emoji: { name: '🗑️' } }]
          : [])
      ])
    ];

    // A remove menu appears only once there is at least one rule to remove.
    if (rules.length) {
      components.push({
        type: 1,
        components: [{
          type: 3,
          custom_id: 'cfg_keyword_remove_select',
          placeholder: '🗑️ Select a rule to remove...',
          options: rules.slice(0, 25).map((r, i) => ({
            label: `#${i + 1} ${(Array.isArray(r.keywords) && r.keywords[0]) || 'rule'}`.slice(0, 100),
            value: String(i),
            description: r.channel_id ? `Channel ${r.channel_id}` : 'No channel',
            emoji: { name: '🗑️' }
          })),
          min_values: 1,
          max_values: 1
        }]
      });
    }

    return { embeds: [embed], components };
  }


  if (page === 'config_music') {
    const channel = config.music_channel_id ? `<#${config.music_channel_id}>` : '(not set)';
    const role = config.music_role_id ? `<@&${config.music_role_id}>` : '(not set)';
    const vcChannel = config.music_vc_id ? `<#${config.music_vc_id}>` : 'All Voice Channels';

    const embed = {
      title: `🎵 ${panelPrefix} — Music Settings`,
      color: 0x1DB954,
      description: `### 🎵 Music Settings\n` +
                   `• **Music Channel**: ${channel}\n` +
                   `• **Required Role for Song Button**: ${role}\n` +
                   `• **Voice Channel to Join**: ${vcChannel}\n\n` +
                   `*Select a channel and role below to configure where the music controls will be sent and who can use the Song button.*\n` +
                   `*If a Voice Channel is selected, the bot will only join that specific VC.*\n\n` +
                   `*Click **Send Music Panel** below to post the interactive control buttons (Join, Song, Normal Play) to the chosen Music Channel.*`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_music', disabledTabs),
      {
        type: 1,
        components: [{
          type: 8,
          custom_id: 'cfg_music_channel',
          placeholder: 'Select text channel for Music Panel',
          min_values: 1,
          max_values: 1,
          channel_types: [0, 5]
        }]
      },
      {
        type: 1,
        components: [{
          type: 6,
          custom_id: 'cfg_music_role',
          placeholder: 'Select required role for Song button',
          min_values: 1,
          max_values: 1
        }]
      },
      {
        type: 1,
        components: [{
          type: 8,
          custom_id: 'cfg_music_vc',
          placeholder: 'Select Voice Channel to join (or clear for All)',
          min_values: 0,
          max_values: 1,
          channel_types: [2] // Voice channels
        }]
      },
      actionSelectRow([
        { label: 'Set 24/7 Playlist URL', value: 'panel_btn_set_playlist', description: 'Set the Spotify/YouTube URL for the 24/7 stream', emoji: { name: '🎧' } },
        { label: 'Send Music Panel', value: 'panel_btn_send_music', description: 'Send the music control panel to the selected channel', emoji: { name: '📤' } }
      ])
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_toggles') {
    const pings = config.toggle_pings !== false;
    const errorAlerts = config.toggle_error_alerts !== false;
    const weather = config.toggle_weather !== false;
    const stormMode = config.toggle_storm_mode !== false;
    const decisionWatch = config.toggle_decision_watch !== false;
    const districts = config.toggle_districts !== false;
    const outlook = config.toggle_outlook !== false;
    const crosscheck = config.toggle_crosscheck !== false;
    const digest = config.toggle_digest === true; // opt-in, off by default
    const headsUp = config.toggle_heads_up !== false;
    const busAlerts = config.toggle_bus_alerts !== false;
    const activityAlerts = config.toggle_activity_alerts !== false;
    const schoolNotices = config.toggle_school_notices !== false;
    const outages = config.toggle_outages !== false;
    const roads = config.toggle_roads !== false;
    const yearRecap = config.toggle_year_recap !== false;
    const aqiAlerts = config.toggle_aqi_alerts !== false;
    const nwsAlerts = config.toggle_nws_alerts !== false;
    const emergencyAlerts = config.toggle_emergency_alerts !== false;
    const emergencyPing = config.toggle_emergency_ping !== false;
    const sessionGate = config.toggle_session_gate !== false;
    const voiceAnnounce = config.toggle_voice_announcements === true;
    const abDay = config.toggle_ab_day !== false;
    const primaryDistrict = config.primary_district || 'hcpss';
    const primaryChoice = PRIMARY_DISTRICT_CHOICES.find(c => c.id === primaryDistrict) || PRIMARY_DISTRICT_CHOICES[0];

    const embed = {
      title: `🔔 ${panelPrefix} — Feature Toggles`,
      color: 0x3498DB,
      description: `### 🚨 Feature Toggles\n` +
                   `Select which features are **enabled** from the dropdown. Deselected options are automatically **disabled**.\n\n` +
                   `• ${pings ? '🟢' : '🔴'} **Role Mentions** — ping roles on status changes\n` +
                   `• ${errorAlerts ? '🟢' : '🔴'} **Scraper Failure Alerts** — warn staff on consecutive scraper errors\n` +
                   `• ${weather ? '🟢' : '🔴'} **Weather Alerts** — show active NWS alerts for Howard County on status embeds\n` +
                   `• ${abDay ? '🟢' : '🔴'} **A/B Day** — show the A/B day schedule for high schools on status embeds\n` +
                   `• ${stormMode ? '🟢' : '🔴'} **Storm Mode** — extra checks every 15 min (4:30–7:30 AM ET) during storm alerts, posting only on changes\n` +
                   `• ${decisionWatch ? '🟢' : '🔴'} **Decision Watch** — live board of every district's morning announcements on storm mornings\n` +
                   `• ${districts ? '🟢' : '🔴'} **Nearby Districts** — show neighboring districts' status on embeds during storm alerts\n` +
                   `• ${outlook ? '🟢' : '🔴'} **Closure Outlook** — estimate closing/delay likelihood during storm alerts\n` +
                   `• ${crosscheck ? '🟢' : '🔴'} **Source Cross-Check** — warn when HCPSS News disagrees with the status page\n` +
                   `• ${digest ? '🟢' : '🔴'} **Morning Digest** — daily 6:00 AM ET summary post (status, calendar, weather)\n` +
                   `• ${headsUp ? '🟢' : '🔴'} **Night-Before Heads-Up** — 7:00 PM ET alert when the Closure Outlook hits High/Very High\n` +
                   `• ${busAlerts ? '🟢' : '🔴'} **Bus & Transportation Alerts** — post HCPSS News transportation service alerts\n` +
                   `• ${activityAlerts ? '🟢' : '🔴'} **Activities & Athletics Alerts** — post after-school/athletics cancellations (no pings)\n` +
                   `• ${schoolNotices ? '🟢' : '🔴'} **School-Specific Notices** — post single-school announcements (no pings)\n` +
                   `• ${outages ? '🟢' : '🔴'} **Power Outages** — show BGE county outage counts during storm alerts\n` +
                   `• ${roads ? '🟢' : '🔴'} **Road Conditions** — show MD CHART road incidents during storm alerts\n` +
                   `• ${yearRecap ? '🟢' : '🔴'} **Year Recap** — end-of-school-year summary post each June\n` +
                   `• ${aqiAlerts ? '🟢' : '🔴'} **Air Quality Alerts** — post when the AQI hits Code Orange or worse\n` +
                   `• ${nwsAlerts ? '🟢' : '🔴'} **NWS Issuance Notices** — post when a winter/heat watch, warning, or advisory is issued\n` +
                   `• ${emergencyAlerts ? '🟢' : '🔴'} **Emergency Alerts** — a big yellow take-shelter post for the alerts NWS pushes to phones (tornado warning, destructive winds), any hour\n` +
                   `• ${emergencyPing ? '🟢' : '🔴'} **Emergency @everyone Ping** — let those emergency alerts ping @everyone (needs the bot to have *Mention Everyone*)\n` +
                   `• ${sessionGate ? '🟢' : '🔴'} **Skip Non-School Days** — hold storm alerts on weekends, breaks, and holidays\n` +
                   `• ${voiceAnnounce ? '🟢' : '🔴'} **Voice Announcements** — join active voice channels and announce status & weather updates 3x\n\n` +
                   `🏫 **Primary District**: ${primaryChoice.name} — the district this server's status posts follow\n\n` +
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
        label: 'A/B Day',
        value: 'toggle_ab_day',
        description: 'Show the A/B day schedule for high schools',
        emoji: { name: '📅' },
        default: abDay
      },
      {
        label: 'Storm Mode',
        value: 'toggle_storm_mode',
        description: 'Extra early-morning checks during storm alerts, post on change only',
        emoji: { name: '🌨️' },
        default: stormMode
      },
      {
        label: 'Decision Watch',
        value: 'toggle_decision_watch',
        description: 'Live morning announcement board on storm mornings (no pings)',
        emoji: { name: '🌅' },
        default: decisionWatch
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
      },
      {
        label: 'Night-Before Heads-Up',
        value: 'toggle_heads_up',
        description: '7:00 PM ET alert when a closing/delay looks likely tomorrow',
        emoji: { name: '🌙' },
        default: headsUp
      },
      {
        label: 'Bus & Transportation Alerts',
        value: 'toggle_bus_alerts',
        description: 'Post transportation service alerts from HCPSS News',
        emoji: { name: '🚌' },
        default: busAlerts
      },
      {
        label: 'Activities & Athletics Alerts',
        value: 'toggle_activity_alerts',
        description: 'Post after-school/athletics cancellations from HCPSS News (no pings)',
        emoji: { name: '🏟️' },
        default: activityAlerts
      },
      {
        label: 'School-Specific Notices',
        value: 'toggle_school_notices',
        description: 'Post single-school announcements from HCPSS News (no pings)',
        emoji: { name: '🏫' },
        default: schoolNotices
      },
      {
        label: 'Power Outages',
        value: 'toggle_outages',
        description: 'Show BGE county outage counts during storm alerts',
        emoji: { name: '🔌' },
        default: outages
      },
      {
        label: 'Road Conditions',
        value: 'toggle_roads',
        description: 'Show MD CHART road incidents during storm alerts',
        emoji: { name: '🛣️' },
        default: roads
      },
      {
        label: 'Year Recap',
        value: 'toggle_year_recap',
        description: 'Post an end-of-school-year summary each June',
        emoji: { name: '🎓' },
        default: yearRecap
      },
      {
        label: 'Air Quality Alerts',
        value: 'toggle_aqi_alerts',
        description: 'Post when the AQI reaches Code Orange or worse (no pings)',
        emoji: { name: '😷' },
        default: aqiAlerts
      },
      {
        label: 'NWS Issuance Notices',
        value: 'toggle_nws_alerts',
        description: 'Post when a school-impacting NWS alert is issued (no pings)',
        emoji: { name: '⚠️' },
        default: nwsAlerts
      },
      {
        label: 'Emergency Alerts',
        value: 'toggle_emergency_alerts',
        description: 'The alerts that set off phone Emergency Alerts — tornado, destructive winds',
        emoji: { name: '🚨' },
        default: emergencyAlerts
      },
      {
        label: 'Emergency @everyone Ping',
        value: 'toggle_emergency_ping',
        description: 'Let emergency alerts ping @everyone (needs Mention Everyone)',
        emoji: { name: '📣' },
        default: emergencyPing
      },
      {
        label: 'Skip Non-School Days',
        value: 'toggle_session_gate',
        description: 'Hold storm alerts on weekends, breaks, and holidays',
        emoji: { name: '📆' },
        default: sessionGate
      },
      {
        label: 'Voice Channel Announcements',
        value: 'toggle_voice_announcements',
        description: 'Speak status & weather updates 3x in active voice channels',
        emoji: { name: '🎙️' },
        default: voiceAnnounce
      }
    ];

    const components = [
      getNavBarRow('config_toggles', disabledTabs),
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
      },
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'cfg_primary_district',
          placeholder: '🏫 Primary district for status posts...',
          options: PRIMARY_DISTRICT_CHOICES.map(c => ({
            label: c.name,
            value: c.id,
            description: c.id === 'hcpss'
              ? 'Default — full HCPSS status page scraper'
              : "Follow this district's own announcements",
            emoji: { name: c.id === 'hcpss' ? '🏠' : '🏫' },
            default: primaryDistrict === c.id
          })),
          min_values: 1,
          max_values: 1
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
      title: `🎨 ${panelPrefix} — Status Theme`,
      color: 0xE74C3C,
      description: `### 🔔 Roles & Embed Themes\n` +
                   `Select a status from the dropdown to edit its **mention role** and **embed color**.\n\n` +
                   `**Current Mapping:**\n${statusPings}\n\n` +
                   `👉 *Currently editing: **${editingLabel}***`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_status', disabledTabs),
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

  if (page === 'config_nws_pings') {
    const rawPing = config.ping_role_ids;
    const pingRoles = Array.isArray(rawPing) ? { default: rawPing } : (rawPing || {});
    const editingPingCat = NWS_PING_CATEGORIES.some(c => c.key === config.editing_nws_ping_key)
      ? config.editing_nws_ping_key
      : 'default';
    const found = NWS_PING_CATEGORIES.find(c => c.key === editingPingCat);
    const editingPingLabel = found ? found.label : 'Default';

    const pingLines = NWS_PING_CATEGORIES.map(c => {
      const ids = Array.isArray(pingRoles[c.key]) ? pingRoles[c.key] : [];
      const display = ids.length ? ids.map(r => '<@&' + r + '>').join(', ') : '(none)';
      const marker = c.key === editingPingCat ? '-> ' : '- ';
      return marker + '**' + c.label + '** (' + c.hint + '): ' + display;
    }).join('\n');

    const embed = {
      title: `${panelPrefix} - NWS Ping Roles`,
      color: 0xF39C12,
      description: '### NWS Alert Ping Roles\n' +
                   'Choose which Discord roles get pinged when NWS alerts are issued.\n\n' +
                   '**Current Mapping:**\n' + pingLines + '\n\n' +
                   '-> *Currently editing: **' + editingPingLabel + '***\n' +
                   '*Pick a category, then pick its role below. Leave blank for none. Changes save instantly.*',
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_nws_pings', disabledTabs),
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'cfg_nws_ping_select',
          placeholder: 'Editing category: ' + editingPingLabel,
          options: NWS_PING_CATEGORIES.map(c => ({
            label: c.label,
            value: c.key,
            description: c.hint,
            default: c.key === editingPingCat
          })),
          min_values: 1,
          max_values: 1
        }]
      },
      {
        type: 1,
        components: [{
          type: 6,
          custom_id: 'cfg_nws_ping_role',
          placeholder: 'Select ping role for ' + editingPingLabel,
          min_values: 0,
          max_values: 1
        }]
      }
    ];

    return { embeds: [embed], components };
  }
  if (page === 'config_joinlogs') {
    let joinlogs = null;
    try {
      const raw = await env.STATUS_KV.get(`joinlogs_config:${guildId}`);
      if (raw) joinlogs = JSON.parse(raw);
    } catch {}
    const jlChannel = joinlogs && joinlogs.channel ? `<#${joinlogs.channel}>` : '(not set)';
    const jlPing = joinlogs && joinlogs.pingRole ? `<@&${joinlogs.pingRole}>` : '(not set)';
    const jlGive = joinlogs && joinlogs.giveRole ? `<@&${joinlogs.giveRole}>` : '(not set)';
    const jlRemove = joinlogs && joinlogs.removeRole ? `<@&${joinlogs.removeRole}>` : '(none)';

    const embed = {
      title: `${panelPrefix} - Join Logs`,
      color: 0x57F287,
      description: '### Join Logs & Verification\n' +
                   'When a user joins, the bot posts a card in the join channel and pings staff. ' +
                   'When staff approves their info, the bot gives the member role and removes the unverified role.\n\n' +
                   '- **Join Channel**: ' + jlChannel + '\n' +
                   '- **Staff Ping Role**: ' + jlPing + '\n' +
                   '- **Role to Give**: ' + jlGive + '\n' +
                   '- **Role to Remove**: ' + jlRemove + '\n\n' +
                   '*Pick below to change a setting - saves instantly.*',
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_joinlogs', disabledTabs),
      {
        type: 1,
        components: [{
          type: 8,
          custom_id: 'cfg_joinlogs_channel',
          placeholder: 'Select join logs channel',
          min_values: 1,
          max_values: 1,
          channel_types: [0, 5]
        }]
      },
      {
        type: 1,
        components: [{
          type: 6,
          custom_id: 'cfg_joinlogs_ping',
          placeholder: 'Select staff ping role',
          min_values: 1,
          max_values: 1
        }]
      },
      {
        type: 1,
        components: [{
          type: 6,
          custom_id: 'cfg_joinlogs_give',
          placeholder: 'Select role to give on approve',
          min_values: 1,
          max_values: 1
        }]
      },
      {
        type: 1,
        components: [{
          type: 6,
          custom_id: 'cfg_joinlogs_remove',
          placeholder: 'Select role to remove on approve (none to clear)',
          min_values: 0,
          max_values: 1
        }]
      }
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_announcementrequests') {
    const reqChannel = config.announcement_request_channel_id
      ? `<#${config.announcement_request_channel_id}>`
      : '(not set)';

    const embed = {
      title: `${panelPrefix} - Announcement Requests`,
      color: 0xF1C40F,
      description: '### Announcement Requests\n' +
                   'Members can submit announcement requests via `/requestannouncement`. ' +
                   'Each request is posted to the channel below so staff can review and act on it.\n\n' +
                   '- **Request Channel**: ' + reqChannel + '\n\n' +
                   '*Pick a channel below to set where requests are posted - saves instantly.*',
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_announcementrequests', disabledTabs),
      {
        type: 1,
        components: [{
          type: 8,
          custom_id: 'cfg_announcement_request_channel',
          placeholder: 'Select announcement request channel',
          min_values: 1,
          max_values: 1,
          channel_types: [0, 5]
        }]
      }
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_emails') {
    const emailChannel = config.email_channel_id
      ? `<#${config.email_channel_id}>`
      : (config.alert_channel_id ? `<#${config.alert_channel_id}> *(default alerts channel)*` : '*(not set)*');
    const toggleEmails = config.toggle_email_alerts !== false;
    const toggleAi = config.toggle_ai_summary !== false;

    let emailLogs = [];
    try {
      const raw = await env.STATUS_KV.get(`email_logs:${guildId}`);
      if (raw) emailLogs = JSON.parse(raw);
    } catch {}

    let emailLines = '*No announcement emails recorded yet.*';
    if (Array.isArray(emailLogs) && emailLogs.length > 0) {
      emailLines = emailLogs.map((e, idx) => {
        const timeStr = e.ts ? `<t:${Math.floor(e.ts / 1000)}:R>` : '';
        const jump = (e.channelId && e.messageId)
          ? `[Jump to Announcement](https://discord.com/channels/${guildId}/${e.channelId}/${e.messageId})`
          : (e.channelId ? `in <#${e.channelId}>` : '');
        const titleText = e.url ? `[${e.subject || 'Announcement'}](${e.url})` : (e.subject || 'Announcement');
        return `> **${idx + 1}. ${titleText}**\n> ${timeStr} · ${jump}`;
      }).slice(0, 8).join('\n\n');
    }

    const embed = {
      title: `📧 ${panelPrefix} — School Announcement Emails`,
      color: 0x3498DB,
      description: '### 📬 HCPSS & Centennial Email Settings\n' +
                   `• **Email Channel**: ${emailChannel}\n` +
                   `• **Email Alerts**: ${toggleEmails ? '🟢 Enabled' : '🔴 Disabled'}\n` +
                   `• **AI Summaries**: ${toggleAi ? '🟢 Enabled' : '🔴 Disabled'}\n\n` +
                   `### 📋 Recent Email Announcements\n${emailLines}\n\n` +
                   '*Pick a channel below to set where announcement emails are posted.*',
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_emails', disabledTabs),
      {
        type: 1,
        components: [{
          type: 8,
          custom_id: 'cfg_email_channel',
          placeholder: 'Select announcement email channel',
          min_values: 1,
          max_values: 1,
          channel_types: [0, 5]
        }]
      },
      actionSelectRow([
        {
          label: toggleEmails ? 'Disable Email Alerts' : 'Enable Email Alerts',
          value: 'panel_toggle_email_alerts',
          description: toggleEmails ? 'Turn off automatic school email announcements' : 'Turn on automatic school email announcements',
          emoji: { name: toggleEmails ? '🔕' : '🔔' }
        },
        {
          label: toggleAi ? 'Disable AI Summaries' : 'Enable AI Summaries',
          value: 'panel_toggle_ai_summary',
          description: toggleAi ? 'Do not generate AI summaries for emails' : 'Generate 2-3 bullet point AI summaries for emails',
          emoji: { name: '🤖' }
        },
        {
          label: 'Clear Channel Override',
          value: 'panel_clear_email_channel',
          description: 'Revert to using the main alerts channel',
          emoji: { name: '↩️' }
        }
      ])
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_analytics') {
    let incidentStats = { totalIncidents: 0, byStatus: {}, lastIncident: null };
    let syLabel = 'Current Year';
    try {
      const hist = await getStatusHistory(env, config.primary_district);
      incidentStats = computeIncidentStats(hist);
      syLabel = schoolYearLabel();
    } catch {}

    let emailStats = { total: 0, past7Days: 0, past30Days: 0 };
    if (env.DB) {
      try {
        emailStats = await getEmailStats(env.DB, guildId);
      } catch {}
    }

    const closureCount = (incidentStats.byStatus?.schools_closed || 0) + (incidentStats.byStatus?.schools_and_offices_closed || 0);
    const delayCount = incidentStats.byStatus?.schools_open_2_hours_late || 0;
    const earlyCount = incidentStats.byStatus?.schools_close_3_hours_early || 0;

    const embed = {
      title: `📊 ${panelPrefix} — Analytics & Trends`,
      color: 0x9B59B6,
      description: `### 📈 School Impact Trends (${syLabel})\n` +
                   `• **Total Weather / Emergency Incidents**: **${incidentStats.totalIncidents}**\n` +
                   `> 🔴 **Full Closures:** ${closureCount} day(s)\n` +
                   `> 🟠 **2-Hour Delays:** ${delayCount} day(s)\n` +
                   `> 🟡 **Early Dismissals:** ${earlyCount} day(s)\n\n` +
                   `### 📧 Announcement Email Volume\n` +
                   `• **Total Archived Announcements:** ${emailStats.total}\n` +
                   `• **Past 7 Days:** ${emailStats.past7Days} email(s)\n` +
                   `• **Past 30 Days:** ${emailStats.past30Days} email(s)\n\n` +
                   `### ⚡ Cloudflare Free Tier Architecture\n` +
                   `• **Database (D1 SQLite):** 100,000 writes/day · 5M reads/day · 5 GB\n` +
                   `• **Vector Search (Vectorize):** 30,000 queries/month · 384d semantic search\n` +
                   `• **Message Queue (Queues):** 1,000,000 ops/month · decoupled alert delivery\n` +
                   `• **Object Storage (R2):** 10 GB free snapshots · $0 egress fees`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_analytics', disabledTabs),
      actionSelectRow([
        {
          label: 'Refresh Analytics',
          value: 'panel_to_config_analytics',
          description: 'Re-query latest incident and email metrics',
          emoji: { name: '🔄' }
        }
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
      title: `🗓️ ${panelPrefix} — Check Schedule`,
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
      getNavBarRow('config_schedule', disabledTabs),
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
      title: `🗓️ ${panelPrefix} — Add Check Time`,
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
      title: `📅 ${panelPrefix} — Calendar`,
      color: 0xE67E22,
      description: `### 🗓️ Upcoming Closures (Next 7 Days)\n` +
                   `${calendarList}` +
                   customSection + `\n\n` +
                   `*Use the actions dropdown below to add or remove this server's custom events.*`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_calendar', disabledTabs),
      actionSelectRow([
        { label: 'Add Event', value: 'panel_btn_add_event', description: 'Add a closure or custom event for a date', emoji: { name: '➕' } },
        { label: 'Remove Event', value: 'panel_btn_remove_event', description: 'Remove a custom event by date', emoji: { name: '➖' } }
      ])
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_commands') {
    const staffRoles = (Array.isArray(config.staff_role_ids) && config.staff_role_ids.length > 0)
      ? config.staff_role_ids.map(id => `<@&${id}>`).join(', ')
      : (config.staff_role_id ? `<@&${config.staff_role_id}>` : '*(none — Administrators only)*');

    const embed = {
      title: `📜 ${panelPrefix} — Command Permissions & Roles`,
      color: 0x1ABC9C,
      description: `### 🛡️ Authorized Staff Roles\n` +
                   `• **Staff Roles**: ${staffRoles}\n\n` +
                   `*Members with these roles (plus Administrators) can run all staff commands and control panel actions.*\n` +
                   `*Select roles below to add or update authorized staff roles.*` +
                   `\n\n### 🤖 Staff-Only Commands\n` +
                   `• \`/post-status\`, \`/override\`, \`/manualstatus\`, \`/events\`, \`/announce\`, \`/refresh-panel\`, \`/setup\`, \`/setupjoinlogs\`, \`/emailchannel\`, \`/districtchannel\`, \`/backup-db\`, \`/health\`, \`/addroledm\`\n\n` +
                   `### 🌐 Everyone Commands\n` +
                   `• \`/status\`, \`/snowday\`, \`/calendar\`, \`/history\`, \`/districts\`, \`/outages\`, \`/stats\`, \`/notify\`, \`/myschool\`, \`/setupclasses\`, \`/mapmyclass\`, \`/requestannouncement\`, \`/searchemails\`, \`/widget\`, \`/help\`\n\n` +
                   `💡 **Making Staff Commands visible in Discord's \`/\` menu:**\n` +
                   `Discord automatically hides staff commands from non-administrators. To make them visible to your staff roles in Discord:\n` +
                   `1. Go to **Server Settings ➔ Integrations**\n` +
                   `2. Click **Centennial School & Status** ➔ **Manage**\n` +
                   `3. Under **Command Permissions**, add your staff role(s) to allow access!`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_commands', disabledTabs),
      {
        type: 1,
        components: [{
          type: 6,
          custom_id: 'cfg_staff_role',
          placeholder: 'Select authorized staff role(s)...',
          min_values: 1,
          max_values: 10
        }]
      }
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
      getNavBarRow('config_stats', disabledTabs)
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
        { label: 'Set Manual School Status', value: 'panel_to_config_manual_status', description: 'Force a specific status & notes for 1-30 days', emoji: { name: '🏫' } }
      ]));
    }

    const embed = {
      title: `📈 ${panelPrefix} — Stats & Override`,
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

  if (page === 'config_manual_status') {
    const activeOverride = await getActiveOverride(env, guildId);
    const editingKey = config.editing_override_status_key || (activeOverride ? activeOverride.status_key : 'normal_operations');
    const editingLabel = STATUS_LABELS[editingKey] || 'Normal Operations';

    let currentStatusInfo = '';
    const actionOptions = [];

    if (activeOverride) {
      const durationHours = Math.max(0, Math.ceil((activeOverride.until - Date.now()) / (1000 * 60 * 60)));
      const days = Math.ceil(durationHours / 24);
      const forcedLabel = ALL_STATUS_LABELS[activeOverride.status_key] || activeOverride.status_label || editingLabel;
      currentStatusInfo = `### ⚠️ **Manual School Status is ACTIVE**\n` +
                          `• **Operation**: \`${forcedLabel}\`\n` +
                          `• **Notes / Details**: *${activeOverride.details || 'None provided.'}*\n` +
                          `• **Custom Headline**: *${activeOverride.title || 'None.'}*\n` +
                          `• **Time Remaining**: \`${days} day(s)\` (~${durationHours} hours)\n` +
                          (activeOverride.created_by ? `• **Set By**: <@${activeOverride.created_by}>\n` : '');

      actionOptions.push({
        label: 'Disable Manual Status',
        value: 'panel_btn_clear_override',
        description: 'Return to live scraper mode immediately',
        emoji: { name: '🛑' }
      });
    } else {
      currentStatusInfo = `### 🟢 **Live Scraper Mode Active**\n` +
                          `*No manual status is currently active. The bot is automatically scraping and posting the live status from the district website.*`;
    }

    actionOptions.push({
      label: 'Set Notes & Apply Manual Status...',
      value: 'panel_btn_override_details',
      description: `Enter notes and duration for "${editingLabel}"`,
      emoji: { name: '✍️' }
    });

    actionOptions.push({
      label: 'Publish Status Embed to Alert Channel',
      value: 'panel_btn_force_post',
      description: 'Post the current status to the alert channel now',
      emoji: { name: '🔄' }
    });

    const embed = {
      title: `🏫 ${panelPrefix} — Manual School Status`,
      color: activeOverride ? 0xF1C40F : 0x3498DB,
      description: `Manually set your school district's operating status and announcement notes (e.g. for snow days, emergency closures, or delays).\n\n` +
                   `${currentStatusInfo}\n\n` +
                   `### 🛠️ Set Operation & Notes\n` +
                   `1. Select the **Operation** from the dropdown below.\n` +
                   `2. Choose **Set Notes & Apply Manual Status** from the actions menu to enter your notes (e.g. *"We don't have school today due to snow"*).\n\n` +
                   `👉 *Selected operation to configure: **${editingLabel}***`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_manual_status', disabledTabs),
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'cfg_override_status_select',
          placeholder: `Selected Operation: ${editingLabel}`,
          options: Object.entries(STATUS_LABELS).map(([key, label]) => ({
            label,
            value: key,
            default: key === editingKey
          })),
          min_values: 1,
          max_values: 1
        }]
      },
      actionSelectRow(actionOptions, '⚡ Actions...')
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_debug') {
    const r2Status = env.BACKUPS_BUCKET ? '✅ Configured (`ss-backups`)' : '⚠️ Not Configured';
    const voiceStatus = config.toggle_voice_announcements !== false ? '✅ Enabled' : '⏸️ Disabled';
    const bridgeChan = config.music_channel_id ? `<#${config.music_channel_id}>` : (config.log_channel_id ? `<#${config.log_channel_id}>` : (config.alert_channel_id ? `<#${config.alert_channel_id}>` : '(not set)'));
    const ownerMention = env.OWNER_ID ? `<@${env.OWNER_ID}>` : '*(unset)*';

    const embed = {
      title: `🛠️ ${panelPrefix} — Debug & Diagnostics`,
      color: 0x5865F2,
      description: `### 🛠️ Bot Diagnostics & Test Suite\n` +
                   `Run real-time diagnostics, health checks, simulated alerts, and voice tests across the server.\n\n` +
                   `• **Voice Announcements**: ${voiceStatus} (Bridge: ${bridgeChan})\n` +
                   `• **Cloudflare R2 Backups**: ${r2Status}\n` +
                   `• **Primary District Source**: \`${config.primary_district || 'hcpss'}\`\n` +
                   `• **Bot Owner**: ${ownerMention}\n\n` +
                   `### 🧪 Staff Diagnostics\n` +
                   `• **Test Voice Announcement**: Joins active voice channels, announces \`HCPSS Status Update\` 3 times, then disconnects.\n` +
                   `• **Run Health Canary**: Measures live latency to HCPSS status, NWS weather API, and BGE outage feeds.\n` +
                   `• **Test Cloudflare R2 Backup**: Immediately snapshots KV data to the R2 backup bucket.\n` +
                   `• **Simulate Status / Weather Alerts**: Delivers test watermarked embeds to verify channel delivery.\n\n` +
                   `*Owner-only diagnostics (cache purge, raw config, KV analytics, system logs) are in the **Owner Panel** (\`/ownerpanel\`).*`,
      timestamp: new Date().toISOString()
    };

    const actionOptions = STAFF_DEBUG_OPTIONS;

    const components = [
      getNavBarRow('config_debug', disabledTabs),
      actionSelectRow(actionOptions, '🛠️ Select a diagnostic test...')
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_override_select') {
    const editingKey = config.editing_override_status_key || 'normal_operations';
    const editingLabel = STATUS_LABELS[editingKey] || 'Normal Operations';

    const embed = {
      title: `🛠️ ${panelPrefix} — Set Status Override`,
      color: 0xF1C40F,
      description: `### ⚠️ Select Status to Override\n` +
                   `Choose the status you want to force from the select menu below, then pick **Set Duration & Details** in the actions dropdown to enter how long the override should last.\n\n` +
                   `👉 *Selected status: **${editingLabel}***`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('config_stats', disabledTabs),
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

  // Dashboard sub-page: Recent Logs — the status posts this server got. Every
  // other action the Worker takes goes to Cloudflare's log store and is read
  // back on the System Logs page, which is a link away in the actions row.
  if (page === 'dashboard_logs') {
    const logKey = guildId ? `panel_logs:${guildId}` : 'panel_logs';
    let logs = [];
    const rawLogs = await env.STATUS_KV.get(logKey);
    if (rawLogs) {
      try { logs = JSON.parse(rawLogs); } catch {}
    }

    const logsContent = renderPanelLogLines(logs);

    const embed = {
      title: `📋 ${panelPrefix} — Recent Logs`,
      color: 0x9B59B6,
      description:
        `### 📋 Status Posts & Alerts (most recent ${PANEL_LOG_DISPLAY_LINES})\n` +
        `${logsContent}\n\n` +
        `*Everything else the Worker did — watcher posts, config edits, failures — is on the* ` +
        `***System Logs*** *page below.*`,
      timestamp: new Date().toISOString()
    };

    const components = [
      getNavBarRow('dashboard_logs', disabledTabs),
      actionSelectRow([
        { label: 'Open System Logs', value: 'panel_logs', description: 'Full Worker activity on the web (private link)', emoji: { name: '📜' } },
        { label: 'Clear Logs', value: 'panel_clear_logs', description: 'Wipe this list (the web log is unaffected)', emoji: { name: '🗑️' } }
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

  // The dashboard is the default page (every /panel open and "Back to
  // Dashboard" lands here) and reads ten independent keys — fan them out in
  // one round trip so a slow-KV moment can't stack ten latencies. The panel
  // navigation defers, so this can't miss Discord's deadline, but a fast
  // render keeps the visible "thinking" gap short.
  const [
    latencyRaw, checkTimeRaw, failuresRaw, failureAlertedRaw, activeOverride,
    lastMessageId, lastChannelId, rawStats, panelMsgId, cachedAlerts
  ] = await Promise.all([
    env.STATUS_KV.get(latencyKey),
    env.STATUS_KV.get(checkTimeKey),
    env.STATUS_KV.get('scraper_failures_count'),
    env.STATUS_KV.get('scraper_failure_alerted'),
    getActiveOverride(env, guildId),
    env.STATUS_KV.get(`last_message_id:${guildId}`),
    env.STATUS_KV.get(`last_channel_id:${guildId}`),
    env.STATUS_KV.get('status_stats'),
    env.STATUS_KV.get(`log_panel_message_id:${guildId}`),
    getCachedWeatherAlerts(env)
  ]);
  const latency = latencyRaw || 'N/A';
  const lastCheckTime = Number(checkTimeRaw) || Date.now();
  const scraperFailures = Number(failuresRaw || 0);
  const scraperFailureAlerted = failureAlertedRaw === 'true';
  let stats = {};
  try { if (rawStats) stats = JSON.parse(rawStats) || {}; } catch {}
  const scrapesTotal = stats.scrapes_total || 0;
  const scrapesFailed = stats.scrapes_failed || 0;
  const successRate = scrapesTotal > 0 ? ((scrapesTotal - scrapesFailed) / scrapesTotal * 100).toFixed(1) : '100.0';
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
  const stormAlertActive = hasStormAlert(cachedAlerts);
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
    title: `🏠 ${panelPrefix} — Dashboard`,
    color: 0x9B59B6,
    description:
      disabledNotice +
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
    footer: { text: isMain ? 'CHS CONTROLS · HCPSS School Status' : 'School Status · Control Panel' },
    timestamp: new Date().toISOString()
  };

  const components = [
    getNavBarRow('dashboard', disabledTabs),
    actionSelectRow([
      { label: 'Run Status Check', value: 'panel_check', description: 'Fetch HCPSS status and post to alert channel', emoji: { name: '🔍' } },
      { label: 'Refresh Panel', value: 'panel_refresh', description: 'Refresh the control panel embed in the log channel', emoji: { name: '🔄' } },
      { label: 'Test Scraper Speed', value: 'panel_speed', description: 'Measure HCPSS page fetch time and response size', emoji: { name: '⚡' } },
      { label: 'View Status History', value: 'panel_history', description: 'Show last 10 operating status changes (private)', emoji: { name: '📜' } },
      { label: 'Open System Logs', value: 'panel_logs', description: 'Full Worker activity on the web (private link)', emoji: { name: '📋' } },
      { label: 'Clear All Logs', value: 'panel_clear_logs', description: 'Wipe the panel list (the web log is unaffected)', emoji: { name: '🗑️' } }
    ], '⚡ Quick Actions...'),
    debugSelectRow(STAFF_DEBUG_OPTIONS, '🛠️ Debug & Diagnostics...'),
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: 'panel_trigger_test_alert',
        placeholder: '🧪 Simulate Status Alert (No Pings)...',
        options: [
          { label: 'Normal Operations', value: 'normal_operations', description: 'Simulate a Normal Operations status update (no pings)' },
          { label: 'Schools Closed', value: 'schools_closed', description: 'Simulate a Schools Closed status update (no pings)' },
          { label: 'Schools & Offices Closed', value: 'schools_and_offices_closed', description: 'Simulate a Schools & Offices Closed status update (no pings)' },
          { label: 'Schools Open 2 Hours Late', value: 'schools_open_2_hours_late', description: 'Simulate a 2-Hour Delay status update (no pings)' },
          { label: 'Schools Close 3 Hours Early', value: 'schools_close_3_hours_early', description: 'Simulate a 3-Hour Early Close status update (no pings)' },
          { label: 'Other/Unknown Alert', value: 'unknown_alert', description: 'Simulate an Unknown Scraper Alert (no pings)' }
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
//
// This is the *control panel* logger, not a general one: a line costs a KV
// write plus a Discord edit, against 1,000 writes a day. It is reserved for the
// two things a server's staff must see in Discord — a status check, and a
// failure that stops updates reaching members (a broken alert channel, a source
// gone quiet). Everything else the Worker does goes to Cloudflare's log store
// through logAction() and is read back on the System Logs page, which is
// unlimited, free, and survives the panel render failing. If the panel needs
// re-rendering but the event doesn't belong in that list, use
// refreshPanelMessage() below.
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

    // Mirror the line into Cloudflare's log store, where gas/showLogs() can
    // read it and where it survives this render failing. Costs no KV, and
    // sends nothing to Discord — the panel below is the only copy a human
    // sees in the log channel.
    logAction(message, { guildId });
  }

  // "Last check" means the last time a status check actually ran, and only
  // check call sites pass a latency — every other caller (calendar edits,
  // announcements, panel refreshes) passes {}. Writing both keys on every
  // postLog call therefore spent a KV write per log line to restate a
  // timestamp that had not changed meaning, on a budget of 1,000 writes/day.
  if (typeof stats.latency === 'number') {
    await env.STATUS_KV.put(latencyKey, String(stats.latency));
    await env.STATUS_KV.put(checkTimeKey, String(Date.now()));
  }

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

// Re-renders the persistent panel message in place without adding a log line:
// for changes the dashboard *displays* (an override taking effect, setup
// finishing) whose record belongs in Cloudflare's log store instead of KV.
// Costs one KV read and one Discord edit — no write.
export function refreshPanelMessage(env, logChannelId, guildId = '') {
  return postLog(env, logChannelId, null, {}, guildId);
}

// Applies a config change from a panel select-menu interaction and saves it.
// Saves a join-logs panel select to the joinlogs_config KV key.
// Returns the guild config (unchanged) so the caller can render fresh.
export async function applyJoinlogsUpdate(body, env) {
  const guildId = body.guild_id || '';
  const customId = body.data && body.data.custom_id;
  const values = body.data && body.data.values;
  let joinlogs = {};
  try {
    const raw = await env.STATUS_KV.get(`joinlogs_config:${guildId}`);
    if (raw) joinlogs = JSON.parse(raw) || {};
  } catch {}
  if (customId === 'cfg_joinlogs_channel' && Array.isArray(values) && values[0]) {
    joinlogs.channel = values[0];
  } else if (customId === 'cfg_joinlogs_ping' && Array.isArray(values) && values[0]) {
    joinlogs.pingRole = values[0];
  } else if (customId === 'cfg_joinlogs_give' && Array.isArray(values) && values[0]) {
    joinlogs.giveRole = values[0];
  } else if (customId === 'cfg_joinlogs_remove') {
    joinlogs.removeRole = (Array.isArray(values) && values[0]) ? values[0] : null;
  }
  await env.STATUS_KV.put(`joinlogs_config:${guildId}`, JSON.stringify(joinlogs));
  return await getConfig(env, guildId);
}

export async function applyConfigUpdate(body, env) {
  // Join-logs settings live in their own KV key, not guild config.
  const _jlId = body.data && body.data.custom_id;
  if (_jlId === 'cfg_joinlogs_channel' || _jlId === 'cfg_joinlogs_ping' ||
      _jlId === 'cfg_joinlogs_give' || _jlId === 'cfg_joinlogs_remove') {
    return await applyJoinlogsUpdate(body, env);
  }
  const guildId = body.guild_id || '';
  const current = await getConfig(env, guildId);
  const customId = body.data && body.data.custom_id;
  const values = body.data && body.data.values;

  const next = { ...current };
  if (!next.status_ping_roles) next.status_ping_roles = {};
  if (!next.editing_status_key) next.editing_status_key = 'normal_operations';
  if (!next.editing_nws_ping_key) next.editing_nws_ping_key = 'default';

  if (customId === 'cfg_channel' && Array.isArray(values) && values[0]) {
    next.alert_channel_id = values[0];
  } else if (customId === 'cfg_log_channel' && Array.isArray(values) && values[0]) {
    next.log_channel_id = values[0];
  } else if (customId === 'cfg_staff_role' && Array.isArray(values) && values[0]) {
    next.staff_role_id = values[0];
    next.staff_role_ids = values;
  } else if (customId === 'cfg_music_channel' && Array.isArray(values) && values[0]) {
    next.music_channel_id = values[0];
  } else if (customId === 'cfg_music_role' && Array.isArray(values) && values[0]) {
    next.music_role_id = values[0];
  } else if (customId === 'cfg_music_vc') {
    next.music_vc_id = (Array.isArray(values) && values[0]) ? values[0] : null;
  } else if (customId === 'cfg_keyword_remove_select' && Array.isArray(values) && values[0] !== undefined) {
    // Remove an auto-reply rule by its index in the list.
    if (Array.isArray(next.keyword_rules)) {
      const idx = parseInt(values[0], 10);
      if (!Number.isNaN(idx) && idx >= 0 && idx < next.keyword_rules.length) {
        next.keyword_rules.splice(idx, 1);
      }
    }
  } else if (customId === 'cfg_status_select' && Array.isArray(values) && values[0]) {
    next.editing_status_key = values[0];
  } else if (customId === 'cfg_status_role') {
    const editingKey = next.editing_status_key || 'normal_operations';
    if (Array.isArray(values) && values[0]) {
      next.status_ping_roles[editingKey] = values[0];
    } else {
      next.status_ping_roles[editingKey] = null;
    }
  } else if (customId === 'cfg_nws_ping_select' && Array.isArray(values) && values[0]) {
    if (NWS_PING_CATEGORIES.some(c => c.key === values[0])) {
      next.editing_nws_ping_key = values[0];
    }
  } else if (customId === 'cfg_nws_ping_role') {
    const editingPingCat = NWS_PING_CATEGORIES.some(c => c.key === next.editing_nws_ping_key)
      ? next.editing_nws_ping_key
      : 'default';
    let pingMap = next.ping_role_ids;
    if (!pingMap || typeof pingMap !== 'object' || Array.isArray(pingMap)) pingMap = {};
    else pingMap = { ...pingMap };
    if (Array.isArray(values) && values[0]) {
      pingMap[editingPingCat] = [values[0]];
    } else {
      pingMap[editingPingCat] = [];
    }
    next.ping_role_ids = pingMap;
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
    next.toggle_ab_day = selected.includes('toggle_ab_day');
    next.toggle_storm_mode = selected.includes('toggle_storm_mode');
    next.toggle_decision_watch = selected.includes('toggle_decision_watch');
    next.toggle_districts = selected.includes('toggle_districts');
    next.toggle_outlook = selected.includes('toggle_outlook');
    next.toggle_crosscheck = selected.includes('toggle_crosscheck');
    next.toggle_digest = selected.includes('toggle_digest');
    next.toggle_heads_up = selected.includes('toggle_heads_up');
    next.toggle_bus_alerts = selected.includes('toggle_bus_alerts');
    next.toggle_activity_alerts = selected.includes('toggle_activity_alerts');
    next.toggle_school_notices = selected.includes('toggle_school_notices');
    next.toggle_outages = selected.includes('toggle_outages');
    next.toggle_roads = selected.includes('toggle_roads');
    next.toggle_year_recap = selected.includes('toggle_year_recap');
    next.toggle_aqi_alerts = selected.includes('toggle_aqi_alerts');
    next.toggle_nws_alerts = selected.includes('toggle_nws_alerts');
    next.toggle_emergency_alerts = selected.includes('toggle_emergency_alerts');
    next.toggle_emergency_ping = selected.includes('toggle_emergency_ping');
    next.toggle_session_gate = selected.includes('toggle_session_gate');
    next.toggle_voice_announcements = selected.includes('toggle_voice_announcements');
  } else if (customId === 'cfg_primary_district' && Array.isArray(values) && values[0]) {
    if (PRIMARY_DISTRICT_CHOICES.some(c => c.id === values[0])) {
      next.primary_district = values[0];
    }
  } else if (customId === 'cfg_override_status_select' && Array.isArray(values) && values[0]) {
    next.editing_override_status_key = values[0];
  } else if (customId === 'cfg_announcement_request_channel' && Array.isArray(values)) {
    next.announcement_request_channel_id = values[0] || null;
  } else if (customId === 'cfg_email_channel' && Array.isArray(values)) {
    next.email_channel_id = values[0] || null;
  }

  await setConfig(env, guildId, next);
  return next;
}
