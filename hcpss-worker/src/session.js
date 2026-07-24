// "Is school actually in session?" — the gate the storm alerts were missing.
//
// The status page never says "closed" for a scheduled break; on Dec 27 it
// still reads Normal Operations. Every alert path keyed off that (the 7 PM
// heads-up, the 4:30 AM Decision Watch board, storm-mode's 15-minute checks)
// would happily announce a possible closing for a day school was never open.
// This module answers the question once so all of them can ask it.
//
// The contract is deliberately one-sided: `noSchoolReason` returns a reason
// ONLY when we are confident there is no school. Anything unknown — a date
// past the built-in calendar, a neighboring district's own PD day — returns
// null, meaning "don't suppress". A missed suppression is channel noise; a
// wrong suppression is a family that never heard the school was closed.

import { SCHOOL_CALENDAR_EVENTS } from './constants.js';

// School-year coverage of SCHOOL_CALENDAR_EVENTS: `start` is the first day for
// K-12 students, `end` is the last day that could possibly be a school day
// (the tail of the inclement-weather makeup range). Update this alongside the
// calendar in constants.js — `calendarExhaustion()` warns when it runs short.
export const SCHOOL_YEAR_WINDOWS = [
  { id: '2026-2027', start: '2026-08-24', end: '2027-06-16' }
];

// Dates outside a known window still get a summer verdict inside this band —
// no Maryland district holds classes between late June and mid-August, so it
// stays correct after the built-in calendar expires.
export const SUMMER_BAND_START = '06-25';
export const SUMMER_BAND_END = '08-15';

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function ymdParts(ymd) {
  const m = YMD_RE.exec(String(ymd || ''));
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function toYmd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 0 = Sunday. -1 for an unparseable date. A YYYY-MM-DD string is already a
// calendar date, so it's read as UTC — no timezone or DST shift can apply.
export function weekdayFromYmd(ymd) {
  const p = ymdParts(ymd);
  if (!p) return -1;
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

// Calendar-date arithmetic that can't be knocked off by a DST transition the
// way `now + 86400000` can.
export function addDaysYmd(ymd, days) {
  const p = ymdParts(ymd);
  if (!p) return '';
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return toYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function nthWeekdayOfMonth(year, month, weekday, n) {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
  return toYmd(year, month, day);
}

export function lastWeekdayOfMonth(year, month, weekday) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return toYmd(year, month, lastDay - ((lastDow - weekday + 7) % 7));
}

// Closures every Maryland public school district observes, computed as
// weekday rules rather than fixed dates so they hold for any year — this is
// what lets the gate work for guilds following a neighboring district, whose
// own calendars the bot doesn't have. Deliberately conservative: district-
// specific things like spring break and PD days are not in here.
export function universalClosureReason(ymd) {
  const p = ymdParts(ymd);
  if (!p) return null;
  const { y, m, d } = p;

  if (m === 12 && d >= 24) return 'Winter Break';
  if (m === 1 && d === 1) return "New Year's Day";
  if (m === 7 && d === 4) return 'Independence Day';

  if (m === 9 && ymd === nthWeekdayOfMonth(y, 9, 1, 1)) return 'Labor Day';
  if (m === 1 && ymd === nthWeekdayOfMonth(y, 1, 1, 3)) return 'Martin Luther King Jr. Day';
  if (m === 2 && ymd === nthWeekdayOfMonth(y, 2, 1, 3)) return 'Presidents Day';
  if (m === 5 && ymd === lastWeekdayOfMonth(y, 5, 1)) return 'Memorial Day';

  if (m === 11) {
    const thanksgiving = nthWeekdayOfMonth(y, 11, 4, 4);
    if (ymd === thanksgiving) return 'Thanksgiving';
    if (ymd === addDaysYmd(thanksgiving, 1)) return 'Thanksgiving Holiday';
  }
  return null;
}

export function findSchoolYearWindow(ymd) {
  if (!ymdParts(ymd)) return null;
  return SCHOOL_YEAR_WINDOWS.find(w => ymd >= w.start && ymd <= w.end) || null;
}

// True only inside the universal summer band. Dates inside a known school-year
// window are never summer, so this is just the out-of-coverage fallback.
export function isSummerBreak(ymd) {
  const p = ymdParts(ymd);
  if (!p) return false;
  if (findSchoolYearWindow(ymd)) return false;
  const md = `${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  return md >= SUMMER_BAND_START && md <= SUMMER_BAND_END;
}

// A calendar entry means "no student day" when it says schools are *closed*.
// "Schools close 3 hours early" is still a school day, and the word is
// "close", not "closed" — so the \bclosed\b test separates them cleanly.
// Exported for tests because that distinction is the whole ballgame.
export function calendarEventClosesSchools(eventText) {
  return /\bclosed\b/i.test(String(eventText || ''));
}

// { inSession, reason, confident } for one date and district.
//   confident:false → the bot does not know; callers must not suppress.
// Only HCPSS has a built-in calendar, so guilds following a neighboring
// district get the district-agnostic rules (weekend, summer, universal
// holidays) and nothing more.
export function getSessionInfo(ymd, districtId = 'hcpss') {
  if (!ymdParts(ymd)) return { inSession: true, reason: '', confident: false };

  const dow = weekdayFromYmd(ymd);
  if (dow === 0 || dow === 6) {
    return { inSession: false, reason: 'Weekend', confident: true };
  }

  if (isSummerBreak(ymd)) {
    return { inSession: false, reason: 'Summer Break', confident: true };
  }

  const universal = universalClosureReason(ymd);
  if (universal) {
    return { inSession: false, reason: universal, confident: true };
  }

  const isHcpss = !districtId || districtId === 'hcpss';
  if (isHcpss) {
    const window = findSchoolYearWindow(ymd);
    if (!window) {
      // Past (or before) the built-in calendar — the weekday/holiday rules
      // above already ran, and beyond them we're guessing.
      return { inSession: true, reason: '', confident: false };
    }
    const event = SCHOOL_CALENDAR_EVENTS[ymd];
    if (event && calendarEventClosesSchools(event)) {
      return { inSession: false, reason: event, confident: true };
    }
    return { inSession: true, reason: '', confident: true };
  }

  // A neighboring district on an ordinary weekday: assume school, since the
  // bot has no calendar to say otherwise.
  return { inSession: true, reason: '', confident: false };
}

// The gate itself. Returns a short human reason when the bot is confident
// there is no school (suppress), or null when there is or might be (post).
export function noSchoolReason(ymd, districtId = 'hcpss') {
  const info = getSessionInfo(ymd, districtId);
  return !info.inSession && info.confident ? info.reason : null;
}

// How much runway the built-in calendar has left. The map covers one school
// year and has to be replaced by hand each August; without this the gate just
// goes quiet and nobody notices.
export function calendarExhaustion(todayYmd, warnWithinDays = 60) {
  const last = SCHOOL_YEAR_WINDOWS[SCHOOL_YEAR_WINDOWS.length - 1];
  if (!last || !ymdParts(todayYmd)) return { endsOn: last ? last.end : '', daysLeft: null, warn: false };

  const a = ymdParts(todayYmd);
  const b = ymdParts(last.end);
  const daysLeft = Math.round(
    (Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000
  );
  return { endsOn: last.end, daysLeft, warn: daysLeft <= warnWithinDays };
}
