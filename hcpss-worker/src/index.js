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
import { maybeUpdateDecisionWatch, maybeCleanupDecisionWatch } from './decisionwatch.js';
import { maybeSendAqiAlerts } from './aqi.js';
import { maybeSendWeatherAlertNotices } from './weatheralerts.js';
import { clearWeatherAlertCache } from './weather.js';
import { clearDistrictCache } from './districts.js';
import { clearNewsSignalCache } from './crosscheck.js';
import { clearSnowfallCache } from './snowfall.js';
import { clearAqiCaches } from './aqi.js';
import { CONTEXT_HOOK_COOLDOWN_SECONDS, contextHookCooldownKey } from './hookmode.js';
import { handleEmailHook } from './emailhook.js';
import { maybeSendStormRecap } from './stormrecap.js';
import { maybeTrackOutlookAccuracy } from './outlookaccuracy.js';
import { maybeWatchServerMembership } from './serverwatch.js';
import { TERMS_MD, PRIVACY_MD, legalPageResponse } from './legal.js';
import { statusPageResponse } from './statuspage.js';
import { recordWatcherError } from './watcherhealth.js';

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
      if (url.pathname === '/') {
        // Public read-only status page (the 60s scrape cache bounds load).
        try {
          return await statusPageResponse(env);
        } catch (e) {
          console.error('Status page failed:', e);
          return new Response('Status page unavailable.', { status: 500 });
        }
      }
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
        let lastCronTickAt = null;
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
            const rawTick = Number(await env.STATUS_KV.get('last_cron_tick') || 0);
            if (rawTick > 0) lastCronTickAt = new Date(rawTick).toISOString();
          } catch {}
        }
        return jsonResponse({
          ok: true,
          worker: 'hcpss-worker',
          gitSha: env.GIT_SHA || null,
          timestamp: new Date().toISOString(),
          manualTriggerConfigured: !!env.MANUAL_TRIGGER_TOKEN,
          guilds,
          scraperFailureStreak,
          lastStatusChangeAt,
          lastCronTickAt
        });
      }
      return new Response('HCPSS Worker: POST signed Discord interactions here, or POST with a manual trigger token to publish a check.', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Push hooks for the external poller (gas/nws-alert-watcher.js): it
    // watches the NWS alert feeds and the HCPSS status page on Google's free
    // timed triggers and calls here only when something changes. Same
    // bearer-token shape as the manual trigger, separate shared secret.
    if (url.pathname === '/nws-hook' || url.pathname === '/status-hook' || url.pathname === '/email-hook' || url.pathname === '/refresh-hook' || url.pathname === '/context-hook') {
      if (!env.NWS_HOOK_SECRET) {
        return new Response('Push hooks disabled: NWS_HOOK_SECRET is not configured.', { status: 403 });
      }
      const provided = getManualTriggerToken(request);
      if (!provided || provided !== env.NWS_HOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    // An HCPSS announcement email arrived in the owner's inbox that may never
    // reach the status page: forward it to every eligible guild's alert
    // channel. Posted inline (no waitUntil) so the Apps Script only marks the
    // email as forwarded after a real 2xx.
    if (url.pathname === '/email-hook') {
      let payload = null;
      try { payload = await request.json(); } catch {}
      const result = await handleEmailHook(env, payload || {});
      return jsonResponse(result, result.ok ? 200 : 400);
    }

    // Outage numbers or road conditions changed: refresh the posted embeds
    // with live data — but only while a power-threat warning is active
    // (that's when the embeds show live storm sections), and at most one
    // edit per 5 minutes. On a quiet day this ping costs a couple of KV
    // reads and nothing else.
    if (url.pathname === '/refresh-hook') {
      ctx.waitUntil(maybeRefreshStormEmbeds(env, new Date(), {
        force: true,
        refreshContextCaches: true
      }).catch(e => {
        console.error('Refresh hook failed', e);
      }));
      return jsonResponse({ ok: true });
    }

    // A context source with no dedicated hook changed (district feeds, HCPSS
    // news RSS, snowfall forecast, AQI): drop its cache so the next reader
    // fetches live instead of waiting out the hook-armed TTL. A per-source
    // cooldown caps the KV churn a noisy fingerprint could cause. Posted
    // storm embeds also refresh so their context lines update — that pass is
    // power-threat-gated and edit-throttled, so a quiet-day ping costs
    // almost nothing.
    if (url.pathname === '/context-hook') {
      let source = '';
      try {
        const body = await request.json();
        if (body && typeof body.source === 'string') source = body.source.trim().toLowerCase();
      } catch {}
      const clearers = {
        districts: clearDistrictCache,
        news: clearNewsSignalCache,
        snowfall: clearSnowfallCache,
        aqi: clearAqiCaches
      };
      if (!clearers[source]) {
        return jsonResponse({ ok: false, error: 'source must be one of: ' + Object.keys(clearers).join(', ') }, 400);
      }
      if (env.STATUS_KV) {
        const cooldownKey = contextHookCooldownKey(source);
        if (await env.STATUS_KV.get(cooldownKey)) {
          return jsonResponse({ ok: true, source, throttled: true });
        }
        await env.STATUS_KV.put(cooldownKey, '1', { expirationTtl: CONTEXT_HOOK_COOLDOWN_SECONDS }).catch(() => {});
      }
      await clearers[source](env);
      ctx.waitUntil(maybeRefreshStormEmbeds(env, new Date(), {
        force: true
      }).catch(e => {
        console.error('Context hook storm refresh failed', e);
      }));
      return jsonResponse({ ok: true, source });
    }

    // The status page changed: run a change-only check pass now. Posts land
    // only in guilds whose source status actually changed (the parsed status
    // is re-verified, so cosmetic page edits stay silent), while the
    // panel-scheduled posts keep firing at their times regardless.
    if (url.pathname === '/status-hook') {
      ctx.waitUntil(doCheckAndPost(env, { source: 'hook' }).catch(e => {
        console.error('Status hook check failed', e);
      }));
      return jsonResponse({ ok: true });
    }

    if (url.pathname === '/nws-hook') {
      let zone = '';
      try {
        const body = await request.json();
        if (body && typeof body.zone === 'string') zone = body.zone.trim().toUpperCase();
      } catch {}
      if (!/^[A-Z]{3}\d{3}$/.test(zone)) {
        return jsonResponse({ ok: false, error: 'zone must be a NWS zone code like MDC027' }, 400);
      }
      await clearWeatherAlertCache(env, zone);
      // The forced pass refetches the zone live (its cache was just dropped);
      // quiet hours and per-guild dedupe still apply inside. A changed alert
      // set also refreshes any posted storm embeds so their weather lines
      // stay current (no-op unless a power-threat warning is active).
      ctx.waitUntil((async () => {
        await maybeSendWeatherAlertNotices(env, new Date(), { force: true }).catch(e => {
          console.error('NWS hook scan failed', e);
        });
        await maybeRefreshStormEmbeds(env, new Date(), { force: true }).catch(e => {
          console.error('NWS hook storm refresh failed', e);
        });
      })());
      return jsonResponse({ ok: true, zone });
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
      // Heartbeat for the external uptime monitor: proves the cron itself is
      // firing (a dead cron is otherwise invisible). Reads every tick but
      // writes only when the stored tick is ≥14 minutes old, keeping ~100
      // writes/day within the KV free-plan budget; the monitor alerts when
      // the tick is older than ~40 minutes.
      try {
        if (env.STATUS_KV) {
          const now = Date.now();
          const last = Number(await env.STATUS_KV.get('last_cron_tick') || 0);
          if (now - last >= 14 * 60 * 1000) {
            await env.STATUS_KV.put('last_cron_tick', String(now));
          }
        }
      } catch (e) {
        console.error('Heartbeat write failed', e);
      }
      try {
        await doCheckAndPost(env, { source: 'scheduled' });
      } catch (e) {
        console.error('Scheduled run failed', e);
        await recordWatcherError(env, 'check', e);
      }
      try {
        await maybeSendMorningDigests(env);
      } catch (e) {
        console.error('Morning digest run failed', e);
        await recordWatcherError(env, 'digest', e);
      }
      try {
        await maybeSendHeadsUp(env);
      } catch (e) {
        console.error('Heads-up run failed', e);
        await recordWatcherError(env, 'headsup', e);
      }
      try {
        await maybeSendBusAlerts(env);
      } catch (e) {
        console.error('Bus alert run failed', e);
        await recordWatcherError(env, 'busalerts', e);
      }
      try {
        await checkNewMembersAndDM(env);
      } catch (e) {
        console.error('Greeter run failed', e);
        await recordWatcherError(env, 'greeter', e);
      }
      try {
        await maybeRefreshStormEmbeds(env);
      } catch (e) {
        console.error('Storm refresh run failed', e);
        await recordWatcherError(env, 'stormrefresh', e);
      }
      try {
        await maybeUpdateDecisionWatch(env);
      } catch (e) {
        console.error('Decision watch run failed', e);
        await recordWatcherError(env, 'decisionwatch', e);
      }
      try {
        await maybeCleanupDecisionWatch(env);
      } catch (e) {
        console.error('Decision watch cleanup run failed', e);
        await recordWatcherError(env, 'decisionwatch', e);
      }
      try {
        await maybeTrackOutlookAccuracy(env);
      } catch (e) {
        console.error('Outlook accuracy run failed', e);
        await recordWatcherError(env, 'outlookaccuracy', e);
      }
      // After the accuracy grader, so the noon recap reads a graded prediction.
      try {
        await maybeSendStormRecap(env);
      } catch (e) {
        console.error('Storm recap run failed', e);
        await recordWatcherError(env, 'stormrecap', e);
      }
      try {
        await maybeSendAqiAlerts(env);
      } catch (e) {
        console.error('AQI alert run failed', e);
        await recordWatcherError(env, 'aqi', e);
      }
      try {
        await maybeSendWeatherAlertNotices(env);
      } catch (e) {
        console.error('NWS issuance notice run failed', e);
        await recordWatcherError(env, 'weatheralerts', e);
      }
      try {
        await maybeSendYearRecap(env);
      } catch (e) {
        console.error('Year recap run failed', e);
        await recordWatcherError(env, 'recap', e);
      }
      try {
        await maybeCleanupDepartedGuilds(env);
      } catch (e) {
        console.error('Guild cleanup run failed', e);
        await recordWatcherError(env, 'cleanup', e);
      }
      try {
        await maybeWatchServerMembership(env);
      } catch (e) {
        console.error('Server membership watch failed', e);
        await recordWatcherError(env, 'serverwatch', e);
      }
    })());
  }
};
