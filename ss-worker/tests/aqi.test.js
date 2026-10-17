import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worstAqiToday, toMdy, aqiCategoryEmoji, AQI_ALERT_THRESHOLD, COUNTY_REPORTING_AREAS } from '../src/aqi.js';

const RECORDS = [
  { validDate: '07/19/26', dataType: 'O', reportingArea: 'Suburban DC', parameter: 'PM2.5', aqi: 71, category: 'Moderate' },
  { validDate: '07/19/26', dataType: 'F', reportingArea: 'Suburban DC', parameter: 'OZONE', aqi: 110, category: 'Unhealthy for Sensitive Groups', isActionDay: true, discussion: 'Smoke lingers.' },
  { validDate: '07/20/26', dataType: 'F', reportingArea: 'Suburban DC', parameter: 'PM2.5', aqi: 160, category: 'Unhealthy' },
  { validDate: '07/19/26', dataType: 'O', reportingArea: 'Metro Baltimore', parameter: 'OZONE', aqi: 45, category: 'Good' }
];

test('worstAqiToday picks the highest AQI for the area and day only', () => {
  const worst = worstAqiToday(RECORDS, 'Suburban DC', '07/19/26');
  assert.equal(worst.aqi, 110);
  assert.equal(worst.forecast, true);
  assert.equal(worst.actionDay, true);
  assert.equal(worst.category, 'Unhealthy for Sensitive Groups');
  assert.match(worst.discussion, /Smoke/);
  // Tomorrow's 160 forecast must not leak into today.
  assert.ok(worst.aqi < 160);
});

test('worstAqiToday keeps the action-day flag even when a later record is lower', () => {
  const worst = worstAqiToday([
    { validDate: '07/19/26', dataType: 'O', reportingArea: 'X', parameter: 'PM2.5', aqi: 120, category: 'USG' },
    { validDate: '07/19/26', dataType: 'F', reportingArea: 'X', parameter: 'OZONE', aqi: 105, category: 'USG', isActionDay: true }
  ], 'X', '07/19/26');
  assert.equal(worst.aqi, 120);
  assert.equal(worst.actionDay, true);
});

test('worstAqiToday returns null for missing areas or junk', () => {
  assert.equal(worstAqiToday(RECORDS, 'Nowhere', '07/19/26'), null);
  assert.equal(worstAqiToday(null, 'Suburban DC', '07/19/26'), null);
  assert.equal(worstAqiToday([{ reportingArea: 'X', validDate: '07/19/26', aqi: 'bad' }], 'X', '07/19/26'), null);
});

test('toMdy converts KV-style dates to AirNow validDate format', () => {
  assert.equal(toMdy('2026-07-19'), '07/19/26');
  assert.equal(toMdy('2027-01-05'), '01/05/27');
});

test('aqiCategoryEmoji tiers match the AQI scale', () => {
  assert.equal(aqiCategoryEmoji(45), '🟢');
  assert.equal(aqiCategoryEmoji(75), '🟡');
  assert.equal(aqiCategoryEmoji(120), '🟠');
  assert.equal(aqiCategoryEmoji(180), '🔴');
  assert.equal(aqiCategoryEmoji(250), '🟣');
  assert.equal(aqiCategoryEmoji(350), '🟤');
});

test('every followable county has a reporting area and the threshold is Code Orange', () => {
  for (const county of ['Howard', 'Anne Arundel', 'Baltimore', 'Carroll', 'Frederick', 'Montgomery', "Prince George's"]) {
    assert.ok(COUNTY_REPORTING_AREAS[county], `missing area for ${county}`);
  }
  assert.equal(AQI_ALERT_THRESHOLD, 101);
});
