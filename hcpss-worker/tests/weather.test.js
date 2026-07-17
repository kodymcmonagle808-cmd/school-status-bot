import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWeatherAlerts, formatWeatherAlertLines, getActiveWeatherAlerts } from '../src/weather.js';

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
