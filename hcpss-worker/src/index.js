// Worker entry point: HTTP routing (health check, signed Discord interactions,
// manual trigger) and the cron-driven scheduled check.

import { MANUAL_TRIGGER_HEADER } from './constants.js';
import { jsonResponse, verifyDiscordRequest } from './discord.js';
import { handleInteraction } from './interactions.js';
import { doCheckAndPost } from './check.js';
import { maybeSendMorningDigests } from './digest.js';
import { maybeSendHeadsUp } from './headsup.js';
import { maybeSendBusAlerts } from './busalerts.js';
import { checkNewMembersAndDM } from './greeter.js';
import { maybeCleanupDepartedGuilds } from './cleanup.js';
import { maybeSendYearRecap } from './recap.js';
import { maybeRefreshStormEmbeds } from './stormrefresh.js';
import { maybeTrackOutlookAccuracy } from './outlookaccuracy.js';
import { TERMS_MD, PRIVACY_MD, legalPageResponse } from './legal.js';

function getManualTriggerToken(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  const headerToken = request.headers.get(MANUAL_TRIGGER_HEADER);
  return headerToken ? headerToken.trim() : '';
}

function validateManualTrigger(request, env) {
  if (!env.MANUAL_TRIGGER_TOKEN) {
    return new Response('Manual trigger disabled: MANUAL_TRIGGER_TOKEN is not configured.', { status: 403 });
  }

  const providedToken = getManualTriggerToken(request);
  if (!providedToken || providedToken !== env.MANUAL_TRIGGER_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      if (url.pathname === '/terms') {
        return legalPageResponse('Terms and Conditions', TERMS_MD);
      }
      if (url.pathname === '/privacy') {
        return legalPageResponse('Privacy Policy', PRIVACY_MD);
      }
      if (url.pathname === '/health') {
        // Operational snapshot on top of the liveness check: how many servers
        // are being served and whether the scraper is currently struggling.
        let guilds = null;
        let scraperFailureStreak = null;
        let lastStatusChangeAt = null;
        if (env.STATUS_KV) {
          try {
            const rawIndex = await env.STATUS_KV.get('guild_index');
            if (rawIndex) {
              const parsed = JSON.parse(rawIndex);
              if (Array.isArray(parsed)) guilds = parsed.filter(Boolean).length;
            }
            scraperFailureStreak = Number(await env.STATUS_KV.get('scraper_failures_count') || 0);
            const rawHistory = await env.STATUS_KV.get('status_history');
            if (rawHistory) {
              const hist = JSON.parse(rawHistory);
              if (Array.isArray(hist) && hist[0] && hist[0].timestamp) {
                lastStatusChangeAt = new Date(hist[0].timestamp).toISOString();
              }
            }
          } catch {}
        }
        return jsonResponse({
          ok: true,
          worker: 'hcpss-worker',
          timestamp: new Date().toISOString(),
          manualTriggerConfigured: !!env.MANUAL_TRIGGER_TOKEN,
          guilds,
          scraperFailureStreak,
          lastStatusChangeAt
        });
      }
      return new Response('HCPSS Worker: POST signed Discord interactions here, or POST with a manual trigger token to publish a check.', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const sig = request.headers.get('x-signature-ed25519');
    const ts = request.headers.get('x-signature-timestamp');
    if (sig && ts) {
      const ok = await verifyDiscordRequest(request.clone(), sig, ts, env.DISCORD_PUBLIC_KEY);
      if (!ok) return new Response('Invalid request signature', { status: 401 });

      const body = await request.json();
      return await handleInteraction(body, env, ctx);
    }

    const manualTriggerError = validateManualTrigger(request, env);
    if (manualTriggerError) return manualTriggerError;

    try {
      const result = await doCheckAndPost(env, { source: 'manual' });
      if (!result.isError) {
        return new Response(`Success: ${result.message}`, { status: 200 });
      }
      return new Response('Scraper check failed: ' + result.error, { status: 500 });
    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await doCheckAndPost(env, { source: 'scheduled' });
      } catch (e) {
        console.error('Scheduled run failed', e);
      }
      try {
        await maybeSendMorningDigests(env);
      } catch (e) {
        console.error('Morning digest run failed', e);
      }
      try {
        await maybeSendHeadsUp(env);
      } catch (e) {
        console.error('Heads-up run failed', e);
      }
      try {
        await maybeSendBusAlerts(env);
      } catch (e) {
        console.error('Bus alert run failed', e);
      }
      try {
        await checkNewMembersAndDM(env);
      } catch (e) {
        console.error('Greeter run failed', e);
      }
      try {
        await maybeRefreshStormEmbeds(env);
      } catch (e) {
        console.error('Storm refresh run failed', e);
      }
      try {
        await maybeTrackOutlookAccuracy(env);
      } catch (e) {
        console.error('Outlook accuracy run failed', e);
      }
      try {
        await maybeSendYearRecap(env);
      } catch (e) {
        console.error('Year recap run failed', e);
      }
      try {
        await maybeCleanupDepartedGuilds(env);
      } catch (e) {
        console.error('Guild cleanup run failed', e);
      }
    })());
  }
};
