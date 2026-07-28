// HCPSS News watcher: bus/transportation alerts, activities/athletics
// cancellations, and school-specific notices.
//
// Bus alerts — HCPSS has no public bus-delay feed (delays go out via
// text/email and the Zum app), but service-level transportation posts (route
// suspensions, systemwide delays, restorations) land on the HCPSS News RSS.
//
// Activity alerts — HCPSS regularly cancels after-school activities,
// athletics, and field trips without closing schools ("all after-school and
// evening activities are canceled"); the status page never shows these, so
// the news feed is the only source.
//
// School-specific notices — the district-wide classifier deliberately ignores
// single-building announcements ("X Elementary closed for a water main
// break"); this watcher surfaces those as low-key posts without pings.

import { getRecentNewsItems } from './crosscheck.js';
import { getEasternTimeStr } from './timeutil.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { discordFetch } from './discord.js';
import { postLog } from './panel.js';
import { notifySchoolSubscribers } from './schoolsubs.js';

const LAST_POSTED_KEY = 'bus_alert_last_ms';
const ACTIVITY_LAST_KEY = 'activity_alert_last_ms';
const SCHOOL_NOTICE_LAST_KEY = 'school_notice_last_ms';
const MAX_POSTS_PER_RUN = 2;

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

// An activity alert names after-school programming AND describes an impact —
// schedule announcements ("High school sports schedules announced") and
// "activities will continue as scheduled" posts stay quiet.
const ACTIVITY_RE = /\bafter-?school\b|\bevening activit\w*|\bextracurricular\b|\bathletic\w*\b|\bfield trips?\b|\bintramural\w*\b|\bpractices and games\b/i;
const ACTIVITY_IMPACT_RE = /\b(cancel(?:s|l?ed|ing|lation)?|postpon\w*|suspend\w*|called? off|will not (?:be held|take place|occur)|resched\w*)\b/i;

export function classifyActivityAlert(text) {
  const t = String(text || '');
  return ACTIVITY_RE.test(t) && ACTIVITY_IMPACT_RE.test(t);
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

// The cron fires every minute; scan on one fixed minute of every ten. A clock
// gate costs zero KV ops — the old cooldown key (get + TTL put) spent ~100
// writes/day of the 1,000/day free budget just pacing itself. Offset staggers
// this scan away from the other watchers' gate minutes.
export const SCAN_MINUTE_OFFSET = 2;

export function isBusScanMinute(etStr) {
  const m = Number(String(etStr).split(':')[1]);
  return Number.isFinite(m) && m % 10 === SCAN_MINUTE_OFFSET;
}

// Scans the news feed (once per 10 minutes, on the clock-gate minute) and
// posts any new transportation alerts to every opted-in guild. Never throws.
//
// The items come from the same pushed cache the cross-check reads, not a fetch
// of this module's own. This used to download news.hcpss.org/feed/ directly on
// every scan — ~102 fetches a day of a feed the Apps Script collector already
// downloads every 5 minutes and pushes on change, which is exactly the
// Worker-side scheduled polling that belongs up in the collector. A null read
// means the items are genuinely unknown (unreadable feed, or a cache entry
// predating stored items), and must not be classified as "no news".
export async function maybeSendBusAlerts(env, now = new Date()) {
  if (!env || !env.STATUS_KV) return { sent: 0 };
  const etStr = getEasternTimeStr(now);
  if (!isWithinBusAlertHours(etStr)) return { sent: 0 };
  if (!isBusScanMinute(etStr)) return { sent: 0 };

  const items = await getRecentNewsItems(env);
  if (!Array.isArray(items) || !items.length) return { sent: 0 };

  // parseRssItems returns newest first; post oldest first so channels read in order.
  const lastBusMs = Number(await env.STATUS_KV.get(LAST_POSTED_KEY) || 0);
  const freshBus = items.filter(i => classifyBusAlert(i.text) && i.atMs > lastBusMs)
    .slice(0, MAX_POSTS_PER_RUN)
    .reverse();

  // Each item lands in exactly one category: bus beats activity beats school.
  const lastActivityMs = Number(await env.STATUS_KV.get(ACTIVITY_LAST_KEY) || 0);
  const freshActivity = items.filter(i =>
    !classifyBusAlert(i.text) && classifyActivityAlert(i.text) && i.atMs > lastActivityMs
  ).slice(0, MAX_POSTS_PER_RUN).reverse();

  const lastSchoolMs = Number(await env.STATUS_KV.get(SCHOOL_NOTICE_LAST_KEY) || 0);
  const freshSchool = items.filter(i =>
    !classifyBusAlert(i.text) && !classifyActivityAlert(i.text) &&
    classifySchoolNotice(i.text) && i.atMs > lastSchoolMs
  ).slice(0, MAX_POSTS_PER_RUN).reverse();

  if (!freshBus.length && !freshActivity.length && !freshSchool.length) return { sent: 0 };

  if (freshBus.length) {
    await env.STATUS_KV.put(LAST_POSTED_KEY, String(Math.max(...freshBus.map(i => i.atMs))));
  }
  if (freshActivity.length) {
    await env.STATUS_KV.put(ACTIVITY_LAST_KEY, String(Math.max(...freshActivity.map(i => i.atMs))));
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
    if (cfg.toggle_activity_alerts !== false) {
      for (const item of freshActivity) {
        embeds.push({
          title: '🏟️ Activities & Athletics Alert',
          url: 'https://news.hcpss.org',
          color: 0x9B59B6,
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
      const resp = await discordFetch(`https://discord.com/api/v10/channels/${cfg.alert_channel_id}/messages`, {
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

  // DM members who registered a school with /myschool when a school-specific
  // notice names it (deduped across guilds inside notifySchoolSubscribers).
  for (const item of freshSchool) {
    try {
      const dmCount = await notifySchoolSubscribers(env, guildIds, {
        title: '🏫 School-Specific Notice',
        url: 'https://news.hcpss.org',
        color: 0x95A5A6,
        description: item.text.slice(0, 3900),
        footer: { text: 'School Status · via HCPSS News' },
        timestamp: new Date(item.atMs).toISOString()
      }, item.text);
      if (dmCount > 0) {
        console.log(`School notice DM sent to ${dmCount} subscriber(s).`);
      }
    } catch (e) {
      console.error('School subscriber DM failed:', e);
    }
  }
  return { sent };
}
