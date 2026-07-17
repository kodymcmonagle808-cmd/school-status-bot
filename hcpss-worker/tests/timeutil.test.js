import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesScheduleTime, formatScheduleTimeLabel, clockEmojiForTime, formatYmdNY } from '../src/timeutil.js';

test('matchesScheduleTime fires on time and up to 5 minutes late', () => {
  assert.equal(matchesScheduleTime('5:20', '5:20'), true);
  assert.equal(matchesScheduleTime('5:25', '5:20'), true);
  assert.equal(matchesScheduleTime('5:26', '5:20'), false);
  assert.equal(matchesScheduleTime('5:19', '5:20'), false);
});

test('matchesScheduleTime handles the midnight wraparound', () => {
  assert.equal(matchesScheduleTime('0:02', '23:59'), true);
  assert.equal(matchesScheduleTime('0:30', '23:59'), false);
});

test('formatScheduleTimeLabel renders 12-hour labels', () => {
  assert.equal(formatScheduleTimeLabel('5:20'), '5:20 AM');
  assert.equal(formatScheduleTimeLabel('20:00'), '8:00 PM');
  assert.equal(formatScheduleTimeLabel('0:05'), '12:05 AM');
  assert.equal(formatScheduleTimeLabel('12:00'), '12:00 PM');
});

test('clockEmojiForTime returns a clock face', () => {
  assert.equal(clockEmojiForTime('1:00'), '🕐');
  assert.equal(clockEmojiForTime('13:00'), '🕐');
  assert.equal(clockEmojiForTime('12:00'), '🕛');
});

test('formatYmdNY formats an Eastern calendar date', () => {
  // 2026-01-15T03:00Z is still Jan 14 in New York
  assert.equal(formatYmdNY(new Date('2026-01-15T03:00:00Z')), '2026-01-14');
});
