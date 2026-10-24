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
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://discord.com/api/v10/channels/') && (opts.method || 'GET') === 'POST') {
      posts.push({ url: u, body: JSON.parse(opts.body || '{}') });
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  });
  return posts;
}

function modalBody(summary, link) {
  const components = [
    { type: 1, components: [{ custom_id: 'input_request_summary', value: summary }] },
    { type: 1, components: [{ custom_id: 'input_request_link', value: link }] }
  ];
  return { data: { custom_id: 'modal_requestannouncement', components } };
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

test('requestannouncement posts to configured channel and confirms', async (t) => {
  const posts = mockDiscord(t);
  const kv = makeKv();
  kv.store.set('config:g1', JSON.stringify({ announcement_request_channel_id: 'chan-req' }));
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token' };
  const res = await handleModalSubmit(modalBody('Test summary', 'https://example.com/story'), env, null, 'g1');
  const data = await res.json();
  assert.equal(data.data.flags, 64);
  assert.match(data.data.content, /submitted/);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.includes('/channels/chan-req/messages'));
  const embed = posts[0].body.embeds[0];
  assert.match(embed.title, /Announcement Request/);
  assert.match(embed.description, /Test summary/);
  assert.ok(embed.description.includes('https://example.com/story'));
});

test('requestannouncement omits link line when link is blank', async (t) => {
  const posts = mockDiscord(t);
  const kv = makeKv();
  kv.store.set('config:g1', JSON.stringify({ announcement_request_channel_id: 'chan-req' }));
  const env = { STATUS_KV: kv, DISCORD_BOT_TOKEN: 'token' };
  await handleModalSubmit(modalBody('Summary only', ''), env, null, 'g1');
  const embed = posts[0].body.embeds[0];
  assert.equal(embed.description, 'Summary only');
});
