// The false-alarm regression: a winter storm during a scheduled break used to
// produce a 7 PM "closure likely" ping, a 4:30 AM Decision Watch board, and
// 15-minute storm checks — for days school was never open, because the status
// page reads Normal Operations straight through winter break.
//
// Each case here runs the real cron entry points twice with identical storm
// conditions, changing only the date, so the difference is provably the gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doCheckAndPost } from '../src/check.js';
import { maybeUpdateDecisionWatch } from '../src/decisionwatch.js';
import { maybeSendHeadsUp } from '../src/headsup.js';

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); },
    async list() { return { keys: [], list_complete: true }; }
  };
}

function statusHtml() {
  return `<html><body><section id="status-block" class="status"><div class="card">
    <h2><span class="status-date">December 28, 2026</span><span>Normal Operations</span></h2>
    <p>Schools are operating on a normal schedule.</p>
  </div></section></body></html>`;
}

// A storm severe enough for a High outlook: a warning plus a neighbor closed.
function seedStormEnv(nowMs, guildConfig = {}) {
  const kv = makeKv();
  kv.store.set('guild_index', JSON.stringify(['g1']));
  kv.store.set('config:g1', JSON.stringify({
    alert_channel_id: 'chan1',
    check_schedule: [],
    created_at: 0,
    ...guildConfig
  }));
  kv.store.set('weather_alerts_cache', JSON.stringify([
    { event: 'Winter Storm Warning', severity: 'Severe', endsMs: 0 }
  ]));
  kv.store.set('district_status_cache', JSON.stringify({
    at: nowMs,
    districts: [{ id: 'aacps', name: 'Anne Arundel Co.', status: 'closed', detail: 'All schools closed' }]
  }));
  return { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
}

function stubFetch(t, posts) {
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.startsWith('https://status.hcpss.org')) {
      return new Response(statusHtml(), { status: 200 });
    }
    if (u.includes('discord.com/api')) {
      if (method === 'POST' && /channels\/[^/]+\/messages$/.test(u)) {
        posts.push({ url: u, body: JSON.parse(opts.body) });
        return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }
    // Every side feed offline — context must never be load-bearing.
    throw new Error(`offline: ${u}`);
  });
}

const alertPosts = posts => posts.filter(p => p.url.includes('/channels/chan1/'));

// 2026-12-28 is the Monday inside winter break; 2027-01-15 is an ordinary
// Friday in the same school year. Both 5:15 AM EST.
const BREAK_515AM = Date.parse('2026-12-28T10:15:00Z');
const SCHOOL_515AM = Date.parse('2027-01-15T10:15:00Z');

// 7:00 PM EST the evening before each of those days.
const BREAK_EVE_7PM = Date.parse('2026-12-28T00:00:00Z');   // Sun Dec 27, about Dec 28
const SCHOOL_EVE_7PM = Date.parse('2027-01-15T00:00:00Z');  // Thu Jan 14, about Jan 15

test('storm mode stays home on a break day', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BREAK_515AM });
  const posts = [];
  stubFetch(t, posts);
  const env = seedStormEnv(BREAK_515AM);

  const result = await doCheckAndPost(env, { source: 'scheduled' });
  assert.equal(result.skipped, true);
  assert.match(result.message, /not in session/);
  assert.equal(alertPosts(posts).length, 0);

  // The gate runs before the storm-slot write, so a break costs no KV writes.
  assert.equal(env.STATUS_KV.store.has('last_storm_slot'), false);
});

test('storm mode still runs on an ordinary school day', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: SCHOOL_515AM });
  const posts = [];
  stubFetch(t, posts);
  const env = seedStormEnv(SCHOOL_515AM);

  const result = await doCheckAndPost(env, { source: 'scheduled' });
  assert.notEqual(result.message, undefined);
  assert.doesNotMatch(String(result.message || ''), /not in session/);
  assert.equal(env.STATUS_KV.store.has('last_storm_slot'), true, 'the storm tick ran');
});

test('Decision Watch posts no board on a break day', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BREAK_515AM });
  const posts = [];
  stubFetch(t, posts);
  const env = seedStormEnv(BREAK_515AM);

  const result = await maybeUpdateDecisionWatch(env);
  assert.equal(result.updated, 0);
  assert.equal(alertPosts(posts).length, 0);
});

test('Decision Watch posts its board on a school day', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: SCHOOL_515AM });
  const posts = [];
  stubFetch(t, posts);
  const env = seedStormEnv(SCHOOL_515AM);

  const result = await maybeUpdateDecisionWatch(env);
  assert.equal(result.updated, 1);
  const board = alertPosts(posts).find(p => p.body.embeds[0].title.includes('Decision Watch'));
  assert.ok(board, 'board posted on a real school day');
});

test('the night-before heads-up asks about tomorrow, not today', async (t) => {
  const posts = [];
  t.mock.timers.enable({ apis: ['Date'], now: BREAK_EVE_7PM });
  stubFetch(t, posts);

  // Sunday evening during winter break: today is a weekend and tomorrow is a
  // break day. Nothing should go out.
  const breakEnv = seedStormEnv(BREAK_EVE_7PM);
  assert.equal((await maybeSendHeadsUp(breakEnv)).sent, 0);
  assert.equal(alertPosts(posts).length, 0);

  // Thursday evening before an ordinary Friday: the heads-up fires. Same
  // storm, same config — only the date moved.
  t.mock.timers.setTime(SCHOOL_EVE_7PM);
  const schoolEnv = seedStormEnv(SCHOOL_EVE_7PM);
  assert.equal((await maybeSendHeadsUp(schoolEnv)).sent, 1);
  const headsUp = alertPosts(posts).find(p => /Heads-Up/.test(p.body.embeds[0].title));
  assert.ok(headsUp, 'heads-up posted the evening before a school day');
});

test('a Friday evening heads-up does not fire for Saturday', async (t) => {
  // Fri 2027-01-15 7 PM EST — tomorrow is a weekend.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-01-16T00:00:00Z') });
  const posts = [];
  stubFetch(t, posts);
  const env = seedStormEnv(Date.parse('2027-01-16T00:00:00Z'));
  assert.equal((await maybeSendHeadsUp(env)).sent, 0);
});

test('toggle_session_gate off restores the old always-on behavior', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BREAK_515AM });
  const posts = [];
  stubFetch(t, posts);
  const env = seedStormEnv(BREAK_515AM, { toggle_session_gate: false });

  const result = await doCheckAndPost(env, { source: 'scheduled' });
  assert.doesNotMatch(String(result.message || ''), /not in session/);
  assert.equal((await maybeUpdateDecisionWatch(env)).updated, 1, 'board posts when the gate is off');
});

test('a guild following a neighboring district keeps its own calendar rules', async (t) => {
  // 2026-10-16 is an HCPSS staff PD day (no students) but an ordinary Friday
  // for Frederick County, whose calendar the bot does not have.
  const PD_DAY_515AM = Date.parse('2026-10-16T09:15:00Z'); // 5:15 AM EDT
  t.mock.timers.enable({ apis: ['Date'], now: PD_DAY_515AM });

  const posts = [];
  stubFetch(t, posts);
  const hcpssEnv = seedStormEnv(PD_DAY_515AM);
  const hcpssResult = await doCheckAndPost(hcpssEnv, { source: 'scheduled' });
  assert.match(hcpssResult.message, /not in session/, 'HCPSS guilds skip their own PD day');

  const fcpsEnv = seedStormEnv(PD_DAY_515AM, { primary_district: 'fcps' });
  const fcpsResult = await doCheckAndPost(fcpsEnv, { source: 'scheduled' });
  assert.doesNotMatch(String(fcpsResult.message || ''), /not in session/,
    'Frederick guilds are not suppressed by Howard\'s calendar');
});
