import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintLogsToken,
  verifyLogsToken,
  buildLogsUrl,
  parseLogEvent,
  selectLogEntries,
  queryWorkerLogs,
  renderLogsPage,
  formatLogText,
  logsPageResponse,
  LOGS_LINK_TTL_MS
} from '../src/workerlogs.js';
import { renderPanelLogLines } from '../src/panel.js';
import { runLogsCommand } from '../src/commands.js';

const ENV = {
  DISCORD_BOT_TOKEN: 'bot-token-abc',
  CF_API_TOKEN: 'cf-token',
  CF_ACCOUNT_ID: 'acct-1',
  PUBLIC_BASE_URL: 'https://worker.example.dev'
};
const NOW = 1780000000000;

function actEvent(iso, level, guildId, text) {
  return { timestamp: Date.parse(iso), message: `ACT|${iso}|${level}|${guildId}|${text}` };
}

// ── the bug this page replaced ──────────────────────────────────────────────

test('renderPanelLogLines keeps a week of status posts under the embed limit', () => {
  // Real shape and length of a stored line; 25 of these measured 4,949 chars
  // as one description, over Discord's 4,096 limit, which made the panel's
  // logs view fail with "the application did not respond".
  const line = '[Jul 29, 10:00:22 AM] ✅ HCPSS status check posted (source: scheduled) to ' +
    '<#1524232469552038038>. [Jump to Message](https://discord.com/channels/1521682363942436895/' +
    '1524232469552038038/1399482758271090699)';
  const out = renderPanelLogLines(Array(25).fill(line));
  assert.ok(out.length < 4096, `block was ${out.length} chars`);
  assert.match(out, /…13 older line\(s\) — see the System Logs page/);

  // The character cap has to hold on its own, even if the line cap is lifted.
  const noLineCap = renderPanelLogLines(Array(25).fill(line), { maxLines: 25 });
  assert.ok(noLineCap.length < 4096, `block was ${noLineCap.length} chars`);
  assert.match(noLineCap, /older line\(s\)/);
});

test('renderPanelLogLines splits the timestamp and survives odd input', () => {
  assert.match(renderPanelLogLines(['[Jul 29, 5:20 AM] posted']), /^`\[Jul 29, 5:20 AM\]` posted$/);
  assert.match(renderPanelLogLines([]), /Nothing recorded yet/);
  assert.match(renderPanelLogLines(null), /Nothing recorded yet/);
  assert.match(renderPanelLogLines(['no timestamp here']), /no timestamp here/);
  // One absurdly long line can't be shown, but it must not blow the budget.
  const huge = renderPanelLogLines([`[Jul 29, 5:20 AM] ${'x'.repeat(9000)}`]);
  assert.ok(huge.length < 4096);
  assert.match(huge, /too long to display/);
});

test('the panel action hands out a link, and reads no KV to do it', async () => {
  const kv = { get: async () => { throw new Error('the logs action must not touch KV'); } };
  const payload = await runLogsCommand({ ...ENV, STATUS_KV: kv }, 'g1', 'user-1');

  const link = payload.components[0].components[0];
  assert.equal(link.style, 5); // a real link button, not a callback
  assert.match(link.url, /^https:\/\/worker\.example\.dev\/logs\?t=/);
  assert.ok(payload.embeds[0].description.length < 4096);
  assert.match(payload.embeds[0].description, /Scoped to this server/);
  assert.equal(payload.flags, 64); // ephemeral: the link is a credential
});

test('the owner gets an all-servers link; everyone else is scoped', async () => {
  const owner = await runLogsCommand({ ...ENV, OWNER_ID: 'owner-1' }, 'g1', 'owner-1');
  const ownerToken = new URL(owner.components[0].components[0].url).searchParams.get('t');
  assert.equal((await verifyLogsToken(ENV, ownerToken, NOW)).all, true);

  const staff = await runLogsCommand({ ...ENV, OWNER_ID: 'owner-1' }, 'g1', 'someone-else');
  const staffToken = new URL(staff.components[0].components[0].url).searchParams.get('t');
  assert.equal((await verifyLogsToken(ENV, staffToken, NOW)).all, false);
});

test('with no PUBLIC_BASE_URL the action says so instead of offering a dead link', async () => {
  const payload = await runLogsCommand({ DISCORD_BOT_TOKEN: 'x' }, 'g1', 'user-1');
  assert.equal(payload.components, undefined);
  assert.match(payload.content, /PUBLIC_BASE_URL/);
});

// ── link signing ───────────────────────────────────────────────────────────

test('a minted token verifies, and its scope and guild survive the round trip', async () => {
  const token = await mintLogsToken(ENV, { guildId: 'g1', now: NOW });
  const ok = await verifyLogsToken(ENV, token, NOW + 1000);
  assert.deepEqual(
    { ok: ok.ok, guildId: ok.guildId, all: ok.all },
    { ok: true, guildId: 'g1', all: false }
  );

  const ownerToken = await mintLogsToken(ENV, { guildId: 'g1', all: true, now: NOW });
  assert.equal((await verifyLogsToken(ENV, ownerToken, NOW)).all, true);
});

test('a tampered, re-scoped, or foreign-signed token is rejected', async () => {
  const token = await mintLogsToken(ENV, { guildId: 'g1', now: NOW });
  const [g, scope, exp, sig] = token.split('.');

  // Promoting a guild link to an owner link must not verify.
  assert.equal((await verifyLogsToken(ENV, `${g}.a.${exp}.${sig}`, NOW)).reason, 'bad-signature');
  // Nor may pointing it at another server.
  assert.equal((await verifyLogsToken(ENV, `g2.${scope}.${exp}.${sig}`, NOW)).reason, 'bad-signature');
  // Nor extending its life.
  assert.equal((await verifyLogsToken(ENV, `${g}.${scope}.${Number(exp) + 3.6e6}.${sig}`, NOW)).reason, 'bad-signature');
  // Nor may a link signed with a different secret work here.
  const foreign = await mintLogsToken({ DISCORD_BOT_TOKEN: 'other' }, { guildId: 'g1', now: NOW });
  assert.equal((await verifyLogsToken(ENV, foreign, NOW)).reason, 'bad-signature');
  assert.equal((await verifyLogsToken(ENV, 'garbage', NOW)).reason, 'malformed');
});

test('a token expires, and without a signing secret none can be minted', async () => {
  const token = await mintLogsToken(ENV, { guildId: 'g1', now: NOW });
  assert.equal((await verifyLogsToken(ENV, token, NOW + LOGS_LINK_TTL_MS - 1)).ok, true);
  assert.equal((await verifyLogsToken(ENV, token, NOW + LOGS_LINK_TTL_MS + 1)).reason, 'expired');

  assert.equal(await mintLogsToken({}, { guildId: 'g1', now: NOW }), null);
  assert.equal((await verifyLogsToken({}, token, NOW)).reason, 'not-configured');
});

test('buildLogsUrl needs a base URL and carries the window and filter', async () => {
  const url = await buildLogsUrl(ENV, { guildId: 'g1', hours: 24, filter: 'errors', now: NOW });
  assert.match(url, /^https:\/\/worker\.example\.dev\/logs\?/);
  const q = new URL(url).searchParams;
  assert.equal(q.get('h'), '24');
  assert.equal(q.get('f'), 'errors');
  assert.equal((await verifyLogsToken(ENV, q.get('t'), NOW)).guildId, 'g1');

  // No PUBLIC_BASE_URL means no link at all, rather than a broken relative one.
  assert.equal(await buildLogsUrl({ DISCORD_BOT_TOKEN: 'x' }, { guildId: 'g1' }), null);
});

// ── parsing and filtering ──────────────────────────────────────────────────

test('parseLogEvent reads ACT lines and keeps stray console output', () => {
  const act = parseLogEvent(actEvent('2026-07-29T14:00:00.000Z', 'info', 'g1', 'Posted to <#c1>'));
  assert.deepEqual(act, {
    ts: Date.parse('2026-07-29T14:00:00.000Z'),
    level: 'info',
    guildId: 'g1',
    text: 'Posted to <#c1>',
    action: true
  });

  // A message containing pipes must not be truncated at the first one.
  assert.equal(parseLogEvent(actEvent('2026-07-29T14:00:00.000Z', 'info', '-', 'a|b|c')).text, 'a|b|c');
  // Worker-wide lines carry no guild.
  assert.equal(parseLogEvent(actEvent('2026-07-29T14:00:00.000Z', 'detail', '-', 'x')).guildId, '');

  // An uncaught error isn't an ACT line, and is exactly what's worth seeing.
  const raw = parseLogEvent({ timestamp: NOW, $metadata: { level: 'error' }, source: { message: 'boom' } });
  assert.deepEqual({ level: raw.level, text: raw.text, action: raw.action }, { level: 'error', text: 'boom', action: false });

  // console.log('a', 'b') arrives as an argument array.
  assert.equal(parseLogEvent({ timestamp: NOW, source: { arguments: ['a', 'b'] } }).text, 'a b');
  assert.equal(parseLogEvent({ timestamp: NOW }), null);
  assert.equal(parseLogEvent(null), null);
});

test('a guild-scoped view never shows another server’s lines', () => {
  const events = [
    actEvent('2026-07-29T10:00:00.000Z', 'info', 'g1', 'mine'),
    actEvent('2026-07-29T11:00:00.000Z', 'info', 'g2', 'someone else'),
    actEvent('2026-07-29T12:00:00.000Z', 'info', '-', 'worker-wide')
  ];
  const scoped = selectLogEntries(events, { guildId: 'g1', filter: 'all' });
  assert.deepEqual(scoped.map(e => e.text), ['worker-wide', 'mine']); // newest first
  const owner = selectLogEntries(events, { guildId: 'g1', all: true, filter: 'all' });
  assert.equal(owner.length, 3);
});

test('the level filters do what their names say', () => {
  const events = [
    actEvent('2026-07-29T10:00:00.000Z', 'info', 'g1', 'an action'),
    actEvent('2026-07-29T11:00:00.000Z', 'detail', 'g1', 'plumbing'),
    actEvent('2026-07-29T12:00:00.000Z', 'error', 'g1', 'a failure')
  ];
  const texts = f => selectLogEntries(events, { guildId: 'g1', filter: f }).map(e => e.text);
  assert.deepEqual(texts('errors'), ['a failure']);
  assert.deepEqual(texts('actions'), ['a failure', 'an action']); // detail hidden
  assert.equal(texts('all').length, 3);
});

// ── querying Cloudflare ────────────────────────────────────────────────────

test('queryWorkerLogs asks for this service over the requested window', async (t) => {
  let sent = null;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ success: true, result: { events: { events: [] } } }), { status: 200 });
  });

  const out = await queryWorkerLogs(ENV, { fromMs: NOW - 3600000, toMs: NOW });
  assert.deepEqual(out, { ok: true, events: [], capped: false });
  assert.match(sent.url, /accounts\/acct-1\/workers\/observability\/telemetry\/query$/);
  assert.deepEqual(sent.body.timeframe, { from: NOW - 3600000, to: NOW });
  assert.equal(sent.body.parameters.filters[0].value, 'hcpss-worker');
});

test('queryWorkerLogs names the missing token permission instead of just failing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ success: false, errors: [{ message: 'Unauthorized' }] }), { status: 403 }));
  const out = await queryWorkerLogs(ENV, { fromMs: NOW - 1000, toMs: NOW });
  assert.equal(out.ok, false);
  assert.match(out.hint, /Workers Observability/);
});

test('queryWorkerLogs never throws — a dead API or missing creds is a reason', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
  const thrown = await queryWorkerLogs(ENV, { fromMs: NOW - 1000, toMs: NOW });
  assert.equal(thrown.ok, false);
  assert.match(thrown.reason, /network down/);

  const unset = await queryWorkerLogs({}, { fromMs: NOW - 1000, toMs: NOW });
  assert.equal(unset.ok, false);
  assert.match(unset.reason, /CF_API_TOKEN/);
});

// ── rendering ──────────────────────────────────────────────────────────────

test('formatLogText escapes HTML before re-applying Discord markdown', () => {
  const out = formatLogText('<script>x</script> **bold** `code` [Jump](https://discord.com/a?b=1&c=2)');
  assert.match(out, /&lt;script&gt;/);
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<code>code<\/code>/);
  assert.match(out, /<a href="https:\/\/discord\.com\/a\?b=1&amp;c=2"[^>]*>Jump<\/a>/);
  // A javascript: target isn't a link — the pattern only accepts http(s).
  assert.doesNotMatch(formatLogText('[x](javascript:alert(1))'), /<a /);
});

test('renderLogsPage lists entries and keeps the token on its own nav links', () => {
  const html = renderLogsPage({
    entries: selectLogEntries([actEvent('2026-07-29T14:00:00.000Z', 'info', 'g1', 'Posted **now**')], { guildId: 'g1', filter: 'actions' }),
    hours: 6,
    filter: 'actions',
    all: false,
    guildId: 'g1',
    expiresAtMs: NOW + LOGS_LINK_TTL_MS,
    token: 'g1.g.123.deadbeef',
    now: NOW
  });
  assert.match(html, /<strong>now<\/strong>/);
  assert.match(html, /noindex/);
  assert.match(html, /href="\/logs\?t=g1\.g\.123\.deadbeef&amp;h=6&amp;f=errors"/);
  assert.match(html, /href="\/logs\?t=g1\.g\.123\.deadbeef&amp;h=24&amp;f=actions"/);
  assert.match(html, /expires in 30 minute/);
});

test('a window that hits the event ceiling says so instead of truncating quietly', async (t) => {
  const many = Array.from({ length: 200 }, (_, i) =>
    actEvent(new Date(NOW - i * 1000).toISOString(), 'info', 'g1', `line ${i}`));
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ success: true, result: { events: { events: many } } }), { status: 200 }));

  const token = await mintLogsToken(ENV, { guildId: 'g1', now: NOW });
  const html = await (await logsPageResponse(ENV, new URL(`https://w.dev/logs?t=${token}&h=48`), NOW)).text();
  assert.match(html, /most recent 200 log events/);
});

test('renderLogsPage explains an empty window and a failed query differently', () => {
  const base = { entries: [], hours: 2, filter: 'actions', all: false, guildId: 'g1', expiresAtMs: NOW, now: NOW };
  assert.match(renderLogsPage(base), /quiet is the normal state/);
  const broken = renderLogsPage({ ...base, error: 'Unauthorized', hint: 'Needs Workers Observability.' });
  assert.match(broken, /Could not read the log store/);
  assert.match(broken, /Needs Workers Observability/);
});

// ── the route ──────────────────────────────────────────────────────────────

test('GET /logs serves the page for a valid link and no-stores it', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    success: true,
    result: { events: { events: [actEvent('2026-07-29T14:00:00.000Z', 'info', 'g1', 'Status check posted')] } }
  }), { status: 200 }));

  const token = await mintLogsToken(ENV, { guildId: 'g1', now: NOW });
  const resp = await logsPageResponse(ENV, new URL(`https://w.dev/logs?t=${token}`), NOW);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('Cache-Control'), 'no-store');
  assert.match(resp.headers.get('X-Robots-Tag'), /noindex/);
  assert.match(await resp.text(), /Status check posted/);
});

test('GET /logs refuses a bad link and distinguishes an expired one', async (t) => {
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetched++; return new Response('{}', { status: 200 }); });

  const bad = await logsPageResponse(ENV, new URL('https://w.dev/logs?t=nope'), NOW);
  assert.equal(bad.status, 403);
  const token = await mintLogsToken(ENV, { guildId: 'g1', now: NOW });
  const expired = await logsPageResponse(ENV, new URL(`https://w.dev/logs?t=${token}`), NOW + LOGS_LINK_TTL_MS + 1);
  assert.equal(expired.status, 410);
  assert.match(await expired.text(), /expired/);
  // A rejected request must not spend a Cloudflare API call.
  assert.equal(fetched, 0);
});

test('GET /logs clamps a silly window and falls back to the default filter', async (t) => {
  let body = null;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ success: true, result: { events: { events: [] } } }), { status: 200 });
  });

  const token = await mintLogsToken(ENV, { guildId: 'g1', now: NOW });
  const resp = await logsPageResponse(ENV, new URL(`https://w.dev/logs?t=${token}&h=9999&f=bogus`), NOW);
  assert.equal(resp.status, 200);
  assert.equal(body.timeframe.from, NOW - 48 * 3600 * 1000); // capped at 48h
  assert.match(await resp.text(), /class="chip on"[^>]*>Actions</);
});
