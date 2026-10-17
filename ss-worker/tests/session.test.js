import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  weekdayFromYmd,
  addDaysYmd,
  nthWeekdayOfMonth,
  lastWeekdayOfMonth,
  universalClosureReason,
  isSummerBreak,
  calendarEventClosesSchools,
  getSessionInfo,
  noSchoolReason,
  calendarExhaustion,
  findSchoolYearWindow,
  SCHOOL_YEAR_WINDOWS
} from '../src/session.js';

test('weekdayFromYmd reads calendar dates without timezone drift', () => {
  assert.equal(weekdayFromYmd('2026-12-26'), 6); // Saturday
  assert.equal(weekdayFromYmd('2026-12-27'), 0); // Sunday
  assert.equal(weekdayFromYmd('2026-12-28'), 1); // Monday
  assert.equal(weekdayFromYmd('nonsense'), -1);
});

test('addDaysYmd rolls months and years and survives DST dates', () => {
  assert.equal(addDaysYmd('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysYmd('2027-03-13', 1), '2027-03-14'); // spring forward
  assert.equal(addDaysYmd('2026-11-01', -1), '2026-10-31');
  assert.equal(addDaysYmd('bad', 1), '');
});

test('nth and last weekday math', () => {
  // Labor Day 2026 is Sept 7; Thanksgiving 2026 is Nov 26.
  assert.equal(nthWeekdayOfMonth(2026, 9, 1, 1), '2026-09-07');
  assert.equal(nthWeekdayOfMonth(2026, 11, 4, 4), '2026-11-26');
  // Memorial Day 2027 is May 31.
  assert.equal(lastWeekdayOfMonth(2027, 5, 1), '2027-05-31');
});

test('universal closures are computed as rules, so they hold in any year', () => {
  assert.equal(universalClosureReason('2026-09-07'), 'Labor Day');
  assert.equal(universalClosureReason('2026-11-26'), 'Thanksgiving');
  assert.equal(universalClosureReason('2026-11-27'), 'Thanksgiving Holiday');
  assert.equal(universalClosureReason('2026-12-28'), 'Winter Break');
  assert.equal(universalClosureReason('2027-01-01'), "New Year's Day");
  assert.equal(universalClosureReason('2027-01-18'), 'Martin Luther King Jr. Day');
  assert.equal(universalClosureReason('2027-02-15'), 'Presidents Day');
  assert.equal(universalClosureReason('2027-05-31'), 'Memorial Day');
  // A year the built-in calendar knows nothing about still resolves.
  assert.equal(universalClosureReason('2031-11-27'), 'Thanksgiving');
  assert.equal(universalClosureReason('2031-11-28'), 'Thanksgiving Holiday');
  assert.equal(universalClosureReason('2026-10-14'), null);
});

test('summer band only applies outside a known school year', () => {
  assert.equal(isSummerBreak('2026-07-24'), true);
  assert.equal(isSummerBreak('2026-08-01'), true);
  // Inside the 2026-27 window, so not summer even though it is out of band.
  assert.equal(isSummerBreak('2027-01-15'), false);
  // Between the band and the first student day — unknown, not summer.
  assert.equal(isSummerBreak('2026-08-20'), false);
});

test('"close 3 hours early" is a school day; "closed" is not', () => {
  assert.equal(calendarEventClosesSchools('Schools and offices closed* – Winter Break'), true);
  assert.equal(calendarEventClosesSchools('Schools closed for students – Staff Professional Learning Day'), true);
  assert.equal(
    calendarEventClosesSchools('Schools close 3 hours early; No half-day Pre-K/RECC – Staff Professional Learning/Workday'),
    false
  );
  assert.equal(
    calendarEventClosesSchools('Elementary schools close 3 hours early; No half-day Pre-K/RECC – ES Parent/Teacher Conferences'),
    false
  );
  assert.equal(calendarEventClosesSchools('First day for K-12 students'), false);
});

test('noSchoolReason suppresses weekends, breaks, and calendar closures', () => {
  assert.equal(noSchoolReason('2026-12-26'), 'Weekend');        // Saturday
  assert.equal(noSchoolReason('2026-12-28'), 'Winter Break');   // Monday in break
  assert.equal(noSchoolReason('2026-07-24'), 'Summer Break');
  assert.equal(noSchoolReason('2026-11-25'), 'Schools closed for students – Parent/Teacher Conferences');
  assert.equal(noSchoolReason('2026-09-07'), 'Labor Day');
});

test('noSchoolReason lets ordinary school days through', () => {
  assert.equal(noSchoolReason('2026-10-14'), null); // plain Wednesday
  assert.equal(noSchoolReason('2026-09-30'), null); // 3-hour early dismissal is still school
  assert.equal(noSchoolReason('2027-06-10'), null); // possible makeup day — err toward alerting
});

test('dates past the built-in calendar are never suppressed on a guess', () => {
  // A Wednesday in a school year the calendar does not cover.
  const info = getSessionInfo('2028-10-11');
  assert.equal(info.confident, false);
  assert.equal(noSchoolReason('2028-10-11'), null);
  // ...but the district-agnostic rules still apply out there.
  assert.equal(noSchoolReason('2028-10-14'), 'Weekend');
});

test('neighboring districts only get the district-agnostic rules', () => {
  // HCPSS-specific PD day: suppressed for Howard, not for Frederick, whose
  // own calendar the bot does not have.
  assert.equal(noSchoolReason('2026-10-16', 'hcpss'), 'Schools closed for students – Staff Professional Learning Day');
  assert.equal(noSchoolReason('2026-10-16', 'fcps'), null);
  // Universal closures and weekends still apply to every district.
  assert.equal(noSchoolReason('2026-11-26', 'fcps'), 'Thanksgiving');
  assert.equal(noSchoolReason('2026-12-26', 'mcps'), 'Weekend');
  assert.equal(noSchoolReason('2026-07-24', 'ccps'), 'Summer Break');
});

test('the heads-up case: a storm on Dec 27 is about a day inside winter break', () => {
  // 7 PM Sunday Dec 27 asks about Monday Dec 28.
  assert.equal(noSchoolReason(addDaysYmd('2026-12-27', 1)), 'Winter Break');
  // And a Sunday in a normal week asks about a real Monday.
  assert.equal(noSchoolReason(addDaysYmd('2026-10-18', 1)), null);
});

test('calendarExhaustion warns before the built-in calendar runs out', () => {
  const last = SCHOOL_YEAR_WINDOWS[SCHOOL_YEAR_WINDOWS.length - 1];
  const early = calendarExhaustion('2026-09-01');
  assert.equal(early.endsOn, last.end);
  assert.equal(early.warn, false);
  assert.ok(early.daysLeft > 60);

  const late = calendarExhaustion('2027-05-20');
  assert.equal(late.warn, true);
  assert.ok(late.daysLeft <= 60);
});

test('findSchoolYearWindow brackets the declared year', () => {
  assert.equal(findSchoolYearWindow('2026-08-24').id, '2026-2027');
  assert.equal(findSchoolYearWindow('2027-06-16').id, '2026-2027');
  assert.equal(findSchoolYearWindow('2026-08-23'), null);
  assert.equal(findSchoolYearWindow('2027-06-17'), null);
});
