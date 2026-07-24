import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSweepMinute,
  computeStaleSources,
  formatSourceHealth,
  mergeObservations,
  SOURCE_EXPECTATIONS,
  SWEEP_MINUTE
} from '../src/sourcehealth.js';

const HOUR = 3600000;
const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);

test('the sweep only runs on its one minute of the hour', () => {
  assert.equal(isSweepMinute(`5:${String(SWEEP_MINUTE).padStart(2, '0')}`), true);
  assert.equal(isSweepMinute('5:08'), false);
  assert.equal(isSweepMinute('5:00'), false);
  assert.equal(isSweepMinute('bad'), false);
});

test('mergeObservations only moves lastData forward on a good read', () => {
  const before = { scraper: { lastCheck: NOW - 5 * HOUR, lastData: NOW - 5 * HOUR, detail: '' } };

  const stillBroken = mergeObservations(before, { scraper: { ok: false, detail: 'no cards parsed' } }, NOW);
  assert.equal(stillBroken.scraper.lastData, NOW - 5 * HOUR, 'a failed read must not refresh lastData');
  assert.equal(stillBroken.scraper.lastCheck, NOW, 'but the check itself is recorded');
  assert.equal(stillBroken.scraper.detail, 'no cards parsed');

  const recovered = mergeObservations(stillBroken, { scraper: { ok: true } }, NOW + HOUR);
  assert.equal(recovered.scraper.lastData, NOW + HOUR);
  assert.equal(recovered.scraper.detail, '');
});

test('a source is stale only past its own threshold', () => {
  const justUnder = SOURCE_EXPECTATIONS.scraper.staleAfterHours - 1;
  const justOver = SOURCE_EXPECTATIONS.scraper.staleAfterHours + 1;

  assert.deepEqual(
    computeStaleSources({ scraper: { lastData: NOW - justUnder * HOUR } }, NOW),
    []
  );
  const stale = computeStaleSources({ scraper: { lastData: NOW - justOver * HOUR, detail: 'no cards parsed' } }, NOW);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].name, 'scraper');
  assert.equal(stale[0].detail, 'no cards parsed');
  assert.ok(stale[0].ageHours >= SOURCE_EXPECTATIONS.scraper.staleAfterHours);
});

test('thresholds are per-source, so a quiet news feed is not an outage', () => {
  // 24h of silence: past the status page's 6h threshold, well inside the
  // news feed's 48h one.
  const health = {
    scraper: { lastData: NOW - 24 * HOUR },
    news_feed: { lastData: NOW - 24 * HOUR }
  };
  const stale = computeStaleSources(health, NOW);
  assert.deepEqual(stale.map(s => s.name), ['scraper']);
});

test('a never-observed source is not reported as an outage', () => {
  assert.deepEqual(computeStaleSources({}, NOW), []);
  assert.deepEqual(computeStaleSources({ scraper: { lastData: 0 } }, NOW), []);
  assert.deepEqual(computeStaleSources(null, NOW), []);
});

test('stale sources are ranked worst-first', () => {
  const health = {
    scraper: { lastData: NOW - 10 * HOUR },   // 4h over its 6h threshold
    districts: { lastData: NOW - 100 * HOUR } // 88h over its 12h threshold
  };
  assert.deepEqual(computeStaleSources(health, NOW).map(s => s.name), ['districts', 'scraper']);
});

test('formatSourceHealth marks each source and covers them all', () => {
  const health = {
    scraper: { lastData: NOW - 1 * HOUR },
    districts: { lastData: NOW - 100 * HOUR, detail: 'all 6 district sources unavailable' }
  };
  const out = formatSourceHealth(health, NOW);
  const lines = out.split('\n');
  assert.equal(lines.length, Object.keys(SOURCE_EXPECTATIONS).length);
  assert.ok(out.includes('🟢 **HCPSS status page**'));
  assert.ok(out.includes('🔴 **Neighboring districts**'));
  assert.ok(out.includes('all 6 district sources unavailable'), 'the reason shows on a stale source');
  assert.ok(out.includes('⚪ **HCPSS News RSS**'), 'never-observed sources read as unknown, not broken');
});

test('detail is only shown for sources that are actually stale', () => {
  const out = formatSourceHealth({ scraper: { lastData: NOW - 1 * HOUR, detail: 'transient blip' } }, NOW);
  assert.ok(!out.includes('transient blip'));
});
