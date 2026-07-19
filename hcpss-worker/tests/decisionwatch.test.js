import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionWatchEntries, buildDecisionWatchDescription } from '../src/decisionwatch.js';

const HCPSS = { id: 'hcpss', name: 'Howard Co. (HCPSS)', status: 'none', detail: '' };
const DISTRICTS = [
  { id: 'aacps', name: 'Anne Arundel Co.', status: 'closed', detail: 'All schools closed' },
  { id: 'bcps', name: 'Baltimore Co.', status: 'delayed', detail: '2 hours late' }
];

test('buildDecisionWatchEntries puts HCPSS first for HCPSS-primary guilds', () => {
  const entries = buildDecisionWatchEntries(DISTRICTS, HCPSS, 'hcpss');
  assert.equal(entries.length, 3);
  assert.equal(entries[0].id, 'hcpss');
  assert.equal(entries[1].id, 'aacps');
});

test('buildDecisionWatchEntries pins a neighboring primary district to the top', () => {
  const entries = buildDecisionWatchEntries(DISTRICTS, HCPSS, 'bcps');
  assert.equal(entries[0].id, 'bcps');
  // The rest keep their order.
  assert.deepEqual(entries.slice(1).map(e => e.id), ['hcpss', 'aacps']);
});

test('buildDecisionWatchEntries tolerates a failed HCPSS scrape', () => {
  const entries = buildDecisionWatchEntries(DISTRICTS, null, 'hcpss');
  assert.deepEqual(entries.map(e => e.id), ['aacps', 'bcps']);
});

test('buildDecisionWatchDescription pins the primary line with a marker', () => {
  const entries = buildDecisionWatchEntries(DISTRICTS, HCPSS, 'hcpss');
  const desc = buildDecisionWatchDescription(entries, 'hcpss');
  const lines = desc.split('\n');
  assert.match(lines[0], /^📍 /);
  assert.match(lines[0], /Howard Co\./);
  // Details render as quote lines for non-primary districts.
  assert.match(desc, /> All schools closed/);
});

test('buildDecisionWatchDescription skips the marker when the primary is missing', () => {
  const entries = buildDecisionWatchEntries(DISTRICTS, null, 'hcpss');
  const desc = buildDecisionWatchDescription(entries, 'hcpss');
  assert.doesNotMatch(desc.split('\n')[0], /^📍 /);
});
