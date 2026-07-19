import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDayOutcome, formatPredictionLine } from '../src/stormrecap.js';

// 2027-01-20 in Eastern time.
const TODAY = '2027-01-20';
const AT = Date.parse('2027-01-20T10:30:00Z');

test('summarizeDayOutcome reports a quiet day', () => {
  const history = [
    { timestamp: Date.parse('2027-01-19T10:00:00Z'), status_key: 'schools_closed' }
  ];
  const outcome = summarizeDayOutcome(history, TODAY);
  assert.equal(outcome.incident, false);
  assert.match(outcome.line, /opened on time/);
});

test('summarizeDayOutcome picks the most severe of today\'s changes', () => {
  const history = [
    { timestamp: AT, status_key: 'schools_closed' },
    { timestamp: AT - 3600_000, status_key: 'schools_open_2_hours_late' }
  ];
  const outcome = summarizeDayOutcome(history, TODAY);
  assert.equal(outcome.incident, true);
  assert.match(outcome.line, /Schools closed/);
  assert.match(outcome.line, /<t:\d+:t>/);
});

test('formatPredictionLine covers hit, miss, ungraded, and absent', () => {
  assert.match(formatPredictionLine([{ date: TODAY, level: 'high', graded: true, hit: true }], TODAY), /✅/);
  assert.match(formatPredictionLine([{ date: TODAY, level: 'high', graded: true, hit: false }], TODAY), /❌/);
  assert.match(formatPredictionLine([{ date: TODAY, level: 'very_high', graded: false }], TODAY), /Very High/);
  assert.equal(formatPredictionLine([{ date: '2027-01-19', level: 'high', graded: true, hit: true }], TODAY), '');
  assert.equal(formatPredictionLine([], TODAY), '');
});
