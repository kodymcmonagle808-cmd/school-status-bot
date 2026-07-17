// Status embed building: turns scraped cards (or an override/error) into the
// Discord embed payloads posted to alert channels.

import {
  EMBED_LIMIT,
  EMBED_SAFE,
  MAX_EMBEDS,
  SCHOOL_CALENDAR_EVENTS,
  getDefaultStatusColor,
  getStatusThumbnail
} from './constants.js';
import { getEasternTimeStr, formatCheckedAt, formatStatusDate, formatYmdNY } from './timeutil.js';
import { HCPSS_URL, fetchHtml, getStatusCards, extractCards, assembleDescription, determineStatusKey, statusDateInfo } from './scraper.js';
import { getActiveWeatherAlerts, formatWeatherAlertLines, hasStormAlert, alertsLikelyTomorrowMorning } from './weather.js';
import { getDistrictStatuses, formatDistrictLines } from './districts.js';
import { computeClosureOutlook, formatOutlookLines } from './outlook.js';
import { getNewsSignal, crossCheckMismatch } from './crosscheck.js';
import { getConfig, getEffectiveConfig, getActiveOverride } from './config.js';

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

export function buildCheckAgainComponents() {
  return [{
    type: 1,
    components: [
      { type: 2, style: 1, label: 'Check again', custom_id: 'check_again' },
      { type: 2, style: 2, label: 'Notify Me', custom_id: 'dm_subscribe', emoji: { name: '🔔' } }
    ]
  }];
}

function addField(embed, name, value) {
  embed.fields = [...(embed.fields || []), { name, value }];
}

export async function buildStatusEmbeds(env, footer = 'HCPSS Status Monitor', cards = null, config = null, staleInfo = null) {
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

  // While a storm alert is active, show what the neighboring districts have
  // announced — surrounding counties' calls are the strongest signal for HCPSS.
  const districtsEnabled = !config || config.toggle_districts !== false;
  const outlookEnabled = !config || config.toggle_outlook !== false;
  const stormActive = weatherEnabled && hasStormAlert(alerts);
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
    const outlookText = formatOutlookLines(computeClosureOutlook(alerts, districts || []));
    if (outlookText) {
      addField(embeds[0], '❄️ Closure Outlook', outlookText);
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
      addField(embeds[0], '🌙 Tomorrow Outlook', outlookLines.join('\n'));
    }
  }

  return embeds;
}

export function buildStatusErrorEmbeds(error, footer = 'HCPSS Status Monitor', config = null) {
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

export function buildOverrideEmbeds(override, footer = 'HCPSS Status Monitor', config = null) {
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

export async function buildStatusPayload(env, { includeComponents = false, footer = 'HCPSS Status Monitor', guildId = '', cards = null, error = null, stale = false, staleAt = 0 } = {}) {
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
