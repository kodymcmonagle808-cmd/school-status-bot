import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRssItems, summarizeNewsItems, crossCheckMismatch, countFeedItems, NEWS_RECENT_WINDOW_MS } from '../src/crosscheck.js';

const NOW = Date.parse('2027-01-15T11:00:00Z');

function rss(items) {
  const body = items.map(i =>
    `<item><title>${i.title}</title><description>${i.desc || ''}</description><pubDate>${new Date(i.atMs).toUTCString()}</pubDate></item>`
  ).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>HCPSS News</title>${body}</channel></rss>`;
}

test('parseRssItems keeps only recent items, newest first', () => {
  const xml = rss([
    { title: 'Old news', atMs: NOW - NEWS_RECENT_WINDOW_MS - 60000 },
    { title: 'Newer post', atMs: NOW - 1000 },
    { title: 'Older post', atMs: NOW - 60 * 60 * 1000 }
  ]);
  const items = parseRssItems(xml, NOW);
  assert.equal(items.length, 2);
  assert.ok(items[0].text.includes('Newer post'));
});

test('parseRssItems strips CDATA and HTML', () => {
  const xml = rss([{ title: '<![CDATA[Schools <b>Closed</b> Today]]>', atMs: NOW - 1000 }]);
  const items = parseRssItems(xml, NOW);
  assert.equal(items[0].text, 'Schools Closed Today');
});

test('summarizeNewsItems finds a closure post', () => {
  const signal = summarizeNewsItems([
    { text: 'Board of Education meeting rescheduled', atMs: NOW - 500 },
    { text: 'All HCPSS schools closed today due to inclement weather', atMs: NOW - 1000 }
  ]);
  assert.ok(signal);
  assert.equal(signal.status, 'closed');
});

test('summarizeNewsItems returns null for ordinary news', () => {
  const signal = summarizeNewsItems([
    { text: 'Student art showcase opens next week', atMs: NOW - 1000 }
  ]);
  assert.equal(signal, null);
});

test('summarizeNewsItems detects a two-hour delay', () => {
  const signal = summarizeNewsItems([
    { text: 'HCPSS schools will open two hours late on Tuesday', atMs: NOW - 1000 }
  ]);
  assert.ok(signal);
  assert.equal(signal.status, 'delayed');
});

test('mismatch when page shows normal but news says closed', () => {
  assert.equal(crossCheckMismatch('normal_operations', { status: 'closed', detail: '', atMs: NOW }), true);
});

test('no mismatch when page already shows the closure', () => {
  assert.equal(crossCheckMismatch('schools_closed', { status: 'closed', detail: '', atMs: NOW }), false);
  assert.equal(crossCheckMismatch('schools_and_offices_closed', { status: 'closed', detail: '', atMs: NOW }), false);
});

test('no mismatch when page shows a different non-normal alert', () => {
  // The page already shows an alert of its own; no lag warning needed.
  assert.equal(crossCheckMismatch('schools_open_2_hours_late', { status: 'closed', detail: '', atMs: NOW }), false);
});

test('no mismatch without a signal', () => {
  assert.equal(crossCheckMismatch('normal_operations', null), false);
});

test('countFeedItems ignores the recency window that parseRssItems applies', () => {
  // A healthy feed whose newest post is a month old: parseRssItems correctly
  // returns nothing, but the feed itself is fine. Source health needs the
  // second number, or every quiet month would look like an outage.
  const old = rss([
    { title: 'Board meeting recap', date: new Date(NOW - 30 * 86400000).toUTCString() },
    { title: 'Spring registration open', date: new Date(NOW - 31 * 86400000).toUTCString() }
  ]);
  assert.equal(parseRssItems(old, NOW).length, 0);
  assert.equal(countFeedItems(old), 2);
});

test('countFeedItems returns 0 for an empty or broken feed', () => {
  assert.equal(countFeedItems('<rss><channel></channel></rss>'), 0);
  assert.equal(countFeedItems(''), 0);
  assert.equal(countFeedItems(null), 0);
  assert.equal(countFeedItems('<html><body>Not a feed at all</body></html>'), 0);
});
