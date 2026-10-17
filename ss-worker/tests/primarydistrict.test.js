import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISTRICTS,
  PRIMARY_DISTRICT_CHOICES,
  getDistrictMeta,
  DISTRICT_STATUS_TO_KEY,
  statusKeyToDistrictStatus
} from '../src/districts.js';

test('primary district choices are HCPSS plus every neighboring district', () => {
  assert.equal(PRIMARY_DISTRICT_CHOICES[0].id, 'hcpss');
  assert.equal(PRIMARY_DISTRICT_CHOICES.length, DISTRICTS.length + 1);
  for (const d of DISTRICTS) {
    assert.ok(PRIMARY_DISTRICT_CHOICES.some(c => c.id === d.id && c.name === d.name));
  }
});

test('every district carries a homepage URL and NWS zone', () => {
  for (const d of DISTRICTS) {
    assert.match(d.url, /^https:\/\//, `${d.id} url`);
    assert.match(d.nwsZone, /^MDC\d{3}$/, `${d.id} zone`);
  }
});

test('getDistrictMeta finds districts by id', () => {
  assert.equal(getDistrictMeta('mcps').name, 'Montgomery Co.');
  assert.equal(getDistrictMeta('hcpss'), null);
  assert.equal(getDistrictMeta('nope'), null);
});

test('district statuses map onto operating-status keys', () => {
  assert.equal(DISTRICT_STATUS_TO_KEY.closed, 'schools_closed');
  assert.equal(DISTRICT_STATUS_TO_KEY.virtual, 'schools_closed');
  assert.equal(DISTRICT_STATUS_TO_KEY.delayed, 'schools_open_2_hours_late');
  assert.equal(DISTRICT_STATUS_TO_KEY.early, 'schools_close_3_hours_early');
  assert.equal(DISTRICT_STATUS_TO_KEY.none, 'normal_operations');
  assert.equal(DISTRICT_STATUS_TO_KEY.notice, 'unknown_alert');
});

test('status keys round-trip to district-style statuses', () => {
  assert.equal(statusKeyToDistrictStatus('schools_closed'), 'closed');
  assert.equal(statusKeyToDistrictStatus('schools_and_offices_closed'), 'closed');
  assert.equal(statusKeyToDistrictStatus('schools_open_2_hours_late'), 'delayed');
  assert.equal(statusKeyToDistrictStatus('schools_close_3_hours_early'), 'early');
  assert.equal(statusKeyToDistrictStatus('unknown_alert'), 'notice');
  assert.equal(statusKeyToDistrictStatus('normal_operations'), 'none');
});
