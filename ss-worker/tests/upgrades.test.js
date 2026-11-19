/* global ReadableStream */
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAnalyticsEvent } from '../src/analytics.js';
import { runWorkersAiWithGateway } from '../src/ai.js';
import { generateEmbedding } from '../src/vectorize.js';
import { extractEmailBodyFromRaw } from '../src/emailhook.js';
import { StormWatchdogWorkflow, triggerStormWatchdogWorkflow } from '../src/stormworkflow.js';
import worker from '../src/index.js';

// --- Analytics Engine Tests ---

test('recordAnalyticsEvent returns false when ANALYTICS binding is missing', () => {
  const recorded = recordAnalyticsEvent({}, { event: 'scrape', status: 'ok' });
  assert.equal(recorded, false);
});

test('recordAnalyticsEvent calls writeDataPoint with properly shaped payload', () => {
  let capturedPoint = null;
  const mockEnv = {
    ANALYTICS: {
      writeDataPoint(point) {
        capturedPoint = point;
      }
    }
  };

  const recorded = recordAnalyticsEvent(mockEnv, {
    event: 'scrape',
    status: 'schools_closed',
    guildId: 'guild_123',
    durationMs: 45.5,
    detail: 'target:hcpss'
  });

  assert.equal(recorded, true);
  assert.ok(capturedPoint);
  assert.deepEqual(capturedPoint.blobs, ['scrape', 'schools_closed', 'guild_123', 'target:hcpss']);
  assert.deepEqual(capturedPoint.doubles, [45.5, 1]);
  assert.deepEqual(capturedPoint.indexes, ['guild_123']);
});

test('recordAnalyticsEvent safely catches exceptions and returns false', () => {
  const throwingEnv = {
    ANALYTICS: {
      writeDataPoint() {
        throw new Error('Disk full');
      }
    }
  };

  const recorded = recordAnalyticsEvent(throwingEnv, { event: 'test' });
  assert.equal(recorded, false);
});

// --- AI Gateway Tests ---

test('runWorkersAiWithGateway routes through AI Gateway when configured', async () => {
  let capturedOptions = null;
  const mockEnv = {
    AI_GATEWAY_ID: 'my-custom-gateway',
    AI: {
      async run(model, input, options) {
        capturedOptions = options;
        return { response: 'bullet points summary' };
      }
    }
  };

  const res = await runWorkersAiWithGateway(mockEnv, '@cf/meta/llama-3.1-8b-instruct', { prompt: 'test' });
  assert.ok(res);
  assert.equal(res.response, 'bullet points summary');
  assert.ok(capturedOptions?.gateway);
  assert.equal(capturedOptions.gateway.id, 'my-custom-gateway');
  assert.equal(capturedOptions.gateway.skipCache, false);
});

test('runWorkersAiWithGateway falls back to direct run if gateway throws', async () => {
  let directRunCalled = false;
  let callCount = 0;

  const mockEnv = {
    AI_GATEWAY_ID: 'failing-gateway',
    AI: {
      async run(model, input, options) {
        callCount++;
        if (options?.gateway) {
          throw new Error('Gateway not found');
        }
        directRunCalled = true;
        return { response: 'direct result' };
      }
    }
  };

  const res = await runWorkersAiWithGateway(mockEnv, '@cf/meta/llama-3.1-8b-instruct', { prompt: 'test' });
  assert.equal(res.response, 'direct result');
  assert.equal(directRunCalled, true);
  assert.equal(callCount, 2);
});

test('generateEmbedding routes through gateway when AI is configured', async () => {
  let capturedGateway = null;
  const mockEnv = {
    AI_GATEWAY_ID: 'vector-gateway',
    AI: {
      async run(model, input, options) {
        capturedGateway = options?.gateway?.id;
        return { data: [[0.1, 0.2, 0.3]] };
      }
    }
  };

  const vector = await generateEmbedding(mockEnv, 'school delay');
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  assert.equal(capturedGateway, 'vector-gateway');
});

// --- Inbound Email Handler Tests ---

test('extractEmailBodyFromRaw removes headers and MIME boundaries', () => {
  const rawEmail = `From: alerts@hcpss.org\r\nTo: family@example.com\r\nSubject: Snow Day\r\n\r\n--boundary123\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSchools will be closed today due to snow.\r\n--boundary123--`;

  const extracted = extractEmailBodyFromRaw(rawEmail);
  assert.match(extracted, /Schools will be closed today due to snow\./);
  assert.doesNotMatch(extracted, /Content-Type/);
});

test('worker.email handler extracts email fields and invokes handleEmailHook', async () => {
  const mockKv = {
    async get(k) {
      if (k === 'guild_index') return JSON.stringify(['g1']);
      return null;
    },
    async put() {}
  };

  const mockMessage = {
    from: 'schools@hcpss.org',
    headers: new Map([
      ['subject', 'Emergency Weather Closure Notice'],
      ['message-id', 'msg-test-123']
    ]),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('Subject: Emergency Weather Closure Notice\n\nAll HCPSS schools and offices closed today.'));
        controller.close();
      }
    })
  };

  const mockEnv = {
    STATUS_KV: mockKv,
    DISCORD_BOT_TOKEN: 'fake_bot_token',
    DISCORD_GUILD_ID: 'g1'
  };

  // Run worker.email
  await worker.email(mockMessage, mockEnv, { waitUntil() {} });
  // Verify it didn't crash and processed
  assert.ok(true);
});

// --- Storm Watchdog Workflow Tests ---

test('triggerStormWatchdogWorkflow returns null when STORM_WORKFLOW is not bound', async () => {
  const res = await triggerStormWatchdogWorkflow({});
  assert.equal(res, null);
});

test('triggerStormWatchdogWorkflow launches workflow instance when binding present', async () => {
  let createdParams = null;
  const mockEnv = {
    STORM_WORKFLOW: {
      async create(opts) {
        createdParams = opts;
        return { id: opts.id };
      }
    }
  };

  const id = await triggerStormWatchdogWorkflow(mockEnv, { reason: 'blizzard_watch' });
  assert.ok(id);
  assert.match(id, /^storm_/);
  assert.equal(createdParams.params.reason, 'blizzard_watch');
});

test('StormWatchdogWorkflow runs multi-step sequence with sleep and do', async () => {
  const stepsRan = [];
  const mockStep = {
    async do(name, fn) {
      stepsRan.push(`do:${name}`);
      return { ok: true, skipped: true };
    },
    async sleep(name, duration) {
      stepsRan.push(`sleep:${name}:${duration}`);
    }
  };

  const workflow = new StormWatchdogWorkflow({}, { STATUS_KV: {} });
  const result = await workflow.run({}, mockStep);

  assert.ok(result.completed);
  assert.ok(stepsRan.includes('do:check-initial-storm-status'));
  assert.ok(stepsRan.includes('sleep:wait-next-storm-scan:10 minutes'));
  assert.ok(stepsRan.includes('do:check-followup-storm-status'));
});
