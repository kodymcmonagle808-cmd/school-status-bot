import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCards, determineStatusKey, assembleDescription, statusDateInfo, getStatusCards, resetScrapeMemCache } from '../src/scraper.js';

const NEW_FORMAT_HTML = `
<html><body>
<section id="status-block" class="status">
  <div class="card">
    <h2><span class="status-date">July 14, 2026</span><span>Schools Closed</span></h2>
    <p>All Howard County public schools are closed today.</p>
    <p>View HCPSS Calendar</p>
  </div>
</section>
</body></html>`;

const LEGACY_FORMAT_HTML = `
<html><body>
<div class="views-row">
  <div class="views-field-changed">July 14, 2026</div>
  <h3>Schools Open 2 Hours Late</h3>
  <div class="alert-content">All schools will open two hours late.</div>
</div>
</body></html>`;

test('extractCards parses the new status-block format', () => {
  const cards = extractCards(NEW_FORMAT_HTML);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'Schools Closed');
  assert.equal(cards[0].date, 'July 14, 2026');
  assert.match(cards[0].body, /closed today/);
  assert.doesNotMatch(cards[0].body, /View HCPSS Calendar/i);
});

test('extractCards falls back to the legacy views-row format', () => {
  const cards = extractCards(LEGACY_FORMAT_HTML);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'Schools Open 2 Hours Late');
  assert.equal(cards[0].date, 'July 14, 2026');
});

test('extractCards returns no cards for a page without status markup', () => {
  assert.deepEqual(extractCards('<html><body><p>hello</p></body></html>'), []);
});

test('determineStatusKey maps cards to status keys', () => {
  assert.equal(determineStatusKey([]), 'normal_operations');
  assert.equal(determineStatusKey(null), 'normal_operations');
  assert.equal(determineStatusKey([{ title: 'Normal Operations', body: '' }]), 'normal_operations');
  assert.equal(determineStatusKey([{ title: 'Schools Closed', body: '' }]), 'schools_closed');
  assert.equal(determineStatusKey([{ title: 'Schools and Offices Closed', body: '' }]), 'schools_and_offices_closed');
  assert.equal(determineStatusKey([{ title: 'Code Yellow', body: 'Schools open 2 hours late' }]), 'schools_open_2_hours_late');
  assert.equal(determineStatusKey([{ title: 'Early Dismissal', body: 'Schools close 3 hours early' }]), 'schools_close_3_hours_early');
  assert.equal(determineStatusKey([{ title: 'Special Notice', body: 'See website' }]), 'unknown_alert');
});

test('assembleDescription defaults to Normal Operations when no cards', () => {
  assert.match(assembleDescription([]), /Normal Operations/);
});

test('statusDateInfo parses site date text as a plain calendar day', () => {
  const info = statusDateInfo('July 14, 2026', new Date(0));
  assert.equal(info.ymd, '2026-07-14');
  assert.equal(info.display, 'Jul 14, 2026');
});

test('statusDateInfo strips a trailing time suffix', () => {
  const info = statusDateInfo('July 14, 2026, 5:20 AM EDT', new Date(0));
  assert.equal(info.ymd, '2026-07-14');
});

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); }
  };
}

test('getStatusCards falls back to the cached scrape when fetch fails', async (t) => {
  const kv = makeKv();
  // Older than the 60s fresh-cache window (so the fetch is attempted) but
  // well within the 24h stale-fallback window.
  kv.store.set('last_good_scrape', JSON.stringify({
    at: Date.now() - 5 * 60_000,
    cards: [{ date: '', title: 'Schools Closed', body: 'cached' }]
  }));

  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });

  const result = await getStatusCards({ STATUS_KV: kv });
  assert.equal(result.stale, true);
  assert.equal(result.cards[0].title, 'Schools Closed');
  assert.ok(result.error);
});

test('getStatusCards ignores a cached scrape older than 24 hours', async (t) => {
  const kv = makeKv();
  kv.store.set('last_good_scrape', JSON.stringify({
    at: Date.now() - 25 * 60 * 60 * 1000,
    cards: [{ date: '', title: 'Schools Closed', body: 'ancient' }]
  }));

  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });

  const result = await getStatusCards({ STATUS_KV: kv });
  assert.equal(result.stale, false);
  assert.equal(result.cards, null);
  assert.ok(result.error);
});

test('getStatusCards caches the parsed cards on success', async (t) => {
  resetScrapeMemCache();
  const kv = makeKv();
  t.mock.method(globalThis, 'fetch', async () => new Response(NEW_FORMAT_HTML, { status: 200 }));

  const result = await getStatusCards({ STATUS_KV: kv });
  assert.equal(result.stale, false);
  assert.equal(result.cards[0].title, 'Schools Closed');
  const cached = JSON.parse(kv.store.get('last_good_scrape'));
  assert.equal(cached.cards[0].title, 'Schools Closed');
});

test('an unchanged rescrape skips the KV rewrite and arms the memory cache', async (t) => {
  resetScrapeMemCache();
  const kv = makeKv();
  // KV holds the same cards the live page will parse to, 5 minutes old —
  // past the 60s fresh window but far from the hourly rewrite horizon.
  const cards = extractCards(NEW_FORMAT_HTML);
  const seededRaw = JSON.stringify({ at: Date.now() - 5 * 60_000, cards });
  kv.store.set('last_good_scrape', seededRaw);

  let puts = 0;
  const origPut = kv.put.bind(kv);
  kv.put = async (k, v) => { puts++; return origPut(k, v); };
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++;
    return new Response(NEW_FORMAT_HTML, { status: 200 });
  });

  const first = await getStatusCards({ STATUS_KV: kv });
  assert.equal(first.cards[0].title, 'Schools Closed');
  assert.equal(fetches, 1);
  assert.equal(puts, 0, 'identical cards must not rewrite last_good_scrape');
  assert.equal(kv.store.get('last_good_scrape'), seededRaw);

  // The in-isolate memory cache now serves the 60s window (the KV `at` is
  // stale precisely because the rewrite was skipped).
  const second = await getStatusCards({ STATUS_KV: kv });
  assert.equal(second.cards[0].title, 'Schools Closed');
  assert.equal(fetches, 1, 'repeat call within 60s must not re-scrape');
});

test('an unchanged scrape still rewrites once the KV copy is an hour old', async (t) => {
  resetScrapeMemCache();
  const kv = makeKv();
  const cards = extractCards(NEW_FORMAT_HTML);
  kv.store.set('last_good_scrape', JSON.stringify({ at: Date.now() - 2 * 60 * 60_000, cards }));
  t.mock.method(globalThis, 'fetch', async () => new Response(NEW_FORMAT_HTML, { status: 200 }));

  await getStatusCards({ STATUS_KV: kv });
  const cached = JSON.parse(kv.store.get('last_good_scrape'));
  assert.ok(Date.now() - cached.at < 60_000, 'stale-fallback timestamp refreshed');
});

test('a changed status always rewrites the KV copy', async (t) => {
  resetScrapeMemCache();
  const kv = makeKv();
  kv.store.set('last_good_scrape', JSON.stringify({
    at: Date.now() - 5 * 60_000,
    cards: [{ date: '', title: 'Normal Operations', body: 'old' }]
  }));
  t.mock.method(globalThis, 'fetch', async () => new Response(NEW_FORMAT_HTML, { status: 200 }));

  const result = await getStatusCards({ STATUS_KV: kv });
  assert.equal(result.cards[0].title, 'Schools Closed');
  const cached = JSON.parse(kv.store.get('last_good_scrape'));
  assert.equal(cached.cards[0].title, 'Schools Closed');
});
