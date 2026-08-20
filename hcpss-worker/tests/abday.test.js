import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getABDay,
  formatABDayLine,
  closureDatesFromHistory,
  countSchoolDays,
  isClosureStatus
} from '../src/abday.js';

describe('AB day rotation', () => {
  it('anchor date 2026-08-24 is A day', () => {
    assert.equal(getABDay('2026-08-24'), 'A');
  });

  it('2026-08-25 (Tue) is B day', () => {
    assert.equal(getABDay('2026-08-25'), 'B');
  });

  it('2026-08-26 (Wed) is A day', () => {
    assert.equal(getABDay('2026-08-26'), 'A');
  });

  it('2026-08-27 (Thu) is B day', () => {
    assert.equal(getABDay('2026-08-27'), 'B');
  });

  it('2026-08-28 (Fri) is A day', () => {
    assert.equal(getABDay('2026-08-28'), 'A');
  });

  it('weekends return null', () => {
    // 2026-08-29 is Saturday, 2026-08-30 is Sunday
    assert.equal(getABDay('2026-08-29'), null);
    assert.equal(getABDay('2026-08-30'), null);
  });

  it('2026-08-31 (Mon, second week) continues rotation from Friday', () => {
    // Mon-Fri of week 1: A B A B A (5 school days)
    // Mon of week 2 (Aug 31): count = 5 → 5 % 2 = 1 → B
    assert.equal(getABDay('2026-08-31'), 'B');
  });

  it('2026-09-01 (Tue, second week) is A', () => {
    // 6 school days elapsed → 6 % 2 = 0 → A
    assert.equal(getABDay('2026-09-01'), 'A');
  });

  it('date before anchor returns null', () => {
    assert.equal(getABDay('2026-08-23'), null);
    assert.equal(getABDay('2025-01-01'), null);
  });

  it('scheduled closure (Labor Day 2026-09-07) returns null', () => {
    // Labor Day is a no-school day
    assert.equal(getABDay('2026-09-07'), null);
  });

  it('rotation skips Labor Day correctly', () => {
    // Week 1 (Aug 24-28): A B A B A (5 days)
    // Week 2 (Sep 1-5): B A B A B (10 days total)
    // Sep 7 = Labor Day (no school, skipped)
    // Sep 8 (Tue): count = 10 → 10 % 2 = 0 → A
    assert.equal(getABDay('2026-09-08'), 'A');
  });

  it('snow day freezes rotation', () => {
    // Suppose 2026-08-25 (normally B day) was a snow day closure
    const closureDates = new Set(['2026-08-25']);

    // 2026-08-24 = A (count 0), 2026-08-25 = closure (skipped)
    // 2026-08-26: count = 1 school day before it (just Aug 24) → 1 % 2 = 1 → B
    // The B day that was missed on the 25th shifts to the 26th
    assert.equal(getABDay('2026-08-26', closureDates), 'B');

    // Without the closure, 2026-08-26 would be A (count=2, 2%2=0)
    assert.equal(getABDay('2026-08-26', new Set()), 'A');
  });

  it('multiple consecutive snow days freeze rotation', () => {
    // Suppose Mon and Tue (Aug 24, 25) are both snow days
    const closureDates = new Set(['2026-08-24', '2026-08-25']);

    // 2026-08-26 (Wed): 0 school days before it → 0 % 2 = 0 → A
    assert.equal(getABDay('2026-08-26', closureDates), 'A');

    // 2026-08-27 (Thu): 1 school day before it (Wed) → 1 % 2 = 1 → B
    assert.equal(getABDay('2026-08-27', closureDates), 'B');
  });

  it('closure on today still shows the A/B day', () => {
    // Even if today is a closure, getABDay returns the letter day
    // so families know which day it will be when they return.
    // The closure date is in closureDates, but getABDay checks if
    // targetYmd is a school day via calendar — a snow day is still
    // a weekday in session per the calendar, so it shows.
    const closureDates = new Set(['2026-08-24']);
    // Aug 24 is a weekday and in session per calendar, so it shows
    // count = 0, 0 % 2 = 0 → A
    assert.equal(getABDay('2026-08-24', closureDates), 'A');
  });
});

describe('countSchoolDays', () => {
  it('returns 0 for the anchor date itself', () => {
    assert.equal(countSchoolDays('2026-08-24'), 0);
  });

  it('returns null for dates before anchor', () => {
    assert.equal(countSchoolDays('2026-08-23'), null);
  });

  it('counts 5 school days for first week', () => {
    // Aug 24 (Mon) through Aug 28 (Fri) = 5 school days
    // Count up to Aug 29 (Sat) = 5
    assert.equal(countSchoolDays('2026-08-29'), 5);
  });

  it('skips closure dates', () => {
    const closureDates = new Set(['2026-08-25']);
    // Aug 24 (school), Aug 25 (closure, skip), Aug 26 counted
    assert.equal(countSchoolDays('2026-08-26', closureDates), 1);
  });
});

describe('isClosureStatus', () => {
  it('identifies closure statuses', () => {
    assert.equal(isClosureStatus('schools_closed'), true);
    assert.equal(isClosureStatus('schools_and_offices_closed'), true);
  });

  it('delays and early dismissals are not closures', () => {
    assert.equal(isClosureStatus('schools_open_2_hours_late'), false);
    assert.equal(isClosureStatus('schools_close_3_hours_early'), false);
    assert.equal(isClosureStatus('normal_operations'), false);
  });
});

describe('closureDatesFromHistory', () => {
  it('extracts closure dates from history entries', () => {
    const history = [
      { timestamp: Date.UTC(2026, 7, 25, 12), status_key: 'schools_closed' },
      { timestamp: Date.UTC(2026, 7, 26, 12), status_key: 'normal_operations' },
      { timestamp: Date.UTC(2026, 7, 27, 12), status_key: 'schools_and_offices_closed' }
    ];
    const dates = closureDatesFromHistory(history);
    assert.ok(dates.has('2026-08-25'));
    assert.ok(!dates.has('2026-08-26'));
    assert.ok(dates.has('2026-08-27'));
  });

  it('handles empty/null history', () => {
    assert.equal(closureDatesFromHistory(null).size, 0);
    assert.equal(closureDatesFromHistory([]).size, 0);
  });
});

describe('formatABDayLine', () => {
  it('formats A day', () => {
    assert.equal(formatABDayLine('A'), '🅰️ **A Day**');
  });

  it('formats B day', () => {
    assert.equal(formatABDayLine('B'), '🅱️ **B Day**');
  });

  it('returns empty for null', () => {
    assert.equal(formatABDayLine(null), '');
  });
});
