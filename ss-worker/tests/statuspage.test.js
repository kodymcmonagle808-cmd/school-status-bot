import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatusPage } from '../src/statuspage.js';
import worker from '../src/index.js';
import { SCREENSHOT_CACHE_KEY } from '../src/screenshot.js';

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

test('renderStatusPage renders A/B day, outlook, districts, outages, AI emails, and screenshot', () => {
  const html = renderStatusPage({
    cards: [{ date: 'January 15, 2027', title: 'Normal Operations', body: 'All schools open.' }],
    alerts: [],
    history: [],
    abDay: 'A',
    outlook: { level: 'high', reasons: ['Winter Storm Warning active'] },
    outageLine: '🔌 **120** of 130,000 BGE customers without power in Howard County',
    districts: [{ id: 'bcps', name: 'Baltimore County', status: 'delayed' }],
    emails: [{ subject: 'Winter Schedule <Reminder>', ai_summary: '• Check buses early', ts: 1780000000000, url: 'https://hcpss.org/news/1' }],
    screenshotUrl: '/screenshot.png'
  });

  assert.match(html, /Today: <strong>A Day<\/strong>/);
  assert.match(html, /Closure Outlook — High/);
  assert.match(html, /120 of 130,000 BGE customers/);
  assert.match(html, /Baltimore County/);
  assert.match(html, /Opening late/);
  assert.match(html, /Winter Schedule &lt;Reminder&gt;/);
  assert.match(html, /🤖 AI Summary/);
  assert.match(html, /Check buses early/);
  assert.match(html, /<img src="\/screenshot\.png"/);
});

test('GET /screenshot.png serves cached R2 image and returns 404 when empty', async () => {
  const pngBytes = new Uint8Array([137, 80, 78, 71]);
  const envWithShot = {
    BACKUPS_BUCKET: {
      async get(key) {
        if (key === SCREENSHOT_CACHE_KEY) {
          return { arrayBuffer: async () => pngBytes.buffer };
        }
        return null;
      }
    }
  };

  const resp = await worker.fetch(new Request('https://example.com/screenshot.png'), envWithShot, {});
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('Content-Type'), 'image/png');
  assert.equal(resp.headers.get('X-Screenshot-Cache'), 'r2');

  const emptyResp = await worker.fetch(new Request('https://example.com/screenshot.png'), {}, {});
  assert.equal(emptyResp.status, 404);
});

