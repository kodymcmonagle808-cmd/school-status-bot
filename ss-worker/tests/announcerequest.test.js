import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleModalSubmit } from '../src/modals.js';

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); }
  };
}

function mockDiscord(t) {
  const posts = [];
  const dmPosts = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    if (u === 'https://discord.com/api/v10/users/@me/channels' && method === 'POST') {
      posts.push({ url: u, body: JSON.parse(opts.body || '{}') });
      return new Response(JSON.stringify({ id: 'dm-chan-1' }), { status: 200 });
    }
    if (u.startsWith('https://discord.com/api/v10/channels/dm-chan-1/messages') && method === 'POST') {
      dmPosts.push({ url: u, body: JSON.parse(opts.body || '{}') });
      return new Response(JSON.stringify({ id: 'm2' }), { status: 200 });
    }
    if (u.startsWith('https://discord.com/api/v10/channels/') && method === 'POST') {
      posts.push({ url: u, body: JSON.parse(opts.body || '{}') });
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    }
    if (u.startsWith('https://discord.com/api/v10/channels/') && method === 'PATCH') {
      posts.push({ url: u, method: 'PATCH', body: JSON.parse(opts.body || '{}') });
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${u} ${method}`);
  });
  return { posts, dmPosts };
}

function modalBody(summary, link) {
  const components = [
    { type: 1, components: [{ custom_id: 'input_request_summary', value: summary }] },
    { type: 1, components: [{ custom_id: 'input_request_link', value: link }] }
  ];
  return { data: { custom_id: 'modal_requestannouncement', components }, member: { user: { id: 'user-123' } } };
}

test('requestannouncement requires a summary', async () => {
  const kv = makeKv();
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token' };
  const res = await handleModalSubmit(modalBody('', ''), env, null, 'g1');
  const data = await res.json();
  assert.equal(data.data.flags, 64);
  assert.match(data.data.content, /required/);
});

test('requestannouncement errors when no request channel is configured', async () => {
  const kv = makeKv();
  kv.store.set('config:g1', JSON.stringify({}));
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token' };
  const res = await handleModalSubmit(modalBody('Something happened', ''), env, null, 'g1');
  const data = await res.json();
  assert.equal(data.data.flags, 64);
  assert.match(data.data.content, /not set up/);
});

test('requestannouncement posts to configured channel with approve/deny buttons', async (t) => {
  const { posts } = mockDiscord(t);
  const kv = makeKv();
  kv.store.set('config:g1', JSON.stringify({ announcement_request_channel_id: 'chan-req' }));
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token' };
  const res = await handleModalSubmit(modalBody('Test summary', 'https://example.com/story'), env, null, 'g1');
  const data = await res.json();
  assert.equal(data.data.flags, 64);
  assert.match(data.data.content, /submitted/);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.includes('/channels/chan-req/messages'));
  assert.ok(posts[0].body.components, 'no components');
  assert.equal(posts[0].body.components[0].components[0].custom_id, 'annreq_approve_user-123');
  assert.equal(posts[0].body.components[0].components[1].custom_id, 'annreq_deny_user-123');
  const embed = posts[0].body.embeds[0];
  assert.match(embed.title, /Announcement Request/);
  assert.match(embed.description, /Test summary/);
  assert.ok(embed.description.includes('https://example.com/story'));
});

test('requestannouncement omits link line when link is blank', async (t) => {
  const { posts } = mockDiscord(t);
  const kv = makeKv();
  kv.store.set('config:g1', JSON.stringify({ announcement_request_channel_id: 'chan-req' }));
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token' };
  await handleModalSubmit(modalBody('Summary only', ''), env, null, 'g1');
  const embed = posts[0].body.embeds[0];
  assert.equal(embed.description, 'Summary only');
});

test('requestannouncement deny modal DMs user with reason', async (t) => {
  const { dmPosts } = mockDiscord(t);
  const kv = makeKv();
  kv.store.set('config:g1', JSON.stringify({ announcement_request_channel_id: 'chan-req' }));
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token' };

  const denyBody = {
    data: {
      custom_id: 'modal_annreq_deny_user-123',
      components: [
        { type: 1, components: [{ custom_id: 'input_deny_reason', value: 'Not enough detail' }] }
      ]
    },
    message: {
      id: 'm1',
      channel_id: 'chan-req',
      embeds: [{ title: '📝 Announcement Request', description: 'Test summary' }]
    },
    member: { user: { id: 'staff-456' } }
  };
  const ctx = { waitUntil: async (fn) => await fn() };
  const res = await handleModalSubmit(denyBody, env, ctx, 'g1');
  const data = await res.json();
  assert.match(data.data.content, /denied/);
  // Flush microtasks to let the waitUntil callback (and dmUser) complete
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(dmPosts.length, 1);
  assert.ok(dmPosts[0].body.content.includes('not approved'));
  assert.ok(dmPosts[0].body.content.includes('Not enough detail'));
});
