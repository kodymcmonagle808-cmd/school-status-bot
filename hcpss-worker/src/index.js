const HCPSS_URL = 'https://hcpss.org';
const EMBED_LIMIT = 4096;
const EMBED_SAFE = 3900;
const MAX_EMBEDS = 10;
const MANUAL_TRIGGER_HEADER = 'x-manual-trigger-token';
const EPHEMERAL_FLAG = 64;
const POST_STATUS_COMMAND = 'post-status';
const CONFIG_COMMAND = 'config';
const OVERRIDE_COMMAND = 'overide';
const DEFAULT_STAFF_ROLE_ID = '1521682363942436896';
const DEFAULT_LOG_CHANNEL_ID = '1524911607942221965';

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
  const parts = html.split(/<div[^>]+class=["']views-row["'][^>]*>/i).slice(1);
  const cards = [];
  for (const p of parts) {
    const dateMatch = p.match(/<div[^>]*class=["']views-field-changed["'][^>]*>(.*?)<\/div>/is);
    const titleMatch = p.match(/<(?:h1|h2|h3)[^>]*>(.*?)<\/(?:h1|h2|h3)>/is);
    const bodyMatch = p.match(/<div[^>]*class=["']alert-content["'][^>]*>(.*?)<\/div>/is) || p.match(/<p[^>]*>(.*?)<\/p>/is);
    const stripTags = s => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const dateText = stripTags(dateMatch && dateMatch[1]);
    const titleText = stripTags(titleMatch && titleMatch[1]);
    const bodyText = stripTags(bodyMatch && bodyMatch[1]);
    if (titleText || bodyText) {
      cards.push({ date: dateText, title: titleText, body: bodyText });
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

function splitEmbeds(title, description, url, color, footer, checkedAt = new Date()) {
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
    } else {
      embed.title = `${title} (cont. ${idx + 1})`;
    }
    return embed;
  });
}

function buildCheckAgainComponents() {
  return [{ type: 1, components: [{ type: 2, style: 1, label: 'Check again', custom_id: 'check_again' }] }];
}

async function buildStatusEmbeds(footer = 'HCPSS Status Monitor') {
  const checkedAt = new Date();
  const html = await fetchHtml(HCPSS_URL);
  const cards = extractCards(html);
  const statusDate = parseStatusDate(cards[0] && cards[0].date, checkedAt);
  const primaryDate = normalizeStatusDate(cards[0] && cards[0].date, checkedAt);
  const isNormalFromSite = !cards.length || cards.every(c => !c.title || /normal operations/i.test(c.title));
  const calendarEvent = SCHOOL_CALENDAR_EVENTS[formatYmdNY(statusDate)];

  let desc = assembleDescription(cards);
  if (isNormalFromSite && calendarEvent) {
    // Calendar only overrides "Normal Operations" days. If HCPSS posts an alert
    // (closures/delays/etc.), that alert is the source of truth for the day.
    desc = `## **${calendarEvent}**\n\nStaff and students report in accordance with the HCPSS calendar.`;
  }

  const color = cards.some(c => c.title && !/normal operations/i.test(c.title)) ? 15158332 : 3066993;
  return splitEmbeds(`HCPSS Status for ${primaryDate}`, desc, HCPSS_URL, color, footer, checkedAt).slice(0, MAX_EMBEDS);
}

function buildStatusErrorEmbeds(error, footer = 'HCPSS Status Monitor') {
  const checkedAt = new Date();
  const detail = error && error.message ? `\n\nTechnical detail: ${error.message}` : '';
  return [{
    title: 'HCPSS status check failed',
    url: HCPSS_URL,
    description: `The monitor could not fetch the HCPSS status page right now. Try again in a minute or check https://hcpss.org directly.${detail}`,
    color: 15158332,
    footer: { text: footerWithCheckedAt(footer, checkedAt) },
    timestamp: checkedAt.toISOString()
  }];
}

function buildOverrideEmbeds(override, footer = 'HCPSS Status Monitor') {
  const checkedAt = new Date();
  const statusKey = override && override.status_key ? String(override.status_key) : '';
  const statusLabel = override && override.status_label ? String(override.status_label) : 'Override';
  const isNormal = statusKey === 'normal_operations';
  const color = isNormal ? 3066993 : 15158332;

  const title = (override && override.title)
    ? String(override.title).slice(0, 256)
    : `HCPSS Status (Override) - ${statusLabel}`.slice(0, 256);

  const details = (override && override.details) ? String(override.details).trim() : '';
  const body = details ? `## **${statusLabel}**\n\n${details}` : `## **${statusLabel}**`;

  return splitEmbeds(title, body, HCPSS_URL, color, footer, checkedAt).slice(0, MAX_EMBEDS);
}

async function buildStatusPayload(env, { includeComponents = false, footer = 'HCPSS Status Monitor' } = {}) {
  const activeOverride = env ? await getActiveOverride(env) : null;
  if (activeOverride) {
    const payload = {
      content: '',
      embeds: buildOverrideEmbeds(activeOverride, footer)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents();
    return { payload, isError: false, isOverride: true };
  }

  try {
    const payload = {
      content: '',
      embeds: await buildStatusEmbeds(footer)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents();
    return { payload, isError: false };
  } catch (error) {
    const payload = {
      content: '',
      embeds: buildStatusErrorEmbeds(error, footer)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents();
    return { payload, isError: true, error };
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

async function postLog(env, logChannelId, message) {
  if (!logChannelId) return;
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return;

  await fetch(`https://discord.com/api/v10/channels/${logChannelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      content: message,
      allowed_mentions: { parse: [] }
    })
  }).catch(() => {});
}

async function doCheckAndPost(env, options = {}) {
  const stored = await getConfig(env);
  const config = getEffectiveConfig(stored);
  const channelId = config.alert_channel_id || env.DISCORD_CHANNEL_ID;
  const logChannelId = config.log_channel_id;
  const pingRoleIds = Array.isArray(config.ping_role_ids) ? config.ping_role_ids : [];

  const builtStatus = await buildStatusPayload(env, { includeComponents: true });
  const isNormal = builtStatus.payload.embeds && builtStatus.payload.embeds[0] && builtStatus.payload.embeds[0].color === 3066993;

  const content = (!isNormal && pingRoleIds.length) ? pingRoleIds.map(id => `<@&${id}>`).join(' ') : '';
  const payload = {
    ...builtStatus.payload,
    content,
    allowed_mentions: pingRoleIds.length ? { roles: pingRoleIds } : { parse: [] },
    __channelId: channelId
  };

  const postResult = await postMessageToChannel(env, payload);

  if (!postResult.ok) {
    const postError = await postResult.text();
    await postLog(env, logChannelId, `HCPSS check failed (source: ${options.source || 'unknown'}): ${postError}`);
    return { ok: false, error: postError, status: postResult.status };
  }

  const postedMessage = await postResult.json();
  const postedMessageId = postedMessage.id;
  const previousMessageId = await env.STATUS_KV.get('last_message_id');
  const previousChannelId = await env.STATUS_KV.get('last_channel_id');
  await env.STATUS_KV.put('last_message_id', postedMessageId);
  await env.STATUS_KV.put('last_channel_id', channelId);

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
    `HCPSS check posted (source: ${options.source || 'unknown'}${options.invokerId ? `, by: ${options.invokerId}` : ''}) to channel ${channelId}, message ${postedMessageId}.`
  );

  return {
    ok: true,
    id: postedMessageId,
    isError: builtStatus.isError,
    error: builtStatus.error && builtStatus.error.message
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
  return next;
}

function memberHasRole(member, roleId) {
  return !!roleId && Array.isArray(member && member.roles) && member.roles.includes(roleId);
}

async function canUseCommands(member, env) {
  if (memberIsAdmin(member)) return true;
  const stored = await getConfig(env);
  const cfg = getEffectiveConfig(stored);
  return memberHasRole(member, cfg.staff_role_id);
}

async function canConfigure(member, env) {
  return await canUseCommands(member, env);
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
  const result = await doCheckAndPost(env, { source: 'command', invokerId });
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

  const sub = Array.isArray(options) && options[0] && options[0].type === 1 ? options[0] : null;
  const subName = sub && sub.name ? String(sub.name) : '';
  const subOptions = sub && Array.isArray(sub.options) ? sub.options : [];

  if (subName === 'clear') {
    await clearOverride(env);
    const invokerId = body && body.member && body.member.user && body.member.user.id;
    const result = await doCheckAndPost(env, { source: 'override-clear', invokerId });
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
  await setOverride(env, {
    status_key: statusKey,
    status_label: statusLabel,
    title: title || null,
    details: details || null,
    created_at: now,
    created_by: invokerId || null,
    until
  });

  const cfg = getEffectiveConfig(await getConfig(env));
  await postLog(env, cfg.log_channel_id, `Override set (status: ${statusLabel}, days: ${days}${invokerId ? `, by: ${invokerId}` : ''}).`);

  await updateInteractionOriginal(env, body.token, {
    content: `Override enabled for ${days} day(s). All status updates will use it until it expires or is cleared.`,
    embeds: []
  });
}

function overrideKey(env) {
  const guildId = env.DISCORD_GUILD_ID;
  return guildId ? `override:${guildId}` : 'override:default';
}

async function getActiveOverride(env) {
  const raw = await env.STATUS_KV.get(overrideKey(env));
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
    await env.STATUS_KV.delete(overrideKey(env)).catch(() => {});
    return null;
  }

  return parsed;
}

async function setOverride(env, override) {
  await env.STATUS_KV.put(overrideKey(env), JSON.stringify(override));
}

async function clearOverride(env) {
  await env.STATUS_KV.delete(overrideKey(env));
}

function getCommandOption(options, name) {
  if (!Array.isArray(options)) return undefined;
  const found = options.find(o => o && o.name === name);
  return found ? found.value : undefined;
}

function configKey(env) {
  const guildId = env.DISCORD_GUILD_ID;
  return guildId ? `config:${guildId}` : 'config:default';
}

async function getConfig(env) {
  const raw = await env.STATUS_KV.get(configKey(env));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function setConfig(env, next) {
  await env.STATUS_KV.put(configKey(env), JSON.stringify(next));
}

function renderConfigMessage(config) {
  const effective = getEffectiveConfig(config);
  const channel = effective.alert_channel_id ? `<#${effective.alert_channel_id}>` : '(not set)';
  const logChannel = effective.log_channel_id ? `<#${effective.log_channel_id}>` : '(not set)';
  const staffRole = effective.staff_role_id ? `<@&${effective.staff_role_id}>` : '(not set)';
  const roles = Array.isArray(effective.ping_role_ids) && effective.ping_role_ids.length
    ? effective.ping_role_ids.map(id => `<@&${id}>`).join(' ')
    : '(none)';
  return `Alert channel: ${channel}\nLog channel: ${logChannel}\nStaff role: ${staffRole}\nPing roles (emergencies): ${roles}`;
}

function buildConfigComponents() {
  return [
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
        placeholder: 'Select staff role (required for commands)',
        min_values: 1,
        max_values: 1
      }]
    },
    {
      type: 1,
      components: [{
        type: 6,
        custom_id: 'cfg_roles',
        placeholder: 'Select role(s) to ping on emergencies',
        min_values: 0,
        max_values: 5
      }]
    },
    {
      type: 1,
      components: [{
        type: 2,
        style: 2,
        label: 'Clear ping roles',
        custom_id: 'cfg_clear_roles'
      }]
    }
  ];
}

async function applyConfigUpdate(body, env) {
  const current = await getConfig(env);
  const customId = body.data && body.data.custom_id;
  const values = body.data && body.data.values;

  const next = { ...current };
  if (customId === 'cfg_channel' && Array.isArray(values) && values[0]) {
    next.alert_channel_id = values[0];
  } else if (customId === 'cfg_log_channel' && Array.isArray(values) && values[0]) {
    next.log_channel_id = values[0];
  } else if (customId === 'cfg_staff_role' && Array.isArray(values) && values[0]) {
    next.staff_role_id = values[0];
  } else if (customId === 'cfg_roles' && Array.isArray(values)) {
    next.ping_role_ids = values.slice(0, 5);
  } else if (customId === 'cfg_clear_roles') {
    next.ping_role_ids = [];
  }

  await setConfig(env, next);
  return next;
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

      if (body.type === 2 && !(await canUseCommands(body.member, env))) {
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

      if (body.type === 2 && body.data && body.data.name === CONFIG_COMMAND) {
        const config = await getConfig(env);
        return interactionResponse({
          content: renderConfigMessage(config),
          components: buildConfigComponents(),
          flags: EPHEMERAL_FLAG
        });
      }

      if (body.type === 3 && body.data && body.data.custom_id === 'check_again') {
        const builtStatus = await buildStatusPayload(env, { footer: 'HCPSS Status Monitor - Only you can see this' });
        return interactionResponse({
          content: '',
          embeds: builtStatus.payload.embeds,
          flags: EPHEMERAL_FLAG
        });
      }

      if (body.type === 3 && body.data && typeof body.data.custom_id === 'string' && body.data.custom_id.startsWith('cfg_')) {
        if (!(await canConfigure(body.member, env))) {
          return jsonResponse({
            type: 7,
            data: {
              content: 'You do not have permission to configure this bot.',
              components: []
            }
          });
        }

        const next = await applyConfigUpdate(body, env);
        return jsonResponse({
          type: 7,
          data: {
            content: renderConfigMessage(next),
            components: buildConfigComponents()
          }
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
  }
};

export async function scheduled(event, env) {
  event.waitUntil((async () => {
    try {
      await doCheckAndPost(env, { source: 'scheduled' });
    } catch (e) {
      console.error('Scheduled run failed', e);
    }
  })());
}
