// Status embed building: turns scraped cards (or an override/error) into the
// Discord embed payloads posted to alert channels.

import {
  EMBED_LIMIT,
  EMBED_SAFE,
  MAX_EMBEDS,
  SCHOOL_CALENDAR_EVENTS,
  ALL_STATUS_LABELS,
  getDefaultStatusColor,
  getStatusThumbnail
} from './constants.js';
import { getEasternTimeStr, formatCheckedAt, formatStatusDate, formatYmdNY } from './timeutil.js';
import { HCPSS_URL, fetchHtml, getStatusCards, extractCards, assembleDescription, determineStatusKey, statusDateInfo } from './scraper.js';
import { getActiveWeatherAlerts, formatWeatherAlertLines, hasStormAlert, alertsLikelyTomorrowMorning } from './weather.js';
import {
  getDistrictStatuses,
  formatDistrictLines,
  getDistrictMeta,
  DISTRICT_STATUS_LABELS,
  DISTRICT_STATUS_TO_KEY,
  statusKeyToDistrictStatus,
  HCPSS_COUNTY
} from './districts.js';
import { computeClosureOutlook, formatOutlookLines, closureOutlookTitle } from './outlook.js';
import { getSnowfallForecast, formatSnowfallLines } from './snowfall.js';
import { getBgeOutages, formatOutageLine, getCountyOutage, outagePercent } from './outages.js';
import { getChartIncidents, formatRoadLines } from './roads.js';
import { getNewsSignal, crossCheckMismatch } from './crosscheck.js';
import { getConfig, getEffectiveConfig, getActiveOverride } from './config.js';
import { getCalendarEvent } from './calendar.js';
import { getStatusHistory } from './history.js';
import { computeSnowDayBudget, formatSnowDayBudgetLines } from './snowbudget.js';

export function footerWithCheckedAt(label, checkedAt) {
  return `${label} - Last checked ${formatCheckedAt(checkedAt)}`;
}

export function splitEmbeds(title, description, url, color, footer, checkedAt = new Date(), thumbnailUrl = '') {
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
      footer: { text: footerWithCheckedAt(footer || 'School Status', checkedAt) },
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

export function buildCheckAgainComponents(config = null) {
  const rows = [{
    type: 1,
    components: [
      { type: 2, style: 1, label: 'Check again', custom_id: 'check_again' },
      { type: 2, style: 2, label: 'Notify Me', custom_id: 'dm_subscribe', emoji: { name: '🔔' } }
    ]
  }];

  // Self-service ping roles: anyone can toggle the notification role for a
  // status right from the post (only affects their own roles).
  const pingRoles = (config && config.status_ping_roles) || {};
  const options = Object.entries(ALL_STATUS_LABELS)
    .filter(([key]) => pingRoles[key])
    .map(([key, label]) => ({
      label: `${label} pings`,
      value: key,
      description: `Toggle the ping role for ${label}`,
      emoji: { name: '🔔' }
    }));
  if (options.length) {
    // First option opens the per-user "My notifications" panel, which can
    // show real checked state (ephemeral responses are per-user).
    options.unshift({
      label: 'My notification roles',
      value: 'my_pings',
      description: 'See which ping roles you have and edit them all at once',
      emoji: { name: '📋' }
    });
    rows.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: 'role_toggle_select',
        placeholder: '🔔 Get pinged — toggle a notification role...',
        options,
        min_values: 1,
        max_values: 1
      }]
    });
  }

  return rows;
}

// Discord hard limits: field name 256, field value 1024, and 6000 characters
// across the whole embed. The individual sections are informally capped, but
// one long NWS event name or road description must never 400 the whole post —
// clamp defensively at the seams.
const FIELD_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;
const EMBED_TOTAL_LIMIT = 6000;

function clampText(text, limit) {
  const s = String(text || '');
  if (s.length <= limit) return s;
  // Prefer cutting at a line break so a truncated list loses whole lines.
  const cut = s.lastIndexOf('\n', limit - 2);
  return `${s.slice(0, cut > limit / 2 ? cut : limit - 1).trimEnd()}…`;
}

function addField(embed, name, value) {
  embed.fields = [...(embed.fields || []), {
    name: clampText(name, FIELD_NAME_LIMIT),
    value: clampText(value, FIELD_VALUE_LIMIT)
  }];
}

export function embedTotalSize(embed) {
  if (!embed) return 0;
  let size = (embed.title || '').length + (embed.description || '').length +
    ((embed.footer && embed.footer.text) || '').length +
    ((embed.author && embed.author.name) || '').length;
  for (const f of embed.fields || []) {
    size += (f.name || '').length + (f.value || '').length;
  }
  return size;
}

// Keeps an embed under Discord's 6000-character total by dropping fields from
// the end (they're added in priority order, so the least critical go first).
// Exported for tests.
export function enforceEmbedBudget(embed) {
  if (!embed) return embed;
  while (embedTotalSize(embed) > EMBED_TOTAL_LIMIT && Array.isArray(embed.fields) && embed.fields.length) {
    embed.fields.pop();
  }
  if (embedTotalSize(embed) > EMBED_TOTAL_LIMIT && embed.description) {
    const overshoot = embedTotalSize(embed) - EMBED_TOTAL_LIMIT;
    embed.description = clampText(embed.description, Math.max(0, embed.description.length - overshoot - 1));
  }
  return embed;
}

export async function buildStatusEmbeds(env, footer = 'School Status', cards = null, config = null, staleInfo = null, guildId = '') {
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
      addField(embeds[0], '⛅ Active Weather Alerts — Howard County', alertLines);
    }
  }

  // During a storm alert, add expected snow/ice accumulations from the NWS
  // forecast so the outlook has concrete numbers behind it.
  if (weatherEnabled && hasStormAlert(alerts) && embeds[0]) {
    const snowLines = formatSnowfallLines(await getSnowfallForecast(env));
    if (snowLines) {
      addField(embeds[0], '🌨️ Snowfall Forecast — Howard County', snowLines);
    }
  }

  // On closure days, show how much of the built-in inclement weather day
  // budget the district has burned (the closure being announced is already in
  // history by the time the per-guild posts build).
  if ((statusKey === 'schools_closed' || statusKey === 'schools_and_offices_closed') && embeds[0] && env && env.STATUS_KV) {
    try {
      const budgetLines = formatSnowDayBudgetLines(computeSnowDayBudget(await getStatusHistory(env), checkedAt));
      if (budgetLines) {
        addField(embeds[0], '❄️ Inclement Weather Days', budgetLines);
      }
    } catch {}
  }

  const stormActive = weatherEnabled && hasStormAlert(alerts);

  // BGE power outages and CHART road conditions for Howard County during storms.
  const outagesEnabled = !config || config.toggle_outages !== false;
  let outageSummary = null;
  if (outagesEnabled && stormActive && embeds[0]) {
    outageSummary = await getBgeOutages(env);
    const county = getCountyOutage(outageSummary, HCPSS_COUNTY);
    if (county && county.out > 0) {
      const line = formatOutageLine(outageSummary, HCPSS_COUNTY);
      if (line) addField(embeds[0], '🔌 Power Outages — Howard County', line);
    }
  }
  const roadsEnabled = !config || config.toggle_roads !== false;
  if (roadsEnabled && stormActive && embeds[0]) {
    const roadLines = formatRoadLines(await getChartIncidents(env), HCPSS_COUNTY);
    if (roadLines) {
      addField(embeds[0], '🛣️ Road Conditions — Howard County', roadLines);
    }
  }

  // While a storm alert is active, show what the neighboring districts have
  // announced — surrounding counties' calls are the strongest signal for HCPSS.
  const districtsEnabled = !config || config.toggle_districts !== false;
  const outlookEnabled = !config || config.toggle_outlook !== false;
  let districts = null;
  if ((districtsEnabled || outlookEnabled) && stormActive && embeds[0]) {
    districts = await getDistrictStatuses(env);
  }
  if (districtsEnabled && stormActive && embeds[0] && districts) {
    const districtLines = formatDistrictLines(districts);
    if (districtLines) {
      addField(embeds[0], '🏫 Nearby Districts', districtLines);
    }
  }

  // Closure Outlook: only meaningful during a storm alert, and pointless once
  // HCPSS has already announced something other than normal operations.
  if (outlookEnabled && stormActive && embeds[0] && statusKey === 'normal_operations') {
    const pct = outagePercent(getCountyOutage(outageSummary, HCPSS_COUNTY));
    const outlookText = formatOutlookLines(computeClosureOutlook(alerts, districts || [], { outagePercent: pct }));
    if (outlookText) {
      addField(embeds[0], closureOutlookTitle(alerts), outlookText);
    }
  }

  // Second-source cross-check: warn when the HCPSS News feed announced a
  // closing/delay but the status page still shows normal operations.
  const crosscheckEnabled = !config || config.toggle_crosscheck !== false;
  if (crosscheckEnabled && embeds[0]) {
    const signal = await getNewsSignal(env);
    if (crossCheckMismatch(statusKey, signal)) {
      const posted = signal.atMs ? ` (posted <t:${Math.floor(signal.atMs / 1000)}:R>)` : '';
      addField(
        embeds[0],
        '🔎 Source Cross-Check',
        `⚠️ The [HCPSS News site](https://news.hcpss.org) has a recent post that reads as a closing or delay${posted}, ` +
        `but the status page still shows Normal Operations — it may be lagging.\n> ${signal.detail}`
      );
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
      try { calEvent = await getCalendarEvent(env, guildId, tomorrowYmd); } catch {}
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
      addField(embeds[0], '🌙 Tomorrow Outlook', outlookLines.join('\n'));
    }
  }

  return embeds.map(enforceEmbedBudget);
}

export function buildStatusErrorEmbeds(error, footer = 'School Status', config = null) {
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

// Status embeds for a guild whose primary district is a neighboring county
// rather than HCPSS. Announcements come from the district's own fetcher;
// weather uses that county's NWS zone; Nearby Districts includes HCPSS.
export async function buildDistrictStatusEmbeds(env, config, guildId = '', hcpssCards = null, footer = 'Status Monitor') {
  const districtId = config && config.primary_district;
  const meta = getDistrictMeta(districtId);
  if (!meta) throw new Error(`Unknown primary district: ${districtId}`);

  const districts = await getDistrictStatuses(env);
  const mine = (districts || []).find(d => d.id === districtId);
  if (!mine || mine.status === 'unavailable') {
    throw new Error(`The ${meta.name} announcement source is unavailable right now.`);
  }

  const checkedAt = new Date();
  const statusKey = DISTRICT_STATUS_TO_KEY[mine.status] || 'unknown_alert';
  const statusLabel = mine.status === 'none' ? 'Normal Operations' : (DISTRICT_STATUS_LABELS[mine.status] || 'Announcement');

  let desc = `## **${statusLabel}**`;
  if (mine.detail && mine.status !== 'none') {
    desc += `\n\n${mine.detail}`;
  } else if (mine.status === 'none') {
    desc += `\n\nNo closing or delay announcements from ${meta.name} schools — normal operations assumed.`;
  }

  let color = getDefaultStatusColor(statusKey);
  if (config && config.status_embed_colors && typeof config.status_embed_colors[statusKey] === 'number') {
    color = config.status_embed_colors[statusKey];
  }
  const customFooter = (config && config.alert_embed_footer) || footer;
  const thumbnailUrl = getStatusThumbnail(statusKey);

  const embeds = splitEmbeds(
    `${meta.name} Schools — Status for ${formatStatusDate(checkedAt)}`,
    desc, meta.url, color, customFooter, checkedAt, thumbnailUrl
  ).slice(0, MAX_EMBEDS);

  // Weather alerts for this district's own county zone.
  const weatherEnabled = !config || config.toggle_weather !== false;
  const alerts = weatherEnabled ? await getActiveWeatherAlerts(env, meta.nwsZone) : [];
  if (weatherEnabled && embeds[0]) {
    const alertLines = formatWeatherAlertLines(alerts);
    if (alertLines) {
      addField(embeds[0], `⛅ Active Weather Alerts — ${meta.name}`, alertLines);
    }
  }

  const stormActive = weatherEnabled && hasStormAlert(alerts);

  if (weatherEnabled && stormActive && embeds[0]) {
    const snowLines = formatSnowfallLines(await getSnowfallForecast(env));
    if (snowLines) {
      addField(embeds[0], '🌨️ Snowfall Forecast — Region', snowLines);
    }
  }

  // BGE power outages (where BGE serves the county) and CHART road conditions.
  const outagesEnabled = !config || config.toggle_outages !== false;
  let outageSummary = null;
  if (outagesEnabled && stormActive && embeds[0]) {
    outageSummary = await getBgeOutages(env);
    const county = getCountyOutage(outageSummary, meta.county);
    if (county && county.out > 0) {
      const line = formatOutageLine(outageSummary, meta.county);
      if (line) addField(embeds[0], `🔌 Power Outages — ${meta.county} County`, line);
    }
  }
  const roadsEnabled = !config || config.toggle_roads !== false;
  if (roadsEnabled && stormActive && embeds[0]) {
    const roadLines = formatRoadLines(await getChartIncidents(env), meta.county);
    if (roadLines) {
      addField(embeds[0], `🛣️ Road Conditions — ${meta.county} County`, roadLines);
    }
  }

  // Nearby Districts: the other five counties plus HCPSS itself.
  const districtsEnabled = !config || config.toggle_districts !== false;
  const outlookEnabled = !config || config.toggle_outlook !== false;
  let neighborList = null;
  if ((districtsEnabled || outlookEnabled) && stormActive && embeds[0]) {
    neighborList = districts.filter(d => d.id !== districtId);
    if (!hcpssCards) {
      try {
        const fetched = await getStatusCards(env);
        hcpssCards = fetched.cards;
      } catch {}
    }
    if (hcpssCards) {
      const hcpssStatus = statusKeyToDistrictStatus(determineStatusKey(hcpssCards));
      neighborList = [
        { id: 'hcpss', name: 'Howard Co.', status: hcpssStatus, detail: '' },
        ...neighborList
      ];
    }
  }
  if (districtsEnabled && stormActive && embeds[0] && neighborList) {
    const districtLines = formatDistrictLines(neighborList);
    if (districtLines) {
      addField(embeds[0], '🏫 Nearby Districts', districtLines);
    }
  }

  if (outlookEnabled && stormActive && embeds[0] && statusKey === 'normal_operations') {
    const pct = outagePercent(getCountyOutage(outageSummary, meta.county));
    const outlookText = formatOutlookLines(computeClosureOutlook(alerts, neighborList || [], { outagePercent: pct }));
    if (outlookText) {
      addField(embeds[0], closureOutlookTitle(alerts), outlookText);
    }
  }

  // Evening Tomorrow Outlook: this guild's own calendar events (the built-in
  // HCPSS calendar doesn't apply to other districts) plus lingering storm alerts.
  const etHour = Number(getEasternTimeStr(checkedAt).split(':')[0]);
  if (etHour >= 17 && embeds[0]) {
    const outlookLines = [];
    const tomorrow = new Date(checkedAt.getTime() + 24 * 60 * 60 * 1000);
    let calEvent = null;
    if (env && env.STATUS_KV) {
      try { calEvent = await getCalendarEvent(env, guildId, formatYmdNY(tomorrow)); } catch {}
    }
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
      addField(embeds[0], '🌙 Tomorrow Outlook', outlookLines.join('\n'));
    }
  }

  return { embeds: embeds.map(enforceEmbedBudget), statusKey };
}

export function buildOverrideEmbeds(override, footer = 'School Status', config = null) {
  const checkedAt = new Date();
  const statusKey = override && override.status_key ? String(override.status_key) : '';
  const statusLabel = override && override.status_label ? String(override.status_label) : 'Override';
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

export async function buildStatusPayload(env, { includeComponents = false, footer = 'School Status', guildId = '', cards = null, error = null, stale = false, staleAt = 0 } = {}) {
  const storedConfig = await getConfig(env, guildId);
  const config = getEffectiveConfig(storedConfig);

  const activeOverride = env ? await getActiveOverride(env, guildId) : null;
  if (activeOverride) {
    const payload = {
      content: '',
      embeds: buildOverrideEmbeds(activeOverride, footer, config)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents(config);
    return { payload, isError: false, isOverride: true, statusKey: activeOverride.status_key };
  }

  // Guilds with a non-HCPSS primary district get their district's status
  // instead of the HCPSS status page.
  if (config.primary_district && config.primary_district !== 'hcpss') {
    try {
      const built = await buildDistrictStatusEmbeds(env, config, guildId, cards, footer);
      const payload = { content: '', embeds: built.embeds };
      if (includeComponents) payload.components = buildCheckAgainComponents(config);
      return { payload, isError: false, statusKey: built.statusKey };
    } catch (err) {
      const meta = getDistrictMeta(config.primary_district);
      const checkedAt = new Date();
      const payload = {
        content: '',
        embeds: [{
          title: `${meta ? meta.name : 'District'} status check failed`,
          url: meta ? meta.url : undefined,
          description: `The monitor could not read this district's announcements right now. Try again in a minute.${err && err.message ? `\n\nTechnical detail: ${err.message}` : ''}`,
          color: getDefaultStatusColor('unknown_alert'),
          footer: { text: footerWithCheckedAt((config && config.alert_embed_footer) || footer, checkedAt) },
          timestamp: checkedAt.toISOString()
        }]
      };
      if (includeComponents) payload.components = buildCheckAgainComponents(config);
      return { payload, isError: true, error: err, statusKey: 'unknown_alert' };
    }
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
    if (includeComponents) payload.components = buildCheckAgainComponents(config);
    return { payload, isError: true, error, statusKey: 'unknown_alert' };
  }

  try {
    const statusKey = determineStatusKey(cards);
    const payload = {
      content: '',
      embeds: await buildStatusEmbeds(env, footer, cards, config, stale ? { staleAt } : null, guildId)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents(config);
    return { payload, isError: false, stale, statusKey };
  } catch (err) {
    const payload = {
      content: '',
      embeds: buildStatusErrorEmbeds(err, footer, config)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents(config);
    return { payload, isError: true, error: err, statusKey: 'unknown_alert' };
  }
}
