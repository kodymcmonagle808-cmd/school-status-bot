/* global FormData, Blob */
// Cloudflare Browser Rendering screenshot capture for official school status pages.
// Uses @cloudflare/puppeteer with env.BROWSER to capture pixel-accurate screenshots
// of status.hcpss.org, caching the image in R2 and memory to respect the $0/month free tier.

import puppeteer from '@cloudflare/puppeteer';
import { updateInteractionOriginal } from './discord.js';
import { HCPSS_URL } from './scraper.js';
import { recordAnalyticsEvent } from './analytics.js';

export const SCREENSHOT_CACHE_KEY = 'cache/status_screenshot_latest.png';
export const SCREENSHOT_TTL_MS = 10 * 60 * 1000; // 10 minutes cache to preserve browser execution quota

let memoryCache = { buffer: null, timestamp: 0 };

/**
 * Resets the in-memory screenshot cache (useful for testing or cache eviction).
 */
export function resetScreenshotCache() {
  memoryCache = { buffer: null, timestamp: 0 };
}

/**
 * Captures a screenshot of the school status website using Cloudflare Browser Rendering.
 * Checks memory and R2 cache first; if fresh, returns cached buffer without starting a browser.
 *
 * @param {object} env Worker environment bindings (BROWSER, BACKUPS_BUCKET)
 * @param {object} options Optional overrides (url, force, ttlMs, mockBuffer, browser, puppeteer)
 * @returns {Promise<{ buffer: Uint8Array, timestamp: number, cached: boolean }>}
 */
export async function captureStatusPageScreenshot(env, options = {}) {
  const ttlMs = typeof options.ttlMs === 'number' ? options.ttlMs : SCREENSHOT_TTL_MS;

  // 1. Mock buffer for unit testing
  if (options.mockBuffer) {
    const now = Date.now();
    memoryCache = { buffer: options.mockBuffer, timestamp: now };
    return { buffer: options.mockBuffer, timestamp: now, cached: false };
  }

  // 2. Check in-memory isolate cache
  if (!options.force && memoryCache.buffer && (Date.now() - memoryCache.timestamp < ttlMs)) {
    return {
      buffer: memoryCache.buffer,
      timestamp: memoryCache.timestamp,
      cached: true
    };
  }

  // 3. Check R2 storage cache (BACKUPS_BUCKET)
  if (!options.force && env && env.BACKUPS_BUCKET) {
    try {
      const obj = await env.BACKUPS_BUCKET.get(SCREENSHOT_CACHE_KEY);
      if (obj) {
        const capturedAt = Number(obj.customMetadata && obj.customMetadata.capturedAt) ||
          (obj.uploaded ? new Date(obj.uploaded).getTime() : 0);
        if (capturedAt && (Date.now() - capturedAt < ttlMs)) {
          const ab = await obj.arrayBuffer();
          const buf = new Uint8Array(ab);
          memoryCache = { buffer: buf, timestamp: capturedAt };
          return {
            buffer: buf,
            timestamp: capturedAt,
            cached: true
          };
        }
      }
    } catch (err) {
      console.warn('Screenshot R2 cache read failed:', err);
    }
  }

  // 4. Validate browser binding
  const puppeteerModule = options.puppeteer || puppeteer;
  if (!options.browser && (!env || !env.BROWSER)) {
    throw new Error('Cloudflare Browser Rendering binding (env.BROWSER) is not available');
  }

  // 5. Launch browser and navigate
  let browser;
  try {
    browser = options.browser || await puppeteerModule.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1.5 });

    const targetUrl = options.url || HCPSS_URL;
    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    } catch {
      // If networkidle2 times out on slow analytics scripts, proceed to capture whatever rendered
      await new Promise(r => setTimeout(r, 600));
    }

    // Brief stabilization pause for web fonts and layout render
    await new Promise(r => setTimeout(r, 400));

    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false
    });

    const buffer = new Uint8Array(screenshot);
    const now = Date.now();
    memoryCache = { buffer, timestamp: now };

    // 6. Write to R2 cache for cross-isolate sharing
    if (env && env.BACKUPS_BUCKET) {
      try {
        await env.BACKUPS_BUCKET.put(SCREENSHOT_CACHE_KEY, buffer, {
          httpMetadata: { contentType: 'image/png' },
          customMetadata: { capturedAt: String(now) }
        });
      } catch (err) {
        console.warn('Screenshot R2 cache write failed:', err);
      }
    }

    return {
      buffer,
      timestamp: now,
      cached: false
    };
  } finally {
    if (browser && !options.browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

/**
 * Builds the Discord embed displaying the official status screenshot.
 */
export function buildScreenshotEmbed(result, url = HCPSS_URL) {
  const timestampSec = Math.floor((result.timestamp || Date.now()) / 1000);
  const cacheNote = result.cached ? ' • *(cached)*' : ' • *(fresh)*';

  return {
    title: '📸 HCPSS Official Status Page Screenshot',
    url,
    description: `Direct capture from **[status.hcpss.org](${url})**\n*Captured: <t:${timestampSec}:R>${cacheNote}*`,
    color: 0x003366,
    image: { url: 'attachment://status-screenshot.png' },
    footer: { text: 'HCPSS Status Screenshot • Only you can see this message' },
    timestamp: new Date(result.timestamp || Date.now()).toISOString()
  };
}

/**
 * Handles the screenshot interaction: captures or fetches the cached screenshot,
 * then uploads it via Discord multipart webhook PATCH to the original deferred message.
 * Responds 100% ephemerally so only the clicking user sees it.
 */
export async function handleScreenshotInteraction(body, env, options = {}) {
  const start = Date.now();
  const applicationId = env && env.DISCORD_APPLICATION_ID;
  const token = body && body.token;
  if (!applicationId || !token) return;

  const targetUrl = options.url || HCPSS_URL;
  try {
    const result = await captureStatusPageScreenshot(env, options);

    recordAnalyticsEvent(env, {
      event: 'screenshot',
      status: result.cached ? 'cached' : 'fresh',
      durationMs: Date.now() - start,
      detail: targetUrl
    });

    const payload = {
      embeds: [buildScreenshotEmbed(result, targetUrl)],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: 'Open status.hcpss.org',
              url: targetUrl,
              emoji: { name: '🌐' }
            }
          ]
        }
      ],
      attachments: [{
        id: 0,
        description: 'HCPSS Official Operating Status Screenshot',
        filename: 'status-screenshot.png'
      }]
    };

    const formData = new FormData();
    formData.append('payload_json', JSON.stringify(payload));
    formData.append('files[0]', new Blob([result.buffer], { type: 'image/png' }), 'status-screenshot.png');

    const fetchFn = options.fetch || fetch;
    const resp = await fetchFn(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, {
      method: 'PATCH',
      body: formData
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`Discord PATCH screenshot webhook returned status ${resp.status}: ${errText}`);
    }
  } catch (err) {
    console.error('Failed to capture or deliver screenshot:', err);
    recordAnalyticsEvent(env, {
      event: 'screenshot',
      status: 'error',
      durationMs: Date.now() - start,
      detail: (err && err.message) || 'error'
    });
    await updateInteractionOriginal(env, body.token, {
      content: '⚠️ Unable to capture live website screenshot right now. You can view the live status page directly at https://status.hcpss.org',
      embeds: [],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: 'Open status.hcpss.org',
              url: targetUrl,
              emoji: { name: '🌐' }
            }
          ]
        }
      ]
    });
  }
}
