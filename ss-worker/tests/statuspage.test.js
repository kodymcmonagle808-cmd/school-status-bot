import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatusPage } from '../src/statuspage.js';

test('renderStatusPage renders cards, alerts, and history with escaping', () => {
  const html = renderStatusPage({
    cards: [{ date: 'January 15, 2027', title: 'Schools Closed', body: 'All schools <closed> today.' }],
    stale: false,
    alerts: [{ event: 'Winter Storm Warning', endsMs: 1800000000000 }],
    history: [{ timestamp: 1780000000000, status: '**Schools Closed**' }]
  });
  assert.match(html, /<h2>Schools Closed<\/h2>/);
  assert.match(html, /&lt;closed&gt;/); // HTML in scraped content is escaped
  assert.match(html, /Winter Storm Warning/);
  assert.match(html, /Recent status changes/);
  assert.doesNotMatch(html, /\*\*/); // markdown markers stripped from history
});

test('renderStatusPage shows the stale banner and the unreachable fallback', () => {
  const stale = renderStatusPage({
    cards: [{ date: '', title: 'Schools Closed', body: 'x' }],
    stale: true,
    staleAt: 1780000000000,
    alerts: [],
    history: []
  });
  assert.match(stale, /Live page unreachable/);

  const down = renderStatusPage({ cards: null, error: new Error('boom'), alerts: [], history: [] });
  assert.match(down, /Status unavailable/);
  assert.match(down, /boom/);
});

test('renderStatusPage treats an empty card list as normal operations', () => {
  const html = renderStatusPage({ cards: [], alerts: [], history: [] });
  assert.match(html, /Normal Operations/);
});

test('renderStatusPage drops the stray separator paragraph from the card body', () => {
  const html = renderStatusPage({
    cards: [{ date: 'October 21, 2026', title: 'Normal Operations', body: 'Staff and students report in accordance with the HCPSS calendar.\n\n-' }],
    alerts: [],
    history: []
  });
  assert.match(html, /report in accordance with the HCPSS calendar/);
  assert.doesNotMatch(html, />\s*-\s*</, 'the lone dash must not reach the card body');
});
