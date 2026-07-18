import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSendHeadsUp, HEADS_UP_LEVELS, HEADS_UP_TIME } from '../src/headsup.js';

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
