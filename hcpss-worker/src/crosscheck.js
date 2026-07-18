// Second-source cross-check: the status page occasionally lags HCPSS's actual
// announcement, which usually lands on the HCPSS News site first. This module
// scans the news RSS feed for a recent closing/delay post and lets the embed
// flag a disagreement with the scraped status page. Failures always degrade to
// "no signal" — this can never break a status post.

import { stripHtml, classifyDistrictText } from './districts.js';

export const HCPSS_NEWS_FEED_URL = 'https://news.hcpss.org/feed/';

const NEWS_CACHE_KEY = 'news_signal_cache';
const NEWS_CACHE_TTL_SECONDS = 600;
const FETCH_TIMEOUT_MS = 8000;

// Only posts this recent can describe today's operating status.
export const NEWS_RECENT_WINDOW_MS = 12 * 60 * 60 * 1000;

const UA = 'school-status-bot (github.com/kodymcmonagle808-cmd/school-status-bot)';

// Parses RSS 2.0 <item> blocks into [{ text, atMs }], newest first, keeping
// only items within the recent window.
export function parseRssItems(xml, nowMs = Date.now()) {
  const items = [];
  for (const m of String(xml || '').matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const block = m[0];
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    const desc = (block.match(/<description[^>]*>([\s\S]*?)<\/description>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const atMs = Date.parse(pubDate.trim()) || 0;
    const text = stripHtml(`${title} ${desc}`.replace(/<!\[CDATA\[|\]\]>/g, ' '));
    if (text && atMs && nowMs - atMs <= NEWS_RECENT_WINDOW_MS) items.push({ text, atMs });
  }
  items.sort((a, b) => b.atMs - a.atMs);
  return items;
}

// Reduces recent news items to one operating-status signal, or null when no
// recent post reads as a closing/delay/early dismissal.
export function summarizeNewsItems(items) {
  for (const item of Array.isArray(items) ? items : []) {
    const status = classifyDistrictText(item.text);
    if (status) {
      return { status, detail: item.text.slice(0, 140), atMs: item.atMs };
    }
  }
  return null;
}

// The scraped status keys each news signal is consistent with. A signal that
// maps to the current status key is agreement, anything else is a mismatch.
const SIGNAL_TO_STATUS_KEYS = {
  closed: ['schools_closed', 'schools_and_offices_closed'],
  delayed: ['schools_open_2_hours_late'],
  early: ['schools_close_3_hours_early'],
  virtual: ['schools_closed', 'schools_and_offices_closed', 'unknown_alert']
};

export function crossCheckMismatch(statusKey, signal) {
  if (!signal || !signal.status) return false;
  const consistent = SIGNAL_TO_STATUS_KEYS[signal.status] || [];
  if (consistent.includes(statusKey)) return false;
  // Any non-normal scraped status already shows an alert; only warn when the
  // page still claims normal operations (the lagging-page case).
  return statusKey === 'normal_operations';
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// Fetches the news signal with a 10-minute KV cache. Caches "no signal" too,
// so quiet days cost one feed fetch per 10 minutes at most. Never throws.
export async function getNewsSignal(env) {
  if (env && env.STATUS_KV) {
    try {
      const cached = await env.STATUS_KV.get(NEWS_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed === 'object') return parsed.signal || null;
      }
    } catch {}
  }

  let signal = null;
  try {
    const r = await fetch(HCPSS_NEWS_FEED_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: timeoutSignal(FETCH_TIMEOUT_MS)
    });
    if (!r.ok) throw new Error('News feed fetch failed ' + r.status);
    signal = summarizeNewsItems(parseRssItems(await r.text()));
  } catch {
    return null;
  }

  if (env && env.STATUS_KV) {
    await env.STATUS_KV.put(
      NEWS_CACHE_KEY,
      JSON.stringify({ at: Date.now(), signal }),
      { expirationTtl: NEWS_CACHE_TTL_SECONDS }
    ).catch(() => {});
  }
  return signal;
}
