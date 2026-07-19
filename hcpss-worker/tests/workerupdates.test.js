import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatWorkerUpdates, buildOwnerStatsFields } from '../src/panel.js';

test('formatWorkerUpdates handles an empty or missing list', () => {
  assert.match(formatWorkerUpdates([]), /No worker updates recorded yet/);
  assert.match(formatWorkerUpdates(null), /No worker updates recorded yet/);
  assert.match(formatWorkerUpdates('nonsense'), /No worker updates recorded yet/);
});

test('formatWorkerUpdates renders success and failure lines', () => {
  const out = formatWorkerUpdates([
    { sha: 'abc1234', ok: true, ts: 1752940800000 },
    { sha: 'def5678', ok: false, ts: 1752854400000 }
  ]);
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^✅ `abc1234` — deployed <t:1752940800:f>$/);
  assert.match(lines[1], /^❌ `def5678` — \*\*failed\*\* <t:1752854400:f>/);
});

test('formatWorkerUpdates skips malformed entries and caps at 15', () => {
  const list = [null, { ok: true }, ...Array.from({ length: 20 }, (_, i) => ({
    sha: `sha${i}`, ok: true, ts: 1752940800000
  }))];
  const out = formatWorkerUpdates(list);
  assert.equal(out.split('\n').length, 15);
  assert.ok(!out.includes('null'));
});

test('formatWorkerUpdates tolerates a missing timestamp', () => {
  const out = formatWorkerUpdates([{ sha: 'abc1234', ok: true }]);
  assert.match(out, /unknown time/);
});

function fieldValue(fields, name) {
  const f = fields.find(x => x.name.includes(name));
  assert.ok(f, `field ${name} present`);
  return f.value;
}

test('buildOwnerStatsFields reports version, deploy rate, and scrape stats', () => {
  const fields = buildOwnerStatsFields({
    runningSha: 'abc1234def5678',
    updates: [
      { sha: 'abc1234', ok: true, ts: 1 },
      { sha: 'ffff000', ok: false, ts: 2 }
    ],
    guildCount: 3,
    scrapesTotal: 1000,
    scrapesFailed: 5,
    consecutiveFailures: 0,
    lastCheckTime: 1752940800000,
    lastCheckLatencyMs: 843
  });
  assert.equal(fieldValue(fields, 'Running version'), '`abc1234`');
  assert.equal(fieldValue(fields, 'Deploys recorded'), '1/2 succeeded');
  assert.equal(fieldValue(fields, 'Servers'), '3');
  assert.equal(fieldValue(fields, 'Scrapes'), '1000 total · 5 failed · 99.5% ok');
  assert.equal(fieldValue(fields, 'Last check'), '<t:1752940800:R> · 843 ms');
});

test('buildOwnerStatsFields warns when the running sha is behind the latest deploy', () => {
  const fields = buildOwnerStatsFields({
    runningSha: 'aaaaaaa1111',
    updates: [
      { sha: 'bbbbbbb', ok: true, ts: 3 },
      { sha: 'aaaaaaa', ok: true, ts: 2 }
    ],
    guildCount: 0
  });
  const version = fieldValue(fields, 'Running version');
  assert.match(version, /`aaaaaaa`/);
  assert.match(version, /⚠️ latest deploy is `bbbbbbb`/);
});

test('buildOwnerStatsFields degrades cleanly with no data at all', () => {
  const fields = buildOwnerStatsFields({});
  assert.equal(fields.length, 6);
  assert.equal(fieldValue(fields, 'Running version'), '(unknown)');
  assert.equal(fieldValue(fields, 'Deploys recorded'), '(none yet)');
  assert.equal(fieldValue(fields, 'Scrapes'), '(none yet)');
  assert.equal(fieldValue(fields, 'Last check'), '(none yet)');
});
