import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatWorkerUpdates } from '../src/panel.js';

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
