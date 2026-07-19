import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doCheckAndPost, delayAnnouncedToday } from '../src/check.js';
import { getEasternTimeStr } from '../src/timeutil.js';

test('delayAnnouncedToday only matches a same-day 2-hour-delay entry', () => {
  const today = '2027-01-20';
  const todayMs = Date.parse('2027-01-20T10:00:00Z'); // 5 AM ET Jan 20
  assert.equal(delayAnnouncedToday([{ timestamp: todayMs, status_key: 'schools_open_2_hours_late' }], today), true);
  assert.equal(delayAnnouncedToday([{ timestamp: todayMs, status_key: 'schools_closed' }], today), false);
  const yesterdayMs = Date.parse('2027-01-19T10:00:00Z');
  assert.equal(delayAnnouncedToday([{ timestamp: yesterdayMs, status_key: 'schools_open_2_hours_late' }], today), false);
  assert.equal(delayAnnouncedToday([], today), false);
  assert.equal(delayAnnouncedToday(null, today), false);
});

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

function statusHtml(title, body) {
  return `<html><body><section id="status-block" class="status">
    <div class="card">
      <h2><span class="status-date">July 18, 2026</span><span>${title}</span></h2>
      <p>${body}</p>
    </div>
  </section></body></html>`;
}

// Routes the fetches doCheckAndPost makes: the HCPSS status page and the
// Discord API. Weather/news are satisfied from seeded KV caches, so anything
// else reaching the network is a test bug and fails loudly.
function mockFetch(t, { html }) {
  const calls = { posts: [], deletes: [] };
  let idCounter = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    if (u.startsWith('https://status.hcpss.org')) {
      return new Response(html.value, { status: 200 });
    }
    if (u.startsWith('https://discord.com/')) {
      if (method === 'DELETE') {
        calls.deletes.push(u);
        return new Response(null, { status: 204 });
      }
      if (method === 'POST') {
        calls.posts.push({ url: u, body: JSON.parse(opts.body || '{}') });
        return new Response(JSON.stringify({ id: `m${++idCounter}` }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${u}`);
  });
  return calls;
}

function makeEnv(store) {
  const kv = makeKv(store);
  // Quiet weather and news caches so embeds never fetch NWS/RSS.
  kv.store.set('weather_alerts_cache', JSON.stringify([]));
  kv.store.set('news_signal_cache', JSON.stringify({ at: Date.now(), signal: null }));
  return { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
}

function seedGuild(env, gid) {
  env.STATUS_KV.store.set(`config:${gid}`, JSON.stringify({ alert_channel_id: `chan-${gid}` }));
  env.STATUS_KV.store.set('guild_index', JSON.stringify([gid]));
}

test('manual check posts the status, stores the message id, and records history', async (t) => {
  const html = { value: statusHtml('Schools Closed', 'All schools are closed today.') };
  const calls = mockFetch(t, { html });
  const env = makeEnv();
  seedGuild(env, 'g1');

  const result = await doCheckAndPost(env, { source: 'manual', guildId: 'g1' });
  assert.equal(result.ok, true);
  assert.ok(result.id);

  const alertPosts = calls.posts.filter(p => p.url.includes('/channels/chan-g1/'));
  assert.equal(alertPosts.length, 1);
  assert.match(alertPosts[0].body.embeds[0].title, /HCPSS Status/);

  assert.equal(env.STATUS_KV.store.get('last_message_id:g1'), 'm1');
  assert.equal(env.STATUS_KV.store.get('last_channel_id:g1'), 'chan-g1');

  const history = JSON.parse(env.STATUS_KV.store.get('status_history'));
  assert.equal(history[0].status_key, 'schools_closed');
  assert.ok(env.STATUS_KV.store.get('last_known_status'));
});

test('a new post deletes the previously tracked message', async (t) => {
  const html = { value: statusHtml('Normal Operations', 'All systems normal.') };
  const calls = mockFetch(t, { html });
  const env = makeEnv();
  seedGuild(env, 'g1');
  env.STATUS_KV.store.set('last_message_id:g1', 'old-msg');
  env.STATUS_KV.store.set('last_channel_id:g1', 'chan-g1');

  await doCheckAndPost(env, { source: 'manual', guildId: 'g1' });
  assert.equal(calls.deletes.length, 1);
  assert.match(calls.deletes[0], /channels\/chan-g1\/messages\/old-msg$/);
  assert.equal(env.STATUS_KV.store.get('last_message_id:g1'), 'm1');
});

test('scheduled run posts for a matching schedule and dedupes the slot', async (t) => {
  const html = { value: statusHtml('Normal Operations', 'All systems normal.') };
  const calls = mockFetch(t, { html });
  const env = makeEnv();
  seedGuild(env, 'g1');
  // Schedule the guild for the current minute so the match is deterministic.
  env.STATUS_KV.store.set('config:g1', JSON.stringify({
    alert_channel_id: 'chan-g1',
    check_schedule: [getEasternTimeStr(new Date())]
  }));

  const first = await doCheckAndPost(env, { source: 'scheduled' });
  assert.equal(first.ok, true);
  assert.equal(calls.posts.filter(p => p.url.includes('/channels/chan-g1/')).length, 1);

  // Same minute again: the slot key already ran today, so nothing posts.
  const second = await doCheckAndPost(env, { source: 'scheduled' });
  assert.equal(second.skipped, true);
  assert.equal(calls.posts.filter(p => p.url.includes('/channels/chan-g1/')).length, 1);
});

test('scheduled run with no matching guilds and no storm alert skips quietly', async (t) => {
  const html = { value: statusHtml('Normal Operations', 'All systems normal.') };
  const calls = mockFetch(t, { html });
  const env = makeEnv();
  seedGuild(env, 'g1'); // default schedule won't match every minute of the day...
  env.STATUS_KV.store.set('config:g1', JSON.stringify({ alert_channel_id: 'chan-g1', check_schedule: [] }));

  const result = await doCheckAndPost(env, { source: 'scheduled' });
  assert.equal(result.skipped, true);
  assert.equal(calls.posts.length, 0);
});

test('a status change DMs subscribers; a repost of the same status does not', async (t) => {
  const html = { value: statusHtml('Normal Operations', 'All systems normal.') };
  const calls = mockFetch(t, { html });
  const env = makeEnv();
  seedGuild(env, 'g1');
  env.STATUS_KV.store.set('dm_subscribers:g1', JSON.stringify(['user9']));

  // Baseline run establishes last_known_status; first observation is not a change.
  await doCheckAndPost(env, { source: 'manual', guildId: 'g1' });
  assert.equal(calls.posts.filter(p => p.url.includes('users/@me/channels')).length, 0);

  // Same status again: still no DM.
  await doCheckAndPost(env, { source: 'manual', guildId: 'g1' });
  assert.equal(calls.posts.filter(p => p.url.includes('users/@me/channels')).length, 0);

  // Status flips to a closure: subscriber gets a DM. Drop the 60-second
  // fresh-scrape cache so the new page is actually fetched.
  html.value = statusHtml('Schools Closed', 'All schools are closed today.');
  env.STATUS_KV.store.delete('last_good_scrape');
  await doCheckAndPost(env, { source: 'manual', guildId: 'g1' });
  const dmOpens = calls.posts.filter(p => p.url.includes('users/@me/channels'));
  assert.equal(dmOpens.length, 1);
  assert.equal(dmOpens[0].body.recipient_id, 'user9');
});

test('a failed alert-channel post is reported and tracked as a failure streak', async (t) => {
  const html = { value: statusHtml('Normal Operations', 'All systems normal.') };
  let idCounter = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://status.hcpss.org')) return new Response(html.value, { status: 200 });
    if (u.includes('/channels/chan-g1/messages')) return new Response('missing access', { status: 403 });
    if (u.startsWith('https://discord.com/')) {
      return new Response(JSON.stringify({ id: `m${++idCounter}` }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  });
  const env = makeEnv();
  seedGuild(env, 'g1');

  const result = await doCheckAndPost(env, { source: 'manual', guildId: 'g1' });
  assert.equal(result.ok, false);
  assert.equal(env.STATUS_KV.store.get('alert_post_failures:g1'), '1');
});
