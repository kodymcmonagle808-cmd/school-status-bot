import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWeatherAlerts, formatWeatherAlertLines, getActiveWeatherAlerts, isStormAlert, hasStormAlert, isPowerThreatAlert, hasPowerThreatAlert, alertsLikelyTomorrowMorning } from '../src/weather.js';

function feature(props) {
  return { properties: props };
}

test('summarizeWeatherAlerts dedupes, filters, and sorts by severity', () => {
  const alerts = summarizeWeatherAlerts([
    feature({ event: 'Winter Weather Advisory', severity: 'Minor', status: 'Actual', ends: '2026-01-15T12:00:00Z' }),
    feature({ event: 'Winter Storm Warning', severity: 'Severe', status: 'Actual', ends: '2026-01-15T18:00:00Z' }),
    feature({ event: 'Winter Storm Warning', severity: 'Severe', status: 'Actual' }), // duplicate event
    feature({ event: 'Test Message', severity: 'Unknown', status: 'Test' }),
    feature({ event: 'Cancelled Thing', severity: 'Severe', status: 'Actual', messageType: 'Cancel' })
  ]);

  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].event, 'Winter Storm Warning');
  assert.equal(alerts[1].event, 'Winter Weather Advisory');
});

test('summarizeWeatherAlerts tolerates junk input', () => {
  assert.deepEqual(summarizeWeatherAlerts(null), []);
  assert.deepEqual(summarizeWeatherAlerts([{}, feature({})]), []);
});

test('formatWeatherAlertLines renders discord timestamps and caps at 3 lines', () => {
  const lines = formatWeatherAlertLines([
    { event: 'A', severity: 'Severe', endsMs: 1750000000000 },
    { event: 'B', severity: 'Minor', endsMs: 0 },
    { event: 'C', severity: 'Minor', endsMs: 0 },
    { event: 'D', severity: 'Minor', endsMs: 0 }
  ]);
  const rendered = lines.split('\n');
  assert.equal(rendered.length, 3);
  assert.match(rendered[0], /\*\*A\*\* — until <t:1750000000:f>/);
  assert.equal(rendered[1], '⚠️ **B**');
});

test('isStormAlert matches winter events and high severity', () => {
  assert.equal(isStormAlert({ event: 'Winter Storm Warning', severity: 'Moderate' }), true);
  assert.equal(isStormAlert({ event: 'Blizzard Warning', severity: 'Unknown' }), true);
  assert.equal(isStormAlert({ event: 'Freezing Rain Advisory', severity: 'Minor' }), true);
  assert.equal(isStormAlert({ event: 'Tornado Warning', severity: 'Extreme' }), true);
  assert.equal(isStormAlert({ event: 'Air Quality Alert', severity: 'Minor' }), false);
  assert.equal(isStormAlert(null), false);
});

test('hasStormAlert scans a list', () => {
  assert.equal(hasStormAlert([{ event: 'Air Quality Alert', severity: 'Minor' }]), false);
  assert.equal(hasStormAlert([{ event: 'Air Quality Alert', severity: 'Minor' }, { event: 'Snow Squall Warning', severity: 'Moderate' }]), true);
  assert.equal(hasStormAlert([]), false);
  assert.equal(hasStormAlert(null), false);
});

test('alertsLikelyTomorrowMorning keeps storm alerts reaching past the horizon', () => {
  const now = 1_700_000_000_000;
  const nineHours = 9 * 60 * 60 * 1000;
  const alerts = [
    { event: 'Winter Storm Warning', severity: 'Severe', endsMs: now + nineHours + 1 }, // reaches morning
    { event: 'Winter Weather Advisory', severity: 'Minor', endsMs: now + 60_000 },      // ends tonight
    { event: 'Ice Storm Warning', severity: 'Severe', endsMs: 0 },                      // unknown end
    { event: 'Air Quality Alert', severity: 'Minor', endsMs: 0 }                        // not a storm
  ];
  const result = alertsLikelyTomorrowMorning(alerts, now);
  assert.deepEqual(result.map(a => a.event), ['Winter Storm Warning', 'Ice Storm Warning']);
});

test('getActiveWeatherAlerts returns [] when the NWS API fails', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('nws down'); });
  assert.deepEqual(await getActiveWeatherAlerts(null), []);
});

test('getActiveWeatherAlerts uses the KV cache when present', async (t) => {
  const store = new Map([['weather_alerts_cache', JSON.stringify([{ event: 'Cached Warning', severity: 'Severe', endsMs: 0 }])]]);
  const kv = {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put() {}
  };
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not be called'); });
  const alerts = await getActiveWeatherAlerts({ STATUS_KV: kv });
  assert.equal(alerts[0].event, 'Cached Warning');
});

test('isPowerThreatAlert only matches warning-level power-threatening events', () => {
  // Warnings for events that can take down power lines
  assert.equal(isPowerThreatAlert({ event: 'Winter Storm Warning', severity: 'Moderate' }), true);
  assert.equal(isPowerThreatAlert({ event: 'Ice Storm Warning', severity: 'Severe' }), true);
  assert.equal(isPowerThreatAlert({ event: 'Blizzard Warning', severity: 'Severe' }), true);
  assert.equal(isPowerThreatAlert({ event: 'High Wind Warning', severity: 'Severe' }), true);
  assert.equal(isPowerThreatAlert({ event: 'Severe Thunderstorm Warning', severity: 'Severe' }), true);

  // Watches and advisories do not trigger, even though they are storm alerts
  assert.equal(isPowerThreatAlert({ event: 'Winter Storm Watch', severity: 'Moderate' }), false);
  assert.equal(isPowerThreatAlert({ event: 'Winter Weather Advisory', severity: 'Minor' }), false);
  assert.equal(isPowerThreatAlert({ event: 'Wind Chill Advisory', severity: 'Moderate' }), false);
  assert.equal(isPowerThreatAlert({ event: 'Wind Chill Warning', severity: 'Moderate' }), false);

  // Extreme severity qualifies regardless of event name
  assert.equal(isPowerThreatAlert({ event: 'Unusual Event', severity: 'Extreme' }), true);

  assert.equal(hasPowerThreatAlert([{ event: 'Winter Weather Advisory' }, { event: 'Ice Storm Warning' }]), true);
  assert.equal(hasPowerThreatAlert([{ event: 'Winter Weather Advisory' }]), false);
  assert.equal(hasPowerThreatAlert([]), false);
});
