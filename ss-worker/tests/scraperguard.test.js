import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCards, validateScrape } from '../src/scraper.js';
import { doCheckAndPost } from '../src/check.js';

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); },
    async list({ prefix }) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
      return { keys, list_complete: true };
    }
  };
}

test('validateScrape accepts known status titles', () => {
  assert.deepEqual(validateScrape([{ title: 'Schools Closed', body: 'x' }], []), { ok: true });
  assert.deepEqual(validateScrape([{ title: 'Normal Operations', body: '' }], []), { ok: true });
  assert.deepEqual(validateScrape([], []), { ok: true, empty: true });
  assert.deepEqual(validateScrape([{ title: '', body: 'body only' }], []), { ok: true });
});

test('validateScrape rejects unrecognized titles', () => {
  const r = validateScrape([{ title: 'Welcome to Our New Website!', body: 'redesign' }], []);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unrecognized status title/);
});

test('validateScrape flags a sudden card-count jump', () => {
  const prior = [{ title: 'Normal Operations' }];
  const now = [1, 2, 3, 4].map(i => ({ title: 'Schools Closed ' + i }));
  const r = validateScrape(now, prior);
  assert.equal(r.ok, false);
  assert.match(r.reason, /card count jumped/);
});

test('drift fixture HTML parses to an unrecognized title', () => {
  const html = '<section id="status-block"><div><span class="status-date">Today</span><h2><span>Grand Reopening Sale!</span></h2><p>Buy one get one</p></div></section>';
  const cards = extractCards(html);
  assert.ok(cards.length >= 1, 'fixture must parse to at least one card, got ' + JSON.stringify(cards));
  const r = validateScrape(cards, [{ title: 'Normal Operations' }]);
  assert.equal(r.ok, false);
});

test('a drifted scrape holds the post, alerts staff once, and counts as failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('status.hcpss.org')) {
      return new Response('<section id="status-block"><div><span class="status-date">Today</span><h2><span>Grand Reopening Sale!</span></h2><p>Buy one get one</p></div></section>', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  const store = new Map();
  store.set('guild_index', JSON.stringify(['g1']));
  store.set('config:g1', JSON.stringify({
    alert_channel_id: 'chan-1', log_channel_id: 'log-1', staff_role_id: 'role-staff',
    check_schedule: ['99:99']
  }));
  // Stale copy: forces a live fetch (bypasses the 60s fresh cache) while
  // still providing prior cards for the count-jump check.
  store.set('last_good_scrape', JSON.stringify({ at: Date.now() - 120_000, cards: [{ title: 'Normal Operations', body: '' }] }));
  const env = { STATUS_KV: makeKv(store), DISCORD_BOT_TOKEN: 'tok', DISCORD_GUILD_ID: 'g1' };

  const posts = [];
  const origFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const out = await origFetch(url, init);
    if (String(url).includes('/channels/chan-1/messages')) posts.push(1);
    return out;
  });

  const res = await doCheckAndPost(env, { source: 'manual', guildId: 'g1' });
  assert.equal(res.ok, false);
  assert.match(res.error || res.message, /unrecognized status title/i);
  assert.equal(posts.length, 0, 'drifted status must not post to the alert channel');
  assert.equal(store.get('scraper_drift_alerted'), '1');
  assert.ok(Number(store.get('scraper_failures_count') || 0) >= 1, 'drift counts as a scrape failure');
});

test('a second drifted run does not re-alert staff', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('status.hcpss.org')) {
      return new Response('<section id="status-block"><div><span class="status-date">Today</span><h2><span>Grand Reopening Sale!</span></h2><p>Buy one get one</p></div></section>', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  const store = new Map();
  store.set('guild_index', JSON.stringify(['g1']));
  store.set('config:g1', JSON.stringify({ alert_channel_id: 'chan-1', log_channel_id: 'log-1', check_schedule: ['99:99'] }));
  // Same stale-copy trick as above so the mock HTML is actually fetched.
  store.set('last_good_scrape', JSON.stringify({ at: Date.now() - 120_000, cards: [{ title: 'Normal Operations', body: '' }] }));
  store.set('scraper_drift_alerted', '1'); // already alerted
  const env = { STATUS_KV: makeKv(store), DISCORD_BOT_TOKEN: 'tok', DISCORD_GUILD_ID: 'g1' };

  let logPosts = 0;
  const origFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const out = await origFetch(url, init);
    if (String(url).includes('/channels/log-1/messages')) logPosts++;
    return out;
  });

  await doCheckAndPost(env, { source: 'manual', guildId: 'g1' });
  assert.equal(logPosts, 0, 'no repeat drift alert');
});
