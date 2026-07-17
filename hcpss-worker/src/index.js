import {
  getEasternTimeStr,
  matchesScheduleTime,
  clockEmojiForTime,
  formatScheduleTimeLabel,
  formatCheckedAt,
  formatStatusDate,
  formatYmdNY,
  delay,
  isInStormWindow,
  stormTickSlot
} from './timeutil.js';
import {
  HCPSS_URL,
  fetchHtml,
  getStatusCards,
  extractCards,
  assembleDescription,
  determineStatusKey,
  statusDateInfo
} from './scraper.js';
import { getActiveWeatherAlerts, formatWeatherAlertLines, hasStormAlert, alertsLikelyTomorrowMorning } from './weather.js';
import { trackStatusHistory, getStatusHistory, computeIncidentStats } from './history.js';
import { toggleSubscriber, notifySubscribers } from './subscriptions.js';

const EMBED_LIMIT = 4096;
const EMBED_SAFE = 3900;
const MAX_EMBEDS = 10;
const MANUAL_TRIGGER_HEADER = 'x-manual-trigger-token';
const EPHEMERAL_FLAG = 64;
const POST_STATUS_COMMAND = 'post-status';
const CONFIG_COMMAND = 'config';
const OVERRIDE_COMMAND = 'override';
const DEFAULT_STAFF_ROLE_ID = '1521682363942436896';
const DEFAULT_LOG_CHANNEL_ID = '1524911607942221965';
const ANNOUNCE_COMMAND = 'announce';

// 2026-2027 HCPSS calendar highlights for annotating "Normal Operations" days
// (and any other status date) with the scheduled event.
const SCHOOL_CALENDAR_EVENTS = {
  '2026-08-13': 'First day for staff',
  '2026-08-24': 'First day for K-12 students',
  '2026-08-27': 'First day for pre-K/RECC students',
  '2026-09-07': 'Schools and offices closed* – Labor Day',
  '2026-09-21': 'Schools and offices closed – Yom Kippur',
  '2026-09-30': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Learning/Workday',
  '2026-10-16': 'Schools closed for students – Staff Professional Learning Day',
  '2026-10-28': 'Schools closed for students – Staff Professional Learning/Workday',
  '2026-11-03': 'Schools and offices closed – Election Day*',
  '2026-11-23': 'Schools close 3 hours early; No half-day Pre-K/RECC – ES/MS Parent/Teacher Conferences, HS Staff Professional Day',
  '2026-11-24': 'Schools close 3 hours early; No half-day Pre-K/RECC – ES/MS Parent/Teacher Conferences',
  '2026-11-25': 'Schools closed for students – Parent/Teacher Conferences',
  '2026-11-26': 'Schools and offices closed* – Thanksgiving Holiday',
  '2026-11-27': 'Schools and offices closed* – Thanksgiving Holiday',
  '2026-12-09': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Learning/Workday',
  '2026-12-24': 'Schools and offices closed* – Winter Break',
  '2026-12-25': 'Schools and offices closed* – Winter Break',
  '2026-12-28': 'Schools closed* – Winter Break',
  '2026-12-29': 'Schools closed* – Winter Break',
  '2026-12-30': 'Schools closed* – Winter Break',
  '2026-12-31': 'Schools closed* – Winter Break',
  '2027-01-01': 'Schools and offices closed* – Winter Break',
  '2027-01-18': 'Schools and offices closed* – Martin Luther King Jr. Day',
  '2027-01-19': 'Schools closed for students –Staff Professional Workday',
  '2027-02-03': 'Schools closed for students – Staff Professional Learning Day',
  '2027-02-11': 'Elementary schools close 3 hours early; No half-day Pre-K/RECC – ES Parent/Teacher Conferences',
  '2027-02-12': 'Elementary schools close 3 hours early; No half-day Pre-K/RECC – ES Parent/Teacher Conferences',
  '2027-02-15': 'Schools and offices closed* – Presidents Day',
  '2027-03-09': 'Schools closed for students – Eid al Fitr; Staff Professional Learning/Workday',
  '2027-03-22': 'Schools closed* – Spring Break',
  '2027-03-23': 'Schools closed* – Spring Break',
  '2027-03-24': 'Schools closed* – Spring Break',
  '2027-03-25': 'Schools closed* – Spring Break',
  '2027-03-26': 'Schools and offices closed* – Spring Break',
  '2027-03-29': 'Schools and offices closed* – Spring Break',
  '2027-04-08': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Learning/Workday',
  '2027-05-17': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Learning/Workday',
  '2027-05-31': 'Schools and offices closed* – Memorial Day',
  '2027-06-02': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Learning/Workday',
  '2027-06-07': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Workday; If inclement weather days are used, may become a full day',
  '2027-06-08': 'Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Workday – Last Scheduled Day; If inclement weather days are used, may become a full day',
  '2027-06-09': 'May be used as inclement weather days',
  '2027-06-10': 'May be used as inclement weather days',
  '2027-06-11': 'May be used as inclement weather days',
  '2027-06-14': 'May be used as inclement weather days',
  '2027-06-15': 'May be used as inclement weather days',
  '2027-06-16': 'May be used as inclement weather days',
  '2027-06-18': 'Schools and offices closed – Juneteenth (observed)',
  '2027-07-05': 'Schools and offices closed – Independence Day (observed)'
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function footerWithCheckedAt(label, checkedAt) {
  return `${label} - Last checked ${formatCheckedAt(checkedAt)}`;
}

function getManualTriggerToken(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  const headerToken = request.headers.get(MANUAL_TRIGGER_HEADER);
  return headerToken ? headerToken.trim() : '';
}

function validateManualTrigger(request, env) {
  if (!env.MANUAL_TRIGGER_TOKEN) {
    return new Response('Manual trigger disabled: MANUAL_TRIGGER_TOKEN is not configured.', { status: 403 });
  }

  const providedToken = getManualTriggerToken(request);
  if (!providedToken || providedToken !== env.MANUAL_TRIGGER_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }

  return null;
}

function hexToUint8(hex) {
  if (hex.startsWith('0x')) hex = hex.slice(2);
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

async function verifyDiscordRequest(rawBody, signatureHex, timestamp, publicKeyHex) {
  try {
    const sig = hexToUint8(signatureHex);
    const pub = hexToUint8(publicKeyHex);
    const enc = new TextEncoder();
    const message = new Uint8Array(enc.encode(timestamp));
    const bodyBytes = new Uint8Array(await rawBody.arrayBuffer());
    const data = new Uint8Array(message.length + bodyBytes.length);
    data.set(message, 0);
    data.set(bodyBytes, message.length);

    const key = await crypto.subtle.importKey('raw', pub, { name: 'NODE-ED25519' }, false, ['verify']).catch(() => null);
    if (key) {
      const ok = await crypto.subtle.verify({ name: 'NODE-ED25519' }, key, sig, data).catch(() => false);
      if (ok) return true;
    }

    const key2 = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']).catch(() => null);
    if (key2) {
      return !!(await crypto.subtle.verify({ name: 'Ed25519' }, key2, sig, data).catch(() => false));
    }

    return false;
  } catch (e) {
    return false;
  }
}

function splitEmbeds(title, description, url, color, footer, checkedAt = new Date(), thumbnailUrl = '') {
  const chunks = [];
  let rem = (description || '').trim();
  while (rem.length) {
    if (rem.length <= EMBED_LIMIT) {
      chunks.push(rem);
      break;
    }
    let splitAt = rem.lastIndexOf('\n', EMBED_SAFE);
    if (splitAt <= 0) splitAt = EMBED_SAFE;
    chunks.push(rem.slice(0, splitAt).trim());
    rem = rem.slice(splitAt).trim();
  }
  if (!chunks.length) chunks.push('');

  return chunks.map((c, idx) => {
    const embed = {
      color,
      description: c,
      footer: { text: footerWithCheckedAt(footer || 'HCPSS Status Monitor', checkedAt) },
      timestamp: checkedAt.toISOString()
    };
    if (idx === 0) {
      embed.title = title;
      embed.url = url;
      if (thumbnailUrl) {
        embed.thumbnail = { url: thumbnailUrl };
      }
    } else {
      embed.title = `${title} (cont. ${idx + 1})`;
    }
    return embed;
  });
}

function buildCheckAgainComponents() {
  return [{
    type: 1,
    components: [
      { type: 2, style: 1, label: 'Check again', custom_id: 'check_again' },
      { type: 2, style: 2, label: 'Notify Me', custom_id: 'dm_subscribe', emoji: { name: '🔔' } }
    ]
  }];
}

function getDefaultStatusColor(statusKey) {
  switch (statusKey) {
    case 'normal_operations':
      return 3066993; // #2ECC71
    case 'schools_closed':
    case 'schools_and_offices_closed':
    case 'unknown_alert':
      return 16711680; // #FF0000
    case 'schools_open_2_hours_late':
    case 'schools_close_3_hours_early':
      return 8421504; // #808080
    default:
      return 16711680; // Default to #FF0000
  }
}

function getStatusThumbnail(statusKey) {
  return '';
}
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

async function buildStatusEmbeds(env, footer = 'HCPSS Status Monitor', cards = null, config = null, staleInfo = null) {
  const checkedAt = new Date();
  if (!cards) {
    const html = await fetchHtml(HCPSS_URL);
    cards = extractCards(html);
  }
  const dateInfo = statusDateInfo(cards[0] && cards[0].date, checkedAt);
  const primaryDate = dateInfo.display;

  // The embed always mirrors the website exactly; calendar events are only
  // shown via /calendar and the control panel, never in the status embed.
  let desc = assembleDescription(cards);

  if (staleInfo && staleInfo.staleAt) {
    desc = `⚠️ *The live status page is unreachable — showing the last known status from <t:${Math.floor(staleInfo.staleAt / 1000)}:R>.*\n\n${desc}`;
  }

  const statusKey = determineStatusKey(cards);
  let color = getDefaultStatusColor(statusKey);
  if (config && config.status_embed_colors && typeof config.status_embed_colors[statusKey] === 'number') {
    color = config.status_embed_colors[statusKey];
  }
  const customFooter = (config && config.alert_embed_footer) || footer;
  const thumbnailUrl = getStatusThumbnail(statusKey);

  const embeds = splitEmbeds(`HCPSS Status for ${primaryDate}`, desc, HCPSS_URL, color, customFooter, checkedAt, thumbnailUrl).slice(0, MAX_EMBEDS);

  // Add active NWS weather alerts for Howard County as context on the first embed.
  const weatherEnabled = !config || config.toggle_weather !== false;
  const alerts = weatherEnabled ? await getActiveWeatherAlerts(env) : [];
  if (weatherEnabled && embeds[0]) {
    const alertLines = formatWeatherAlertLines(alerts);
    if (alertLines) {
      embeds[0].fields = [
        ...(embeds[0].fields || []),
        { name: '⛅ Active Weather Alerts — Howard County', value: alertLines }
      ];
    }
  }

  // Evening posts (5 PM ET onward) get a Tomorrow Outlook: the next day's
  // calendar event plus any storm alerts likely to still be active by morning.
  const etHour = Number(getEasternTimeStr(checkedAt).split(':')[0]);
  if (etHour >= 17 && embeds[0]) {
    const outlookLines = [];

    const tomorrow = new Date(checkedAt.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowYmd = formatYmdNY(tomorrow);
    let calEvent = null;
    if (env && env.STATUS_KV) {
      try { calEvent = await env.STATUS_KV.get(`calendar_event:${tomorrowYmd}`); } catch {}
    }
    if (!calEvent) calEvent = SCHOOL_CALENDAR_EVENTS[tomorrowYmd] || null;
    if (calEvent) {
      outlookLines.push(`📅 **${formatStatusDate(tomorrow)}**: ${calEvent}`);
    }

    if (weatherEnabled) {
      for (const a of alertsLikelyTomorrowMorning(alerts, checkedAt.getTime()).slice(0, 2)) {
        const until = a.endsMs ? ` (until <t:${Math.floor(a.endsMs / 1000)}:f>)` : '';
        outlookLines.push(`🌨️ **${a.event}** may affect tomorrow morning${until}`);
      }
    }

    if (outlookLines.length) {
      embeds[0].fields = [
        ...(embeds[0].fields || []),
        { name: '🌙 Tomorrow Outlook', value: outlookLines.join('\n') }
      ];
    }
  }

  return embeds;
}

function buildStatusErrorEmbeds(error, footer = 'HCPSS Status Monitor', config = null) {
  const checkedAt = new Date();
  const detail = error && error.message ? `\n\nTechnical detail: ${error.message}` : '';
  let color = getDefaultStatusColor('unknown_alert');
  if (config && config.status_embed_colors && typeof config.status_embed_colors['unknown_alert'] === 'number') {
    color = config.status_embed_colors['unknown_alert'];
  }
  const customFooter = (config && config.alert_embed_footer) || footer;
  return [{
    title: 'HCPSS status check failed',
    url: HCPSS_URL,
    description: `The monitor could not fetch the HCPSS status page right now. Try again in a minute or check https://hcpss.org directly.${detail}`,
    color: color,
    footer: { text: footerWithCheckedAt(customFooter, checkedAt) },
    timestamp: checkedAt.toISOString()
  }];
}

function buildOverrideEmbeds(override, footer = 'HCPSS Status Monitor', config = null) {
  const checkedAt = new Date();
  const statusKey = override && override.status_key ? String(override.status_key) : '';
  const statusLabel = override && override.status_label ? String(override.status_label) : 'Override';
  const isNormal = statusKey === 'normal_operations';
  let color = getDefaultStatusColor(statusKey);
  if (config && config.status_embed_colors && typeof config.status_embed_colors[statusKey] === 'number') {
    color = config.status_embed_colors[statusKey];
  }
  const customFooter = (config && config.alert_embed_footer) || footer;

  const title = (override && override.title)
    ? String(override.title).slice(0, 256)
    : `HCPSS Status (Override) - ${statusLabel}`.slice(0, 256);

  const details = (override && override.details) ? String(override.details).trim() : '';
  const body = details ? `## **${statusLabel}**\n\n${details}` : `## **${statusLabel}**`;
  const thumbnailUrl = getStatusThumbnail(statusKey);

  return splitEmbeds(title, body, HCPSS_URL, color, customFooter, checkedAt, thumbnailUrl).slice(0, MAX_EMBEDS);
}

async function buildStatusPayload(env, { includeComponents = false, footer = 'HCPSS Status Monitor', guildId = '', cards = null, error = null, stale = false, staleAt = 0 } = {}) {
  const storedConfig = await getConfig(env, guildId);
  const config = getEffectiveConfig(storedConfig);

  const activeOverride = env ? await getActiveOverride(env, guildId) : null;
  if (activeOverride) {
    const payload = {
      content: '',
      embeds: buildOverrideEmbeds(activeOverride, footer, config)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents();
    return { payload, isError: false, isOverride: true, statusKey: activeOverride.status_key };
  }

  // No pre-fetched cards from the caller: fetch live, falling back to the
  // cached last-good scrape when the status page is unreachable.
  if (!cards && !error) {
    const fetched = await getStatusCards(env);
    cards = fetched.cards;
    error = fetched.error;
    stale = fetched.stale;
    staleAt = fetched.staleAt;
  }

  if (!cards && error) {
    const payload = {
      content: '',
      embeds: buildStatusErrorEmbeds(error, footer, config)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents();
    return { payload, isError: true, error, statusKey: 'unknown_alert' };
  }

  try {
    const statusKey = determineStatusKey(cards);
    const payload = {
      content: '',
      embeds: await buildStatusEmbeds(env, footer, cards, config, stale ? { staleAt } : null)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents();
    return { payload, isError: false, stale, statusKey };
  } catch (err) {
    const payload = {
      content: '',
      embeds: buildStatusErrorEmbeds(err, footer, config)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents();
    return { payload, isError: true, error: err, statusKey: 'unknown_alert' };
  }
}

async function postMessageToChannel(env, payload) {
  const token = env.DISCORD_BOT_TOKEN;
  const channelId = payload && payload.__channelId ? payload.__channelId : env.DISCORD_CHANNEL_ID;
  if (!token || !channelId) throw new Error('Missing token or channel id');

  const cleaned = { ...payload };
  delete cleaned.__channelId;

  return await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cleaned)
  });
}

async function handlePanelSpeed(body, env) {
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

async function handlePanelKvDebug(body, env) {
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
    `last_known_status`,
    `last_good_scrape`,
    `weather_alerts_cache`,
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

async function handlePanelCheck(body, env) {
  const invokerId = body.member && body.member.user && body.member.user.id;
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

async function postLog(env, logChannelId, message, stats = {}, guildId = '') {
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

function runCalendarCommand() {
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

async function runHistoryCommand(env) {
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

async function runLogsCommand(env, guildId = '') {
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

async function handleScraperFailure(env, logChannelId, config, error) {
  const currentFailures = Number(await env.STATUS_KV.get('scraper_failures_count') || 0) + 1;
  await env.STATUS_KV.put('scraper_failures_count', String(currentFailures));

  const maxFailuresThreshold = 3;
  if (currentFailures >= maxFailuresThreshold) {
    if (config && config.toggle_error_alerts === false) {
      return;
    }
    const alreadyAlerted = await env.STATUS_KV.get('scraper_failure_alerted') === 'true';
    if (!alreadyAlerted) {
      await env.STATUS_KV.put('scraper_failure_alerted', 'true');
      
      const staffRoleId = config.staff_role_id;
      const pingText = staffRoleId ? `<@&${staffRoleId}> ` : '';
      const errorMessage = error && error.message ? error.message : 'Unknown scraping error';

      const token = env.DISCORD_BOT_TOKEN;
      if (token && logChannelId) {
        await fetch(`https://discord.com/api/v10/channels/${logChannelId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            content: `⚠️ ${pingText}**SCRAPER FAILURE ALERT!**\nThe HCPSS status scraper has failed **${currentFailures} consecutive times**.\n` +
                     `• Latest Error: \`${errorMessage}\`\n` +
                     `• This warning will not repeat until the scraper recovers.`,
            allowed_mentions: staffRoleId ? { roles: [staffRoleId] } : { parse: [] }
          })
        }).catch(() => {});
      }
    }
  }
}

async function handleScraperSuccessOrFailure(env, scrapeFailed, error, targetGuildIds) {
  if (scrapeFailed) {
    const defaultGuildConfig = getEffectiveConfig(await getConfig(env, env.DISCORD_GUILD_ID));
    const firstLogChannelId = targetGuildIds.length > 0 ? (getEffectiveConfig(await getConfig(env, targetGuildIds[0])).log_channel_id) : defaultGuildConfig.log_channel_id;
    await handleScraperFailure(env, firstLogChannelId, defaultGuildConfig, error);
  } else {
    await handleScraperSuccess(env);
  }
}

async function handleScraperSuccess(env) {
  const failures = Number(await env.STATUS_KV.get('scraper_failures_count') || 0);
  if (failures > 0) {
    await env.STATUS_KV.put('scraper_failures_count', '0');
    
    const wasAlerted = await env.STATUS_KV.get('scraper_failure_alerted') === 'true';
    if (wasAlerted) {
      await env.STATUS_KV.delete('scraper_failure_alerted');
    }
  }
}

async function doCheckAndPost(env, options = {}) {
  const start = Date.now();
  const isScheduled = options.source === 'scheduled';

  // Determine target guilds to post/check for.
  let targetGuildIds = [];
  if (options.guildId) {
    targetGuildIds = [options.guildId];
  } else {
    // Scheduled runs fire every minute, so read the cached guild index instead of
    // doing a KV list operation (list ops are limited to 1,000/day on the free plan).
    let haveIndex = false;
    if (isScheduled) {
      const rawIndex = await env.STATUS_KV.get('guild_index');
      if (rawIndex) {
        try {
          const parsedIndex = JSON.parse(rawIndex);
          if (Array.isArray(parsedIndex)) {
            targetGuildIds = parsedIndex.filter(Boolean);
            haveIndex = true;
          }
        } catch {}
      }
    }

    if (!haveIndex) {
      // Collect all guilds from KV keys starting with 'config:'
      try {
        const listResult = await env.STATUS_KV.list({ prefix: 'config:' });
        targetGuildIds = listResult.keys.map(k => k.name.replace(/^config:/, '')).filter(Boolean);
        if (isScheduled) {
          await env.STATUS_KV.put('guild_index', JSON.stringify(targetGuildIds));
        }
      } catch (e) {
        console.error('Failed to list configs in KV:', e);
      }
    }

    // Ensure default guild from environment is included if configured
    if (env.DISCORD_GUILD_ID && !targetGuildIds.includes(env.DISCORD_GUILD_ID)) {
      targetGuildIds.push(env.DISCORD_GUILD_ID);
    }
  }

  let activeGuildIds = [...targetGuildIds];
  let isStormCheck = false;

  if (isScheduled) {
    const now = new Date();
    const currentEtStr = getEasternTimeStr(now);
    const todayYmd = formatYmdNY(now);
    const matchedGuilds = [];
    for (const guildId of targetGuildIds) {
      const stored = await getConfig(env, guildId);
      const config = getEffectiveConfig(stored);
      const schedule = Array.isArray(config.check_schedule) ? config.check_schedule : [];
      const matchedTime = schedule.find(schedTime => matchesScheduleTime(currentEtStr, schedTime));
      if (!matchedTime) continue;

      // Dedupe: the cron fires every minute and the match window is 5 minutes
      // wide, so skip guilds whose matched slot already ran today.
      const slotKey = `last_sched_slot:${guildId}`;
      const slotVal = `${todayYmd} ${matchedTime}`;
      const lastSlot = await env.STATUS_KV.get(slotKey);
      if (lastSlot === slotVal) continue;
      await env.STATUS_KV.put(slotKey, slotVal);

      matchedGuilds.push(guildId);
    }
    activeGuildIds = matchedGuilds;

    // Storm mode: when no regular check matched, run extra checks every 15
    // minutes during the 4:30-7:30 AM ET decision window while a winter storm
    // alert is active. Storm checks only post (and ping) if the status changed.
    if (activeGuildIds.length === 0) {
      const stormSlot = stormTickSlot(currentEtStr);
      if (!stormSlot) {
        return { ok: true, skipped: true, message: 'No guilds scheduled for this time.' };
      }
      const alerts = await getActiveWeatherAlerts(env);
      if (!hasStormAlert(alerts)) {
        return { ok: true, skipped: true, message: 'Storm window, but no storm alert active.' };
      }
      const slotVal = `${todayYmd} ${stormSlot}`;
      if (await env.STATUS_KV.get('last_storm_slot') === slotVal) {
        return { ok: true, skipped: true, message: 'Storm slot already checked.' };
      }
      await env.STATUS_KV.put('last_storm_slot', slotVal);
      isStormCheck = true;
      activeGuildIds = [...targetGuildIds];
    }
  }

  if (activeGuildIds.length === 0) {
    return { ok: true, skipped: true, message: "No guilds scheduled for this time." };
  }

  // 1. Fetch HTML and extract cards once (falls back to the cached last-good
  // scrape when the live page is unreachable).
  const fetched = await getStatusCards(env);
  const cards = fetched.cards;
  const error = fetched.cards ? null : fetched.error;
  const isStale = fetched.stale;
  const staleAt = fetched.staleAt;
  const scrapeFailed = !!fetched.error;
  const latency = Date.now() - start;

  // Increment check counts in KV
  try {
    let stats = {};
    const rawStats = await env.STATUS_KV.get('status_stats');
    if (rawStats) {
      stats = JSON.parse(rawStats) || {};
    }
    stats.scrapes_total = (stats.scrapes_total || 0) + 1;
    if (scrapeFailed) {
      stats.scrapes_failed = (stats.scrapes_failed || 0) + 1;
    }
    await env.STATUS_KV.put('status_stats', JSON.stringify(stats));
  } catch (e) {
    console.error('Failed to update scraper statistics:', e);
  }

  // Fetch status once using a default/live payload to determine global history/failures tracking.
  const liveStatusResult = await buildStatusPayload(env, {
    includeComponents: true,
    cards,
    error,
    stale: isStale,
    staleAt
  });

  const firstEmbedGlobal = liveStatusResult.payload.embeds && liveStatusResult.payload.embeds[0];
  const liveStatusTextGlobal = firstEmbedGlobal ? (firstEmbedGlobal.description || '') : '';

  // Track global status history on change. A stale fallback repeats the cached
  // status, so it can never register as a change (or trigger DM notifications).
  let statusChanged = false;
  if (!liveStatusResult.isOverride && !liveStatusResult.isError && !isStale) {
    const lastKnownStatus = await env.STATUS_KV.get('last_known_status');
    if (lastKnownStatus !== liveStatusTextGlobal) {
      statusChanged = lastKnownStatus !== null;
      if (firstEmbedGlobal) {
        const statusTitle = firstEmbedGlobal.title || '';
        await trackStatusHistory(env, liveStatusTextGlobal, statusTitle, liveStatusResult.statusKey);
      }
      await env.STATUS_KV.put('last_known_status', liveStatusTextGlobal);
    }
  }

  // Storm checks are silent unless the status actually changed — no reposts,
  // no pings, just fast detection of a new closing/delay announcement.
  if (isStormCheck && !statusChanged) {
    await handleScraperSuccessOrFailure(env, scrapeFailed, fetched.error, targetGuildIds);
    return { ok: true, skipped: true, message: 'Storm check: status unchanged.' };
  }

  const results = [];
  const sourceLabel = isStormCheck ? 'storm-mode' : (options.source || 'unknown');

  for (const guildId of activeGuildIds) {
    const stored = await getConfig(env, guildId);
    const config = getEffectiveConfig(stored);
    if (isStormCheck && config.toggle_storm_mode === false) {
      results.push({ guildId, ok: true, skipped: true, reason: 'Storm mode disabled' });
      continue;
    }
    const channelId = config.alert_channel_id || (guildId === env.DISCORD_GUILD_ID ? env.DISCORD_CHANNEL_ID : null);
    const logChannelId = config.log_channel_id;
    if (!channelId) {
      // Guild hasn't configured an alert channel yet, but we should still update check timestamp & control panel
      await postLog(
        env,
        logChannelId,
        null,
        { latency },
        guildId
      );
      results.push({ guildId, ok: true, skipped: true, reason: 'No alert channel configured' });
      continue;
    }
    const pingRoleIds = Array.isArray(config.ping_role_ids) ? config.ping_role_ids : [];

    // Get the status payload for THIS guild (incorporates any active override for this guild)
    const builtStatus = await buildStatusPayload(env, {
      includeComponents: true,
      guildId,
      cards,
      error,
      stale: isStale,
      staleAt
    });

    const statusKey = builtStatus.statusKey || 'normal_operations';

    let roleId = undefined;
    if (config.status_ping_roles) {
      roleId = config.status_ping_roles[statusKey];
    }

    let rolesToPing = [];
    if (roleId) {
      rolesToPing = [roleId];
    } else if (roleId === undefined && statusKey !== 'normal_operations') {
      rolesToPing = pingRoleIds;
    }

    const pingsEnabled = config.toggle_pings !== false;
    const content = (pingsEnabled && rolesToPing.length) ? rolesToPing.map(id => `<@&${id}>`).join(' ') : '';
    const payload = {
      ...builtStatus.payload,
      content,
      allowed_mentions: (pingsEnabled && rolesToPing.length) ? { roles: rolesToPing } : { parse: [] },
      __channelId: channelId
    };

    // Every check posts the latest status, changed or not (the previous status
    // message is deleted after the new one goes out). The only exception is a
    // scraper error during a scheduled run — the failure alert system covers that.
    const shouldPostAlert = !isScheduled || !builtStatus.isError;

    let postedMessageId = null;
    if (shouldPostAlert) {
      const postResult = await postMessageToChannel(env, payload);
      if (!postResult.ok) {
        const postError = await postResult.text();
        await postLog(
          env,
          logChannelId,
          `❌ HCPSS status check failed (source: ${sourceLabel}): ${postError}`,
          { latency },
          guildId
        );
        results.push({ guildId, ok: false, error: postError, status: postResult.status });
        continue;
      }

      const postedMessage = await postResult.json();
      postedMessageId = postedMessage.id;

      const previousMessageId = await env.STATUS_KV.get(`last_message_id:${guildId}`);
      const previousChannelId = await env.STATUS_KV.get(`last_channel_id:${guildId}`);
      
      await env.STATUS_KV.put(`last_message_id:${guildId}`, postedMessageId);
      await env.STATUS_KV.put(`last_channel_id:${guildId}`, channelId);

      if (previousMessageId && previousMessageId !== postedMessageId) {
        const deleteChannelId = previousChannelId || channelId;
        await fetch(`https://discord.com/api/v10/channels/${deleteChannelId}/messages/${previousMessageId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
        }).catch(() => {});
      }

      await postLog(
        env,
        logChannelId,
        `${isStale ? '⚠️' : isStormCheck ? '🌨️' : '✅'} HCPSS status check posted${isStale ? ' (stale fallback — live page unreachable)' : isStormCheck ? ' (storm mode detected a status change)' : ''} (source: ${sourceLabel}${options.invokerId ? `, by: <@${options.invokerId}>` : ''}) to <#${channelId}>. [Jump to Message](https://discord.com/channels/${guildId}/${channelId}/${postedMessageId})`,
        { latency },
        guildId
      );

      // DM subscribers only when the operating status actually changed.
      if (statusChanged && !builtStatus.isOverride) {
        const dmCount = await notifySubscribers(env, guildId, builtStatus.payload.embeds);
        if (dmCount > 0) {
          await postLog(env, logChannelId, `🔔 Status change DM sent to ${dmCount} subscriber(s).`, {}, guildId);
        }
      }

      results.push({ guildId, ok: true, id: postedMessageId });
    } else {
      // Scheduled check hit a scraper error: don't post the error embed on a schedule.
      await postLog(
        env,
        logChannelId,
        `⚠️ HCPSS status check errored (source: ${sourceLabel}) — error status not posted.`,
        { latency },
        guildId
      );
      results.push({ guildId, ok: true, skipped: true });
    }
  }

  // Handle global scraper success/failure tracking. A stale fallback still
  // counts as a scrape failure so consecutive-failure alerts keep working.
  await handleScraperSuccessOrFailure(env, scrapeFailed, fetched.error, targetGuildIds);

  const successCount = results.filter(r => r.ok).length;
  const failureCount = results.filter(r => !r.ok).length;
  const isErr = liveStatusResult.isError || failureCount > 0;

  const firstSuccessId = results.find(r => r.ok && r.id)?.id || null;

  return {
    ok: failureCount === 0,
    id: firstSuccessId,
    isError: isErr,
    error: liveStatusResult.error && liveStatusResult.error.message,
    message: `Processed ${targetGuildIds.length} guilds. Success: ${successCount}, Failures: ${failureCount}`
  };
}

function interactionResponse(data) {
  return jsonResponse({ type: 4, data });
}

function deferredInteractionResponse() {
  return jsonResponse({
    type: 5,
    data: { flags: EPHEMERAL_FLAG }
  });
}

function memberIsAdmin(member) {
  const perms = member && member.permissions;
  if (!perms) return false;
  try {
    // ADMINISTRATOR = 0x8
    return (BigInt(perms) & 8n) === 8n;
  } catch {
    return false;
  }
}

function getEffectiveConfig(stored) {
  const next = { ...(stored || {}) };
  if (!next.staff_role_id) next.staff_role_id = DEFAULT_STAFF_ROLE_ID;
  if (!next.log_channel_id) next.log_channel_id = DEFAULT_LOG_CHANNEL_ID;
  if (!Array.isArray(next.ping_role_ids)) next.ping_role_ids = [];
  if (!next.status_ping_roles) next.status_ping_roles = {};
  if (!next.status_embed_colors) next.status_embed_colors = {};
  if (!next.editing_status_key) next.editing_status_key = 'normal_operations';
  if (!Array.isArray(next.check_schedule)) {
    next.check_schedule = ["5:20", "7:20", "10:00", "20:00"];
  }
  if (typeof next.toggle_pings !== 'boolean') next.toggle_pings = true;
  if (typeof next.toggle_error_alerts !== 'boolean') next.toggle_error_alerts = true;
  if (typeof next.toggle_weather !== 'boolean') next.toggle_weather = true;
  if (typeof next.toggle_storm_mode !== 'boolean') next.toggle_storm_mode = true;
  return next;
}

function memberHasRole(member, roleId) {
  return !!roleId && Array.isArray(member && member.roles) && member.roles.includes(roleId);
}

async function canUseCommands(member, env, guildId = '') {
  if (memberIsAdmin(member)) return true;
  const stored = await getConfig(env, guildId);
  const cfg = getEffectiveConfig(stored);
  return memberHasRole(member, cfg.staff_role_id);
}

async function canConfigure(member, env, guildId = '') {
  return await canUseCommands(member, env, guildId);
}

async function createGuildRole(guildId, roleName, token) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/roles`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: roleName,
      mentionable: true
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Discord API error creating role '${roleName}': ${response.status} ${errText}`);
  }
  const data = await response.json();
  return data.id;
}

async function updateInteractionOriginal(env, interactionToken, payload) {
  const applicationId = env.DISCORD_APPLICATION_ID;
  if (!applicationId || !interactionToken) return;

  await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

async function runPostStatusCommand(body, env) {
  const invokerId = body && body.member && body.member.user && body.member.user.id;
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

async function runOverrideCommand(body, env) {
  const options = body && body.data && body.data.options;
  const invokerId = body && body.member && body.member.user && body.member.user.id;
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

  const STATUS_LABELS = {
    normal_operations: 'Normal Operations',
    schools_closed: 'Schools Closed',
    schools_and_offices_closed: 'Schools and Offices Closed',
    schools_open_2_hours_late: 'Schools Open 2 Hours Late',
    schools_close_3_hours_early: 'Schools Close 3 Hours Early'
  };

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

function overrideKey(guildId) {
  return guildId ? `override:${guildId}` : 'override:default';
}

async function getActiveOverride(env, guildId = '') {
  const key = overrideKey(guildId || env.DISCORD_GUILD_ID);
  const raw = await env.STATUS_KV.get(key);
  if (!raw) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const until = typeof parsed.until === 'number' ? parsed.until : 0;
  if (!until) return null;

  const now = Date.now();
  if (now > until) {
    await env.STATUS_KV.delete(key).catch(() => {});
    return null;
  }

  return parsed;
}

async function setOverride(env, guildId, override) {
  const key = overrideKey(guildId || env.DISCORD_GUILD_ID);
  await env.STATUS_KV.put(key, JSON.stringify(override));
}

async function clearOverride(env, guildId) {
  const key = overrideKey(guildId || env.DISCORD_GUILD_ID);
  await env.STATUS_KV.delete(key);
}

function getCommandOption(options, name) {
  if (!Array.isArray(options)) return undefined;
  const found = options.find(o => o && o.name === name);
  return found ? found.value : undefined;
}

function configKey(guildId) {
  return guildId ? `config:${guildId}` : 'config:default';
}

async function getConfig(env, guildId = '') {
  const key = configKey(guildId || env.DISCORD_GUILD_ID);
  const raw = await env.STATUS_KV.get(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function setConfig(env, guildId, next) {
  const effectiveGuildId = guildId || env.DISCORD_GUILD_ID;
  const key = configKey(effectiveGuildId);
  await env.STATUS_KV.put(key, JSON.stringify(next));

  // Keep the cached guild index in sync so per-minute scheduled runs can
  // avoid KV list operations.
  if (effectiveGuildId) {
    try {
      let index = [];
      const rawIndex = await env.STATUS_KV.get('guild_index');
      if (rawIndex) {
        try { index = JSON.parse(rawIndex); } catch {}
      }
      if (!Array.isArray(index)) index = [];
      if (!index.includes(effectiveGuildId)) {
        index.push(effectiveGuildId);
        await env.STATUS_KV.put('guild_index', JSON.stringify(index));
      }
    } catch (e) {
      console.error('Failed to update guild index:', e);
    }
  }
}

function getModalInputValue(body, customId) {
  if (!body || !body.data || !Array.isArray(body.data.components)) return '';
  for (const row of body.data.components) {
    if (row && Array.isArray(row.components)) {
      const found = row.components.find(c => c && c.custom_id === customId);
      if (found) return found.value;
    }
  }
  return '';
}

const PANEL_NAV_TABS = [
  { label: 'Dashboard', value: 'dashboard', emoji: '📊', description: 'System status, logs, and quick actions' },
  { label: 'Settings', value: 'config_general', emoji: '⚙️', description: 'Channels, staff role, schedule, and toggles' },
  { label: 'Status Theme', value: 'config_status', emoji: '🎨', description: 'Embed colors and ping roles per status' },
  { label: 'Calendar', value: 'config_calendar', emoji: '📅', description: 'Upcoming closures and custom events' },
  { label: 'Stats', value: 'config_stats', emoji: '📈', description: 'Check statistics and status overrides' },
  { label: 'Command Menu', value: 'config_commands', emoji: '📜', description: 'List of available slash commands' }
];

function getNavTabForPage(page) {
  if (['config_general', 'config_schedule', 'config_toggles'].includes(page)) return 'config_general';
  if (['config_stats', 'config_override_select'].includes(page)) return 'config_stats';
  if (page === 'dashboard_logs' || page === 'dashboard_bot_status') return 'dashboard';
  return PANEL_NAV_TABS.some(t => t.value === page) ? page : 'dashboard';
}

async function getNavBarRow(env, guildId, activeTab) {
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
async function buildBotStatusPayload(env, guildId, fraction = 1) {
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
    title: '📡 HCPSS Status Monitor — Bot Status',
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
    await getNavBarRow(env, guildId, 'dashboard'),
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: 'panel_view_select',
        placeholder: '📂 Switch view...',
        options: [
          { label: 'Logging', value: 'dashboard_logs', description: 'View recent bot activity logs', emoji: { name: '📋' } },
          { label: 'Bot Status', value: 'dashboard_bot_status', description: 'View ping, latency bars, and bot health metrics', emoji: { name: '📡' }, default: true }
        ],
        min_values: 1,
        max_values: 1
      }]
    },
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: 'System Status', custom_id: 'panel_to_dashboard', emoji: { name: '📊' } },
        { type: 2, style: 1, label: 'Refresh Metrics', custom_id: 'panel_to_dashboard_bot_status', emoji: { name: '🔄' }, disabled: !isFinal }
      ]
    }
  ];

  return { embeds: [embed], components };
}
async function buildControlPanelPayload(env, guildId, configOverride = null, pageOverride = null) {
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
      title: '⚙️ HCPSS Status Monitor - General Config',
      color: 0x3498DB,
      description: `### 🔧 Server Settings\n` +
                   `• **Alerts Destination**: ${channel}\n` +
                   `• **System Logs Destination**: ${logChannel}\n` +
                   `• **Moderator Staff Role**: ${staffRole}\n` +
                   `• **Alert Embed Footer**: \`${embedFooter}\`\n\n` +
                   `*Modify settings using the dropdowns and text buttons below.*`,
      timestamp: new Date().toISOString()
    };

    const components = [
      await getNavBarRow(env, guildId, 'config_general'),
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
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'cfg_general_action_select',
          placeholder: '🔧 More actions...',
          options: [
            { label: 'Set Embed Footer Text', value: 'set_footer', description: 'Customize the footer shown on status embeds', emoji: { name: '✍️' } },
            { label: 'Manage Check Schedule', value: 'to_schedule', description: 'Configure what times the bot checks for status updates', emoji: { name: '🗓️' } },
            { label: 'Manage Feature Toggles', value: 'to_toggles', description: 'Enable or disable pings, always-post, and error alerts', emoji: { name: '⚙️' } }
          ],
          min_values: 1,
          max_values: 1
        }]
      }
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_toggles') {
    const pings = config.toggle_pings !== false;
    const errorAlerts = config.toggle_error_alerts !== false;
    const weather = config.toggle_weather !== false;
    const stormMode = config.toggle_storm_mode !== false;

    const embed = {
      title: '⚙️ Settings - Toggles & Options',
      color: 0x3498DB,
      description: `### 🚨 Feature Toggles\n` +
                   `Select which features are **enabled** from the dropdown. Deselected options are automatically **disabled**.\n\n` +
                   `• ${pings ? '🟢' : '🔴'} **Role Mentions** — ping roles on status changes\n` +
                   `• ${errorAlerts ? '🟢' : '🔴'} **Scraper Failure Alerts** — warn staff on consecutive scraper errors\n` +
                   `• ${weather ? '🟢' : '🔴'} **Weather Alerts** — show active NWS alerts for Howard County on status embeds\n` +
                   `• ${stormMode ? '🟢' : '🔴'} **Storm Mode** — extra checks every 15 min (4:30–7:30 AM ET) during storm alerts, posting only on changes\n\n` +
                   `*Select the toggles you want **ON** in the dropdown and submit. Unselected = OFF.*`,
      timestamp: new Date().toISOString()
    };

    // Build default selections based on current config
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
      }
    ];

    const components = [
      await getNavBarRow(env, guildId, 'config_toggles'),
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'cfg_toggle_select',
          placeholder: 'Select which features are ON...',
          options: toggleOptions,
          min_values: 0,
          max_values: 4
        }]
      }
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_status') {
    const STATUS_LABELS = {
      normal_operations: 'Normal Operations',
      schools_closed: 'Schools Closed',
      schools_and_offices_closed: 'Schools and Offices Closed',
      schools_open_2_hours_late: 'Schools Open 2 Hours Late',
      schools_close_3_hours_early: 'Schools Close 3 Hours Early',
      unknown_alert: 'Other/Unknown Alert'
    };

    const editingKey = config.editing_status_key || 'normal_operations';
    const editingLabel = STATUS_LABELS[editingKey] || 'Normal Operations';

    const statusPings = Object.entries(STATUS_LABELS).map(([key, label]) => {
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
      title: '🎨 HCPSS Status Monitor - Status & Theme Config',
      color: 0xE74C3C,
      description: `### 🔔 Roles & Embed Themes\n` +
                   `Select a status from the dropdown to edit its **mention role** and **embed color**.\n\n` +
                   `**Current Mapping:**\n${statusPings}\n\n` +
                   `👉 *Currently editing: **${editingLabel}***`,
      timestamp: new Date().toISOString()
    };

    const components = [
      await getNavBarRow(env, guildId, 'config_status'),
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'cfg_status_select',
          placeholder: `Editing status: ${editingLabel}`,
          options: Object.entries(STATUS_LABELS).map(([key, label]) => ({
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
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: `Set Color for ${editingLabel.split(' ')[0]}...`, custom_id: 'panel_btn_set_color', emoji: { name: '🎨' } }
        ]
      }
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_schedule') {
    const currentSchedule = Array.isArray(config.check_schedule) ? config.check_schedule : [];
    const scheduleLines = currentSchedule
      .map(t => `> ### ${clockEmojiForTime(t)}  ${formatScheduleTimeLabel(t)}`)
      .join('\n');

    const embed = {
      title: '🗓️ HCPSS Status Monitor - Schedule Config',
      color: 0x2ECC71,
      description: `### ⏱️ Daily Check Times (Eastern)\n` +
                   `The bot checks the HCPSS status website at these times every day:\n\n` +
                   `${scheduleLines || '> *(no check times set)*'}\n\n` +
                   `➕ **Add Time** — pick a new check time (up to 4)\n` +
                   `🗑️ Use the dropdown below to remove a time\n` +
                   `🔄 **Reset Defaults** — restore 5:20 AM, 7:20 AM, 10:00 AM & 8:00 PM`,
      timestamp: new Date().toISOString()
    };

    const components = [
      await getNavBarRow(env, guildId, 'config_schedule'),
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
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Add Time', custom_id: 'panel_btn_add_time', emoji: { name: '➕' } },
          { type: 2, style: 2, label: 'Reset Defaults', custom_id: 'panel_btn_reset_schedule', emoji: { name: '🔄' } },
          { type: 2, style: 2, label: 'Back to Settings', custom_id: 'panel_to_config_general', emoji: { name: '⬅️' } }
        ]
      }
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
      title: '🗓️ HCPSS Status Monitor - Add Check Time',
      color: 0x2ECC71,
      description: `## ${clockEmojiForTime(pickedTime)}  ${pickedLabel}\n\n` +
                   `Dial in a time with the three pickers below, then press **Add**.\n` +
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
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: `Add ${pickedLabel}`, custom_id: `panel_btn_confirm_add_time:${h}:${mt}${mo}`, emoji: { name: '✅' } },
          { type: 2, style: 2, label: 'Cancel', custom_id: 'panel_to_config_schedule', emoji: { name: '⬅️' } }
        ]
      }
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_calendar') {
    const checkedAt = new Date();
    const events = [];
    
    for (let i = 0; i < 7; i++) {
      const d = new Date(checkedAt.getTime() + i * 24 * 60 * 60 * 1000);
      const ymd = formatYmdNY(d);
      let event = await env.STATUS_KV.get(`calendar_event:${ymd}`);
      if (!event) {
        event = SCHOOL_CALENDAR_EVENTS[ymd];
      }
      if (event) {
        events.push(`• **${formatStatusDate(d)}** (${ymd}): *${event}*`);
      }
    }
    const calendarList = events.length ? events.join('\n') : '*No scheduled closures or events in the next 7 days.*';

    const embed = {
      title: '📅 HCPSS Status Monitor - School Calendar',
      color: 0xE67E22,
      description: `### 🗓️ Upcoming Closures (Next 7 Days)\n` +
                   `${calendarList}\n\n` +
                   `*Use the buttons below to manage dynamic calendar overrides (e.g. adding closures or custom events).*`,
      timestamp: new Date().toISOString()
    };

    const components = [
      await getNavBarRow(env, guildId, 'config_calendar'),
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Add Event', custom_id: 'panel_btn_add_event', emoji: { name: '➕' } },
          { type: 2, style: 4, label: 'Remove Event', custom_id: 'panel_btn_remove_event', emoji: { name: '➖' } }
        ]
      }
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_commands') {
    const embed = {
      title: '📜 HCPSS Status Monitor - Command Menu',
      color: 0x1ABC9C,
      description: `### 🤖 Available Slash Commands\n\n` +
                   `• **\`/post-status\`**: Post the latest HCPSS status now.\n` +
                   `• **\`/override set\`**: Enable a status override for 1-30 days.\n` +
                   `• **\`/override clear\`**: Disable the active override immediately.\n` +
                   `• **\`/calendar\`**: Show scheduled closures or events in the next 7 days.\n` +
                   `• **\`/history\`**: Show the last 10 operating status changes.\n` +
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
      await getNavBarRow(env, guildId, 'config_commands')
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

    const STATUS_LABELS = {
      normal_operations: 'Normal Operations',
      schools_closed: 'Schools Closed',
      schools_and_offices_closed: 'Schools and Offices Closed',
      schools_open_2_hours_late: 'Schools Open 2 Hours Late',
      schools_close_3_hours_early: 'Schools Close 3 Hours Early',
      unknown_alert: 'Other/Unknown Alert'
    };

    const incidentList = Object.entries(STATUS_LABELS).map(([key, label]) => {
      const count = stats[key] || 0;
      return `• **${label}**: \`${count}\` occurrences`;
    }).join('\n');

    const activeOverride = await getActiveOverride(env, guildId);
    let overrideInfo = '';
    let components = [
      await getNavBarRow(env, guildId, 'config_stats')
    ];

    if (activeOverride) {
      const durationHours = Math.max(0, Math.ceil((activeOverride.until - Date.now()) / (1000 * 60 * 60)));
      const days = Math.ceil(durationHours / 24);
      overrideInfo = `⚠️ **Active Override Detected!**\n` +
                     `• **Status Forced**: \`${STATUS_LABELS[activeOverride.status_key] || activeOverride.status_label}\`\n` +
                     `• **Time Remaining**: \`${days} days\` (~${durationHours} hours)\n` +
                     `• **Details**: *${activeOverride.details || 'None provided.'}*\n` +
                     `• **Custom Title**: *${activeOverride.title || 'None.'}*`;

      components.push({
        type: 1,
        components: [
          { type: 2, style: 4, label: 'Disable Override', custom_id: 'panel_btn_clear_override', emoji: { name: '🛑' } }
        ]
      });
    } else {
      overrideInfo = `✅ **No Active Override**\n*The bot is currently running in Live Scraper Mode, showing the actual status posted on the HCPSS website.*`;
      components.push({
        type: 1,
        components: [
          { type: 2, style: 1, label: 'Set Status Override', custom_id: 'panel_to_config_override_select', emoji: { name: '🛠️' } }
        ]
      });
    }

    const embed = {
      title: '📈 HCPSS Status Monitor - Diagnostics & Stats',
      color: 0x9B59B6,
      description: `### 📊 Scraper Diagnostics\n` +
                   `• **Total Scrapes**: \`${scrapesTotal}\` checks\n` +
                   `• **Failed Scrapes**: \`${scrapesFailed}\` errors\n` +
                   `• **Success Rate**: \`${successRate}%\`\n\n` +
                   `### 📋 Incident Statistics (All-Time)\n` +
                   `${incidentList}\n\n` +
                   `### 🛠️ Status Override Configuration\n` +
                   `${overrideInfo}`,
      timestamp: new Date().toISOString()
    };

    return { embeds: [embed], components };
  }

  if (page === 'config_override_select') {
    const STATUS_LABELS = {
      normal_operations: 'Normal Operations',
      schools_closed: 'Schools Closed',
      schools_and_offices_closed: 'Schools and Offices Closed',
      schools_open_2_hours_late: 'Schools Open 2 Hours Late',
      schools_close_3_hours_early: 'Schools Close 3 Hours Early'
    };

    const editingKey = config.editing_override_status_key || 'normal_operations';
    const editingLabel = STATUS_LABELS[editingKey] || 'Normal Operations';

    const embed = {
      title: '🛠️ Configure Status Override',
      color: 0xF1C40F,
      description: `### ⚠️ Select Status to Override\n` +
                   `Choose the status you want to force from the select menu below, then click **Set Duration & Details** to enter how long the override should last.\n\n` +
                   `👉 *Selected status: **${editingLabel}***`,
      timestamp: new Date().toISOString()
    };

    const components = [
      await getNavBarRow(env, guildId, 'config_stats'),
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
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Set Duration & Details...', custom_id: 'panel_btn_override_details', emoji: { name: '✍️' } },
          { type: 2, style: 2, label: 'Cancel', custom_id: 'panel_to_config_stats', emoji: { name: '⬅️' } }
        ]
      }
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
      title: '📋 HCPSS Status Monitor - Recent Logs',
      color: 0x9B59B6,
      description:
        `### 📋 Recent Logs (last 25)\n` +
        `${logsContent}\n\n` +
        `*Use the view dropdown or buttons below to switch views or manage logs.*`,
      timestamp: new Date().toISOString()
    };

    const components = [
      await getNavBarRow(env, guildId, 'dashboard'),
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'panel_view_select',
          placeholder: '📂 Switch view...',
          options: [
            { label: 'Logging', value: 'dashboard_logs', description: 'View recent bot activity logs', emoji: { name: '📋' }, default: true },
            { label: 'Bot Status', value: 'dashboard_bot_status', description: 'View ping, latency bars, and bot health metrics', emoji: { name: '📡' } }
          ],
          min_values: 1,
          max_values: 1
        }]
      },
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: 'System Status', custom_id: 'panel_to_dashboard', emoji: { name: '📊' } },
          { type: 2, style: 4, label: 'Clear Logs', custom_id: 'panel_clear_logs', emoji: { name: '🗑️' } }
        ]
      }
    ];

    return { embeds: [embed], components };
  }

// Dashboard sub-page: Bot Status
  if (page === 'dashboard_bot_status') {
    return await buildBotStatusPayload(env, guildId, 1);
  }
  // Otherwise, default to Dashboard Page (System Status sub-page)
  const logKey = guildId ? `panel_logs:${guildId}` : 'panel_logs';
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
    title: '🛠️ HCPSS Status Monitor - Control Panel',
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
      `\n*Use the nav dropdown to switch pages. Use the Quick Actions dropdown for diagnostics.*`,
    timestamp: new Date().toISOString()
  };

  const components = [
    await getNavBarRow(env, guildId, 'dashboard'),
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: 'panel_view_select',
        placeholder: '📂 Switch view...',
        options: [
          { label: 'Logging', value: 'dashboard_logs', description: 'View recent bot activity logs', emoji: { name: '📋' } },
          { label: 'Bot Status', value: 'dashboard_bot_status', description: 'View ping, latency bars, and bot health metrics', emoji: { name: '📡' } }
        ],
        min_values: 1,
        max_values: 1
      }]
    },
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: 'panel_action_select',
        placeholder: '⚡ Quick Actions...',
        options: [
          { label: 'Run Status Check', value: 'panel_check', description: 'Fetch HCPSS status and post to alert channel', emoji: { name: '🔍' } },
          { label: 'Test Scraper Speed', value: 'panel_speed', description: 'Measure HCPSS page fetch time and response size', emoji: { name: '⚡' } },
          { label: 'Refresh Panel', value: 'panel_refresh', description: 'Refresh the control panel embed in the log channel', emoji: { name: '🔄' } },
          { label: 'View Status History', value: 'panel_history', description: 'Show last 10 operating status changes (private)', emoji: { name: '📜' } },
          { label: 'View Full Logs', value: 'panel_logs', description: 'Show all 25 stored log entries (private)', emoji: { name: '📋' } },
          { label: 'KV Store Diagnostic', value: 'panel_kv_debug', description: 'Dump all KV keys and values for this guild (private)', emoji: { name: '🗄️' } },
          { label: 'Clear All Logs', value: 'panel_clear_logs', description: 'Permanently wipe the log history for this guild', emoji: { name: '🗑️' } }
        ],
        min_values: 1,
        max_values: 1
      }]
    },
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

async function applyConfigUpdate(body, env) {
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
    const cur = Array.isArray(next.check_schedule) ? next.check_schedule : ['5:20', '7:20', '10:00', '20:00'];
    next.check_schedule = cur.filter(t => t !== values[0]);
  } else if (customId === 'cfg_toggle_select') {
    // Multi-select: selected values = ON, absent values = OFF
    const selected = Array.isArray(values) ? values : [];
    next.toggle_pings = selected.includes('toggle_pings');
    next.toggle_error_alerts = selected.includes('toggle_error_alerts');
    next.toggle_weather = selected.includes('toggle_weather');
    next.toggle_storm_mode = selected.includes('toggle_storm_mode');
  } else if (customId === 'cfg_override_status_select' && Array.isArray(values) && values[0]) {
    next.editing_override_status_key = values[0];
  }

  await setConfig(env, guildId, next);
  return next;
}

async function runEventsCommand(body, env) {
  const options = body && body.data && body.data.options;
  const sub = Array.isArray(options) && options[0] && options[0].type === 1 ? options[0] : null;
  const subName = sub && sub.name ? String(sub.name) : '';
  const subOptions = sub && Array.isArray(sub.options) ? sub.options : [];
  const guildId = body.guild_id || '';
  const invokerId = body && body.member && body.member.user && body.member.user.id;

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

async function runStatsCommand(env) {
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

  const STATUS_LABELS = {
    schools_closed: 'Schools Closed',
    schools_and_offices_closed: 'Schools and Offices Closed',
    schools_open_2_hours_late: 'Schools Open 2 Hours Late',
    schools_close_3_hours_early: 'Schools Close 3 Hours Early',
    unknown_alert: 'Other/Unknown Alert'
  };

  const countsDisplay = Object.entries(STATUS_LABELS).map(([key, label]) => {
    const count = stats[key] || 0;
    return `• **${label}**: ${count}`;
  }).join('\n');

  const history = await getStatusHistory(env);
  const yearStats = computeIncidentStats(history, checkedAt);
  const yearCountsDisplay = Object.entries(STATUS_LABELS).map(([key, label]) => {
    return `• **${label}**: ${yearStats.year[key] || 0}`;
  }).join('\n');
  const lastIncidentStr = yearStats.lastIncident
    ? `<t:${Math.floor(yearStats.lastIncident.timestamp / 1000)}:D> — *${yearStats.lastIncident.date || 'Unknown date'}*`
    : '*None recorded*';

  const embed = {
    title: '📊 HCPSS Status Monitor - Statistics',
    color: 0x34495E,
    description: `**Scraper Diagnostics:**\n` +
                 `• Total Checks: \`${scrapesTotal}\`\n` +
                 `• Scraper Success Rate: \`${uptimePct}%\` (\`${scrapesSuccess}/${scrapesTotal}\` successful)\n\n` +
                 `**This School Year:**\n` +
                 `• ❄️ **Closure Days**: \`${yearStats.snowDays}\`\n` +
                 `• 🕑 **2-Hour Delays**: \`${yearStats.delays}\`\n` +
                 `• 🏃 **Early Closings**: \`${yearStats.earlyCloses}\`\n` +
                 `• 📌 **Last Incident**: ${lastIncidentStr}\n\n` +
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

async function handlePanelRefresh(body, env) {
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

async function handlePanelClearLogs(body, env) {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      if (url.pathname === '/health') {
        return jsonResponse({
          ok: true,
          worker: 'hcpss-worker',
          timestamp: new Date().toISOString(),
          manualTriggerConfigured: !!env.MANUAL_TRIGGER_TOKEN
        });
      }
      return new Response('HCPSS Worker: POST signed Discord interactions here, or POST with a manual trigger token to publish a check.', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const sig = request.headers.get('x-signature-ed25519');
    const ts = request.headers.get('x-signature-timestamp');
    if (sig && ts) {
      const ok = await verifyDiscordRequest(request.clone(), sig, ts, env.DISCORD_PUBLIC_KEY);
      if (!ok) return new Response('Invalid request signature', { status: 401 });

      const body = await request.json();
      if (body.type === 1) return jsonResponse({ type: 1 });

      const guildId = body.guild_id || '';

      if (body.type === 5) {
        // Handle announce modal before the canConfigure gate (staff can announce)
        if (body.data && body.data.custom_id === 'modal_announce') {
          if (!(await canUseCommands(body.member, env, guildId))) {
            return interactionResponse({
              content: '❌ You do not have permission to use `/announce`.',
              flags: EPHEMERAL_FLAG
            });
          }

          const announceTitle = getModalInputValue(body, 'input_announce_title').trim();
          const announceBody  = getModalInputValue(body, 'input_announce_body').trim();
          const announceFooter = getModalInputValue(body, 'input_announce_footer').trim();
          const channelId = body.channel_id || body.channel && body.channel.id || '';

          if (!announceTitle && !announceBody) {
            return interactionResponse({
              content: '❌ Please provide at least a title or message body.',
              flags: EPHEMERAL_FLAG
            });
          }

          if (!channelId) {
            return interactionResponse({
              content: '❌ Could not determine the channel to post in.',
              flags: EPHEMERAL_FLAG
            });
          }

          const invokerId = body.member && body.member.user && body.member.user.id;
          const embed = {
            title: announceTitle || undefined,
            description: announceBody || undefined,
            color: 0x5865F2,
            footer: announceFooter ? { text: announceFooter } : { text: 'HCPSS Status Monitor' },
            timestamp: new Date().toISOString()
          };

          const postRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: 'POST',
            headers: {
              Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ embeds: [embed] })
          });

          if (!postRes.ok) {
            const errText = await postRes.text();
            console.error('Announce post failed:', errText);
            return interactionResponse({
              content: `❌ Failed to post announcement (Discord error ${postRes.status}). Make sure the bot has permission to send messages in this channel.`,
              flags: EPHEMERAL_FLAG
            });
          }

          const stored = await getConfig(env, guildId);
          const cfg = getEffectiveConfig(stored);
          await postLog(env, cfg.log_channel_id, `📣 Announcement posted to <#${channelId}>${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);

          return interactionResponse({
            content: `✅ Announcement posted to <#${channelId}>!`,
            flags: EPHEMERAL_FLAG
          });
        }

        if (!(await canConfigure(body.member, env, guildId))) {
          return interactionResponse({
            content: 'You do not have permission to configure this bot.',
            flags: EPHEMERAL_FLAG
          });
        }

        const modalId = body.data.custom_id;
        let config = await getConfig(env, guildId);
        let updated = false;

        if (modalId === 'modal_set_color') {
          const val = getModalInputValue(body, 'input_color').trim();
          const editingKey = config.editing_status_key || 'normal_operations';

          if (val.toLowerCase() === 'default' || val.toLowerCase() === 'none' || val.toLowerCase() === 'clear') {
            if (!config.status_embed_colors) config.status_embed_colors = {};
            delete config.status_embed_colors[editingKey];
            updated = true;
          } else {
            const hexMatch = val.match(/^#?([0-9A-Fa-f]{6})$/);
            if (hexMatch) {
              const colorInt = parseInt(hexMatch[1], 16);
              if (!config.status_embed_colors) config.status_embed_colors = {};
              config.status_embed_colors[editingKey] = colorInt;
              updated = true;
            } else {
              return interactionResponse({
                content: `❌ Invalid HEX color \`${val}\`. Use a 6-digit hex code (e.g. \`2ECC71\`).`,
                flags: EPHEMERAL_FLAG
              });
            }
          }
        }

        if (modalId === 'modal_set_footer') {
          const val = getModalInputValue(body, 'input_footer').trim();
          if (val.toLowerCase() === 'default' || val.toLowerCase() === 'none' || val.toLowerCase() === 'clear') {
            delete config.alert_embed_footer;
            updated = true;
          } else {
            config.alert_embed_footer = val.slice(0, 2048);
            updated = true;
          }
        }

        if (modalId === 'modal_add_event') {
          const dateStr = getModalInputValue(body, 'input_event_date').trim();
          const descStr = getModalInputValue(body, 'input_event_desc').trim();
          if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            await env.STATUS_KV.put(`calendar_event:${dateStr}`, descStr);
            const invokerId = body.member && body.member.user && body.member.user.id;
            await postLog(env, config.log_channel_id, `📅 Calendar event added: **${dateStr}** - *${descStr}*${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);
            updated = true;
          } else {
            return interactionResponse({
              content: '❌ Invalid date format. Please use `YYYY-MM-DD` (e.g. `2026-12-25`).',
              flags: EPHEMERAL_FLAG
            });
          }
        }

        if (modalId === 'modal_remove_event') {
          const dateStr = getModalInputValue(body, 'input_event_date').trim();
          if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            await env.STATUS_KV.delete(`calendar_event:${dateStr}`);
            const invokerId = body.member && body.member.user && body.member.user.id;
            await postLog(env, config.log_channel_id, `📅 Calendar event removed for date: **${dateStr}**${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);
            updated = true;
          } else {
            return interactionResponse({
              content: '❌ Invalid date format. Please use `YYYY-MM-DD` (e.g. `2026-12-25`).',
              flags: EPHEMERAL_FLAG
            });
          }
        }

        if (modalId === 'modal_set_override') {
          const daysRaw = getModalInputValue(body, 'input_override_days').trim();
          const titleRaw = getModalInputValue(body, 'input_override_title').trim();
          const detailsRaw = getModalInputValue(body, 'input_override_details').trim();

          const daysParsed = parseInt(daysRaw, 10);
          if (isNaN(daysParsed) || daysParsed < 1 || daysParsed > 30) {
            return interactionResponse({
              content: '❌ Invalid duration. Please specify a number of days between 1 and 30.',
              flags: EPHEMERAL_FLAG
            });
          }

          const overrideStatusKey = config.editing_override_status_key || 'normal_operations';
          const STATUS_LABELS = {
            normal_operations: 'Normal Operations',
            schools_closed: 'Schools Closed',
            schools_and_offices_closed: 'Schools and Offices Closed',
            schools_open_2_hours_late: 'Schools Open 2 Hours Late',
            schools_close_3_hours_early: 'Schools Close 3 Hours Early'
          };
          const statusLabel = STATUS_LABELS[overrideStatusKey] || 'Override';

          const overrideObj = {
            status_key: overrideStatusKey,
            status_label: statusLabel,
            details: detailsRaw,
            title: titleRaw,
            until: Date.now() + daysParsed * 24 * 60 * 60 * 1000
          };

          await setOverride(env, guildId, overrideObj);

          const invokerId = body.member && body.member.user && body.member.user.id;
          await postLog(env, config.log_channel_id, `🛠️ Status override enabled: **${statusLabel}** for **${daysParsed} days**${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);

          ctx.waitUntil(doCheckAndPost(env, { source: 'override-set', invokerId, guildId }));

          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_stats');
          delete config.editing_override_status_key;
          updated = true;
        }

        if (updated) {
          await setConfig(env, guildId, config);
        }

        const payload = await buildControlPanelPayload(env, guildId, updated ? config : null);
        return jsonResponse({
          type: 7,
          data: payload
        });
      }

      if (body.type === 2 && body.data && body.data.name === 'setup') {
        if (!memberIsAdmin(body.member)) {
          return interactionResponse({
            content: '❌ This command is only allowed for users with Administrator permissions.',
            flags: EPHEMERAL_FLAG
          });
        }
        const setupDoneKey = `setup_done:${guildId}`;
        const setupDone = await env.STATUS_KV.get(setupDoneKey);
        if (setupDone === 'true') {
          return jsonResponse({
            type: 4,
            data: {
              content: '⚠️ **HCPSS Status Monitor Setup Alert**\n\nThis command has already been run in this server. Running setup again will create duplicate notification roles and may disrupt your current configuration.\n\nAre you sure you want to proceed?',
              components: [
                {
                  type: 1,
                  components: [
                    {
                      type: 2,
                      style: 4,
                      label: 'Proceed Anyway',
                      custom_id: 'setup_proceed_anyway'
                    },
                    {
                      type: 2,
                      style: 2,
                      label: 'Cancel Setup',
                      custom_id: 'setup_cancel'
                    }
                  ]
                }
              ],
              flags: EPHEMERAL_FLAG
            }
          });
        }
        return jsonResponse({
          type: 4,
          data: {
            content: '⚙️ **HCPSS Status Monitor Setup**\n\nWhich channel should the bot post system logs and the control panel to?',
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 8,
                    custom_id: 'setup_select_log_channel',
                    placeholder: 'Select logging channel',
                    min_values: 1,
                    max_values: 1,
                    channel_types: [0, 5]
                  }
                ]
              }
            ],
            flags: EPHEMERAL_FLAG
          }
        });
      }

      if (body.type === 2 && !(await canUseCommands(body.member, env, guildId))) {
        return interactionResponse({
          content: 'You do not have permission to use this bot command.',
          flags: EPHEMERAL_FLAG
        });
      }

      if (body.type === 2 && body.data && body.data.name === POST_STATUS_COMMAND) {
        ctx.waitUntil(runPostStatusCommand(body, env));
        return deferredInteractionResponse();
      }

      if (body.type === 2 && body.data && body.data.name === OVERRIDE_COMMAND) {
        ctx.waitUntil(runOverrideCommand(body, env));
        return deferredInteractionResponse();
      }

      if (body.type === 2 && body.data && body.data.name === 'calendar') {
        const payload = runCalendarCommand();
        return interactionResponse(payload);
      }

      if (body.type === 2 && body.data && body.data.name === 'history') {
        const payload = await runHistoryCommand(env);
        return interactionResponse(payload);
      }

      if (body.type === 2 && body.data && body.data.name === 'events') {
        ctx.waitUntil(runEventsCommand(body, env));
        return deferredInteractionResponse();
      }

      if (body.type === 2 && body.data && body.data.name === 'stats') {
        const payload = await runStatsCommand(env);
        return interactionResponse(payload);
      }

      if (body.type === 2 && body.data && body.data.name === 'refresh-panel') {
        ctx.waitUntil(handlePanelRefresh(body, env));
        return deferredInteractionResponse();
      }

      if (body.type === 2 && body.data && body.data.name === ANNOUNCE_COMMAND) {
        return jsonResponse({
          type: 9,
          data: {
            title: '📣 Post an Announcement',
            custom_id: 'modal_announce',
            components: [
              {
                type: 1,
                components: [{
                  type: 4,
                  custom_id: 'input_announce_title',
                  style: 1,
                  label: 'Title',
                  placeholder: 'e.g. Important Notice',
                  max_length: 256,
                  required: false
                }]
              },
              {
                type: 1,
                components: [{
                  type: 4,
                  custom_id: 'input_announce_body',
                  style: 2,
                  label: 'Message',
                  placeholder: 'Type the full announcement here...',
                  max_length: 3900,
                  required: true
                }]
              },
              {
                type: 1,
                components: [{
                  type: 4,
                  custom_id: 'input_announce_footer',
                  style: 1,
                  label: 'Footer (optional)',
                  placeholder: 'e.g. HCPSS Administration',
                  max_length: 256,
                  required: false
                }]
              }
            ]
          }
        });
      }

      if (body.type === 3 && body.data && typeof body.data.custom_id === 'string' && body.data.custom_id.startsWith('panel_')) {
        if (!(await canUseCommands(body.member, env, guildId))) {
          return interactionResponse({
            content: 'You do not have permission to use the control panel.',
            flags: EPHEMERAL_FLAG
          });
        }

        const customId = body.data.custom_id;

        if (customId === 'panel_nav_select') {
          const selected = Array.isArray(body.data.values) && body.data.values[0];
          const target = PANEL_NAV_TABS.some(t => t.value === selected) ? selected : 'dashboard';
          await env.STATUS_KV.put(`panel_page:${guildId}`, target);
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_view_select') {
          const selected = Array.isArray(body.data.values) && body.data.values[0];
          const allowed = ['dashboard_logs', 'dashboard_bot_status'];
          const target = allowed.includes(selected) ? selected : 'dashboard_logs';
          await env.STATUS_KV.put(`panel_page:${guildId}`, target);
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_action_select') {
          const action = Array.isArray(body.data.values) && body.data.values[0];
          if (action === 'panel_check') {
            ctx.waitUntil(handlePanelCheck(body, env));
            return deferredInteractionResponse();
          }
          if (action === 'panel_speed') {
            ctx.waitUntil(handlePanelSpeed(body, env));
            return deferredInteractionResponse();
          }
          if (action === 'panel_refresh') {
            ctx.waitUntil(handlePanelRefresh(body, env));
            return deferredInteractionResponse();
          }
          if (action === 'panel_history') {
            const payload = await runHistoryCommand(env);
            return interactionResponse(payload);
          }
          if (action === 'panel_logs') {
            const payload = await runLogsCommand(env, guildId);
            return interactionResponse(payload);
          }
          if (action === 'panel_kv_debug') {
            ctx.waitUntil(handlePanelKvDebug(body, env));
            return deferredInteractionResponse();
          }
          if (action === 'panel_clear_logs') {
            ctx.waitUntil(handlePanelClearLogs(body, env));
            return deferredInteractionResponse();
          }
          return interactionResponse({ content: '❌ Unknown action.', flags: EPHEMERAL_FLAG });
        }



        if (customId === 'panel_speed') {
          ctx.waitUntil(handlePanelSpeed(body, env));
          return deferredInteractionResponse();
        }

        if (customId === 'panel_check') {
          ctx.waitUntil(handlePanelCheck(body, env));
          return deferredInteractionResponse();
        }

        if (customId === 'panel_history') {
          const payload = await runHistoryCommand(env);
          return interactionResponse(payload);
        }

        if (customId === 'panel_logs') {
          const payload = await runLogsCommand(env, guildId);
          return interactionResponse(payload);
        }

        if (customId === 'panel_refresh') {
          ctx.waitUntil(handlePanelRefresh(body, env));
          return deferredInteractionResponse();
        }

        if (customId === 'panel_clear_logs') {
          ctx.waitUntil(handlePanelClearLogs(body, env));
          return deferredInteractionResponse();
        }

        if (customId === 'panel_to_config_general') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_general');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_to_config_status') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_status');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_to_config_schedule') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_schedule');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_to_config_toggles') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_toggles');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_to_config_calendar') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_calendar');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_to_config_stats') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_stats');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_to_config_override_select') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_override_select');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_to_config_commands') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_commands');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_to_dashboard') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'dashboard');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_to_dashboard_logs') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'dashboard_logs');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_to_dashboard_bot_status') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'dashboard_bot_status');

          ctx.waitUntil((async () => {
            const frames = [0.15, 0.4, 0.7, 1];
            for (let i = 0; i < frames.length; i++) {
              const payload = await buildBotStatusPayload(env, guildId, frames[i]);
              await updateInteractionOriginal(env, body.token, payload);
              if (i < frames.length - 1) await delay(450);
            }
          })());

          return jsonResponse({ type: 6 });
        }

        if (customId === 'panel_btn_clear_override') {
          await clearOverride(env, guildId);
          const invokerId = body.member && body.member.user && body.member.user.id;
          ctx.waitUntil(doCheckAndPost(env, { source: 'override-clear', invokerId, guildId }));
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_stats');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_btn_reset_schedule') {
          if (!(await canConfigure(body.member, env, guildId))) {
            return interactionResponse({
              content: 'You do not have permission to configure this bot.',
              flags: EPHEMERAL_FLAG
            });
          }
          const storedCfg = await getConfig(env, guildId);
          storedCfg.check_schedule = ['5:20', '7:20', '10:00', '20:00'];
          await setConfig(env, guildId, storedCfg);
          const invokerId = body.member && body.member.user && body.member.user.id;
          await postLog(env, getEffectiveConfig(storedCfg).log_channel_id, `🗓️ Check schedule reset to defaults${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);
          const payload = await buildControlPanelPayload(env, guildId, storedCfg);
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_btn_add_time') {
          const storedCfg = await getConfig(env, guildId);
          const effectiveCfg = getEffectiveConfig(storedCfg);
          if ((effectiveCfg.check_schedule || []).length >= 4) {
            return interactionResponse({
              content: '❌ You already have 4 check times. Remove one first.',
              flags: EPHEMERAL_FLAG
            });
          }
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_schedule_add');
          const payload = await buildControlPanelPayload(env, guildId, storedCfg, 'config_schedule_add');
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId.startsWith('panel_btn_confirm_add_time')) {
          if (!(await canConfigure(body.member, env, guildId))) {
            return interactionResponse({
              content: 'You do not have permission to configure this bot.',
              flags: EPHEMERAL_FLAG
            });
          }

          // The picked time is encoded in the button's custom_id so the add is
          // always exactly what the panel displayed, independent of KV staleness.
          const bits = customId.split(':');
          const hours = parseInt(bits[1], 10);
          const mm = bits[2] || '';
          if (isNaN(hours) || hours > 23 || !/^\d{2}$/.test(mm) || parseInt(mm, 10) > 59) {
            return interactionResponse({
              content: '❌ Could not read the picked time. Please try again.',
              flags: EPHEMERAL_FLAG
            });
          }
          const newTime = `${hours}:${mm}`;

          const storedCfg = await getConfig(env, guildId);
          const current = getEffectiveConfig(storedCfg).check_schedule || [];
          if (current.length >= 4 && !current.includes(newTime)) {
            return interactionResponse({
              content: '❌ You already have 4 check times. Remove one first.',
              flags: EPHEMERAL_FLAG
            });
          }

          const merged = current.includes(newTime) ? current.slice() : [...current, newTime];
          merged.sort((a, b) => {
            const [ah, am] = a.split(':').map(Number);
            const [bh, bm] = b.split(':').map(Number);
            return (ah * 60 + am) - (bh * 60 + bm);
          });
          storedCfg.check_schedule = merged;
          delete storedCfg.schedule_pick;
          await setConfig(env, guildId, storedCfg);

          const invokerId = body.member && body.member.user && body.member.user.id;
          await postLog(env, getEffectiveConfig(storedCfg).log_channel_id, `🗓️ Check time added: **${formatScheduleTimeLabel(newTime)}**${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);

          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_schedule');
          const payload = await buildControlPanelPayload(env, guildId, storedCfg, 'config_schedule');
          return jsonResponse({ type: 7, data: payload });
        }

        if (customId === 'panel_btn_add_event') {
          return jsonResponse({
            type: 9,
            data: {
              title: 'Add Calendar Event',
              custom_id: 'modal_add_event',
              components: [
                {
                  type: 1,
                  components: [{
                    type: 4,
                    custom_id: 'input_event_date',
                    style: 1,
                    label: 'Date (YYYY-MM-DD)',
                    placeholder: '2026-12-25',
                    min_length: 10,
                    max_length: 10,
                    required: true
                  }]
                },
                {
                  type: 1,
                  components: [{
                    type: 4,
                    custom_id: 'input_event_desc',
                    style: 1,
                    label: 'Event Description',
                    placeholder: 'Christmas Holiday - Schools Closed',
                    max_length: 200,
                    required: true
                  }]
                }
              ]
            }
          });
        }

        if (customId === 'panel_btn_remove_event') {
          return jsonResponse({
            type: 9,
            data: {
              title: 'Remove Calendar Event',
              custom_id: 'modal_remove_event',
              components: [{
                type: 1,
                components: [{
                  type: 4,
                  custom_id: 'input_event_date',
                  style: 1,
                  label: 'Date of Event to Remove (YYYY-MM-DD)',
                  placeholder: '2026-12-25',
                  min_length: 10,
                  max_length: 10,
                  required: true
                }]
              }]
            }
          });
        }

        if (customId === 'panel_btn_override_details') {
          const config = await getConfig(env, guildId);
          const overrideStatusKey = config.editing_override_status_key || 'normal_operations';
          const STATUS_LABELS = {
            normal_operations: 'Normal Operations',
            schools_closed: 'Schools Closed',
            schools_and_offices_closed: 'Schools and Offices Closed',
            schools_open_2_hours_late: 'Schools Open 2 Hours Late',
            schools_close_3_hours_early: 'Schools Close 3 Hours Early'
          };
          const statusLabel = STATUS_LABELS[overrideStatusKey] || 'Override';

          return jsonResponse({
            type: 9,
            data: {
              title: `Set Override: ${statusLabel.split(' ')[0]}`,
              custom_id: 'modal_set_override',
              components: [
                {
                  type: 1,
                  components: [{
                    type: 4,
                    custom_id: 'input_override_days',
                    style: 1,
                    label: 'Duration in Days (1-30)',
                    placeholder: '1',
                    min_length: 1,
                    max_length: 2,
                    required: true
                  }]
                },
                {
                  type: 1,
                  components: [{
                    type: 4,
                    custom_id: 'input_override_title',
                    style: 1,
                    label: 'Embed Title Override (Optional)',
                    placeholder: `HCPSS Status (Override) - ${statusLabel}`,
                    required: false,
                    max_length: 256
                  }]
                },
                {
                  type: 1,
                  components: [{
                    type: 4,
                    custom_id: 'input_override_details',
                    style: 2,
                    label: 'Details/Reason (Optional)',
                    placeholder: 'Inclement weather conditions...',
                    required: false,
                    max_length: 1000
                  }]
                }
              ]
            }
          });
        }

        if (customId === 'panel_btn_set_color') {
          const config = await getConfig(env, guildId);
          const editingKey = config.editing_status_key || 'normal_operations';
          const STATUS_LABELS = {
            normal_operations: 'Normal Operations',
            schools_closed: 'Schools Closed',
            schools_and_offices_closed: 'Schools and Offices Closed',
            schools_open_2_hours_late: 'Schools Open 2 Hours Late',
            schools_close_3_hours_early: 'Schools Close 3 Hours Early',
            unknown_alert: 'Other/Unknown Alert'
          };
          const statusLabel = STATUS_LABELS[editingKey] || editingKey;

          return jsonResponse({
            type: 9,
            data: {
              title: `Set Color: ${statusLabel.split(' ')[0]}`,
              custom_id: 'modal_set_color',
              components: [{
                type: 1,
                components: [{
                  type: 4,
                  custom_id: 'input_color',
                  style: 1,
                  label: `HEX Color for ${statusLabel.split(' ')[0]} (or default)`,
                  placeholder: "2ECC71",
                  min_length: 1,
                  max_length: 10,
                  required: true
                }]
              }]
            }
          });
        }

        if (customId === 'panel_btn_set_footer') {
          const config = await getConfig(env, guildId);
          const currentFooter = config.alert_embed_footer || '';

          return jsonResponse({
            type: 9,
            data: {
              title: 'Set Embed Footer Text',
              custom_id: 'modal_set_footer',
              components: [{
                type: 1,
                components: [{
                  type: 4,
                  custom_id: 'input_footer',
                  style: 2,
                  label: "Custom Footer (or default)",
                  placeholder: "Howard County Public School System Daily Monitor",
                  value: currentFooter,
                  min_length: 1,
                  max_length: 1000,
                  required: true
                }]
              }]
            }
          });
        }

        // Legacy button handlers kept for backwards compatibility
        if (customId === 'panel_speed') {
          ctx.waitUntil(handlePanelSpeed(body, env));
          return deferredInteractionResponse();
        }
        if (customId === 'panel_check') {
          ctx.waitUntil(handlePanelCheck(body, env));
          return deferredInteractionResponse();
        }
        if (customId === 'panel_history') {
          const payload = await runHistoryCommand(env);
          return interactionResponse(payload);
        }
        if (customId === 'panel_logs') {
          const payload = await runLogsCommand(env, guildId);
          return interactionResponse(payload);
        }
        if (customId === 'panel_clear_logs') {
          ctx.waitUntil(handlePanelClearLogs(body, env));
          return deferredInteractionResponse();
        }
      }

      if (body.type === 3 && body.data && body.data.custom_id === 'panel_trigger_test_alert') {
        if (!(await canConfigure(body.member, env, guildId))) {
          return interactionResponse({
            content: '❌ You do not have permission to run scraper diagnostics.',
            flags: EPHEMERAL_FLAG
          });
        }

        const selectedStatusKey = body.data.values && body.data.values[0];
        if (!selectedStatusKey) {
          return interactionResponse({
            content: '❌ No status was selected.',
            flags: EPHEMERAL_FLAG
          });
        }

        ctx.waitUntil((async () => {
          try {
            const token = env.DISCORD_BOT_TOKEN;
            const invokerId = body && body.member && body.member.user && body.member.user.id;
            const stored = await getConfig(env, guildId);
            const config = getEffectiveConfig(stored);
            const alertChannelId = config.alert_channel_id || (guildId === env.DISCORD_GUILD_ID ? env.DISCORD_CHANNEL_ID : null);
            const logChannelId = config.log_channel_id;

            if (!alertChannelId) {
              await updateInteractionOriginal(env, body.token, {
                content: '❌ Scraper test failed: Alert channel is not configured. Please set it in **General Config**.',
                components: []
              });
              return;
            }

            const MOCK_DATA = {
              normal_operations: {
                title: 'Normal Operations',
                body: 'All schools and offices will open on time. Staff and students report in accordance with the HCPSS calendar.'
              },
              schools_closed: {
                title: 'Schools Closed',
                body: 'All Howard County public schools are closed today. All evening activities are cancelled.'
              },
              schools_and_offices_closed: {
                title: 'Schools and Offices Closed',
                body: 'All Howard County public schools and offices are closed today. Emergency personnel report as scheduled.'
              },
              schools_open_2_hours_late: {
                title: 'Schools Open 2 Hours Late',
                body: 'All Howard County public schools will open two hours late today. Morning pre-K and half-day classes are cancelled.'
              },
              schools_close_3_hours_early: {
                title: 'Schools Close 3 Hours Early',
                body: 'All Howard County public schools will close three hours early today. Afternoon pre-K and evening activities are cancelled.'
              },
              unknown_alert: {
                title: 'Special Notice / Alert',
                body: 'The HCPSS status page has posted a custom/unknown weather notice. Please consult the HCPSS website for specific details.'
              }
            };

            const mock = MOCK_DATA[selectedStatusKey] || MOCK_DATA.unknown_alert;
            const cards = [{
              title: mock.title,
              body: `🧪 **[TEST ALERT - SIMULATED STATUS]**\n\n${mock.body}`
            }];

            const statusKey = selectedStatusKey;
            let roleId = undefined;
            if (config.status_ping_roles) {
              roleId = config.status_ping_roles[statusKey];
            }

            let rolesToPing = [];
            const pingRoleIds = Array.isArray(config.ping_role_ids) ? config.ping_role_ids : [];
            if (roleId) {
              rolesToPing = [roleId];
            } else if (roleId === undefined && statusKey !== 'normal_operations') {
              rolesToPing = pingRoleIds;
            }

            const content = rolesToPing.length ? rolesToPing.map(id => `<@&${id}>`).join(' ') : '';
            const customFooter = config.alert_embed_footer || 'HCPSS Status Monitor';
            const color = config.status_embed_colors && typeof config.status_embed_colors[statusKey] === 'number'
              ? config.status_embed_colors[statusKey]
              : getDefaultStatusColor(statusKey);

            const thumbnailUrl = getStatusThumbnail(statusKey);
            const embeds = splitEmbeds(
              `HCPSS Status for Today (Test)`,
              cards[0].body,
              HCPSS_URL,
              color,
              customFooter,
              new Date(),
              thumbnailUrl
            ).slice(0, MAX_EMBEDS);

            const postResp = await fetch(`https://discord.com/api/v10/channels/${alertChannelId}/messages`, {
              method: 'POST',
              headers: {
                Authorization: `Bot ${token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                content,
                embeds,
                allowed_mentions: rolesToPing.length ? { roles: rolesToPing } : { parse: [] }
              })
            });

            if (!postResp.ok) {
              const errTxt = await postResp.text();
              throw new Error(`Discord API error posting test message: ${postResp.status} ${errTxt}`);
            }

            await postLog(
              env,
              logChannelId,
              `🧪 Scraper test alert for '${statusKey}' triggered by <@${invokerId}>. Sent to <#${alertChannelId}>.`,
              {},
              guildId
            );

            const STATUS_LABELS = {
              normal_operations: 'Normal Operations',
              schools_closed: 'Schools Closed',
              schools_and_offices_closed: 'Schools and Offices Closed',
              schools_open_2_hours_late: 'Schools Open 2 Hours Late',
              schools_close_3_hours_early: 'Schools Close 3 Hours Early',
              unknown_alert: 'Other/Unknown Alert'
            };

            await updateInteractionOriginal(env, body.token, {
              content: `✅ **Diagnostic Test Successful!**\n\n` +
                       `• Status Simulated: **${STATUS_LABELS[selectedStatusKey] || selectedStatusKey}**\n` +
                       `• Alert Channel: <#${alertChannelId}>\n` +
                       `• Role Pings: ${rolesToPing.length ? rolesToPing.map(id => `<@&${id}>`).join(', ') : '*(none)*'}\n\n` +
                       `Check <#${alertChannelId}> to see the rendered test embed card.`,
              components: []
            });
          } catch (err) {
            console.error('Test alert failed:', err);
            await updateInteractionOriginal(env, body.token, {
              content: `❌ **Test Alert Failed:** ${err.message}`,
              components: []
            });
          }
        })());

        return deferredInteractionResponse();
      }

      if (body.type === 3 && body.data && body.data.custom_id === 'dm_subscribe') {
        // Open to everyone — subscribing only affects the user's own DMs.
        const userId = (body.member && body.member.user && body.member.user.id) || (body.user && body.user.id);
        if (!userId) {
          return interactionResponse({ content: '❌ Could not determine your user ID.', flags: EPHEMERAL_FLAG });
        }
        const result = await toggleSubscriber(env, guildId, userId);
        if (result.full) {
          return interactionResponse({ content: '❌ The subscriber list for this server is full.', flags: EPHEMERAL_FLAG });
        }
        return interactionResponse({
          content: result.subscribed
            ? "🔔 **Subscribed!** I'll DM you whenever the HCPSS operating status changes (not on every scheduled repost). Make sure DMs from this server's members are enabled. Click the button again to unsubscribe."
            : '🔕 **Unsubscribed.** You will no longer get DMs when the status changes.',
          flags: EPHEMERAL_FLAG
        });
      }

      if (body.type === 3 && body.data && body.data.custom_id === 'check_again') {
        const builtStatus = await buildStatusPayload(env, { footer: 'HCPSS Status Monitor - Only you can see this', guildId });
        return interactionResponse({
          content: '',
          embeds: builtStatus.payload.embeds,
          flags: EPHEMERAL_FLAG
        });
      }

      if (body.type === 3 && body.data && body.data.custom_id === 'setup_cancel') {
        if (!memberIsAdmin(body.member)) {
          return interactionResponse({
            content: '❌ Only users with Administrator permissions can interact with setup.',
            flags: EPHEMERAL_FLAG
          });
        }
        return jsonResponse({
          type: 7,
          data: {
            content: '❌ Setup cancelled.',
            components: []
          }
        });
      }

      if (body.type === 3 && body.data && body.data.custom_id === 'setup_proceed_anyway') {
        if (!memberIsAdmin(body.member)) {
          return interactionResponse({
            content: '❌ Only users with Administrator permissions can interact with setup.',
            flags: EPHEMERAL_FLAG
          });
        }
        return jsonResponse({
          type: 7,
          data: {
            content: '⚙️ **HCPSS Status Monitor Setup (Force Rerun)**\n\nWhich channel should the bot post system logs and the control panel to?',
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 8,
                    custom_id: 'setup_select_log_channel_force',
                    placeholder: 'Select logging channel',
                    min_values: 1,
                    max_values: 1,
                    channel_types: [0, 5]
                  }
                ]
              }
            ]
          }
        });
      }

      if (body.type === 3 && body.data && (body.data.custom_id === 'setup_select_log_channel' || body.data.custom_id === 'setup_select_log_channel_force')) {
        if (!memberIsAdmin(body.member)) {
          return interactionResponse({
            content: '❌ Only users with Administrator permissions can complete the setup.',
            flags: EPHEMERAL_FLAG
          });
        }

        const setupDoneKey = `setup_done:${guildId}`;
        const isForce = body.data.custom_id === 'setup_select_log_channel_force';
        if (!isForce) {
          const setupDone = await env.STATUS_KV.get(setupDoneKey);
          if (setupDone === 'true') {
            return interactionResponse({
              content: '❌ The `/setup` command has already been run in this server.',
              flags: EPHEMERAL_FLAG
            });
          }
        }

        const selectedChannelId = body.data.values && body.data.values[0];
        if (!selectedChannelId) {
          return interactionResponse({
            content: '❌ No channel was selected.',
            flags: EPHEMERAL_FLAG
          });
        }

        ctx.waitUntil((async () => {
          try {
            await updateInteractionOriginal(env, body.token, {
              content: '⚙️ **HCPSS Status Monitor Setup**\n\n⏳ Creating status notification roles and configuring the bot...',
              components: []
            });

            const token = env.DISCORD_BOT_TOKEN;
            const rolesToCreate = [
              { key: 'normal_operations', name: 'HCPSS Normal Operations' },
              { key: 'schools_closed', name: 'HCPSS Schools Closed' },
              { key: 'schools_and_offices_closed', name: 'HCPSS Schools and Offices Closed' },
              { key: 'schools_open_2_hours_late', name: 'HCPSS Schools Open 2 Hours Late' },
              { key: 'schools_close_3_hours_early', name: 'HCPSS Schools Close 3 Hours Early' },
              { key: 'unknown_alert', name: 'HCPSS Other/Unknown Alert' }
            ];

            const stored = await getConfig(env, guildId);
            const config = { ...stored };
            config.log_channel_id = selectedChannelId;
            if (!config.status_ping_roles) config.status_ping_roles = {};

            // Fetch guild roles to check if they already exist in the server
            let guildRoles = [];
            try {
              const rolesUrl = `https://discord.com/api/v10/guilds/${guildId}/roles`;
              const rolesResp = await fetch(rolesUrl, {
                method: 'GET',
                headers: {
                  Authorization: `Bot ${token}`,
                  'Content-Type': 'application/json'
                }
              });
              if (rolesResp.ok) {
                guildRoles = await rolesResp.json();
              }
            } catch (err) {
              console.error('Failed to fetch guild roles, falling back to config check only:', err);
            }

            const createdRoles = await Promise.all(
              rolesToCreate.map(async (role) => {
                const existingId = config.status_ping_roles[role.key];

                // 1. Check if the ID stored in config exists in the server
                if (existingId && guildRoles.some(r => r.id === existingId)) {
                  return { key: role.key, name: role.name, id: existingId };
                }

                // 2. Check if a role with the same name exists in the server
                const matchByName = guildRoles.find(r => r.name === role.name);
                if (matchByName) {
                  return { key: role.key, name: role.name, id: matchByName.id };
                }

                // 3. Otherwise, create a new role
                const roleId = await createGuildRole(guildId, role.name, token);
                return { key: role.key, name: role.name, id: roleId };
              })
            );

            for (const r of createdRoles) {
              config.status_ping_roles[r.key] = r.id;
            }

            await setConfig(env, guildId, config);
            await env.STATUS_KV.put(setupDoneKey, 'true');

            await postLog(env, selectedChannelId, 'Bot setup completed successfully. Notification roles created and registered.', {}, guildId);

            const roleList = createdRoles.map(r => `• **${r.name}**: <@&${r.id}>`).join('\n');
            await updateInteractionOriginal(env, body.token, {
              content: `✅ **Setup Complete!**\n\n` +
                       `• Log channel set to <#${selectedChannelId}>\n` +
                       `• Created and configured notification roles:\n${roleList}\n\n` +
                       `The Control Panel has been published to <#${selectedChannelId}>.`,
              components: []
            });
          } catch (err) {
            console.error('Setup failed:', err);
            await updateInteractionOriginal(env, body.token, {
              content: `❌ **Setup Failed:** ${err.message}`,
              components: []
            });
          }
        })());

        return deferredInteractionResponse();
      }

      if (body.type === 3 && body.data && body.data.custom_id === 'cfg_general_action_select') {
        if (!(await canConfigure(body.member, env, guildId))) {
          return interactionResponse({
            content: 'You do not have permission to configure this bot.',
            flags: EPHEMERAL_FLAG
          });
        }

        const action = Array.isArray(body.data.values) && body.data.values[0];

        if (action === 'set_footer') {
          const config = await getConfig(env, guildId);
          const currentFooter = config.alert_embed_footer || '';
          return jsonResponse({
            type: 9,
            data: {
              title: 'Set Embed Footer Text',
              custom_id: 'modal_set_footer',
              components: [{
                type: 1,
                components: [{
                  type: 4,
                  custom_id: 'input_footer',
                  style: 2,
                  label: 'Custom Footer (or default)',
                  placeholder: 'Howard County Public School System Daily Monitor',
                  value: currentFooter,
                  min_length: 1,
                  max_length: 1000,
                  required: true
                }]
              }]
            }
          });
        }

        if (action === 'to_schedule') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_schedule');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        if (action === 'to_toggles') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_toggles');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({ type: 7, data: payload });
        }

        return interactionResponse({ content: '❌ Unknown action.', flags: EPHEMERAL_FLAG });
      }

      if (body.type === 3 && body.data && typeof body.data.custom_id === 'string' && body.data.custom_id.startsWith('cfg_')) {
        if (!(await canConfigure(body.member, env, guildId))) {
          return interactionResponse({
            content: 'You do not have permission to configure this bot.',
            flags: EPHEMERAL_FLAG
          });
        }

        const freshConfig = await applyConfigUpdate(body, env);
        const cfgCustomId = body.data.custom_id;
        let pageHint = null;
        if (cfgCustomId.startsWith('cfg_schedpick_')) pageHint = 'config_schedule_add';
        else if (cfgCustomId === 'cfg_schedremove_select') pageHint = 'config_schedule';
        const payload = await buildControlPanelPayload(env, guildId, freshConfig, pageHint);
        return jsonResponse({
          type: 7,
          data: payload
        });
      }

      return interactionResponse({
        content: 'Interaction received.',
        flags: EPHEMERAL_FLAG
      });
    }

    const manualTriggerError = validateManualTrigger(request, env);
    if (manualTriggerError) return manualTriggerError;

    try {
      const result = await doCheckAndPost(env, { source: 'manual' });
      if (!result.isError) {
        return new Response(`Success: ${result.message}`, { status: 200 });
      }
      return new Response('Scraper check failed: ' + result.error, { status: 500 });
    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await doCheckAndPost(env, { source: 'scheduled' });
      } catch (e) {
        console.error('Scheduled run failed', e);
      }
    })());
  }
};
