import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gradePredictions,
  summarizeOutlookAccuracy,
  formatOutlookAccuracyLines,
  getOutlookPredictions,
  maybeTrackOutlookAccuracy,
  OUTLOOK_HIT_KEYS
} from '../src/outlookaccuracy.js';

// Noon UTC keeps the ET calendar date equal to the UTC date year-round.
function tsOn(ymd) {
  return Date.parse(`${ymd}T12:00:00Z`);
}

test('gradePredictions marks hits from morning-call history entries', () => {
  const predictions = [
    { date: '2027-01-06', level: 'high', graded: false, hit: null },
    { date: '2027-01-05', level: 'moderate', graded: false, hit: null }
  ];
  const history = [
    { timestamp: tsOn('2027-01-06'), status_key: 'schools_closed' },
    { timestamp: tsOn('2027-01-05'), status_key: 'normal_operations' }
  ];
  const { predictions: graded, changed } = gradePredictions(predictions, history, '2027-01-07', false);
  assert.equal(changed, true);
  assert.equal(graded[0].graded, true);
  assert.equal(graded[0].hit, true);
  assert.equal(graded[1].graded, true);
  assert.equal(graded[1].hit, false);
});

test('gradePredictions waits for today until past noon', () => {
  const predictions = [{ date: '2027-01-07', level: 'high', graded: false, hit: null }];
  const history = [{ timestamp: tsOn('2027-01-07'), status_key: 'schools_open_2_hours_late' }];

  const before = gradePredictions(predictions, history, '2027-01-07', false);
  assert.equal(before.changed, false);
  assert.equal(before.predictions[0].graded, false);

  const after = gradePredictions(predictions, history, '2027-01-07', true);
  assert.equal(after.changed, true);
  assert.equal(after.predictions[0].hit, true);
});

test('gradePredictions leaves already-graded entries and future dates alone', () => {
  const predictions = [
    { date: '2027-01-05', level: 'high', graded: true, hit: false },
    { date: '2027-02-01', level: 'low', graded: false, hit: null }
  ];
  const { predictions: out, changed } = gradePredictions(predictions, [], '2027-01-10', true);
  assert.equal(changed, false);
  assert.deepEqual(out, predictions);
});

test('early closings do not count as a night-before hit', () => {
  assert.equal(OUTLOOK_HIT_KEYS.includes('schools_close_3_hours_early'), false);
  const predictions = [{ date: '2027-01-06', level: 'high', graded: false, hit: null }];
  const history = [{ timestamp: tsOn('2027-01-06'), status_key: 'schools_close_3_hours_early' }];
  const { predictions: graded } = gradePredictions(predictions, history, '2027-01-08', true);
  assert.equal(graded[0].hit, false);
});

test('summarizeOutlookAccuracy tallies graded predictions per level', () => {
  const summary = summarizeOutlookAccuracy([
    { level: 'high', graded: true, hit: true },
    { level: 'high', graded: true, hit: false },
    { level: 'very_high', graded: true, hit: true },
    { level: 'moderate', graded: false, hit: null } // pending: excluded
  ]);
  assert.deepEqual(summary.high, { hits: 1, total: 2 });
  assert.deepEqual(summary.very_high, { hits: 1, total: 1 });
  assert.equal(summary.moderate, undefined);
});

test('formatOutlookAccuracyLines renders levels in order and skips empty ones', () => {
  const lines = formatOutlookAccuracyLines({
    high: { hits: 5, total: 6 },
    very_high: { hits: 2, total: 2 }
  });
  const rendered = lines.split('\n');
  assert.equal(rendered.length, 2);
  assert.match(rendered[0], /Very High.*2\/2.*100%/);
  assert.match(rendered[1], /High.*5\/6.*83%/);
  assert.equal(formatOutlookAccuracyLines({}), '');
  assert.equal(formatOutlookAccuracyLines(null), '');
});

test('getOutlookPredictions tolerates missing and malformed KV data', async () => {
  const kv = new Map();
  const env = { STATUS_KV: { async get(k) { return kv.get(k) ?? null; } } };
  assert.deepEqual(await getOutlookPredictions(env), []);
  kv.set('outlook_predictions', 'not json');
  assert.deepEqual(await getOutlookPredictions(env), []);
  kv.set('outlook_predictions', JSON.stringify([{ date: '2027-01-06', level: 'high' }]));
  assert.equal((await getOutlookPredictions(env))[0].level, 'high');
});

test('maybeTrackOutlookAccuracy is a no-op without KV', async () => {
  assert.deepEqual(await maybeTrackOutlookAccuracy(null), { recorded: false, graded: 0 });
  assert.deepEqual(await maybeTrackOutlookAccuracy({}), { recorded: false, graded: 0 });
});
