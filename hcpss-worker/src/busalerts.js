// HCPSS News watcher: bus/transportation alerts and school-specific notices.
//
// Bus alerts — HCPSS has no public bus-delay feed (delays go out via
// text/email and the Zum app), but service-level transportation posts (route
// suspensions, systemwide delays, restorations) land on the HCPSS News RSS.
//
// School-specific notices — the district-wide classifier deliberately ignores
// single-building announcements ("X Elementary closed for a water main
// break"); this watcher surfaces those as low-key posts without pings.

import { HCPSS_NEWS_FEED_URL, parseRssItems } from './crosscheck.js';
import { getEasternTimeStr } from './timeutil.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { postLog } from './panel.js';

const SCAN_COOLDOWN_KEY = 'bus_alert_scan_cooldown';
const SCAN_COOLDOWN_TTL_SECONDS = 600;
const LAST_POSTED_KEY = 'bus_alert_last_ms';
const SCHOOL_NOTICE_LAST_KEY = 'school_notice_last_ms';
const FETCH_TIMEOUT_MS = 8000;
const MAX_POSTS_PER_RUN = 2;

const UA = 'school-status-bot (github.com/kodymcmonagle808-cmd/school-status-bot)';

// Only scan while buses actually run and families are awake.
export const BUS_ALERT_START_HOUR = 5;
export const BUS_ALERT_END_HOUR = 22;

// A post is a transportation alert when it names transportation AND describes
// a service impact — plain transportation newsletters ("Transportation
// Reminders for the Start of the School Year") stay quiet.
const TRANSPORT_RE = /\b(bus|buses|transportation|route|routes)\b/i;
const IMPACT_RE = /\b(delay(?:s|ed)?|suspend(?:s|ed|ing|sion)?|cancel(?:s|l?ed|ing|lation)?|late|no service|not operat\w*|out of service|restor(?:e|ed|ing|ation)|resum(?:e|ed|ing)|detour(?:s|ed)?|interrupt\w*|disrupt\w*|driver shortage)\b/i;

export function classifyBusAlert(text) {
  const t = String(text || '');
  return TRANSPORT_RE.test(t) && IMPACT_RE.test(t);
}

// A school-specific notice names a single school and a real impact, without
// reading as a district-wide announcement (those are handled by the status
// scraper and cross-check).
const SCHOOL_RE = /\b(elementary|middle|high) school\b|\bschool\b[^.]{0,30}\b(students|families|community)\b/i;
const SCHOOL_IMPACT_RE = /\b(closed|closing|close|dismiss\w*|evacuat\w*|relocat\w*|without power|power outage|water main|no water|gas leak|reopen\w*|delayed opening|virtual (?:instruction|learning))\b/i;

export function classifySchoolNotice(text) {
  const t = String(text || '');
  if (!t) return false;
  // Plural "schools" reads as district-wide — that's the status scraper's job.
  if (/\bschools\b/i.test(t)) return false;
  return SCHOOL_RE.test(t) && SCHOOL_IMPACT_RE.test(t);
}

export function isWithinBusAlertHours(etStr) {
  const h = Number(String(etStr).split(':')[0]);
  return Number.isFinite(h) && h >= BUS_ALERT_START_HOUR && h < BUS_ALERT_END_HOUR;
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// Scans the news feed (at most once per 10 minutes) and posts any new
// transportation alerts to every opted-in guild. Never throws.
export async function maybeSendBusAlerts(env) {
  if (!env || !env.STATUS_KV) return { sent: 0 };
  if (!isWithinBusAlertHours(getEasternTimeStr(new Date()))) return { sent: 0 };

  if (await env.STATUS_KV.get(SCAN_COOLDOWN_KEY)) return { sent: 0 };
  await env.STATUS_KV.put(SCAN_COOLDOWN_KEY, '1', { expirationTtl: SCAN_COOLDOWN_TTL_SECONDS }).catch(() => {});

  let items = [];
  try {
    const r = await fetch(HCPSS_NEWS_FEED_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: timeoutSignal(FETCH_TIMEOUT_MS)
    });
    if (!r.ok) throw new Error('News feed fetch failed ' + r.status);
    items = parseRssItems(await r.text());
  } catch {
    return { sent: 0 };
  }

  // parseRssItems returns newest first; post oldest first so channels read in order.
  const lastBusMs = Number(await env.STATUS_KV.get(LAST_POSTED_KEY) || 0);
  const freshBus = items.filter(i => classifyBusAlert(i.text) && i.atMs > lastBusMs)
    .slice(0, MAX_POSTS_PER_RUN)
    .reverse();

  const lastSchoolMs = Number(await env.STATUS_KV.get(SCHOOL_NOTICE_LAST_KEY) || 0);
  const freshSchool = items.filter(i =>
    !classifyBusAlert(i.text) && classifySchoolNotice(i.text) && i.atMs > lastSchoolMs
  ).slice(0, MAX_POSTS_PER_RUN).reverse();

  if (!freshBus.length && !freshSchool.length) return { sent: 0 };

  if (freshBus.length) {
    await env.STATUS_KV.put(LAST_POSTED_KEY, String(Math.max(...freshBus.map(i => i.atMs))));
  }
  if (freshSchool.length) {
    await env.STATUS_KV.put(SCHOOL_NOTICE_LAST_KEY, String(Math.max(...freshSchool.map(i => i.atMs))));
  }

  let guildIds = [];
  const rawIndex = await env.STATUS_KV.get('guild_index');
  if (rawIndex) {
    try {
      const parsed = JSON.parse(rawIndex);
      if (Array.isArray(parsed)) guildIds = parsed.filter(Boolean);
    } catch {}
  }
  if (env.DISCORD_GUILD_ID && !guildIds.includes(env.DISCORD_GUILD_ID)) {
    guildIds.push(env.DISCORD_GUILD_ID);
  }

  let sent = 0;
  const token = env.DISCORD_BOT_TOKEN;
  for (const gid of guildIds) {
    const cfg = getEffectiveConfig(await getConfig(env, gid));
    if (!cfg.alert_channel_id) continue;

    const footerText = `${cfg.alert_embed_footer || 'School Status'} · via HCPSS News`;
    const embeds = [];
    if (cfg.toggle_bus_alerts !== false) {
      for (const item of freshBus) {
        embeds.push({
          title: '🚌 HCPSS Transportation Alert',
          url: 'https://news.hcpss.org',
          color: 0xE67E22,
          description: item.text.slice(0, 3900),
          footer: { text: footerText },
          timestamp: new Date(item.atMs).toISOString()
        });
      }
    }
    if (cfg.toggle_school_notices !== false) {
      for (const item of freshSchool) {
        embeds.push({
          title: '🏫 School-Specific Notice',
          url: 'https://news.hcpss.org',
          color: 0x95A5A6,
          description: item.text.slice(0, 3900),
          footer: { text: footerText },
          timestamp: new Date(item.atMs).toISOString()
        });
      }
    }
    if (!embeds.length) continue;

    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${cfg.alert_channel_id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ embeds, allowed_mentions: { parse: [] } })
      });
      if (resp.ok) {
        sent++;
        await postLog(env, cfg.log_channel_id, `📰 News watcher posted ${embeds.length} item(s) to <#${cfg.alert_channel_id}>.`, {}, gid);
      } else {
        console.error(`News watcher post failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error('News watcher post failed:', e);
    }
  }
  return { sent };
}
