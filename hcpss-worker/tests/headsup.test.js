import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSendHeadsUp, parseHeadsUpState, shouldEscalate, HEADS_UP_LEVELS, HEADS_UP_TIME } from '../src/headsup.js';

test('shouldSendHeadsUp fires only on high/very_high outlook with normal operations', () => {
  assert.equal(shouldSendHeadsUp({ level: 'high' }, 'normal_operations'), true);
  assert.equal(shouldSendHeadsUp({ level: 'very_high' }, 'normal_operations'), true);
  assert.equal(shouldSendHeadsUp({ level: 'moderate' }, 'normal_operations'), false);
  assert.equal(shouldSendHeadsUp({ level: 'low' }, 'normal_operations'), false);
  assert.equal(shouldSendHeadsUp({ level: 'none' }, 'normal_operations'), false);
});

test('shouldSendHeadsUp stays quiet once HCPSS has already announced', () => {
  assert.equal(shouldSendHeadsUp({ level: 'very_high' }, 'schools_closed'), false);
  assert.equal(shouldSendHeadsUp({ level: 'high' }, 'schools_open_2_hours_late'), false);
  assert.equal(shouldSendHeadsUp(null, 'normal_operations'), false);
});

test('heads-up constants are sane', () => {
  assert.deepEqual(HEADS_UP_LEVELS, ['high', 'very_high']);
  assert.match(HEADS_UP_TIME, /^\d{1,2}:\d{2}$/);
});

test('parseHeadsUpState reads the day|level format and legacy bare days', () => {
  assert.deepEqual(parseHeadsUpState('2027-01-20|high'), { ymd: '2027-01-20', level: 'high' });
  // Entries written before escalation existed count as the top tier.
  assert.deepEqual(parseHeadsUpState('2027-01-20'), { ymd: '2027-01-20', level: 'very_high' });
  assert.deepEqual(parseHeadsUpState(null), { ymd: '', level: 'none' });
});

test('shouldEscalate fires on the first post of the night and on tier climbs only', () => {
  const today = '2027-01-20';
  // Nothing sent tonight yet (yesterday's state or none at all).
  assert.equal(shouldEscalate(parseHeadsUpState(null), today, 'high'), true);
  assert.equal(shouldEscalate(parseHeadsUpState('2027-01-19|very_high'), today, 'high'), true);
  // Already announced high: only very_high posts again.
  assert.equal(shouldEscalate(parseHeadsUpState('2027-01-20|high'), today, 'high'), false);
  assert.equal(shouldEscalate(parseHeadsUpState('2027-01-20|high'), today, 'very_high'), true);
  // Never de-escalates.
  assert.equal(shouldEscalate(parseHeadsUpState('2027-01-20|very_high'), today, 'high'), false);
  // Legacy bare-day entries never double-post on deploy day.
  assert.equal(shouldEscalate(parseHeadsUpState('2027-01-20'), today, 'very_high'), false);
});
