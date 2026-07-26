// The action log: a complete record of what the Worker did, written to
// Cloudflare's log store at zero KV cost — and sent to Discord never.
//
// Both properties are the reason this module exists rather than reusing
// postLog, so both are asserted directly: logging must not write to KV, and it
// must not put a message in any channel. The user-facing log is the control
// panel's Recent Activity list, which postLog owns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logAction, logActionError, logDetail } from '../src/actionlog.js';
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

// Captures the ACT| lines a block of logging emits.
function captureLog(t) {
  const lines = [];
  t.mock.method(console, 'log', (...args) => {
    const first = String(args[0] || '');
    if (first.startsWith('ACT|')) lines.push(first);
  });
  return lines;
}

function parse(line) {
  const [, at, level, guildId, ...rest] = line.split('|');
  return { at, level, guildId, text: rest.join('|') };
}

test('logging writes ACT| lines and nothing else', (t) => {
  const lines = captureLog(t);

  logAction('did a thing');
  logActionError('broke a thing', { guildId: 'g1' });
  logDetail('stored a feed', { guildId: 'g2' });

  assert.equal(lines.length, 3);
  const [action, error, detail] = lines.map(parse);
  assert.equal(action.text, 'did a thing');
  assert.equal(action.level, 'info');
  assert.equal(action.guildId, '-', 'a Worker-wide line is scoped to no guild');
  assert.equal(error.level, 'error');
  assert.equal(error.guildId, 'g1');
  assert.equal(detail.level, 'detail', 'routine plumbing stays filterable');
  assert.equal(detail.guildId, 'g2');
});

test('logging ignores empty messages', (t) => {
  const lines = captureLog(t);
  logAction('');
  logAction(null);
  logAction('   ');
  logDetail('');
  assert.deepEqual(lines, []);
});

test('logging never contacts Discord and never writes KV', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  captureLog(t);

  // The batched log channel feed is gone: a tick full of actions must produce
  // no outbound request at all. The panel is the only thing in the channel.
  logAction('posted the status', { guildId: 'g1' });
  logAction('refreshed the board', { guildId: 'g1' });
  logActionError('a watcher threw');
  logDetail('Watcher pushed fresh data: roads.');

  assert.equal(fetchMock.mock.callCount(), 0, 'the action log must send no messages');
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

test('postLog records to the panel history and the log store, not to a chat message', async (t) => {
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ id: 'panel-msg' }), { status: 200 });
  });
  const lines = captureLog(t);

  const kv = kvStub();
  await postLog({ STATUS_KV: kv, DISCORD_BOT_TOKEN: 'bot-token' }, 'chan-1', 'Override set (status: closed)', {}, 'g9');

  // The line is in the panel's own history array…
  const history = JSON.parse(kv.map.get('panel_logs:g9'));
  assert.equal(history.length, 1);
  assert.match(history[0], /Override set/);

  // …and in the log store, scoped to the guild…
  assert.equal(lines.length, 1);
  assert.equal(parse(lines[0]).guildId, 'g9');
  assert.match(parse(lines[0]).text, /Override set/);

  // …and the only thing sent to Discord is the control panel itself.
  assert.equal(posts.length, 1);
  assert.ok(posts[0].body.embeds, 'the panel is an embed, not a log line');
  assert.equal(posts[0].body.content, undefined);
});

// --- "Last checked" must report the last real check, not the render time ---

test('resolveCheckedAt prefers the stored check time over now', async () => {
  const { resolveCheckedAt } = await import('../src/embeds.js');

  const at = Date.UTC(2026, 6, 26, 0, 0, 52);
  const kv = kvStub({ 'last_check_time:g1': String(at) });
  const resolved = await resolveCheckedAt({ STATUS_KV: kv }, 'g1');
  assert.equal(resolved.getTime(), at, 'a re-render must inherit the stored check time');

  // An explicit Date always wins — that is how a caller that actually scraped
  // reports its own check.
  const explicit = new Date(Date.UTC(2026, 6, 26, 1, 2, 3));
  assert.equal(
    (await resolveCheckedAt({ STATUS_KV: kv }, 'g1', explicit)).getTime(),
    explicit.getTime()
  );

  // No check has ever run for this guild: fall back to now rather than 1970.
  const fresh = await resolveCheckedAt({ STATUS_KV: kvStub() }, 'never');
  assert.ok(Date.now() - fresh.getTime() < 5000);

  // Missing KV must not throw — the footer is never allowed to break a post.
  assert.ok((await resolveCheckedAt(null, 'g1')) instanceof Date);
});

test('a storm-mode re-render does not advance the footer past the real check', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  const { buildStatusPayload } = await import('../src/embeds.js');

  const checkAt = Date.UTC(2026, 6, 26, 0, 0, 52); // 8:00:52 PM ET
  const kv = kvStub({
    'last_check_time:g1': String(checkAt),
    'override:g1': JSON.stringify({
      status_key: 'schools_closed',
      status_label: 'Schools Closed',
      expires_at: Date.now() + 86400000
    })
  });

  // No checkedAt passed — this is the storm-refresh / re-render path.
  const built = await buildStatusPayload({ STATUS_KV: kv }, { guildId: 'g1' });
  const footer = built.payload.embeds[0].footer.text;
  assert.match(footer, /Last checked/);
  assert.match(footer, /8:00/, `footer should report the 8:00 PM check, got: ${footer}`);
});
