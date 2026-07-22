// End-to-end simulation of a storm morning across the cron-driven modules:
// 4:30 AM the Decision Watch board posts, 5:15 AM storm mode catches a delay
// announcement, 8:15 AM the conversion watch catches the delay-to-closure
// upgrade (outside the storm window), and noon brings the storm recap. Time
// is mocked via node:test timers, network via a fetch stub, KV via a Map —
// this catches the cross-module wiring that unit tests can't.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doCheckAndPost } from '../src/check.js';
import { maybeUpdateDecisionWatch, maybeCleanupDecisionWatch } from '../src/decisionwatch.js';
import { maybeSendStormRecap } from '../src/stormrecap.js';

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); },
    async list() { return { keys: [], list_complete: true }; }
  };
}

function statusHtml(title, body) {
  return `<html><body><section id="status-block" class="status"><div class="card">
    <h2><span class="status-date">January 15, 2027</span><span>${title}</span></h2>
    <p>${body}</p>
  </div></section></body></html>`;
}

// 2027-01-15 is EST (UTC-5).
const T_430AM = Date.parse('2027-01-15T09:30:00Z');
const T_515AM = Date.parse('2027-01-15T10:15:00Z');
const T_815AM = Date.parse('2027-01-15T13:15:00Z');
const T_NOON = Date.parse('2027-01-15T17:00:00Z');

test('full storm morning: board, delay, closure upgrade, recap', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T_430AM });

  const kv = makeKv();
  kv.store.set('guild_index', JSON.stringify(['g1']));
  kv.store.set('config:g1', JSON.stringify({
    alert_channel_id: 'chan1',
    check_schedule: [],
    created_at: 0
  }));
  // Pre-seeded caches keep the run offline: a storm alert for Howard County
  // and one neighbor already closed.
  kv.store.set('weather_alerts_cache', JSON.stringify([
    { event: 'Winter Storm Warning', severity: 'Severe', endsMs: 0 }
  ]));
  kv.store.set('district_status_cache', JSON.stringify({
    at: T_430AM,
    districts: [{ id: 'aacps', name: 'Anne Arundel Co.', status: 'closed', detail: 'All schools closed' }]
  }));

  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };

  let currentHtml = statusHtml('Normal Operations', 'Schools are operating on a normal schedule.');
  const discordPosts = [];
  const discordDeletes = [];
  let messageCounter = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.startsWith('https://status.hcpss.org')) {
      return new Response(currentHtml, { status: 200 });
    }
    if (u.includes('discord.com/api')) {
      if (method === 'POST' && /channels\/[^/]+\/messages$/.test(u)) {
        discordPosts.push({ url: u, body: JSON.parse(opts.body) });
        return new Response(JSON.stringify({ id: `m${++messageCounter}` }), { status: 200 });
      }
      if (method === 'DELETE') {
        discordDeletes.push(u);
        return new Response(null, { status: 204 });
      }
      return new Response('{}', { status: 200 });
    }
    // Every other source (BGE, CHART, snowfall, news, ...) is down — the run
    // must still work because context never breaks a status post.
    throw new Error(`offline: ${u}`);
  });

  const alertPosts = () => discordPosts.filter(p => p.url.includes('/channels/chan1/'));

  // 4:30 AM — Decision Watch posts the board; the storm check sees no change.
  let result = await doCheckAndPost(env, { source: 'scheduled' });
  assert.equal(result.skipped, true, '4:30 storm check should be silent with no change');
  await maybeUpdateDecisionWatch(env);
  const board = alertPosts().find(p => p.body.embeds && p.body.embeds[0].title.includes('Decision Watch'));
  assert.ok(board, 'Decision Watch board posted');
  assert.match(board.body.embeds[0].description, /Anne Arundel Co\./);

  // 5:15 AM — HCPSS announces a 2-hour delay; the storm tick posts it.
  t.mock.timers.setTime(T_515AM);
  currentHtml = statusHtml('Schools Open 2 Hours Late', 'All schools will open two hours late today.');
  result = await doCheckAndPost(env, { source: 'scheduled' });
  assert.equal(result.ok, true);
  const delayPost = alertPosts().find(p => p.body.embeds &&
    (p.body.embeds[0].description || '').includes('two hours late'));
  assert.ok(delayPost, 'storm mode posted the delay announcement');

  // 8:15 AM — outside the storm window, the delay upgrades to a closure; the
  // conversion watch (armed by the delay in history) catches it.
  t.mock.timers.setTime(T_815AM);
  currentHtml = statusHtml('Schools Closed', 'All schools are now closed today.');
  result = await doCheckAndPost(env, { source: 'scheduled' });
  assert.equal(result.ok, true);
  assert.notEqual(result.skipped, true, 'conversion watch should have run');
  const closurePost = alertPosts().find(p => p.body.embeds &&
    (p.body.embeds[0].description || '').includes('now closed'));
  assert.ok(closurePost, 'conversion watch posted the closure upgrade');

  // Still 8:15 — the cleanup pass deletes the board message and its KV record.
  const boardRecord = JSON.parse(kv.store.get('decision_watch:g1'));
  const cleanupResult = await maybeCleanupDecisionWatch(env);
  assert.equal(cleanupResult.deleted, 1);
  assert.ok(
    discordDeletes.some(u => u.endsWith(`/messages/${boardRecord.messageId}`)),
    'board message deleted via Discord API'
  );
  assert.equal(kv.store.has('decision_watch:g1'), false);
  // Second tick the same morning is a no-op (day-key dedupe).
  assert.equal((await maybeCleanupDecisionWatch(env)).deleted, 0);

  const history = JSON.parse(kv.store.get('status_history'));
  assert.equal(history[0].status_key, 'schools_closed');
  assert.equal(history[1].status_key, 'schools_open_2_hours_late');

  // Noon — the storm recap closes the loop with the outcome and the board.
  t.mock.timers.setTime(T_NOON);
  const recapResult = await maybeSendStormRecap(env);
  assert.equal(recapResult.sent, 1);
  const recap = alertPosts().find(p => p.body.embeds && p.body.embeds[0].title.includes('Storm Recap'));
  assert.ok(recap, 'storm recap posted');
  assert.match(recap.body.embeds[0].description, /Schools closed/);
  assert.match(recap.body.embeds[0].description, /Anne Arundel Co\./);
});
