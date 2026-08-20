// A/B day rotation for HCPSS.
//
// HCPSS alternates between A days and B days on school days. The rotation
// does NOT advance on days when school is cancelled (snow days, closures) —
// if it was an A day and school is cancelled, the next school day is still
// an A day. Weekends, holidays, and scheduled closures are also skipped.
//
// The anchor is the first day of the 2026-2027 school year for K-12:
//   2026-08-24 (Monday) = A day.

import { getSessionInfo, addDaysYmd } from './session.js';

// Anchor: the first student day of the 2026-2027 school year is an A day.
export const AB_DAY_ANCHOR = '2026-08-24';
export const AB_DAY_ANCHOR_VALUE = 'A'; // 0 = A

// Status keys that mean school was cancelled (the rotation does not advance).
const CLOSURE_STATUS_KEYS = new Set([
  'schools_closed',
  'schools_and_offices_closed'
]);

// Determines whether a given status key represents a cancellation that should
// freeze the A/B rotation for that day. Delays and early dismissals are still
// school days — the rotation advances normally.
export function isClosureStatus(statusKey) {
  return CLOSURE_STATUS_KEYS.has(statusKey);
}

// Builds a Set of YYYY-MM-DD date strings for days that had a closure status
// in the history array. Each history entry has { timestamp, status_key, date }.
// `date` is the display date (e.g. "Aug 24, 2026") — not reliably a YMD — so
// we derive the YMD from the timestamp (Eastern time).
export function closureDatesFromHistory(history) {
  const dates = new Set();
  for (const h of Array.isArray(history) ? history : []) {
    if (!h || !isClosureStatus(h.status_key)) continue;
    // Derive the YMD in Eastern time from the timestamp.
    const d = new Date(h.timestamp);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(d);
    const get = t => (parts.find(p => p.type === t) || {}).value || '';
    const ymd = `${get('year')}-${get('month')}-${get('day')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) dates.add(ymd);
  }
  return dates;
}

// Counts the number of school days (for rotation purposes) from the anchor
// up to but NOT including `targetYmd`. A school day is a weekday that is
// in-session per the calendar AND was not a closure day per history.
//
// Returns the count, or null if targetYmd is before the anchor or invalid.
export function countSchoolDays(targetYmd, closureDates = new Set()) {
  if (!targetYmd || targetYmd < AB_DAY_ANCHOR) return null;

  let count = 0;
  let cursor = AB_DAY_ANCHOR;

  while (cursor < targetYmd) {
    const session = getSessionInfo(cursor, 'hcpss');
    // A day counts as a school day for rotation if:
    //  1. The calendar says school is in session (weekday, not a holiday/closure)
    //  2. It was not a snow day / cancellation (from history)
    if (session.inSession && !closureDates.has(cursor)) {
      count++;
    }
    cursor = addDaysYmd(cursor, 1);
  }

  return count;
}

// Returns 'A' or 'B' for the given date, or null if the date is before the
// anchor or outside the school year.
//
// `closureDates` is a Set of YYYY-MM-DD strings for days when school was
// cancelled (from status history). Pass the result of closureDatesFromHistory.
//
// The target date itself is NOT counted in the rotation — we want to know
// what letter day today IS, not what comes after it. So we count the school
// days before it: even count → A, odd count → B.
export function getABDay(targetYmd, closureDates = new Set()) {
  const count = countSchoolDays(targetYmd, closureDates);
  if (count === null) return null;

  // Check if the target date is itself a school day. If not (weekend,
  // holiday, etc.), there's no A/B day to show.
  const session = getSessionInfo(targetYmd, 'hcpss');
  if (!session.inSession) return null;

  return count % 2 === 0 ? 'A' : 'B';
}

// Formatted line for the status embed.
export function formatABDayLine(abDay) {
  if (!abDay) return '';
  const emoji = abDay === 'A' ? '🅰️' : '🅱️';
  return `${emoji} **${abDay} Day**`;
}
