// Closure Outlook: a simple heuristic score for how likely an HCPSS closing or
// delay is, built from the two strongest signals the bot already collects —
// active NWS storm alerts and what the neighboring districts have announced.
// This is an informal estimate for context, never a prediction of HCPSS's call.

import { isStormAlert } from './weather.js';

export const OUTLOOK_LEVELS = {
  none: { label: 'None', emoji: '⚪' },
  low: { label: 'Low', emoji: '🟢' },
  moderate: { label: 'Moderate', emoji: '🟡' },
  high: { label: 'High', emoji: '🟠' },
  very_high: { label: 'Very High', emoji: '🔴' }
};

// Points for the single strongest weather alert. Warnings outrank watches
// outrank advisories; NWS severity is the tiebreaker for unusual event names.
function weatherPoints(alert) {
  const event = String(alert.event || '').toLowerCase();
  if (/blizzard|ice storm/.test(event)) return 4;
  if (/warning/.test(event)) return 3;
  if (/watch/.test(event)) return 2;
  if (alert.severity === 'Extreme') return 3;
  if (alert.severity === 'Severe') return 2;
  return 1; // advisories and anything else storm-like
}

// Widespread power outages add to the outlook: schools without power can't
// open even in fine weather.
export const OUTAGE_MODERATE_PERCENT = 5;
export const OUTAGE_SEVERE_PERCENT = 20;

// Computes { level, score, reasons } from summarized weather alerts, district
// statuses, and optional extras ({ outagePercent }). Returns level 'none'
// when there is no storm signal at all.
export function computeClosureOutlook(alerts, districts, extras = {}) {
  const stormAlerts = (Array.isArray(alerts) ? alerts : []).filter(isStormAlert);
  const reasons = [];
  let score = 0;

  if (stormAlerts.length) {
    const strongest = stormAlerts.reduce((a, b) => (weatherPoints(b) > weatherPoints(a) ? b : a));
    score += weatherPoints(strongest);
    reasons.push(`${strongest.event} active`);
  }

  const closed = [];
  const delayed = [];
  for (const d of Array.isArray(districts) ? districts : []) {
    if (d.status === 'closed' || d.status === 'virtual') closed.push(d.name);
    else if (d.status === 'delayed') delayed.push(d.name);
  }
  // Nearby calls are the strongest signal, but cap their contribution so one
  // region-wide event doesn't instantly max the meter on its own.
  const districtPoints = Math.min(4, closed.length * 2 + delayed.length);
  score += districtPoints;
  if (closed.length) {
    reasons.push(`${closed.length} nearby district${closed.length === 1 ? '' : 's'} closed (${closed.join(', ')})`);
  }
  if (delayed.length) {
    reasons.push(`${delayed.length} nearby district${delayed.length === 1 ? '' : 's'} opening late (${delayed.join(', ')})`);
  }

  const pct = Number(extras && extras.outagePercent) || 0;
  if (pct >= OUTAGE_SEVERE_PERCENT) {
    score += 2;
    reasons.push(`${pct.toFixed(0)}% of the county without power`);
  } else if (pct >= OUTAGE_MODERATE_PERCENT) {
    score += 1;
    reasons.push(`${pct.toFixed(0)}% of the county without power`);
  }

  let level = 'none';
  if (score >= 6) level = 'very_high';
  else if (score >= 4) level = 'high';
  else if (score >= 2) level = 'moderate';
  else if (score >= 1) level = 'low';

  return { level, score, reasons };
}

export function formatOutlookLines(outlook) {
  if (!outlook || outlook.level === 'none') return '';
  const meta = OUTLOOK_LEVELS[outlook.level] || OUTLOOK_LEVELS.low;
  const reasonText = outlook.reasons.length ? outlook.reasons.map(r => `> ${r}`).join('\n') : '';
  const header = `${meta.emoji} **${meta.label}** chance of a closing or delay`;
  return reasonText
    ? `${header}\n${reasonText}\n> *Unofficial estimate — HCPSS makes the final call.*`
    : `${header}\n> *Unofficial estimate — HCPSS makes the final call.*`;
}
