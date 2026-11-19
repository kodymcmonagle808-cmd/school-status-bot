/* global FormData */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureStatusPageScreenshot,
  buildScreenshotEmbed,
  handleScreenshotInteraction,
  resetScreenshotCache,
  SCREENSHOT_CACHE_KEY
} from '../src/screenshot.js';
import { buildCheckAgainComponents } from '../src/embeds.js';
import { handleInteraction } from '../src/interactions.js';

test('buildCheckAgainComponents includes the Official Screenshot button in Row 0', () => {
  const rows = buildCheckAgainComponents();
  assert.equal(rows.length, 2);
  const buttons = rows[0].components;
  assert.equal(buttons.length, 3);

  const screenshotBtn = buttons.find(b => b.custom_id === 'btn_status_screenshot');
  assert.ok(screenshotBtn, 'Screenshot button should exist in Row 0');
  assert.equal(screenshotBtn.type, 2);
  assert.equal(screenshotBtn.style, 2);
  assert.equal(screenshotBtn.label, 'Official Screenshot');
  assert.deepEqual(screenshotBtn.emoji, { name: '📸' });
});

test('buildScreenshotEmbed formats embed with attachment image and ephemeral footer', () => {
  const embed = buildScreenshotEmbed({
    timestamp: 1700000000000,
    cached: false
  }, 'https://status.hcpss.org');

  assert.equal(embed.title, '📸 HCPSS Official Status Page Screenshot');
  assert.equal(embed.url, 'https://status.hcpss.org');
  assert.match(embed.description, /status\.hcpss\.org/);
  assert.equal(embed.image.url, 'attachment://status-screenshot.png');
  assert.match(embed.footer.text, /Only you can see this/);
});

test('captureStatusPageScreenshot throws if env.BROWSER is missing and no browser provided', async () => {
  resetScreenshotCache();
  await assert.rejects(
    async () => {
      await captureStatusPageScreenshot({});
    },
    /env\.BROWSER/
  );
});

test('captureStatusPageScreenshot returns mockBuffer and caches it in memory', async () => {
  resetScreenshotCache();
  const mockBytes = new Uint8Array([1, 2, 3, 4]);
  const res1 = await captureStatusPageScreenshot({}, { mockBuffer: mockBytes });
  assert.equal(res1.cached, false);
  assert.deepEqual(res1.buffer, mockBytes);

  // Second call without mockBuffer should return from memory cache
  const res2 = await captureStatusPageScreenshot({});
  assert.equal(res2.cached, true);
  assert.deepEqual(res2.buffer, mockBytes);
});

test('captureStatusPageScreenshot reads from R2 cache when present', async () => {
  resetScreenshotCache();
  const r2Bytes = new Uint8Array([9, 8, 7]);
  const mockBucket = {
    async get(key) {
      if (key === SCREENSHOT_CACHE_KEY) {
        return {
          customMetadata: { capturedAt: String(Date.now() - 1000) },
          async arrayBuffer() {
            return r2Bytes.buffer;
          }
        };
      }
      return null;
    }
  };

  const res = await captureStatusPageScreenshot({ BACKUPS_BUCKET: mockBucket });
  assert.equal(res.cached, true);
  assert.deepEqual(res.buffer, r2Bytes);
});

test('captureStatusPageScreenshot launches mock browser when provided', async () => {
  resetScreenshotCache();
  let viewportSet = false;
  let navigatedUrl = '';
  let screenshotTaken = false;
  let browserClosed = false;

  const mockBrowser = {
    async newPage() {
      return {
        async setViewport(vp) {
          viewportSet = vp.width === 1280;
        },
        async goto(url) {
          navigatedUrl = url;
        },
        async screenshot() {
          screenshotTaken = true;
          return new Uint8Array([137, 80, 78, 71]);
        }
      };
    },
    async close() {
      browserClosed = true;
    }
  };

  const res = await captureStatusPageScreenshot({}, {
    browser: mockBrowser,
    force: true
  });

  assert.equal(res.cached, false);
  assert.equal(viewportSet, true);
  assert.equal(navigatedUrl, 'https://status.hcpss.org');
  assert.equal(screenshotTaken, true);
  // Options.browser is not closed automatically if caller passed their own browser
  assert.equal(browserClosed, false);
});

test('handleScreenshotInteraction sends multipart FormData on success', async () => {
  resetScreenshotCache();
  const mockBytes = new Uint8Array([137, 80, 78, 71, 0, 1, 2]);
  let sentUrl = '';
  let sentBody = null;

  const mockFetch = async (url, init) => {
    sentUrl = url;
    sentBody = init.body;
    return { ok: true, status: 200 };
  };

  const body = { token: 'tok_test_123' };
  const env = { DISCORD_APPLICATION_ID: 'app_test_456' };

  await handleScreenshotInteraction(body, env, {
    mockBuffer: mockBytes,
    fetch: mockFetch
  });

  assert.match(sentUrl, /webhooks\/app_test_456\/tok_test_123\/messages\/@original/);
  assert.ok(sentBody instanceof FormData, 'Should send multipart FormData');
  assert.ok(sentBody.has('payload_json'));
  assert.ok(sentBody.has('files[0]'));

  const parsed = JSON.parse(sentBody.get('payload_json'));
  assert.equal(parsed.embeds[0].title, '📸 HCPSS Official Status Page Screenshot');
  assert.equal(parsed.embeds[0].image.url, 'attachment://status-screenshot.png');
  assert.equal(parsed.components[0].components[0].url, 'https://status.hcpss.org');
});

test('handleScreenshotInteraction handles error by sending friendly fallback message', async () => {
  resetScreenshotCache();
  let updatedPayload = null;

  const mockEnv = {
    DISCORD_APPLICATION_ID: 'app_test_456',
    // No BROWSER binding, will throw
  };

  // Override discord fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.includes('/messages/@original')) {
      updatedPayload = JSON.parse(init.body);
      return { ok: true, status: 200 };
    }
    return originalFetch(url, init);
  };

  try {
    const body = { token: 'tok_test_err' };
    await handleScreenshotInteraction(body, mockEnv);

    assert.ok(updatedPayload);
    assert.match(updatedPayload.content, /Unable to capture live website screenshot/);
    assert.equal(updatedPayload.components[0].components[0].url, 'https://status.hcpss.org');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('handleInteraction defers ephemerally for btn_status_screenshot component click', async () => {
  let waitUntilRan = false;
  const ctx = {
    waitUntil(promise) {
      waitUntilRan = true;
      promise.catch(() => {});
    }
  };

  const body = {
    type: 3,
    data: { custom_id: 'btn_status_screenshot' },
    token: 'tok_click'
  };

  const env = {
    STATUS_KV: { get: async () => null, put: async () => {} },
    DISCORD_APPLICATION_ID: 'app1'
  };

  const resp = await handleInteraction(body, env, ctx);
  const data = await resp.json();

  // type 5 is DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  assert.equal(data.type, 5);
  // flags 64 is EPHEMERAL_FLAG (hidden so only the clicker sees it)
  assert.equal(data.data.flags, 64);
  assert.equal(waitUntilRan, true);
});

test('handleInteraction defers ephemerally for /screenshot slash command', async () => {
  let waitUntilRan = false;
  const ctx = {
    waitUntil(promise) {
      waitUntilRan = true;
      promise.catch(() => {});
    }
  };

  const body = {
    type: 2,
    data: { name: 'screenshot' },
    token: 'tok_slash'
  };

  const env = {
    STATUS_KV: { get: async () => null, put: async () => {} },
    DISCORD_APPLICATION_ID: 'app1'
  };

  const resp = await handleInteraction(body, env, ctx);
  const data = await resp.json();

  assert.equal(data.type, 5);
  assert.equal(data.data.flags, 64);
  assert.equal(waitUntilRan, true);
});
