// The batched action log: a complete Discord record of what the Worker did,
// at zero KV write cost.
//
// The cost property is the reason this module exists rather than reusing
// postLog, so it is asserted directly: a flush must not write to KV at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginActionLog,
  logAction,
  logActionError,
  flushActionLog,
  formatActionBatch,
  getBufferedActions
} from '../src/actionlog.js';
import { postLog } from '../src/panel.js';

function kvStub(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    writes: 0,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, val) { this.writes++; map.set(key, val); },
    async delete(key) { map.delete(key); },
    async list() { return { keys: [], list_complete: true }; }
  };
}

function envWith(guilds, kv) {
  return {
    STATUS_KV: kv,
    DISCORD_BOT_TOKEN: 'bot-token',
    ...guilds
  };
}

test('logAction buffers lines and beginActionLog clears them', () => {
  beginActionLog();
  assert.deepEqual(getBufferedActions(), []);
  logAction('did a thing');
  logActionError('broke a thing', { guildId: 'g1' });
  const buffered = getBufferedActions();
  assert.equal(buffered.length, 2);
  assert.equal(buffered[0].text, 'did a thing');
  assert.equal(buffered[0].level, 'info');
  assert.equal(buffered[1].level, 'error');
  assert.equal(buffered[1].guildId, 'g1');
  beginActionLog();
  assert.deepEqual(getBufferedActions(), []);
});

test('logAction ignores empty messages', () => {
  beginActionLog();
  logAction('');
  logAction(null);
  logAction('   ');
  assert.deepEqual(getBufferedActions(), []);
});

test('formatActionBatch splits into code blocks under the Discord limit', () => {
  const lines = Array.from({ length: 200 }, (_, i) => ({
    text: `line ${i} ${'x'.repeat(40)}`,
    guildId: '',
    level: 'info',
    at: Date.now()
  }));
  const chunks = formatActionBatch(lines);
  assert.ok(chunks.length > 1, 'should split');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2000, `chunk too long: ${chunk.length}`);
    assert.ok(chunk.startsWith('```\n') && chunk.endsWith('\n```'));
  }
  // A single line longer than the whole budget is truncated, not dropped.
  const huge = formatActionBatch([{ text: 'y'.repeat(5000), guildId: '', level: 'info', at: Date.now() }]);
  assert.equal(huge.length, 1);
  assert.ok(huge[0].length <= 2000);
});

test('flushActionLog posts one batch and spends no KV writes', async (t) => {
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return new Response('{}', { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1']),
    'config:g1': JSON.stringify({ log_channel_id: 'chan-1' })
  });
  const env = envWith({}, kv);

  beginActionLog();
  logAction('posted the status');
  logAction('refreshed the board');
  const result = await flushActionLog(env);

  assert.equal(result.posted, 1);
  assert.equal(posts.length, 1, 'one API call, not one per line');
  assert.match(posts[0].url, /channels\/chan-1\/messages/);
  assert.match(posts[0].body.content, /posted the status/);
  assert.match(posts[0].body.content, /refreshed the board/);
  assert.equal(kv.writes, 0, 'the action log must never write to KV');
  // The buffer is drained, so a second flush is a no-op.
  assert.equal((await flushActionLog(env)).posted, 0);
});

test('flushActionLog stays silent when there is nothing to say', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  const kv = kvStub({ guild_index: JSON.stringify(['g1']) });
  beginActionLog();
  const result = await flushActionLog(envWith({}, kv));
  assert.equal(result.posted, 0);
  assert.equal(fetchMock.mock.callCount(), 0, 'a quiet tick must cost nothing');
});

test('flushActionLog honours the per-guild toggle', async (t) => {
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return new Response('{}', { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['off', 'on']),
    'config:off': JSON.stringify({ log_channel_id: 'c-off', toggle_action_log: false }),
    'config:on': JSON.stringify({ log_channel_id: 'c-on' })
  });

  beginActionLog();
  logAction('worker-wide line');
  await flushActionLog(envWith({}, kv));

  assert.equal(posts.length, 1, 'the opted-out guild must get nothing');
  assert.match(posts[0].url, /channels\/c-on\/messages/);
});

test('guild-scoped lines only reach their own guild', async (t) => {
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return new Response('{}', { status: 200 });
  });

  const kv = kvStub({
    guild_index: JSON.stringify(['g1', 'g2']),
    'config:g1': JSON.stringify({ log_channel_id: 'c1' }),
    'config:g2': JSON.stringify({ log_channel_id: 'c2' })
  });

  beginActionLog();
  logAction('global line');
  logAction('g1 only', { guildId: 'g1' });
  await flushActionLog(envWith({}, kv));

  const byChannel = Object.fromEntries(posts.map(p => [p.url.match(/channels\/([^/]+)\//)[1], p.body.content]));
  assert.match(byChannel.c1, /global line/);
  assert.match(byChannel.c1, /g1 only/);
  assert.match(byChannel.c2, /global line/);
  assert.doesNotMatch(byChannel.c2, /g1 only/);
});

test('postLog only stamps last_check_time for calls that were actually checks', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));

  // A non-check log line (calendar edit, announcement, panel refresh) used to
  // spend a KV write restating a "last check" timestamp it had not changed.
  const kv = kvStub();
  await postLog({ STATUS_KV: kv }, null, 'Calendar event added', {}, 'g1');
  assert.equal(kv.map.has('last_check_time:g1'), false);
  assert.equal(kv.map.has('last_check_latency:g1'), false);

  // A real check passes a latency, and both keys are recorded as before.
  const kv2 = kvStub();
  await postLog({ STATUS_KV: kv2 }, null, 'status check posted', { latency: 42 }, 'g1');
  assert.equal(kv2.map.get('last_check_latency:g1'), '42');
  assert.ok(Number(kv2.map.get('last_check_time:g1')) > 0);
});

test('postLog feeds the action log so the Discord stream is complete', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  beginActionLog();
  await postLog({ STATUS_KV: kvStub() }, null, 'Override set (status: closed)', {}, 'g9');
  const buffered = getBufferedActions();
  assert.equal(buffered.length, 1);
  assert.match(buffered[0].text, /Override set/);
  assert.equal(buffered[0].guildId, 'g9');
});
