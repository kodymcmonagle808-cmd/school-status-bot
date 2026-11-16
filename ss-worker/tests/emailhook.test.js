import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { buildEmailEmbed, handleEmailHook } from '../src/emailhook.js';
import { runEmailChannelCommand } from '../src/commands.js';

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); }
  };
}

function makeEnv(guilds) {
  const kv = makeKv();
  kv.store.set('guild_index', JSON.stringify(Object.keys(guilds)));
  for (const [gid, cfg] of Object.entries(guilds)) {
    kv.store.set(`config:${gid}`, JSON.stringify(cfg));
  }
  return { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: '' };
}

function mockDiscord(t) {
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://discord.com/') && (opts.method || 'GET') === 'POST') {
      posts.push({ url: u, body: JSON.parse(opts.body || '{}') });
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  });
  return posts;
}

const email = {
  id: 'msg-1',
  subject: 'Important Update for HCPSS Families',
  body: 'Due to the water main break, Centennial HS dismisses at noon.',
  receivedAt: 1752940800000
};

test('buildEmailEmbed clamps and shapes the notice', () => {
  const embed = buildEmailEmbed({ subject: 'S'.repeat(400), body: 'B'.repeat(4000), receivedAt: 1752940800000 }, 'My Footer');
  assert.ok(embed.title.startsWith('📧 S'));
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description.length <= 2500);
  assert.equal(embed.footer.text, 'My Footer · via HCPSS email');
  assert.equal(embed.timestamp, new Date(1752940800000).toISOString());
});

test('handleEmailHook rejects malformed payloads', async () => {
  const env = makeEnv({});
  assert.equal((await handleEmailHook(env, {})).ok, false);
  assert.equal((await handleEmailHook(env, { subject: 'x', body: 'y' })).ok, false); // no id
  assert.equal((await handleEmailHook(env, null)).ok, false);
});

test('handleEmailHook posts to eligible guilds and skips opted-out and district guilds', async (t) => {
  const posts = mockDiscord(t);
  const env = makeEnv({
    g1: { alert_channel_id: 'chan-g1' },
    g2: { alert_channel_id: 'chan-g2', toggle_email_alerts: false },
    g3: { alert_channel_id: 'chan-g3', primary_district: 'fcps' },
    g4: {} // no alert channel
  });

  const result = await handleEmailHook(env, email);
  assert.equal(result.ok, true);
  assert.equal(result.sent, 1);
  // Count only alert-channel posts — postLog may also write to a log channel.
  const alertPosts = posts.filter(p => /channels\/chan-/.test(p.url));
  assert.equal(alertPosts.length, 1);
  assert.match(alertPosts[0].url, /channels\/chan-g1\/messages$/);
  assert.match(alertPosts[0].body.embeds[0].title, /Important Update/);
  assert.deepEqual(alertPosts[0].body.allowed_mentions, { parse: [] });
});

test('handleEmailHook dedupes by Gmail message id', async (t) => {
  const posts = mockDiscord(t);
  const env = makeEnv({ g1: { alert_channel_id: 'chan-g1' } });

  const first = await handleEmailHook(env, email);
  assert.equal(first.sent, 1);
  const second = await handleEmailHook(env, email);
  assert.equal(second.ok, true);
  assert.equal(second.sent, 0);
  assert.equal(second.deduped, true);
  assert.equal(posts.filter(p => /channels\/chan-/.test(p.url)).length, 1);
});

test('POST /email-hook requires secret and routes valid payload', async (t) => {
  mockDiscord(t);
  const env = makeEnv({ g1: { alert_channel_id: 'chan-g1' } });
  env.NWS_HOOK_SECRET = 'email-secret';
  const ctx = { waitUntil() {} };

  const unauthReq = new Request('https://worker.example/email-hook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(email)
  });
  assert.equal((await worker.fetch(unauthReq, env, ctx)).status, 403);

  const authReq = new Request('https://worker.example/email-hook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer email-secret'
    },
    body: JSON.stringify(email)
  });
  const res = await worker.fetch(authReq, env, ctx);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.sent, 1);
});

test('handleEmailHook uses email_channel_id when configured', async (t) => {
  const posts = mockDiscord(t);
  const env = makeEnv({
    g1: { alert_channel_id: 'chan-alerts', email_channel_id: 'chan-emails' }
  });

  const result = await handleEmailHook(env, { ...email, id: 'msg-override' });
  assert.equal(result.ok, true);
  assert.equal(result.sent, 1);
  const alertPosts = posts.filter(p => /channels\/chan-/.test(p.url));
  assert.equal(alertPosts.length, 1);
  assert.match(alertPosts[0].url, /channels\/chan-emails\/messages$/);
});

test('runEmailChannelCommand manages email_channel_id', async () => {
  const env = makeEnv({ g1: { alert_channel_id: 'chan-alerts' } });
  const adminMember = { permissions: '8' };

  // view initial
  const view1 = await runEmailChannelCommand({
    guild_id: 'g1',
    member: adminMember,
    data: { options: [{ name: 'view', type: 1 }] }
  }, env);
  assert.match(view1.content, /chan-alerts/);

  // set
  const setRes = await runEmailChannelCommand({
    guild_id: 'g1',
    member: adminMember,
    data: {
      options: [{
        name: 'set',
        type: 1,
        options: [{ name: 'channel', value: 'chan-custom-emails' }]
      }]
    }
  }, env);
  assert.match(setRes.content, /chan-custom-emails/);

  // view after set
  const view2 = await runEmailChannelCommand({
    guild_id: 'g1',
    member: adminMember,
    data: { options: [{ name: 'view', type: 1 }] }
  }, env);
  assert.match(view2.content, /chan-custom-emails/);

  // clear
  const clearRes = await runEmailChannelCommand({
    guild_id: 'g1',
    member: adminMember,
    data: { options: [{ name: 'clear', type: 1 }] }
  }, env);
  assert.match(clearRes.content, /cleared/);
});
