// Full-school-year status history stored in KV under `status_history`.
// Entries: { timestamp, status, date, status_key } — status_key was added when the
// cap grew from 10 to HISTORY_LIMIT, so older entries may not have it.
export const HISTORY_LIMIT = 200;

export const INCIDENT_KEYS = [
  'schools_closed',
  'schools_and_offices_closed',
  'schools_open_2_hours_late',
  'schools_close_3_hours_early',
  'unknown_alert'
];

// School years run Aug 1 → Jul 31 (Eastern calendar).
export function schoolYearStartMs(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now);
  const get = t => Number((parts.find(p => p.type === t) || {}).value);
  const y = get('year');
  const m = get('month');
  const startYear = m >= 8 ? y : y - 1;
  return Date.UTC(startYear, 7, 1);
}

// Computes per-status incident counts for the current school year from history
// entries, plus the most recent incident of any kind. Entries without a
// status_key (recorded before the field existed) are skipped.
export function computeIncidentStats(history, now = new Date()) {
  const start = schoolYearStartMs(now);
  const year = {};
  for (const k of INCIDENT_KEYS) year[k] = 0;

  let lastIncident = null;
  for (const h of Array.isArray(history) ? history : []) {
    const key = h && h.status_key;
    if (!key || key === 'normal_operations') continue;
    if (!lastIncident || h.timestamp > lastIncident.timestamp) lastIncident = h;
    if (h.timestamp >= start && key in year) year[key]++;
  }

  return {
    year,
    snowDays: year.schools_closed + year.schools_and_offices_closed,
    delays: year.schools_open_2_hours_late,
    earlyCloses: year.schools_close_3_hours_early,
    lastIncident
  };
}

export async function getStatusHistory(env) {
  const rawHistory = await env.STATUS_KV.get('status_history');
  if (!rawHistory) return [];
  try {
    const parsed = JSON.parse(rawHistory);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Records a status change. Callers are responsible for only invoking this when
// the status actually changed (they own the `last_known_status` comparison).
export async function trackStatusHistory(env, currentStatus, primaryDate, statusKey = '') {
  const history = await getStatusHistory(env);

  history.unshift({
    timestamp: Date.now(),
    status: currentStatus,
    date: primaryDate,
    status_key: statusKey || ''
  });

  await env.STATUS_KV.put('status_history', JSON.stringify(history.slice(0, HISTORY_LIMIT)));

  // Increment the all-time operating status counters
  if (statusKey && statusKey !== 'normal_operations') {
    try {
      let stats = {};
      const rawStats = await env.STATUS_KV.get('status_stats');
      if (rawStats) {
        stats = JSON.parse(rawStats) || {};
      }
      stats[statusKey] = (stats[statusKey] || 0) + 1;
      await env.STATUS_KV.put('status_stats', JSON.stringify(stats));
    } catch (e) {
      console.error('Failed to increment operating status stats:', e);
    }
  }
}
