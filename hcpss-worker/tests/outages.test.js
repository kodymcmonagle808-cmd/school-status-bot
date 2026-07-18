import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOutageFeed, getCountyOutage, outagePercent, formatOutageLine, getBgeOutages } from '../src/outages.js';

const FEED = {
  stormmode: 'N',
  counties: [
    { county: 'Howard', customersServed: 130377, customersOut: 2410, customersRestored: 0 },
    { county: 'Anne Arundel', customersServed: 251160, customersOut: 0, customersRestored: 0 },
    { county: "Prince George's", customersServed: 85134, customersOut: 17, customersRestored: 0 }
  ]
};

test('summarizeOutageFeed reduces counties and storm mode', () => {
  const s = summarizeOutageFeed(FEED);
  assert.equal(s.stormMode, false);
  assert.deepEqual(s.counties.Howard, { out: 2410, served: 130377 });
  assert.deepEqual(s.counties["Prince George's"], { out: 17, served: 85134 });
  assert.equal(summarizeOutageFeed(JSON.stringify({ ...FEED, stormmode: 'Y' })).stormMode, true);
});

test('summarizeOutageFeed tolerates junk input', () => {
  assert.equal(summarizeOutageFeed(null), null);
  assert.equal(summarizeOutageFeed('not json'), null);
  assert.equal(summarizeOutageFeed({}), null);
});

test('getCountyOutage and outagePercent', () => {
  const s = summarizeOutageFeed(FEED);
  assert.equal(getCountyOutage(s, 'Frederick'), null);
  assert.equal(getCountyOutage(null, 'Howard'), null);
  assert.ok(Math.abs(outagePercent(getCountyOutage(s, 'Howard')) - 1.8485) < 0.01);
  assert.equal(outagePercent(null), 0);
});

test('formatOutageLine renders counts and percent', () => {
  const s = summarizeOutageFeed(FEED);
  const line = formatOutageLine(s, 'Howard');
  assert.match(line, /\*\*2,410\*\* of 130,377 BGE customers without power in Howard County \(1\.8%\)/);
  // Tiny percentages drop the parenthetical; missing counties render nothing.
  assert.doesNotMatch(formatOutageLine(s, "Prince George's"), /%\)/);
  assert.equal(formatOutageLine(s, 'Frederick'), '');
});

test('getBgeOutages serves from KV cache without fetching', async () => {
  const store = new Map([
    ['bge_outage_cache', JSON.stringify({ at: Date.now(), summary: { stormMode: true, counties: { Howard: { out: 5, served: 100 } } } })]
  ]);
  const env = { STATUS_KV: { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } } };
  const s = await getBgeOutages(env);
  assert.equal(s.stormMode, true);
  assert.equal(s.counties.Howard.out, 5);
});
