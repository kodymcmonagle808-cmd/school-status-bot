import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesScheduleTime, formatScheduleTimeLabel, clockEmojiForTime, formatYmdNY, isInStormWindow, stormTickSlot, middayTickSlot, eveningTickSlot, conversionTickSlot, nextScheduledTime } from '../src/timeutil.js';

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

test('isInStormWindow covers 4:30-7:30 AM ET inclusive', () => {
  assert.equal(isInStormWindow('4:29'), false);
  assert.equal(isInStormWindow('4:30'), true);
  assert.equal(isInStormWindow('6:00'), true);
  assert.equal(isInStormWindow('7:30'), true);
  assert.equal(isInStormWindow('7:31'), false);
  assert.equal(isInStormWindow('20:00'), false);
});

test('stormTickSlot fires on quarter hours inside the window', () => {
  assert.equal(stormTickSlot('4:30'), '4:30');
  assert.equal(stormTickSlot('5:15'), '5:15');
  assert.equal(stormTickSlot('7:30'), '7:30');
  assert.equal(stormTickSlot('5:20'), null); // not a tick minute
});

test('stormTickSlot allows up to 2 minutes of cron delay', () => {
  assert.equal(stormTickSlot('5:16'), '5:15');
  assert.equal(stormTickSlot('5:17'), '5:15');
  assert.equal(stormTickSlot('5:18'), null);
  assert.equal(stormTickSlot('7:32'), '7:30'); // delayed final tick still counts
});

test('stormTickSlot rejects quarter hours outside the window', () => {
  assert.equal(stormTickSlot('4:15'), null);
  assert.equal(stormTickSlot('7:45'), null);
  assert.equal(stormTickSlot('12:00'), null);
});

test('middayTickSlot covers the 10 AM-2 PM early-dismissal window', () => {
  assert.equal(middayTickSlot('10:00'), '10:00');
  assert.equal(middayTickSlot('12:15'), '12:15');
  assert.equal(middayTickSlot('14:00'), '14:00');
  assert.equal(middayTickSlot('14:01'), '14:00'); // cron delay grace
  assert.equal(middayTickSlot('9:45'), null);
  assert.equal(middayTickSlot('14:15'), null);
  assert.equal(middayTickSlot('12:20'), null); // not a tick minute
  assert.equal(middayTickSlot('5:15'), null);  // morning window belongs to stormTickSlot
});

test('conversionTickSlot covers 7:45-9:30 AM for delay-to-closure upgrades', () => {
  assert.equal(conversionTickSlot('7:45'), '7:45');
  assert.equal(conversionTickSlot('8:30'), '8:30');
  assert.equal(conversionTickSlot('9:30'), '9:30');
  assert.equal(conversionTickSlot('9:31'), '9:30'); // cron delay grace
  assert.equal(conversionTickSlot('7:30'), null); // still the storm window's tick
  assert.equal(conversionTickSlot('9:45'), null);
  assert.equal(conversionTickSlot('8:20'), null); // not a tick minute
});

test('eveningTickSlot covers 7:00-11:45 PM for the heads-up watch', () => {
  assert.equal(eveningTickSlot('19:00'), '19:00');
  assert.equal(eveningTickSlot('21:30'), '21:30');
  assert.equal(eveningTickSlot('23:45'), '23:45');
  assert.equal(eveningTickSlot('23:46'), '23:45'); // cron delay grace
  assert.equal(eveningTickSlot('18:45'), null);
  assert.equal(eveningTickSlot('0:00'), null);
  assert.equal(eveningTickSlot('19:20'), null); // not a tick minute
});

test('nextScheduledTime finds the next slot and wraps to tomorrow', () => {
  const schedule = ['5:20', '7:20', '10:00', '20:00'];
  assert.deepEqual(nextScheduledTime(schedule, '6:00'), { time: '7:20', tomorrow: false });
  assert.deepEqual(nextScheduledTime(schedule, '10:00'), { time: '20:00', tomorrow: false });
  assert.deepEqual(nextScheduledTime(schedule, '21:00'), { time: '5:20', tomorrow: true });
  assert.equal(nextScheduledTime([], '6:00'), null);
  assert.equal(nextScheduledTime(['bogus'], '6:00'), null);
});

test('formatYmdNY formats an Eastern calendar date', () => {
  // 2026-01-15T03:00Z is still Jan 14 in New York
  assert.equal(formatYmdNY(new Date('2026-01-15T03:00:00Z')), '2026-01-14');
});
