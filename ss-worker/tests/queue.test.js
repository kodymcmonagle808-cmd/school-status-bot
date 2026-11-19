import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueAlert,
  enqueueAlertBatch,
  dispatchQueuedAlert,
  processAlertQueueBatch
} from '../src/queue.js';

test('enqueueAlert: sends to ALERT_QUEUE when bound', async () => {
  const sent = [];
  const env = {
    ALERT_QUEUE: {
      async send(msg) {
        sent.push(msg);
      }
    }
  };

  const res = await enqueueAlert(env, { channelId: '123', payload: { content: 'test' } });
  assert.equal(res.queued, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, '123');
  assert.ok(sent[0].enqueuedAt > 0);
});

test('enqueueAlert: returns queued: false when ALERT_QUEUE is missing or throws', async () => {
  const envNoQueue = {};
  const res1 = await enqueueAlert(envNoQueue, { channelId: '123' });
  assert.equal(res1.queued, false);

  const envThrowing = {
    ALERT_QUEUE: {
      async send() { throw new Error('Queue full'); }
    }
  };
  const res2 = await enqueueAlert(envThrowing, { channelId: '123' });
  assert.equal(res2.queued, false);
});

test('enqueueAlertBatch: sends batch to ALERT_QUEUE', async () => {
  const sentBatches = [];
  const env = {
    ALERT_QUEUE: {
      async sendBatch(msgs) {
        sentBatches.push(msgs);
      }
    }
  };

  const alerts = [
    { channelId: '101', payload: { content: 'alert 1' } },
    { channelId: '102', payload: { content: 'alert 2' } }
  ];
  const res = await enqueueAlertBatch(env, alerts);
  assert.equal(res.queued, true);
  assert.equal(res.count, 2);
  assert.equal(sentBatches.length, 1);
  assert.equal(sentBatches[0].length, 2);
  assert.equal(sentBatches[0][0].body.channelId, '101');
});

test('dispatchQueuedAlert: posts message to channel and updates KV', async (t) => {
  const kvStore = new Map();
  const env = {
    DISCORD_BOT_TOKEN: 'fake-token',
    STATUS_KV: {
      async put(k, v) { kvStore.set(k, v); }
    }
  };

  const fetchCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    fetchCalls.push({ url, init });
    return new Response(JSON.stringify({ id: 'msg-999' }), { status: 200 });
  });

  const message = {
    channelId: 'chan-555',
    payload: { content: 'School Closed' },
    guildId: 'guild-777',
    previousMessageId: 'old-111',
    deletePrevious: true
  };

  const res = await dispatchQueuedAlert(env, message);
  assert.equal(res.id, 'msg-999');

  // Verify DELETE old message was sent
  const deleteCall = fetchCalls.find(c => c.init?.method === 'DELETE');
  assert.ok(deleteCall, 'Expected previous message delete call');
  assert.match(deleteCall.url, /chan-555\/messages\/old-111/);

  // Verify POST new message was sent
  const postCall = fetchCalls.find(c => c.init?.method === 'POST');
  assert.ok(postCall, 'Expected post message call');
  assert.match(postCall.url, /chan-555\/messages/);

  // Verify KV was updated with new message id
  assert.equal(kvStore.get('last_message_id:guild-777'), 'msg-999');
  assert.equal(kvStore.get('last_channel_id:guild-777'), 'chan-555');
});

test('processAlertQueueBatch: acks on success and retries on failure', async (t) => {
  const env = { DISCORD_BOT_TOKEN: 'token' };

  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(JSON.stringify({ id: '1' }), { status: 200 });
    }
    throw new Error('Network error');
  });

  let acked = false;
  let retried = false;

  const batch = {
    messages: [
      {
        body: { channelId: 'c1', payload: { content: 'ok' } },
        ack() { acked = true; },
        retry() {}
      },
      {
        body: { channelId: 'c2', payload: { content: 'fail' } },
        ack() {},
        retry() { retried = true; }
      }
    ]
  };

  await processAlertQueueBatch(batch, env, {});
  assert.ok(acked, 'First message should be acked');
  assert.ok(retried, 'Second message should be retried');
});
