import test from 'node:test';
import assert from 'node:assert/strict';
import { computeClosureOutlook, formatOutlookLines } from '../src/outlook.js';

function district(name, status) {
  return { id: name.toLowerCase(), name, status, detail: '' };
}

test('no storm alerts and quiet districts → level none', () => {
  const out = computeClosureOutlook([], [district('Baltimore Co.', 'none')]);
  assert.equal(out.level, 'none');
  assert.equal(out.score, 0);
  assert.equal(formatOutlookLines(out), '');
});

test('non-storm alert alone does not trigger an outlook', () => {
  const out = computeClosureOutlook([{ event: 'Air Quality Alert', severity: 'Minor', endsMs: 0 }], []);
  assert.equal(out.level, 'none');
});

test('winter weather advisory alone → low', () => {
  const out = computeClosureOutlook([{ event: 'Winter Weather Advisory', severity: 'Minor', endsMs: 0 }], []);
  assert.equal(out.level, 'low');
  assert.ok(out.reasons[0].includes('Winter Weather Advisory'));
});

test('winter storm watch alone → moderate', () => {
  const out = computeClosureOutlook([{ event: 'Winter Storm Watch', severity: 'Moderate', endsMs: 0 }], []);
  assert.equal(out.level, 'moderate');
});

test('winter storm warning alone → moderate score 3', () => {
  const out = computeClosureOutlook([{ event: 'Winter Storm Warning', severity: 'Severe', endsMs: 0 }], []);
  assert.equal(out.score, 3);
  assert.equal(out.level, 'moderate');
});

test('blizzard warning alone → high', () => {
  const out = computeClosureOutlook([{ event: 'Blizzard Warning', severity: 'Extreme', endsMs: 0 }], []);
  assert.equal(out.level, 'high');
});

test('warning plus two closed districts → very high', () => {
  const out = computeClosureOutlook(
    [{ event: 'Winter Storm Warning', severity: 'Severe', endsMs: 0 }],
    [district('Baltimore Co.', 'closed'), district('Carroll Co.', 'closed'), district('Frederick Co.', 'none')]
  );
  assert.equal(out.level, 'very_high');
  assert.ok(out.reasons.some(r => r.includes('2 nearby districts closed')));
});

test('district contribution is capped at 4 points', () => {
  const districts = ['A', 'B', 'C', 'D', 'E'].map(n => district(n, 'closed'));
  const out = computeClosureOutlook([{ event: 'Winter Weather Advisory', severity: 'Minor', endsMs: 0 }], districts);
  assert.equal(out.score, 1 + 4);
});

test('only the strongest weather alert counts', () => {
  const out = computeClosureOutlook(
    [
      { event: 'Winter Weather Advisory', severity: 'Minor', endsMs: 0 },
      { event: 'Winter Storm Warning', severity: 'Severe', endsMs: 0 }
    ],
    []
  );
  assert.equal(out.score, 3);
  assert.ok(out.reasons[0].includes('Winter Storm Warning'));
});

test('delayed and virtual districts count as signals', () => {
  const out = computeClosureOutlook(
    [{ event: 'Winter Storm Warning', severity: 'Severe', endsMs: 0 }],
    [district('Baltimore Co.', 'delayed'), district('Montgomery Co.', 'virtual')]
  );
  // warning (3) + virtual counts as closed (2) + delayed (1) = 6
  assert.equal(out.level, 'very_high');
  assert.ok(out.reasons.some(r => r.includes('opening late')));
});

test('formatOutlookLines includes the disclaimer and reasons', () => {
  const out = computeClosureOutlook([{ event: 'Winter Storm Warning', severity: 'Severe', endsMs: 0 }], []);
  const text = formatOutlookLines(out);
  assert.ok(text.includes('Moderate'));
  assert.ok(text.includes('Winter Storm Warning'));
  assert.ok(text.includes('HCPSS makes the final call'));
});

test('widespread power outages raise the outlook', () => {
  const alerts = [{ event: 'Winter Storm Warning', severity: 'Severe', endsMs: 0 }];
  const base = computeClosureOutlook(alerts, []);
  const moderate = computeClosureOutlook(alerts, [], { outagePercent: 7 });
  const severe = computeClosureOutlook(alerts, [], { outagePercent: 25 });
  assert.equal(moderate.score, base.score + 1);
  assert.equal(severe.score, base.score + 2);
  assert.ok(severe.reasons.some(r => r.includes('without power')));
  // Tiny outages contribute nothing.
  assert.equal(computeClosureOutlook(alerts, [], { outagePercent: 1 }).score, base.score);
});
