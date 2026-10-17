import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecapLines } from '../src/recap.js';

const YEAR_STATS = { snowDays: 4, delays: 3, earlyCloses: 1 };

test('buildRecapLines shows this year without a previous year', () => {
  const text = buildRecapLines(YEAR_STATS, null, null);
  assert.match(text, /Closure Days\*\*: 4/);
  assert.match(text, /2-Hour Delays\*\*: 3/);
  assert.match(text, /Early Closings\*\*: 1/);
  assert.doesNotMatch(text, /vs\./);
});

test('buildRecapLines compares against the previous year', () => {
  const prev = { schools_closed: 3, schools_and_offices_closed: 2, schools_open_2_hours_late: 2, schools_close_3_hours_early: 0 };
  const text = buildRecapLines(YEAR_STATS, '2024-25', prev);
  assert.match(text, /vs\. 2024-25\*\*: ❄️ 5 closure\(s\) · 🕑 2 delay\(s\) · 🏃 0 early closing\(s\)/);
  // 8 this year vs 7 last year → wilder
  assert.match(text, /wilder year than last — 8 incidents vs\. 7/);
});

test('buildRecapLines handles calmer and even years', () => {
  const busyPrev = { schools_closed: 10, schools_open_2_hours_late: 5, schools_close_3_hours_early: 0 };
  assert.match(buildRecapLines(YEAR_STATS, '2024-25', busyPrev), /calmer year than last/);

  const evenPrev = { schools_closed: 4, schools_open_2_hours_late: 3, schools_close_3_hours_early: 1 };
  assert.match(buildRecapLines(YEAR_STATS, '2024-25', evenPrev), /Dead even with last year at 8/);
});
