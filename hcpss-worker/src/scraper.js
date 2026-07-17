import { delay, formatStatusDate, formatYmdNY } from './timeutil.js';

export const HCPSS_URL = 'https://status.hcpss.org';

const LAST_GOOD_SCRAPE_KEY = 'last_good_scrape';
// Don't serve cached status older than this — a day-old status is worse than an
// honest error embed.
const STALE_MAX_MS = 24 * 60 * 60 * 1000;

export async function fetchHtml(url, { retries = 1, retryDelayMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('Fetch failed ' + r.status);
      return await r.text();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await delay(retryDelayMs);
    }
  }
  throw lastErr;
}

// Fetches and parses the live status page. On success the parsed cards are
// cached in KV; on failure the last good scrape (if recent enough) is returned
// with stale=true so callers can post a "last known status" instead of an error.
export async function getStatusCards(env) {
  try {
    const html = await fetchHtml(HCPSS_URL);
    const cards = extractCards(html);
    if (env && env.STATUS_KV) {
      await env.STATUS_KV.put(LAST_GOOD_SCRAPE_KEY, JSON.stringify({ at: Date.now(), cards })).catch(() => {});
    }
    return { cards, error: null, stale: false, staleAt: 0 };
  } catch (err) {
    if (env && env.STATUS_KV) {
      try {
        const raw = await env.STATUS_KV.get(LAST_GOOD_SCRAPE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.cards) && Date.now() - parsed.at <= STALE_MAX_MS) {
            return { cards: parsed.cards, error: err, stale: true, staleAt: parsed.at };
          }
        }
      } catch {}
    }
    return { cards: null, error: err, stale: false, staleAt: 0 };
  }
}

export function extractCards(html) {
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

export function assembleDescription(cards) {
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

export function determineStatusKey(cards) {
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

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Resolves the status date from the site's date text (e.g. "July 14, 2026") as a plain
// calendar day, without any timezone conversion that could shift it to the previous day.
export function statusDateInfo(dateText, fallbackDate) {
  const cleaned = dateText
    ? String(dateText).replace(/,\s*\d{1,2}:\d{2}\s*[AP]M\s*[A-Z]{2,4}$/i, '').trim()
    : '';

  if (cleaned) {
    const m = cleaned.match(/([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (m) {
      const monthIdx = MONTH_NAMES.indexOf(m[1].toLowerCase().slice(0, 3));
      if (monthIdx >= 0) {
        const day = parseInt(m[2], 10);
        const year = parseInt(m[3], 10);
        const utcDate = new Date(Date.UTC(year, monthIdx, day));
        return {
          display: new Intl.DateTimeFormat('en-US', {
            timeZone: 'UTC',
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          }).format(utcDate),
          ymd: `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        };
      }
    }
    return { display: cleaned, ymd: formatYmdNY(fallbackDate) };
  }

  return { display: formatStatusDate(fallbackDate), ymd: formatYmdNY(fallbackDate) };
}
