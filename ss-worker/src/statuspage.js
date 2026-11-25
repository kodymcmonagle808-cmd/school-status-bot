// Public read-only status page served at GET / — a shareable dashboard for people
// who aren't in a Discord server. Renders live status cards (60s cache), A/B day,
// active NWS alerts, Closure Outlook, BGE outages, neighboring districts, recent
// AI-summarized announcements, and a cached official website screenshot.

import { getStatusCards, determineStatusKey, cleanBody, HCPSS_URL } from './scraper.js';
import { getCachedWeatherAlerts } from './weather.js';
import { getStatusHistory } from './history.js';
import { formatCheckedAt, formatYmdNY } from './timeutil.js';
import { getABDay, closureDatesFromHistory } from './abday.js';
import { getDistrictStatuses, HCPSS_COUNTY, DISTRICT_STATUS_LABELS } from './districts.js';
import { getBgeOutages, getCountyOutage, outagePercent, formatOutageLine } from './outages.js';
import { computeClosureOutlook, OUTLOOK_LEVELS } from './outlook.js';
import { ensureEmailsTable } from './db.js';
import { SCREENSHOT_CACHE_KEY } from './screenshot.js';

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STATUS_COLORS = {
  normal_operations: '#2ecc71',
  schools_closed: '#e74c3c',
  schools_and_offices_closed: '#e74c3c',
  schools_open_2_hours_late: '#e67e22',
  schools_close_3_hours_early: '#e67e22',
  unknown_alert: '#e74c3c'
};

const DISTRICT_BADGE_EMOJI = {
  closed: '🔴',
  delayed: '🟠',
  early: '🟡',
  virtual: '💻',
  notice: 'ℹ️',
  none: '🟢',
  unavailable: '⚪'
};

// Pure renderer; exported for tests. Optional fields default cleanly for backwards compatibility.
export function renderStatusPage({
  cards,
  stale,
  staleAt,
  error,
  alerts,
  history,
  now = new Date(),
  abDay = null,
  districts = null,
  outlook = null,
  outageLine = '',
  emails = null,
  screenshotUrl = ''
}) {
  const statusKey = cards ? determineStatusKey(cards) : 'unknown_alert';
  const color = STATUS_COLORS[statusKey] || '#e74c3c';

  let statusHtml;
  if (cards && cards.length) {
    statusHtml = cards.map(c => {
      const body = cleanBody(c.body);
      return `
      <article class="card">
        ${c.date ? `<div class="date">${escapeHtml(c.date)}</div>` : ''}
        <h2>${escapeHtml(c.title)}</h2>
        ${body ? `<p>${escapeHtml(body)}</p>` : ''}
      </article>`;
    }).join('\n');
  } else if (cards) {
    statusHtml = '<article class="card"><h2>Normal Operations</h2><p>No alerts on the HCPSS status page.</p></article>';
  } else {
    statusHtml = `<article class="card"><h2>Status unavailable</h2><p>The HCPSS status page could not be reached${error ? ` (${escapeHtml(error.message)})` : ''}. Check <a href="${HCPSS_URL}">status.hcpss.org</a> directly.</p></article>`;
  }

  const abBadgeHtml = abDay
    ? `<span class="pill">📅 Today: <strong>${escapeHtml(abDay)} Day</strong></span>`
    : '';

  const staleHtml = stale && staleAt
    ? `<p class="stale">⚠️ Live page unreachable — showing the last known status from ${escapeHtml(formatCheckedAt(new Date(staleAt)))}.</p>`
    : '';

  let outlookHtml = '';
  if (outlook && outlook.level && outlook.level !== 'none') {
    const meta = OUTLOOK_LEVELS[outlook.level] || OUTLOOK_LEVELS.low;
    const reasons = Array.isArray(outlook.reasons) && outlook.reasons.length
      ? `<ul>${outlook.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
      : '';
    outlookHtml = `
    <section class="panel">
      <h3>${meta.emoji} Closure Outlook — ${escapeHtml(meta.label)}</h3>
      ${reasons}
      <p class="muted">Unofficial estimate — HCPSS makes the final call.</p>
    </section>`;
  }

  const alertsHtml = (alerts || []).length
    ? `<h3>Active weather alerts — Howard County</h3><ul>${alerts.map(a =>
        `<li>⚠️ ${escapeHtml(a.event)}${a.endsMs ? ` — until ${escapeHtml(formatCheckedAt(new Date(a.endsMs)))}` : ''}</li>`).join('')}</ul>`
    : '';

  const cleanOutage = String(outageLine || '').replace(/\*\*/g, '');
  const outageHtml = cleanOutage
    ? `<p class="outage">${escapeHtml(cleanOutage)}</p>`
    : '';

  const districtsHtml = Array.isArray(districts) && districts.length
    ? `<h3>Neighboring School Districts</h3>
       <div class="grid">${districts.map(d => {
         const emoji = DISTRICT_BADGE_EMOJI[d.status] || '⚪';
         const label = DISTRICT_STATUS_LABELS[d.status] || 'Unknown';
         return `<div class="mini-card"><span class="dist-name">${emoji} ${escapeHtml(d.name)}</span><span class="dist-status">${escapeHtml(label)}</span></div>`;
       }).join('')}</div>`
    : '';

  const screenshotHtml = screenshotUrl
    ? `<h3>Official Status Page Snapshot</h3>
       <figure class="shot">
         <a href="${escapeHtml(screenshotUrl)}" target="_blank" rel="noopener">
           <img src="${escapeHtml(screenshotUrl)}" alt="Official HCPSS status page screenshot" loading="lazy">
         </a>
       </figure>`
    : '';

  const emailsHtml = Array.isArray(emails) && emails.length
    ? `<h3>Recent School Announcements</h3>
       <div class="emails">${emails.map(e => {
         const titleText = e.url
           ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.subject || 'Announcement')}</a>`
           : escapeHtml(e.subject || 'Announcement');
         const when = e.ts ? `<span class="when">${escapeHtml(formatCheckedAt(new Date(Number(e.ts))))}</span>` : '';
         const summary = e.ai_summary
           ? `<div class="ai-summary"><strong>🤖 AI Summary</strong><pre>${escapeHtml(e.ai_summary)}</pre></div>`
           : '';
         return `<article class="email-card"><h4>${titleText}</h4>${when}${summary}</article>`;
       }).join('')}</div>`
    : '';

  const historyHtml = (history || []).length
    ? `<h3>Recent status changes</h3><ul>${history.slice(0, 5).map(h =>
        `<li><span class="when">${escapeHtml(formatCheckedAt(new Date(h.timestamp)))}</span><br>${escapeHtml(String(h.status).replace(/[#*_>`]/g, ''))}</li>`).join('')}</ul>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HCPSS School Status</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.6;
         max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem; }
  h1 { font-size: 1.6rem; margin: 0; }
  h3 { margin-top: 1.8rem; margin-bottom: .6rem; }
  .pill { background: rgba(52, 152, 219, .15); border: 1px solid rgba(52, 152, 219, .4);
          padding: .25rem .7rem; border-radius: 999px; font-size: .9rem; }
  .card { border-left: 6px solid ${color}; background: rgba(127,127,127,.08);
          padding: .85rem 1.15rem; border-radius: 6px; margin: 1rem 0; }
  .card h2 { margin: .2rem 0; font-size: 1.25rem; }
  .card .date { font-size: .85rem; opacity: .7; }
  .panel { background: rgba(230, 126, 34, .09); border: 1px solid rgba(230, 126, 34, .3);
           padding: .75rem 1rem; border-radius: 6px; margin: 1rem 0; }
  .panel h3 { margin-top: 0; }
  .muted { font-size: .85rem; opacity: .75; margin-bottom: 0; }
  .stale { color: #e67e22; font-weight: 600; }
  .outage { background: rgba(127,127,127,.08); padding: .55rem .85rem; border-radius: 6px; font-size: .95rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .6rem; }
  .mini-card { background: rgba(127,127,127,.08); padding: .55rem .75rem; border-radius: 6px;
               display: flex; flex-direction: column; gap: .15rem; font-size: .9rem; }
  .dist-name { font-weight: 600; }
  .dist-status { opacity: .8; font-size: .85rem; }
  .shot { margin: .6rem 0 0; }
  .shot img { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid rgba(127,127,127,.25); }
  .email-card { background: rgba(127,127,127,.08); padding: .75rem 1rem; border-radius: 6px; margin: .65rem 0; }
  .email-card h4 { margin: 0 0 .2rem; font-size: 1rem; }
  .ai-summary { margin-top: .5rem; font-size: .9rem; }
  .ai-summary pre { font-family: inherit; white-space: pre-wrap; margin: .25rem 0 0; opacity: .9; }
  ul { padding-left: 1.2rem; }
  li { margin: .4rem 0; }
  .when { font-size: .85rem; opacity: .7; }
  footer { margin-top: 3rem; font-size: .85rem; opacity: .7; }
  a { color: inherit; }
</style>
</head>
<body>
<header>
  <h1>HCPSS School Status</h1>
  ${abBadgeHtml}
</header>
${staleHtml}
${statusHtml}
${outlookHtml}
${alertsHtml}
${outageHtml}
${districtsHtml}
${emailsHtml}
${screenshotHtml}
${historyHtml}
<footer>Checked ${escapeHtml(formatCheckedAt(now))} · Unofficial — always verify with
<a href="${HCPSS_URL}">status.hcpss.org</a> · <a href="/api/status">JSON API</a> ·
<a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></footer>
</body>
</html>`;
}

export async function statusPageResponse(env) {
  const now = new Date();
  const [fetched, alerts, history, districts, outageSummary] = await Promise.all([
    getStatusCards(env),
    getCachedWeatherAlerts(env).catch(() => []),
    getStatusHistory(env).catch(() => []),
    getDistrictStatuses(env).catch(() => []),
    getBgeOutages(env).catch(() => null)
  ]);

  const abDay = getABDay(formatYmdNY(now), closureDatesFromHistory(history));
  const hcpssOutage = getCountyOutage(outageSummary, HCPSS_COUNTY);
  const outagePct = outagePercent(hcpssOutage);
  const outageLine = hcpssOutage && hcpssOutage.out > 0 ? formatOutageLine(outageSummary, HCPSS_COUNTY) : '';
  const outlook = computeClosureOutlook(alerts, districts, { outagePercent: outagePct });

  let emails = [];
  if (env && env.DB) {
    try {
      await ensureEmailsTable(env.DB);
      const res = await env.DB.prepare(`
        SELECT id, subject, ai_summary, MAX(ts) AS ts, url
        FROM emails
        GROUP BY id
        ORDER BY ts DESC
        LIMIT 4
      `).all();
      emails = (res && Array.isArray(res.results)) ? res.results : [];
    } catch {}
  }

  let screenshotUrl = '';
  if (env && env.BACKUPS_BUCKET && typeof env.BACKUPS_BUCKET.head === 'function') {
    try {
      const head = await env.BACKUPS_BUCKET.head(SCREENSHOT_CACHE_KEY);
      if (head) screenshotUrl = '/screenshot.png';
    } catch {}
  }
  if (!screenshotUrl && env && env.BROWSER) {
    screenshotUrl = '/screenshot.png';
  }

  return new Response(renderStatusPage({
    cards: fetched.cards,
    stale: fetched.stale,
    staleAt: fetched.staleAt,
    error: fetched.error,
    alerts,
    history,
    now,
    abDay,
    districts,
    outlook,
    outageLine,
    emails,
    screenshotUrl
  }), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The scrape cache is 60s; let browsers/CDN reuse the page for that long.
      'Cache-Control': 'public, max-age=60'
    }
  });
}
