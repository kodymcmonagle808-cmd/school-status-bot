import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAccumulationLines, formatSnowfallLines, getSnowfallForecast } from '../src/snowfall.js';

const PERIODS = [
  {
    name: 'Tonight',
    detailedForecast: 'Snow, mainly after 9pm. Low around 28. New snow accumulation of 4 to 8 inches possible.'
  },
  {
    name: 'Tuesday',
    detailedForecast: 'Snow before noon. High near 31. Total daytime snow accumulation of 1 to 3 inches possible. Ice accumulation of around a light glaze possible.'
  },
  {
    name: 'Tuesday Night',
    detailedForecast: 'Mostly cloudy, with a low around 20.'
  },
  {
    name: 'Wednesday',
    detailedForecast: 'Sunny, with a high near 35.'
  }
];

test('extractAccumulationLines pulls accumulation sentences per period', () => {
  const lines = extractAccumulationLines(PERIODS);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].name, 'Tonight');
  assert.equal(lines[0].text, 'New snow accumulation of 4 to 8 inches possible.');
  assert.equal(lines[1].name, 'Tuesday');
  assert.match(lines[1].text, /Total daytime snow accumulation of 1 to 3 inches possible\./);
  assert.match(lines[1].text, /Ice accumulation/);
});

test('extractAccumulationLines respects the period window and junk input', () => {
  assert.deepEqual(extractAccumulationLines(null), []);
  assert.deepEqual(extractAccumulationLines([{}, { detailedForecast: 'Sunny.' }]), []);
  const beyondWindow = [
    { name: 'P1', detailedForecast: 'Clear.' },
    { name: 'P2', detailedForecast: 'Clear.' },
    { name: 'P3', detailedForecast: 'Clear.' },
    { name: 'P4', detailedForecast: 'Clear.' },
    { name: 'P5', detailedForecast: 'New snow accumulation of 2 inches possible.' }
  ];
  assert.deepEqual(extractAccumulationLines(beyondWindow), []);
});

test('formatSnowfallLines renders and caps at 3 lines', () => {
  const out = formatSnowfallLines([
    { name: 'Tonight', text: 'New snow accumulation of 4 to 8 inches possible.' },
    { name: 'Tuesday', text: 'A.' },
    { name: 'Tuesday Night', text: 'B.' },
    { name: 'Wednesday', text: 'C.' }
  ]);
  const lines = out.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '❄️ **Tonight** — New snow accumulation of 4 to 8 inches possible.');
  assert.equal(formatSnowfallLines([]), '');
});

test('getSnowfallForecast serves from KV cache without fetching', async () => {
  const store = new Map([
    ['snowfall_forecast_cache', JSON.stringify({ at: Date.now(), lines: [{ name: 'Tonight', text: 'Cached.' }] })]
  ]);
  const env = {
    STATUS_KV: {
      get: async k => store.get(k) ?? null,
      put: async (k, v) => { store.set(k, v); }
    }
  };
  const lines = await getSnowfallForecast(env);
  assert.deepEqual(lines, [{ name: 'Tonight', text: 'Cached.' }]);
});
