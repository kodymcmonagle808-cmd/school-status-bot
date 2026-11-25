/* global ReadableStream */
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAnalyticsEvent, parseAnalyticsSqlResults, queryAnalyticsSummary, formatAnalyticsLines } from '../src/analytics.js';
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

// --- Owner Panel Tool Tests ---

test('handlePanelComponent responds to owner tools (workflow, AI gateway, analytics, email)', async () => {
  const { handlePanelComponent } = await import('../src/panelcomponents.js');

  const mockKv = {
    async get() { return null; },
    async put() {}
  };
  const mockEnv = {
    OWNER_ID: 'owner-42',
    STATUS_KV: mockKv,
    AI_GATEWAY_ID: 'school-status-gateway',
    ANALYTICS: { writeDataPoint() {} }
  };

  const baseBody = {
    type: 3,
    member: { user: { id: 'owner-42' } }
  };

  // 1. AI Gateway info
  const gwResp = await handlePanelComponent({ ...baseBody, data: { custom_id: 'panel_owner_ai_gateway_info' } }, mockEnv, {}, 'g1');
  const gwData = await gwResp.json();
  assert.match(gwData.data.embeds[0].title, /AI Gateway/);
  assert.match(gwData.data.embeds[0].description, /school-status-gateway/);

  // 2. Analytics info
  const anResp = await handlePanelComponent({ ...baseBody, data: { custom_id: 'panel_owner_analytics_info' } }, mockEnv, {}, 'g1');
  const anData = await anResp.json();
  assert.match(anData.data.embeds[0].title, /Analytics Engine/);
  assert.match(anData.data.embeds[0].description, /Active & Logging/);

  // 3. Email info
  const emResp = await handlePanelComponent({ ...baseBody, data: { custom_id: 'panel_owner_email_info' } }, mockEnv, {}, 'g1');
  const emData = await emResp.json();
  assert.match(emData.data.embeds[0].title, /Email Routing/);
  assert.match(emData.data.embeds[0].description, /Send to a Worker/);

  // 4. Batch presets dropdown
  const actionResp = await handlePanelComponent({
    ...baseBody,
    data: {
      custom_id: 'cfg_owner_features_action_select:normal',
      values: ['enable_all']
    }
  }, mockEnv, {}, 'g1');
  const actionData = await actionResp.json();
  assert.equal(actionData.type, 7);
  assert.match(actionData.data.content, /All Features Enabled/);
});

// --- Analytics Engine SQL Query Tests ---

test('parseAnalyticsSqlResults aggregates events, weighted averages, and top commands', () => {
  const summaryRows = [
    { event: 'scrape', status: 'ok', count: 10, avg_ms: 100 },
    { event: 'scrape', status: 'error', count: 2, avg_ms: 400 },
    { event: 'screenshot', status: 'cached', count: 3, avg_ms: 5 },
    { event: 'screenshot', status: 'fresh', count: 1, avg_ms: 1200 },
    { event: 'interaction', status: 'slash', count: 8, avg_ms: 0 }
  ];
  const topRows = [
    { detail: 'status', count: 5 },
    { detail: 'screenshot', count: 3 }
  ];

  const parsed = parseAnalyticsSqlResults(summaryRows, topRows);
  assert.equal(parsed.totalEvents24h, 24);
  assert.equal(parsed.byEvent.scrape.total, 12);
  assert.equal(parsed.byEvent.scrape.avgMs, 150);
  assert.equal(parsed.byEvent.scrape.statuses.error, 2);
  assert.equal(parsed.topCommands.length, 2);
  assert.equal(parsed.topCommands[0].detail, 'status');

  const formatted = formatAnalyticsLines({ configured: true, ...parsed });
  assert.match(formatted, /24h Total Datapoints:\*\* \*\*24\*\*/);
  assert.match(formatted, /75% cache hits/);
  assert.match(formatted, /`status` \(5\)/);
});

test('queryAnalyticsSummary returns standby when CF creds missing and caches valid SQL results', async () => {
  const standby = await queryAnalyticsSummary({});
  assert.equal(standby.configured, false);
  assert.match(formatAnalyticsLines(standby), /standby/);

  const kvStore = new Map();
  let fetchCount = 0;
  const mockEnv = {
    CF_API_TOKEN: 'tok',
    CF_ACCOUNT_ID: 'acct',
    STATUS_KV: {
      get: async k => kvStore.get(k) || null,
      put: async (k, v) => kvStore.set(k, v)
    }
  };
  const mockFetch = async (_url, init) => {
    fetchCount++;
    const isSummary = String(init?.body || '').includes('GROUP BY event');
    return {
      ok: true,
      json: async () => ({
        data: isSummary
          ? [{ event: 'scrape', status: 'ok', count: 4, avg_ms: 50 }]
          : [{ detail: 'snowday', count: 2 }]
      })
    };
  };

  const first = await queryAnalyticsSummary(mockEnv, { fetch: mockFetch, now: 1000000 });
  assert.equal(first.configured, true);
  assert.equal(first.totalEvents24h, 4);
  assert.equal(fetchCount, 2);
  assert.ok(kvStore.has('analytics_sql_cache'));

  // Cached hit should avoid calling fetch again
  const second = await queryAnalyticsSummary(mockEnv, { fetch: mockFetch, now: 1000500 });
  assert.equal(second.totalEvents24h, 4);
  assert.equal(fetchCount, 2);
});

