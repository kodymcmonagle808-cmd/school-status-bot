const HCPSS_URL = 'https://status.hcpss.org';
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

const SCHEDULE_OPTIONS = [
  { label: '5:20 AM', value: '5:20' },
  { label: '7:20 AM', value: '7:20' },
  { label: '10:00 AM', value: '10:00' },
  { label: '8:00 PM', value: '20:00' }
];

function getEasternTimeStr(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(date);
  const hourVal = parts.find(p => p.type === 'hour').value;
  const minuteVal = parts.find(p => p.type === 'minute').value;
  const hr = parseInt(hourVal, 10) % 24;
  const min = parseInt(minuteVal, 10);
  return `${hr}:${min.toString().padStart(2, '0')}`;
}


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

async function fetchHtml(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Fetch failed ' + r.status);
  return await r.text();
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function formatCheckedAt(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(date);
}

function formatStatusDate(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

function formatYmdNY(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function normalizeStatusDate(dateText, fallbackDate) {
  if (!dateText) return formatStatusDate(fallbackDate);

  const parsed = new Date(dateText);
  if (!Number.isNaN(parsed.getTime())) return formatStatusDate(parsed);

  return dateText.replace(/,\s*\d{1,2}:\d{2}\s*[AP]M\s*[A-Z]{2,4}$/i, '').trim();
}

function parseStatusDate(dateText, fallbackDate) {
  if (!dateText) return fallbackDate;
  const cleaned = String(dateText).replace(/,\s*\d{1,2}:\d{2}\s*[AP]M\s*[A-Z]{2,4}$/i, '').trim();
  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.getTime()) ? fallbackDate : parsed;
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

function extractCards(html) {
  const cards = [];
  const stripTags = s => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  // Try parsing the new status.hcpss.org format first
  const statusBlockMatch = html.match(/<section[^>]+id=["']status-block["'][^>]*>(.*?)<\/section>/is);
  if (statusBlockMatch) {
    const blockContent = statusBlockMatch[1];
    const divParts = blockContent.split(/<div[^>]*>/is);
    for (const part of divParts) {
      if (part.includes('status-date')) {
        const dateMatch = part.match(/<span[^>]*class=["']status-date["'][^>]*>(.*?)<\/span>/is);
        
        const hMatch = part.match(/<(h1|h2|h3)[^>]*>(.*?)<\/\1>/is);
        let titleText = '';
        if (hMatch) {
          const hContent = hMatch[2];
          const spans = hContent.match(/<span[^>]*>(.*?)<\/span>/gis);
          if (spans) {
            for (const span of spans) {
              if (!span.includes('status-date')) {
                titleText = stripTags(span);
                break;
              }
            }
          }
          if (!titleText) {
            const dateVal = dateMatch ? stripTags(dateMatch[1]) : '';
            titleText = stripTags(hContent).replace(dateVal, '').trim();
          }
        }
        
        const dateText = dateMatch ? stripTags(dateMatch[1]) : '';
        
        const pMatches = part.match(/<p[^>]*>(.*?)<\/p>/gis) || [];
        const bodyParts = [];
        for (const p of pMatches) {
          const pClean = stripTags(p);
          if (pClean.toLowerCase().includes('view hcpss calendar')) {
            continue;
          }
          bodyParts.push(pClean);
        }
        const bodyText = bodyParts.join('\n\n');
        
        if (titleText || bodyText) {
          cards.push({ date: dateText, title: titleText, body: bodyText });
        }
      }
    }
  }

  // Fallback to legacy views-row format
  if (cards.length === 0) {
    const parts = html.split(/<div[^>]+class=["']views-row["'][^>]*>/i).slice(1);
    for (const p of parts) {
      const dateMatch = p.match(/<div[^>]*class=["']views-field-changed["'][^>]*>(.*?)<\/div>/is);
      const titleMatch = p.match(/<(?:h1|h2|h3)[^>]*>(.*?)<\/(?:h1|h2|h3)>/is);
      const bodyMatch = p.match(/<div[^>]*class=["']alert-content["'][^>]*>(.*?)<\/div>/is) || p.match(/<p[^>]*>(.*?)<\/p>/is);
      const dateText = stripTags(dateMatch && dateMatch[1]);
      const titleText = stripTags(titleMatch && titleMatch[1]);
      const bodyText = stripTags(bodyMatch && bodyMatch[1]);
      if (titleText || bodyText) {
        cards.push({ date: dateText, title: titleText, body: bodyText });
      }
    }
  }

  return cards;
}

function assembleDescription(cards) {
  if (!cards.length) {
    return '## **Normal Operations**\n\nStaff and students report in accordance with the HCPSS calendar.';
  }
  return cards.map(c => {
    let md = '';
    if (c.title) md += `## **${c.title}**\n\n`;
    if (c.body) md += `${c.body}\n`;
    return md;
  }).join('\n___\n\n');
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
  return [{ type: 1, components: [{ type: 2, style: 1, label: 'Check again', custom_id: 'check_again' }] }];
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

function determineStatusKey(cards) {
  if (!cards || cards.length === 0) {
    return 'normal_operations';
  }
  
  const isNormal = cards.every(c => !c.title || /normal operations/i.test(c.title));
  if (isNormal) {
    return 'normal_operations';
  }

  const alertCard = cards.find(c => c.title && !/normal operations/i.test(c.title));
  if (!alertCard) return 'normal_operations';

  const title = alertCard.title.toLowerCase();
  const body = (alertCard.body || '').toLowerCase();

  if (title.includes('schools and offices closed') || body.includes('schools and offices closed')) {
    return 'schools_and_offices_closed';
  }
  if (title.includes('schools closed') || body.includes('schools closed')) {
    return 'schools_closed';
  }
  if (title.includes('2 hours late') || title.includes('two hours late') || body.includes('2 hours late') || body.includes('two hours late')) {
    return 'schools_open_2_hours_late';
  }
  if (title.includes('3 hours early') || title.includes('three hours early') || body.includes('3 hours early') || body.includes('three hours early')) {
    return 'schools_close_3_hours_early';
  }

  if (title.includes('closed') || body.includes('closed')) {
    return 'schools_closed';
  }
  if (title.includes('late') || body.includes('late') || title.includes('delay') || body.includes('delay')) {
    return 'schools_open_2_hours_late';
  }
  if (title.includes('early') || body.includes('early')) {
    return 'schools_close_3_hours_early';
  }

  return 'unknown_alert';
}

async function buildStatusEmbeds(env, footer = 'HCPSS Status Monitor', cards = null, config = null) {
  const checkedAt = new Date();
  if (!cards) {
    const html = await fetchHtml(HCPSS_URL);
    cards = extractCards(html);
  }
  const statusDate = parseStatusDate(cards[0] && cards[0].date, checkedAt);
  const primaryDate = normalizeStatusDate(cards[0] && cards[0].date, checkedAt);
  const isNormalFromSite = !cards.length || cards.every(c => !c.title || /normal operations/i.test(c.title));
  
  const ymd = formatYmdNY(statusDate);
  let calendarEvent = env ? await env.STATUS_KV.get(`calendar_event:${ymd}`) : null;
  if (!calendarEvent) {
    calendarEvent = SCHOOL_CALENDAR_EVENTS[ymd];
  }

  let desc = assembleDescription(cards);
  if (isNormalFromSite && calendarEvent) {
    // Calendar only overrides "Normal Operations" days. If HCPSS posts an alert
    // (closures/delays/etc.), that alert is the source of truth for the day.
    desc = `## **${calendarEvent}**\n\nStaff and students report in accordance with the HCPSS calendar.`;
  }

  const statusKey = determineStatusKey(cards);
  let color = getDefaultStatusColor(statusKey);
  if (config && config.status_embed_colors && typeof config.status_embed_colors[statusKey] === 'number') {
    color = config.status_embed_colors[statusKey];
  }
  const customFooter = (config && config.alert_embed_footer) || footer;
  const thumbnailUrl = getStatusThumbnail(statusKey);

  return splitEmbeds(`HCPSS Status for ${primaryDate}`, desc, HCPSS_URL, color, customFooter, checkedAt, thumbnailUrl).slice(0, MAX_EMBEDS);
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

async function buildStatusPayload(env, { includeComponents = false, footer = 'HCPSS Status Monitor', guildId = '', cards = null, error = null } = {}) {
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

  if (error) {
    const payload = {
      content: '',
      embeds: buildStatusErrorEmbeds(error, footer, config)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents();
    return { payload, isError: true, error, statusKey: 'unknown_alert' };
  }

  try {
    const finalCards = cards || extractCards(await fetchHtml(HCPSS_URL));
    const statusKey = determineStatusKey(finalCards);
    const payload = {
      content: '',
      embeds: await buildStatusEmbeds(env, footer, finalCards, config)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents();
    return { payload, isError: false, statusKey };
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
  try {
    const r = await fetch(HCPSS_URL);
    ok = r.ok;
    statusText = `${r.status} ${r.statusText}`;
  } catch (e) {
    statusText = e.message;
  }
  const duration = Date.now() - start;
  await updateInteractionOriginal(env, body.token, {
    content: `⚡ **Scraper speed test:**\n• Status: \`${statusText}\`\n• Fetch time: \`${duration}ms\`\n• Result: ${ok ? '🟢 Ok' : '🔴 Failed'}`,
    embeds: []
  });
}

async function handlePanelCheck(body, env) {
  const invokerId = body.member && body.member.user && body.member.user.id;
  const result = await doCheckAndPost(env, { source: 'panel-trigger', invokerId });
  const content = result.ok
    ? (result.isError ? '⚠️ Posted the HCPSS error status embed.' : '✅ Posted the latest HCPSS status.')
    : `❌ Could not post status: ${result.error || result.status}`;
  await updateInteractionOriginal(env, body.token, {
    content,
    embeds: []
  });
}

async function postLog(env, logChannelId, message, stats = {}, guildId = '') {
  if (!logChannelId) return;
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return;

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

async function trackStatusHistory(env, currentStatus, primaryDate, statusKey = '') {
  const lastKnown = await env.STATUS_KV.get('last_known_status');
  if (lastKnown === currentStatus) {
    return; // No change
  }

  await env.STATUS_KV.put('last_known_status', currentStatus);

  let history = [];
  const rawHistory = await env.STATUS_KV.get('status_history');
  if (rawHistory) {
    try {
      history = JSON.parse(rawHistory);
    } catch (e) {
      history = [];
    }
  }

  history.unshift({
    timestamp: Date.now(),
    status: currentStatus,
    date: primaryDate
  });

  history = history.slice(0, 10); // Keep last 10 status changes
  await env.STATUS_KV.put('status_history', JSON.stringify(history));

  // Increment operating status count in KV
  if (statusKey && statusKey !== 'normal_operations') {
    try {
      let stats = {};
      const rawStats = await env.STATUS_KV.get('status_stats');
      if (rawStats) {
        stats = JSON.parse(rawStats) || {};
      }
      stats[statusKey] = (stats[statusKey] || 0) + 1;
      await env.STATUS_KV.put('status_stats', JSON.stringify(stats));
    } catch (e) {
      console.error('Failed to increment operating status stats:', e);
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
  const rawHistory = await env.STATUS_KV.get('status_history');
  let history = [];
  if (rawHistory) {
    try {
      history = JSON.parse(rawHistory);
    } catch (e) {
      history = [];
    }
  }

  const embed = {
    title: '📜 HCPSS Recent Status History',
    color: 3066993,
    timestamp: checkedAt.toISOString(),
    footer: { text: 'HCPSS Status Monitor' }
  };

  if (history.length === 0) {
    embed.description = 'No status history recorded yet. History starts recording on changes.';
  } else {
    embed.description = history.map((h, index) => {
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

  // Determine target guilds to post/check for.
  let targetGuildIds = [];
  if (options.guildId) {
    targetGuildIds = [options.guildId];
  } else {
    // Collect all guilds from KV keys starting with 'config:'
    try {
      const listResult = await env.STATUS_KV.list({ prefix: 'config:' });
      targetGuildIds = listResult.keys.map(k => k.name.replace(/^config:/, '')).filter(Boolean);
    } catch (e) {
      console.error('Failed to list configs in KV:', e);
    }
    
    // Ensure default guild from environment is included if configured
    if (env.DISCORD_GUILD_ID && !targetGuildIds.includes(env.DISCORD_GUILD_ID)) {
      targetGuildIds.push(env.DISCORD_GUILD_ID);
    }
  }

  const isScheduled = options.source === 'scheduled';
  let activeGuildIds = [...targetGuildIds];

  if (isScheduled) {
    const currentEtStr = getEasternTimeStr(new Date());
    const matchedGuilds = [];
    for (const guildId of targetGuildIds) {
      const stored = await getConfig(env, guildId);
      const config = getEffectiveConfig(stored);
      if (config.check_schedule.includes(currentEtStr)) {
        matchedGuilds.push(guildId);
      }
    }
    activeGuildIds = matchedGuilds;
  }

  if (activeGuildIds.length === 0) {
    return { ok: true, skipped: true, message: "No guilds scheduled for this time." };
  }

  // 1. Fetch HTML and extract cards once
  let cards = null;
  let error = null;
  try {
    const html = await fetchHtml(HCPSS_URL);
    cards = extractCards(html);
  } catch (err) {
    error = err;
  }
  const latency = Date.now() - start;

  // Increment check counts in KV
  try {
    let stats = {};
    const rawStats = await env.STATUS_KV.get('status_stats');
    if (rawStats) {
      stats = JSON.parse(rawStats) || {};
    }
    stats.scrapes_total = (stats.scrapes_total || 0) + 1;
    if (error) {
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
    error
  });

  const firstEmbedGlobal = liveStatusResult.payload.embeds && liveStatusResult.payload.embeds[0];
  const liveStatusTextGlobal = firstEmbedGlobal ? (firstEmbedGlobal.description || '') : '';

  // Track global status history on change
  if (!liveStatusResult.isOverride && !liveStatusResult.isError) {
    const lastKnownStatus = await env.STATUS_KV.get('last_known_status');
    if (lastKnownStatus !== liveStatusTextGlobal) {
      if (firstEmbedGlobal) {
        const statusTitle = firstEmbedGlobal.title || '';
        await trackStatusHistory(env, liveStatusTextGlobal, statusTitle, liveStatusResult.statusKey);
      }
      await env.STATUS_KV.put('last_known_status', liveStatusTextGlobal);
    }
  }

  const results = [];

  for (const guildId of activeGuildIds) {
    const stored = await getConfig(env, guildId);
    const config = getEffectiveConfig(stored);
    const channelId = config.alert_channel_id || (guildId === env.DISCORD_GUILD_ID ? env.DISCORD_CHANNEL_ID : null);
    if (!channelId) {
      // Guild hasn't configured an alert channel yet
      continue;
    }
    const logChannelId = config.log_channel_id;
    const pingRoleIds = Array.isArray(config.ping_role_ids) ? config.ping_role_ids : [];

    // Get the status payload for THIS guild (incorporates any active override for this guild)
    const builtStatus = await buildStatusPayload(env, {
      includeComponents: true,
      guildId,
      cards,
      error
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

    const content = rolesToPing.length ? rolesToPing.map(id => `<@&${id}>`).join(' ') : '';
    const payload = {
      ...builtStatus.payload,
      content,
      allowed_mentions: rolesToPing.length ? { roles: rolesToPing } : { parse: [] },
      __channelId: channelId
    };

    const firstEmbed = builtStatus.payload.embeds && builtStatus.payload.embeds[0];
    const liveStatusText = firstEmbed ? (firstEmbed.description || '') : '';
    
    const lastPostedText = await env.STATUS_KV.get(`last_posted_text:${guildId}`);
    const statusChanged = lastPostedText !== liveStatusText;

    const shouldPostAlert = !isScheduled || (statusChanged && !builtStatus.isError);

    let postedMessageId = null;
    if (shouldPostAlert) {
      const postResult = await postMessageToChannel(env, payload);
      if (!postResult.ok) {
        const postError = await postResult.text();
        await postLog(
          env,
          logChannelId,
          `❌ HCPSS status check failed (source: ${options.source || 'unknown'}): ${postError}`,
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
      await env.STATUS_KV.put(`last_posted_text:${guildId}`, liveStatusText);

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
        `✅ HCPSS status check posted (source: ${options.source || 'unknown'}${options.invokerId ? `, by: <@${options.invokerId}>` : ''}) to <#${channelId}>. [Jump to Message](https://discord.com/channels/${guildId}/${channelId}/${postedMessageId})`,
        { latency },
        guildId
      );
      results.push({ guildId, ok: true, id: postedMessageId });
    } else {
      // Scheduled check with no status change: just update stats & timestamp, no new log message
      await postLog(
        env,
        logChannelId,
        null,
        { latency },
        guildId
      );
      results.push({ guildId, ok: true, skipped: true });
    }
  }

  // Handle global scraper success/failure tracking
  if (liveStatusResult.isError) {
    const defaultGuildConfig = getEffectiveConfig(await getConfig(env, env.DISCORD_GUILD_ID));
    const firstLogChannelId = targetGuildIds.length > 0 ? (getEffectiveConfig(await getConfig(env, targetGuildIds[0])).log_channel_id) : defaultGuildConfig.log_channel_id;
    await handleScraperFailure(env, firstLogChannelId, defaultGuildConfig, liveStatusResult.error);
  } else {
    await handleScraperSuccess(env);
  }

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
  const key = configKey(guildId || env.DISCORD_GUILD_ID);
  await env.STATUS_KV.put(key, JSON.stringify(next));
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

async function buildControlPanelPayload(env, guildId) {
  const stored = await getConfig(env, guildId);
  const config = getEffectiveConfig(stored);
  const page = await env.STATUS_KV.get(`panel_page:${guildId}`) || 'dashboard';

  if (page === 'config_general') {
    const channel = config.alert_channel_id ? `<#${config.alert_channel_id}>` : '(not set)';
    const logChannel = config.log_channel_id ? `<#${config.log_channel_id}>` : '(not set)';
    const staffRole = config.staff_role_id ? `<@&${config.staff_role_id}>` : '(not set)';
    const embedFooter = config.alert_embed_footer || '(default)';

    const embed = {
      title: '⚙️ HCPSS Status Monitor - General Config',
      color: 0x3498DB,
      description: `Configure the general settings for this server.\n\n` +
                   `• **Alert Channel**: ${channel}\n` +
                   `• **Log Channel**: ${logChannel}\n` +
                   `• **Staff Role**: ${staffRole}\n` +
                   `• **Custom Footer**: \`${embedFooter}\``,
      timestamp: new Date().toISOString()
    };

    const components = [
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
        components: [
          { type: 2, style: 2, label: 'Configure Colors/Pings', custom_id: 'panel_to_config_status', emoji: { name: '🎨' } },
          { type: 2, style: 2, label: 'Configure Schedule', custom_id: 'panel_to_config_schedule', emoji: { name: '🗓️' } },
          { type: 2, style: 2, label: 'Set Footer Text', custom_id: 'panel_btn_set_footer', emoji: { name: '✍️' } },
          { type: 2, style: 3, label: 'Dashboard', custom_id: 'panel_to_dashboard', emoji: { name: '📊' } }
        ]
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
      description: `Select a status below to set its ping role and embed color.\n\n` +
                   `**Current Settings:**\n${statusPings}\n\n` +
                   `*Currently editing: **${editingLabel}***`,
      timestamp: new Date().toISOString()
    };

    const components = [
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
          { type: 2, style: 1, label: `Set Color for ${editingLabel.split(' ')[0]}...`, custom_id: 'panel_btn_set_color', emoji: { name: '🎨' } },
          { type: 2, style: 2, label: 'General Config', custom_id: 'panel_to_config_general', emoji: { name: '⚙️' } },
          { type: 2, style: 3, label: 'Dashboard', custom_id: 'panel_to_dashboard', emoji: { name: '📊' } }
        ]
      }
    ];

    return { embeds: [embed], components };
  }

  if (page === 'config_schedule') {
    const currentSchedule = config.check_schedule || [];
    const formattedTimes = currentSchedule.map(timeStr => {
      const option = SCHEDULE_OPTIONS.find(o => o.value === timeStr);
      return option ? option.label : timeStr;
    }).join(', ');

    const embed = {
      title: '🗓️ HCPSS Status Monitor - Schedule Config',
      color: 0x2ECC71,
      description: `Configure the times when the bot automatically scrapes the HCPSS status website.\n\n` +
                   `• **Current Schedule**: ${formattedTimes || '(none)'}\n\n` +
                   `*Select up to **4 times** from the dropdown below.*`,
      timestamp: new Date().toISOString()
    };

    const components = [
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'cfg_schedule_select',
          placeholder: 'Select check times (max 4)',
          options: SCHEDULE_OPTIONS.map(opt => ({
            label: opt.label,
            value: opt.value,
            default: currentSchedule.includes(opt.value)
          })),
          min_values: 1,
          max_values: 4
        }]
      },
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: 'General Config', custom_id: 'panel_to_config_general', emoji: { name: '⚙️' } },
          { type: 2, style: 3, label: 'Dashboard', custom_id: 'panel_to_dashboard', emoji: { name: '📊' } }
        ]
      }
    ];

    return { embeds: [embed], components };
  }

  // Otherwise, default to Dashboard Page
  const logKey = guildId ? `panel_logs:${guildId}` : 'panel_logs';
  const latencyKey = guildId ? `last_check_latency:${guildId}` : 'last_check_latency';
  const checkTimeKey = guildId ? `last_check_time:${guildId}` : 'last_check_time';

  let logs = [];
  const rawLogs = await env.STATUS_KV.get(logKey);
  if (rawLogs) {
    try { logs = JSON.parse(rawLogs); } catch {}
  }
  const latency = await env.STATUS_KV.get(latencyKey) || 'N/A';
  const lastCheckTime = Number(await env.STATUS_KV.get(checkTimeKey)) || Date.now();

  const recentLogs = logs.slice(0, 3);
  const logsContent = recentLogs.length ? recentLogs.map(line => {
    const match = line.match(/^\[(.*?)\] (.*)$/);
    if (match) {
      return `\`[${match[1]}]\` ${match[2]}`;
    }
    return line;
  }).join('\n') : '*No logs yet.*';

  const embed = {
    title: '🛠️ HCPSS Status Monitor - Control Panel',
    color: 0x9B59B6,
    description: `**System Status**: 🟢 Online\n` +
                 `**Last Check**: <t:${Math.floor(lastCheckTime / 1000)}:F> (<t:${Math.floor(lastCheckTime / 1000)}:R>)\n` +
                 `**Scraper Latency**: \`${latency}ms\`\n` +
                 `**KV Namespace**: \`STATUS_KV\` (Connected)\n\n` +
                 `**Recent System Logs:**\n${logsContent}\n\n` +
                 `*Use the buttons below to run diagnostics or configure settings.*`,
    timestamp: new Date().toISOString()
  };

  const components = [
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: 'Run Check', custom_id: 'panel_check', emoji: { name: '🔍' } },
        { type: 2, style: 1, label: 'Test Speed', custom_id: 'panel_speed', emoji: { name: '⚡' } },
        { type: 2, style: 2, label: 'Refresh', custom_id: 'panel_refresh', emoji: { name: '🔄' } }
      ]
    },
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: 'Configure Bot', custom_id: 'panel_to_config_general', emoji: { name: '⚙️' } },
        { type: 2, style: 2, label: 'History', custom_id: 'panel_history', emoji: { name: '📜' } },
        { type: 2, style: 2, label: 'Logs', custom_id: 'panel_logs', emoji: { name: '📋' } },
        { type: 2, style: 4, label: 'Clear Logs', custom_id: 'panel_clear_logs', emoji: { name: '🗑️' } }
      ]
    },
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: 'panel_trigger_test_alert',
          placeholder: '🧪 Trigger Scraper Test Alert...',
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
        }
      ]
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
  } else if (customId === 'cfg_schedule_select' && Array.isArray(values)) {
    next.check_schedule = values.slice(0, 4);
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

  const embed = {
    title: '📊 HCPSS Status Monitor - Statistics',
    color: 0x34495E,
    description: `**Scraper Diagnostics:**\n` +
                 `• Total Checks: \`${scrapesTotal}\`\n` +
                 `• Scraper Success Rate: \`${uptimePct}%\` (\`${scrapesSuccess}/${scrapesTotal}\` successful)\n\n` +
                 `**Operating Status Changes (School Year):**\n` +
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

        if (updated) {
          await setConfig(env, guildId, config);
        }

        const payload = await buildControlPanelPayload(env, guildId);
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

      if (body.type === 3 && body.data && typeof body.data.custom_id === 'string' && body.data.custom_id.startsWith('panel_')) {
        if (!(await canUseCommands(body.member, env, guildId))) {
          return interactionResponse({
            content: 'You do not have permission to use the control panel.',
            flags: EPHEMERAL_FLAG
          });
        }

        const customId = body.data.custom_id;
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
          return jsonResponse({
            type: 7,
            data: payload
          });
        }

        if (customId === 'panel_to_config_status') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_status');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({
            type: 7,
            data: payload
          });
        }

        if (customId === 'panel_to_config_schedule') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_schedule');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({
            type: 7,
            data: payload
          });
        }

        if (customId === 'panel_to_dashboard') {
          await env.STATUS_KV.put(`panel_page:${guildId}`, 'dashboard');
          const payload = await buildControlPanelPayload(env, guildId);
          return jsonResponse({
            type: 7,
            data: payload
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

      if (body.type === 3 && body.data && typeof body.data.custom_id === 'string' && body.data.custom_id.startsWith('cfg_')) {
        if (!(await canConfigure(body.member, env, guildId))) {
          return interactionResponse({
            content: 'You do not have permission to configure this bot.',
            flags: EPHEMERAL_FLAG
          });
        }

        await applyConfigUpdate(body, env);
        const payload = await buildControlPanelPayload(env, guildId);
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
      if (result.ok) {
        const prefix = result.isError ? 'Posted error embed' : 'Posted';
        return new Response(`${prefix}: ${result.id}`, { status: 200 });
      }
      return new Response('Post failed: ' + (result.error || result.status), { status: 500 });
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
