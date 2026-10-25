import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dmOwner } from '../src/discord.js';

function mockDiscord(t) {
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    if (u === 'https://discord.com/api/v10/users/@me/channels' && (opts.method || 'GET') === 'POST') {
      posts.push({ url: u, body: JSON.parse(opts.body || '{}') });
      return new Response(JSON.stringify({ id: 'dm-chan-1' }), { status: 200 });
    }
    if (u.startsWith('https://discord.com/api/v10/channels/dm-chan-1/messages') && (opts.method || 'GET') === 'POST') {
      posts.push({ url: u, body: JSON.parse(opts.body || '{}') });
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  });
  return posts;
}

test('dmOwner opens a DM and sends the message', async (t) => {
  const posts = mockDiscord(t);
  const env = { OWNER_ID: 'owner-123', DISCORD_BOT_TOKEN: 'token' };
  const ok = await dmOwner(env, '🚨 Watcher code error');
  assert.equal(ok, true);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.recipient_id, 'owner-123');
  assert.equal(posts[1].body.content, '🚨 Watcher code error');
});

test('dmOwner returns false without OWNER_ID', async () => {
  const env = { DISCORD_BOT_TOKEN: 'token' };
  const ok = await dmOwner(env, 'error');
  assert.equal(ok, false);
});

test('dmOwner returns false without token', async () => {
  const env = { OWNER_ID: 'owner-123' };
  const ok = await dmOwner(env, 'error');
  assert.equal(ok, false);
});

test('dmOwner truncates long messages to 2000 chars', async (t) => {
  const posts = mockDiscord(t);
  const env = { OWNER_ID: 'owner-123', DISCORD_BOT_TOKEN: 'token' };
  const long = 'x'.repeat(5000);
  await dmOwner(env, long);
  assert.equal(posts[1].body.content.length, 2000);
});

test('dmOwner handles Discord API failure gracefully', async (t) => {
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    if (u === 'https://discord.com/api/v10/users/@me/channels' && (opts.method || 'GET') === 'POST') {
      posts.push({ url: u });
      return new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 });
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  });
  const env = { OWNER_ID: 'owner-123', DISCORD_BOT_TOKEN: 'token' };
  const ok = await dmOwner(env, 'error');
  assert.equal(ok, false);
  assert.equal(posts.length, 1);
});
