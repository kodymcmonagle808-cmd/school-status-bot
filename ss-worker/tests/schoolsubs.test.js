import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSchoolSubscriptions,
  setSchoolSubscription,
  clearSchoolSubscription,
  noticeMatchesSchool,
  notifySchoolSubscribers
} from '../src/schoolsubs.js';

function makeKv(store = new Map()) {
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); }
  };
}

test('set, read, and clear a school subscription', async () => {
  const env = { STATUS_KV: makeKv() };
  const result = await setSchoolSubscription(env, 'guild1', 'user1', 'Centennial High');
  assert.equal(result.ok, true);
  assert.deepEqual(await getSchoolSubscriptions(env, 'guild1'), { user1: 'Centennial High' });

  const removed = await clearSchoolSubscription(env, 'guild1', 'user1');
  assert.equal(removed, 'Centennial High');
  assert.deepEqual(await getSchoolSubscriptions(env, 'guild1'), {});
  assert.equal(await clearSchoolSubscription(env, 'guild1', 'user1'), null);
});

test('noticeMatchesSchool matches meaningful words and ignores generic ones', () => {
  const notice = 'Centennial High School will be closed Tuesday due to a water main break.';
  assert.equal(noticeMatchesSchool(notice, 'Centennial High'), true);
  assert.equal(noticeMatchesSchool(notice, 'Centennial High School'), true);
  assert.equal(noticeMatchesSchool(notice, 'centennial'), true);
  assert.equal(noticeMatchesSchool(notice, 'Wilde Lake High'), false);
  // Names made only of generic words can never match everything.
  assert.equal(noticeMatchesSchool(notice, 'School'), false);
  assert.equal(noticeMatchesSchool('', 'Centennial High'), false);
});

test('noticeMatchesSchool requires whole-word matches', () => {
  assert.equal(noticeMatchesSchool('Centennial Lane Elementary is closed.', 'Centennial Lane'), true);
  assert.equal(noticeMatchesSchool('The centennial celebration continues.', 'Centennial Lane'), false);
});

test('notifySchoolSubscribers DMs matching users once across guilds', async (t) => {
  const env = { STATUS_KV: makeKv(), DISCORD_BOT_TOKEN: 'token' };
  await setSchoolSubscription(env, 'guild1', 'user-match', 'Centennial High');
  await setSchoolSubscription(env, 'guild2', 'user-match', 'Centennial High');
  await setSchoolSubscription(env, 'guild1', 'user-other', 'Wilde Lake High');

  const dmRecipients = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).endsWith('/users/@me/channels')) {
      dmRecipients.push(JSON.parse(opts.body).recipient_id);
      return new Response(JSON.stringify({ id: 'dm-channel' }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'message' }), { status: 200 });
  });

  const sent = await notifySchoolSubscribers(
    env,
    ['guild1', 'guild2'],
    { title: 'Notice' },
    'Centennial High School closed for repairs.'
  );
  assert.equal(sent, 1);
  assert.deepEqual(dmRecipients, ['user-match']);
});

test('notifySchoolSubscribers is a no-op without a token or text', async () => {
  const env = { STATUS_KV: makeKv() };
  assert.equal(await notifySchoolSubscribers(env, ['guild1'], { title: 'x' }, 'text'), 0);
  const env2 = { STATUS_KV: makeKv(), DISCORD_BOT_TOKEN: 'token' };
  assert.equal(await notifySchoolSubscribers(env2, ['guild1'], { title: 'x' }, ''), 0);
});
