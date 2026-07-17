import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeIncidentStats,
  schoolYearStartMs,
  schoolYearLabel,
  computeYearlyIncidents,
  getYearlyStats,
  trackStatusHistory,
  HISTORY_LIMIT
} from '../src/history.js';

test('schoolYearStartMs rolls over on Aug 1', () => {
  assert.equal(schoolYearStartMs(new Date('2026-09-15T12:00:00Z')), Date.UTC(2026, 7, 1));
  assert.equal(schoolYearStartMs(new Date('2027-03-15T12:00:00Z')), Date.UTC(2026, 7, 1));
  assert.equal(schoolYearStartMs(new Date('2026-07-17T12:00:00Z')), Date.UTC(2025, 7, 1));
});

test('computeIncidentStats counts this school year and finds the last incident', () => {
  const now = new Date('2027-02-01T12:00:00Z');
  const thisYear = Date.UTC(2026, 10, 15); // Nov 2026, in the 2026-27 school year
  const lastYear = Date.UTC(2026, 1, 10);  // Feb 2026, previous school year

  const history = [
    { timestamp: thisYear + 3, status: 'Closed', date: 'Nov 15, 2026', status_key: 'schools_closed' },
    { timestamp: thisYear + 2, status: 'Normal', date: 'Nov 16, 2026', status_key: 'normal_operations' },
    { timestamp: thisYear + 1, status: 'Delay', date: 'Nov 14, 2026', status_key: 'schools_open_2_hours_late' },
    { timestamp: lastYear, status: 'Closed', date: 'Feb 10, 2026', status_key: 'schools_and_offices_closed' },
    { timestamp: lastYear - 1, status: 'Old entry with no key', date: 'Feb 9, 2026' }
  ];

  const stats = computeIncidentStats(history, now);
  assert.equal(stats.year.schools_closed, 1);
  assert.equal(stats.year.schools_open_2_hours_late, 1);
  assert.equal(stats.year.schools_and_offices_closed, 0); // previous school year
  assert.equal(stats.snowDays, 1);
  assert.equal(stats.delays, 1);
  assert.equal(stats.earlyCloses, 0);
  assert.equal(stats.lastIncident.timestamp, thisYear + 3);
});

test('computeIncidentStats tolerates empty and malformed history', () => {
  assert.equal(computeIncidentStats([]).snowDays, 0);
  assert.equal(computeIncidentStats(null).lastIncident, null);
});

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); }
  };
}

test('trackStatusHistory records status_key and respects the cap', async () => {
  const kv = makeKv();
  const seed = Array.from({ length: HISTORY_LIMIT }, (_, i) => ({ timestamp: i, status: `s${i}`, date: 'd', status_key: 'schools_closed' }));
  kv.store.set('status_history', JSON.stringify(seed));

  await trackStatusHistory({ STATUS_KV: kv }, 'New closure', 'Jan 5, 2027', 'schools_closed');

  const history = JSON.parse(kv.store.get('status_history'));
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0].status, 'New closure');
  assert.equal(history[0].status_key, 'schools_closed');

  const stats = JSON.parse(kv.store.get('status_stats'));
  assert.equal(stats.schools_closed, 1);
});

test('trackStatusHistory does not count normal operations as an incident', async () => {
  const kv = makeKv();
  await trackStatusHistory({ STATUS_KV: kv }, 'Back to normal', 'Jan 6, 2027', 'normal_operations');
  assert.equal(kv.store.get('status_stats'), undefined);
  assert.equal(kv.store.get('yearly_stats'), undefined);
  const history = JSON.parse(kv.store.get('status_history'));
  assert.equal(history[0].status_key, 'normal_operations');
});

test('schoolYearLabel formats the Aug-Jul school year', () => {
  assert.equal(schoolYearLabel(new Date('2026-09-15T12:00:00Z')), '2026-27');
  assert.equal(schoolYearLabel(new Date('2027-03-15T12:00:00Z')), '2026-27');
  assert.equal(schoolYearLabel(new Date('2026-07-17T12:00:00Z')), '2025-26');
});

test('computeYearlyIncidents groups incidents by school year', () => {
  const history = [
    { timestamp: Date.UTC(2026, 10, 15), status: 'Closed', date: '', status_key: 'schools_closed' },
    { timestamp: Date.UTC(2026, 10, 16), status: 'Normal', date: '', status_key: 'normal_operations' },
    { timestamp: Date.UTC(2026, 1, 10), status: 'Delay', date: '', status_key: 'schools_open_2_hours_late' },
    { timestamp: Date.UTC(2026, 1, 11), status: 'Closed', date: '', status_key: 'schools_closed' },
    { timestamp: Date.UTC(2026, 1, 9), status: 'Old entry with no key', date: '' }
  ];
  const yearly = computeYearlyIncidents(history);
  assert.deepEqual(yearly['2026-27'], { schools_closed: 1 });
  assert.deepEqual(yearly['2025-26'], { schools_open_2_hours_late: 1, schools_closed: 1 });
});

test('trackStatusHistory bumps the per-school-year archive', async () => {
  const kv = makeKv();
  await trackStatusHistory({ STATUS_KV: kv }, 'Closure', 'Jan 5, 2027', 'schools_closed');
  await trackStatusHistory({ STATUS_KV: kv }, 'Another closure', 'Jan 8, 2027', 'schools_closed');
  const yearly = JSON.parse(kv.store.get('yearly_stats'));
  const label = schoolYearLabel(new Date());
  assert.equal(yearly[label].schools_closed, 2);
});

test('getYearlyStats merges archive and history-derived counts with max', async () => {
  const kv = makeKv();
  // Archive knows about an old year that history has lost, and undercounts a
  // year that history still fully retains.
  kv.store.set('yearly_stats', JSON.stringify({
    '2024-25': { schools_closed: 5 },
    '2025-26': { schools_closed: 1 }
  }));
  const history = [
    { timestamp: Date.UTC(2026, 1, 10), status: 'Closed', date: '', status_key: 'schools_closed' },
    { timestamp: Date.UTC(2026, 1, 11), status: 'Closed again', date: '', status_key: 'schools_closed' },
    { timestamp: Date.UTC(2026, 2, 1), status: 'Delay', date: '', status_key: 'schools_open_2_hours_late' }
  ];
  const merged = await getYearlyStats({ STATUS_KV: kv }, history);
  assert.equal(merged['2024-25'].schools_closed, 5);
  assert.equal(merged['2025-26'].schools_closed, 2);
  assert.equal(merged['2025-26'].schools_open_2_hours_late, 1);
});
