// Public read-only status page served at GET / — a shareable link for people
// who aren't in a Discord server. Renders the same data the bot posts: current
// status cards (via the 60-second scrape cache, so page traffic can't hammer
// the HCPSS site), active weather alerts (cache-only), and recent history.

import { getStatusCards, determineStatusKey, HCPSS_URL } from './scraper.js';
import { getCachedWeatherAlerts } from './weather.js';
import { getStatusHistory } from './history.js';
import { formatCheckedAt } from './timeutil.js';

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

// Pure renderer; exported for tests.
export function renderStatusPage({ cards, stale, staleAt, error, alerts, history, now = new Date() }) {
  const statusKey = cards ? determineStatusKey(cards) : 'unknown_alert';
  const color = STATUS_COLORS[statusKey] || '#e74c3c';

  let statusHtml;
  if (cards && cards.length) {
    statusHtml = cards.map(c => `
      <article class="card">
        ${c.date ? `<div class="date">${escapeHtml(c.date)}</div>` : ''}
        <h2>${escapeHtml(c.title)}</h2>
        ${c.body ? `<p>${escapeHtml(c.body)}</p>` : ''}
      </article>`).join('\n');
  } else if (cards) {
    statusHtml = '<article class="card"><h2>Normal Operations</h2><p>No alerts on the HCPSS status page.</p></article>';
  } else {
    statusHtml = `<article class="card"><h2>Status unavailable</h2><p>The HCPSS status page could not be reached${error ? ` (${escapeHtml(error.message)})` : ''}. Check <a href="${HCPSS_URL}">status.hcpss.org</a> directly.</p></article>`;
  }

  const staleHtml = stale && staleAt
    ? `<p class="stale">⚠️ Live page unreachable — showing the last known status from ${escapeHtml(formatCheckedAt(new Date(staleAt)))}.</p>`
    : '';

  const alertsHtml = (alerts || []).length
    ? `<h3>Active weather alerts — Howard County</h3><ul>${alerts.map(a =>
        `<li>⚠️ ${escapeHtml(a.event)}${a.endsMs ? ` — until ${escapeHtml(formatCheckedAt(new Date(a.endsMs)))}` : ''}</li>`).join('')}</ul>`
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
         max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.5rem; }
  .card { border-left: 6px solid ${color}; background: rgba(127,127,127,.08);
          padding: .75rem 1.1rem; border-radius: 6px; margin: 1rem 0; }
  .card h2 { margin: .2rem 0; font-size: 1.25rem; }
  .card .date { font-size: .85rem; opacity: .7; }
  .stale { color: #e67e22; font-weight: 600; }
  ul { padding-left: 1.2rem; }
  li { margin: .4rem 0; }
  .when { font-size: .85rem; opacity: .7; }
  footer { margin-top: 3rem; font-size: .85rem; opacity: .7; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>HCPSS School Status</h1>
${staleHtml}
${statusHtml}
${alertsHtml}
${historyHtml}
<footer>Checked ${escapeHtml(formatCheckedAt(now))} · Unofficial — always verify with
<a href="${HCPSS_URL}">status.hcpss.org</a> · Powered by the School Status Discord bot ·
<a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></footer>
</body>
</html>`;
}

export async function statusPageResponse(env) {
  const fetched = await getStatusCards(env);
  const alerts = await getCachedWeatherAlerts(env);
  let history = [];
  try { history = await getStatusHistory(env); } catch {}

  return new Response(renderStatusPage({
    cards: fetched.cards,
    stale: fetched.stale,
    staleAt: fetched.staleAt,
    error: fetched.error,
    alerts,
    history
  }), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The scrape cache is 60s; let browsers/CDN reuse the page for that long.
      'Cache-Control': 'public, max-age=60'
    }
  });
}
