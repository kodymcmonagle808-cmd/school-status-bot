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
function schoolYearStartYear(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now);
  const get = t => Number((parts.find(p => p.type === t) || {}).value);
  const y = get('year');
  const m = get('month');
  return m >= 8 ? y : y - 1;
}

export function schoolYearStartMs(now = new Date()) {
  return Date.UTC(schoolYearStartYear(now), 7, 1);
}

// Label for the school year containing the given moment, e.g. "2026-27".
export function schoolYearLabel(now = new Date()) {
  const start = schoolYearStartYear(now);
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
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

// Per-school-year incident counts derived from whatever history entries are
// still retained, keyed by school-year label.
export function computeYearlyIncidents(history) {
  const yearly = {};
  for (const h of Array.isArray(history) ? history : []) {
    const key = h && h.status_key;
    if (!key || key === 'normal_operations' || !INCIDENT_KEYS.includes(key)) continue;
    const label = schoolYearLabel(new Date(h.timestamp));
    if (!yearly[label]) yearly[label] = {};
    yearly[label][key] = (yearly[label][key] || 0) + 1;
  }
  return yearly;
}

// HCPSS history lives under the legacy unsuffixed keys; guilds following a
// neighboring district get their own parallel keys per district id.
function historyKey(districtId) {
  return districtId && districtId !== 'hcpss' ? `status_history:${districtId}` : 'status_history';
}

function yearlyStatsKey(districtId) {
  return districtId && districtId !== 'hcpss' ? `yearly_stats:${districtId}` : 'yearly_stats';
}

// Persistent per-year archive under `yearly_stats`, shaped
// { "<label>": { <status_key>: count } }. History entries are capped at
// HISTORY_LIMIT, so this archive is what preserves old school years.
async function getYearlyStatsArchive(env, districtId = '') {
  const raw = await env.STATUS_KV.get(yearlyStatsKey(districtId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function bumpYearlyStats(env, statusKey, districtId = '', now = new Date()) {
  try {
    const yearly = await getYearlyStatsArchive(env, districtId);
    const label = schoolYearLabel(now);
    if (!yearly[label]) yearly[label] = {};
    yearly[label][statusKey] = (yearly[label][statusKey] || 0) + 1;
    await env.STATUS_KV.put(yearlyStatsKey(districtId), JSON.stringify(yearly));
  } catch (e) {
    console.error('Failed to update yearly stats:', e);
  }
}

// Merges the persistent archive with counts derived from retained history,
// taking the max per status key. The archive only started accruing when this
// feature shipped, so history-derived counts backfill years it missed; once
// history rolls off, the archive keeps the year alive.
export async function getYearlyStats(env, history = null, districtId = '') {
  const [archive, hist] = await Promise.all([
    getYearlyStatsArchive(env, districtId),
    history ? Promise.resolve(history) : getStatusHistory(env, districtId)
  ]);
  const derived = computeYearlyIncidents(hist);

  const merged = {};
  for (const label of new Set([...Object.keys(archive), ...Object.keys(derived)])) {
    merged[label] = {};
    for (const key of INCIDENT_KEYS) {
      const count = Math.max((archive[label] || {})[key] || 0, (derived[label] || {})[key] || 0);
      if (count > 0) merged[label][key] = count;
    }
  }
  return merged;
}

export async function getStatusHistory(env, districtId = '') {
  const rawHistory = await env.STATUS_KV.get(historyKey(districtId));
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
// Pass a districtId to record into that district's own history instead of the
// HCPSS one (district history skips the global all-time `status_stats` counters).
export async function trackStatusHistory(env, currentStatus, primaryDate, statusKey = '', districtId = '') {
  const history = await getStatusHistory(env, districtId);

  history.unshift({
    timestamp: Date.now(),
    status: currentStatus,
    date: primaryDate,
    status_key: statusKey || ''
  });

  await env.STATUS_KV.put(historyKey(districtId), JSON.stringify(history.slice(0, HISTORY_LIMIT)));

  // Increment the all-time and per-school-year operating status counters
  if (statusKey && statusKey !== 'normal_operations') {
    if (!districtId || districtId === 'hcpss') {
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
    await bumpYearlyStats(env, statusKey, districtId);
  }
}
