// Operating status of the school districts neighboring Howard County.
// Each district publishes announcements through a different platform, so each
// has its own fetcher; all of them reduce to { entries: [{ text, atMs }] } and
// share one keyword classifier. Results are cached in KV for 10 minutes and
// any per-district failure degrades to 'unavailable' — this feature is never
// allowed to break a status post.

const DISTRICT_CACHE_KEY = 'district_status_cache';
const DISTRICT_CACHE_TTL_SECONDS = 600;
const FETCH_TIMEOUT_MS = 8000;

// Feed-based sources (AACPS, Carroll) always contain unrelated recent news, so
// only posts newer than this window are considered for classification.
export const RECENT_WINDOW_MS = 18 * 60 * 60 * 1000;

const UA = 'school-status-bot (github.com/kodymcmonagle808-cmd/school-status-bot)';

export const DISTRICT_STATUS_LABELS = {
  closed: 'Schools closed',
  delayed: 'Opening late',
  early: 'Closing early',
  virtual: 'Virtual learning day',
  notice: 'Announcement posted',
  none: 'No announcement',
  unavailable: 'Unavailable'
};

const DISTRICT_STATUS_EMOJI = {
  closed: '🔴',
  delayed: '🟠',
  early: '🟡',
  virtual: '💻',
  notice: 'ℹ️',
  none: '🟢',
  unavailable: '⚪'
};

export function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&ndash;|&#x2013;|&#8211;/gi, '–')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Classifies one announcement's text. Word "schools" is required in plural for
// a closure so single-building notices ("X Elementary School will be closed
// for repairs") don't read as district-wide closures.
export function classifyDistrictText(text) {
  const t = stripHtml(text).toLowerCase();
  if (!t) return null;
  if (/closed session|board of education/.test(t)) return null;

  if (/(two|2)[\s-]*hours? (late|delay)|delayed (opening|start|arrival)|open(ing)?\s+(two|2) hours late/.test(t)) {
    return 'delayed';
  }
  if (/(close|closing|dismiss(ing|al)?)[^.]{0,50}\bearly\b|(two|2|three|3)[\s-]*hours? early/.test(t)) {
    return 'early';
  }
  if (/virtual learning|e-?learning day|asynchronous (instruction|learning)|remote learning day/.test(t)) {
    return 'virtual';
  }
  if (/\bschools\b[^.]{0,60}\bclosed\b|\bclosed\b[^.]{0,40}\bschools\b|all\s+[a-z .']*schools[^.]{0,60}\bclos(e|ed|ing)\b/.test(t)) {
    return 'closed';
  }
  return null;
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function fetchText(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...(init.headers || {}) },
    signal: timeoutSignal(FETCH_TIMEOUT_MS)
  });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  return await r.text();
}

// --- Per-platform parsers (pure; exported for tests) ---

// Apptegy/Thrillshare live feed JSON (AACPS): recent posts with timestamps.
export function parseThrillshareFeed(json, nowMs = Date.now()) {
  let data;
  try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  const feeds = data && Array.isArray(data.live_feeds) ? data.live_feeds : [];
  return feeds
    .map(f => ({ text: stripHtml(f && f.status), atMs: Date.parse((f && f.publishing_at) || '') || 0 }))
    .filter(e => e.text && e.atMs && nowMs - e.atMs <= RECENT_WINDOW_MS);
}

// SharpSchool GetActiveAlerts (BCPS, FCPS): {"d":[...]} of active alerts.
// The alert item shape is not documented, so collect every string field.
export function parseSharpSchoolAlerts(json) {
  let data;
  try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  const items = data && Array.isArray(data.d) ? data.d : [];
  return items.map(item => {
    let text;
    if (typeof item === 'string') {
      text = stripHtml(item);
    } else if (item && typeof item === 'object') {
      text = stripHtml(Object.values(item).filter(v => typeof v === 'string').join(' '));
    }
    return { text: text || '', atMs: 0, active: true };
  }).filter(e => e.text);
}

// Finalsite Composer Atom feed (Carroll): <entry> titles with <updated> stamps.
export function parseAtomEntries(xml, nowMs = Date.now()) {
  const entries = [];
  for (const m of String(xml || '').matchAll(/<entry[\s>][\s\S]*?<\/entry>/g)) {
    const block = m[0];
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    const summary = (block.match(/<(?:summary|content)[^>]*>([\s\S]*?)<\/(?:summary|content)>/) || [])[1] || '';
    const updated = (block.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1] || '';
    const atMs = Date.parse(updated.trim()) || 0;
    const text = stripHtml(`${title} ${summary}`);
    if (text && atMs && nowMs - atMs <= RECENT_WINDOW_MS) entries.push({ text, atMs });
  }
  return entries;
}

// MCPS homepage API: emsg is HTML; the 'emer-code-green' class means normal
// operations, anything else is an actively displayed message.
export function parseMcpsEmergency(json) {
  let data;
  try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  let emsg = data && typeof data.emsg === 'string' ? data.emsg : '';
  if (!emsg || emsg.includes('emer-code-green')) return [];
  emsg = emsg.replace(/<span[^>]*class=['"]timestamp['"][^>]*>[\s\S]*?<\/span>/gi, '');
  const text = stripHtml(emsg)
    .replace(/Important Message:?\s*(Mensaje de importante)?\s*/gi, '')
    .trim();
  return text ? [{ text, atMs: 0, active: true }] : [];
}

// PGCPS homepage: the site-alert banner is server-rendered when active.
export function parsePgcpsAlert(html) {
  const m = String(html || '').match(/<section class="site-alert-component[\s\S]*?<\/section>/);
  if (!m) return [];
  const title = (m[0].match(/<h3 class="title">([\s\S]*?)<\/h3>/) || [])[1] || '';
  const body = (m[0].match(/<div class="read-more">([\s\S]*?)<\/div>/) || [])[1] || '';
  const text = stripHtml(`${title} ${body}`);
  return text ? [{ text, atMs: 0, active: true }] : [];
}

// --- District definitions ---

async function fetchSharpSchoolEntries(host) {
  const body = await fetchText(`https://${host}/WebServices/UnifiedPublishing/UnifiedPublishingService.asmx/GetActiveAlerts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01'
    },
    body: '{"returnDummyAlerts":false}'
  });
  return parseSharpSchoolAlerts(body);
}

export const DISTRICTS = [
  {
    id: 'aacps',
    name: 'Anne Arundel Co.',
    url: 'https://www.aacps.org',
    nwsZone: 'MDC003',
    county: 'Anne Arundel',
    fetchEntries: async () => parseThrillshareFeed(await fetchText('https://api.thrillshare.com/api/v4/o/20274/cms/live_feeds?page=1&per_page=15', { headers: { Accept: 'application/json' } }))
  },
  {
    id: 'bcps',
    name: 'Baltimore Co.',
    url: 'https://www.bcps.org',
    nwsZone: 'MDC005',
    county: 'Baltimore',
    fetchEntries: () => fetchSharpSchoolEntries('www.bcps.org')
  },
  {
    id: 'ccps',
    name: 'Carroll Co.',
    url: 'https://www.carrollk12.org',
    nwsZone: 'MDC013',
    county: 'Carroll',
    fetchEntries: async () => {
      // Closings land on General News (3) or News Releases (63).
      const results = await Promise.allSettled([
        fetchText('https://www.carrollk12.org/fs/post-manager/boards/3/posts/feed'),
        fetchText('https://www.carrollk12.org/fs/post-manager/boards/63/posts/feed')
      ]);
      if (results.every(r => r.status === 'rejected')) throw results[0].reason;
      return results.flatMap(r => r.status === 'fulfilled' ? parseAtomEntries(r.value) : []);
    }
  },
  {
    id: 'fcps',
    name: 'Frederick Co.',
    url: 'https://www.fcps.org',
    nwsZone: 'MDC021',
    county: 'Frederick',
    fetchEntries: () => fetchSharpSchoolEntries('www.fcps.org')
  },
  {
    id: 'mcps',
    name: 'Montgomery Co.',
    url: 'https://www.montgomeryschoolsmd.org',
    nwsZone: 'MDC031',
    county: 'Montgomery',
    fetchEntries: async () => parseMcpsEmergency(await fetchText('https://api.montgomeryschoolsmd.org/schools/homepageInput', { headers: { Accept: 'application/json' } }))
  },
  {
    id: 'pgcps',
    name: "Prince George's Co.",
    url: 'https://www.pgcps.org',
    nwsZone: 'MDC033',
    county: "Prince George's",
    fetchEntries: async () => parsePgcpsAlert(await fetchText('https://www.pgcps.org'))
  }
];

// The county HCPSS itself serves (for outage and road-condition lookups).
export const HCPSS_COUNTY = 'Howard';

// Every district a guild can pick as its primary status source. HCPSS stays
// the default and uses the full status-page scraper; the others use their
// district fetcher above.
export const PRIMARY_DISTRICT_CHOICES = [
  { id: 'hcpss', name: 'Howard Co. (HCPSS)' },
  ...DISTRICTS.map(d => ({ id: d.id, name: d.name }))
];

export function getDistrictMeta(districtId) {
  return DISTRICTS.find(d => d.id === districtId) || null;
}

// Maps a classified district status to the bot's operating-status keys so
// ping roles, embed colors, and thumbnails work for any primary district.
export const DISTRICT_STATUS_TO_KEY = {
  closed: 'schools_closed',
  virtual: 'schools_closed',
  delayed: 'schools_open_2_hours_late',
  early: 'schools_close_3_hours_early',
  notice: 'unknown_alert',
  none: 'normal_operations'
};

// Reverse direction: lets an HCPSS status-page key render as a district-style
// line when HCPSS appears in another primary district's Nearby Districts list.
export function statusKeyToDistrictStatus(statusKey) {
  switch (statusKey) {
    case 'schools_closed':
    case 'schools_and_offices_closed':
      return 'closed';
    case 'schools_open_2_hours_late':
      return 'delayed';
    case 'schools_close_3_hours_early':
      return 'early';
    case 'unknown_alert':
      return 'notice';
    default:
      return 'none';
  }
}

// Reduces one district's entries to a status. Banner-style entries
// (active: true) that don't match a classification still surface as 'notice';
// feed posts that don't classify are just news and count as 'none'.
export function summarizeDistrictEntries(entries) {
  let notice = null;
  for (const e of Array.isArray(entries) ? entries : []) {
    const status = classifyDistrictText(e.text);
    if (status) return { status, detail: stripHtml(e.text).slice(0, 120) };
    if (e.active && !notice) notice = { status: 'notice', detail: stripHtml(e.text).slice(0, 120) };
  }
  return notice || { status: 'none', detail: '' };
}

// Fetches all district statuses in parallel with a shared 10-minute KV cache.
// Never throws; failures come back as status 'unavailable'.
export async function getDistrictStatuses(env) {
  if (env && env.STATUS_KV) {
    try {
      const cached = await env.STATUS_KV.get(DISTRICT_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.districts)) return parsed.districts;
      }
    } catch {}
  }

  const results = await Promise.allSettled(DISTRICTS.map(d => d.fetchEntries()));
  const districts = DISTRICTS.map((d, i) => {
    const base = { id: d.id, name: d.name };
    if (results[i].status !== 'fulfilled') return { ...base, status: 'unavailable', detail: '' };
    return { ...base, ...summarizeDistrictEntries(results[i].value) };
  });

  if (env && env.STATUS_KV) {
    await env.STATUS_KV.put(
      DISTRICT_CACHE_KEY,
      JSON.stringify({ at: Date.now(), districts }),
      { expirationTtl: DISTRICT_CACHE_TTL_SECONDS }
    ).catch(() => {});
  }
  return districts;
}

export function formatDistrictLines(districts, { includeDetail = false } = {}) {
  return (Array.isArray(districts) ? districts : []).map(d => {
    const emoji = DISTRICT_STATUS_EMOJI[d.status] || '⚪';
    const label = DISTRICT_STATUS_LABELS[d.status] || 'Unknown';
    let line = `${emoji} **${d.name}** — ${label}`;
    if (includeDetail && d.detail && d.status !== 'none') {
      line += `\n> ${d.detail}`;
    }
    return line;
  }).join('\n');
}
