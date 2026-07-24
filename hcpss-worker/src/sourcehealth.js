// Silent-zero detection for the external data sources.
//
// `watcherhealth.js` counts watchers that *threw*. But the iron rule is that
// every fetcher degrades to null/[]/'' instead of throwing, so the failure
// mode that actually happens in production — a changed selector, a moved
// endpoint, a feed that quietly starts returning nothing — records zero
// errors and looks exactly like a calm day. `scripts/canary.mjs` catches it,
// but only once a day in CI and only if someone reads the run.
//
// This module watches the sources that should *never* be empty and reports
// the ones that have gone quiet. It deliberately only covers sources with an
// unambiguous "this failed" signal:
//   • the status page scrape returns an explicit `error`
//   • each district entry reports `unavailable` when its own fetch failed
//   • the news feed's item count is recorded by getNewsSignal
// Sources that are legitimately empty most of the year (weather alerts,
// outages, roads, AQI) can't be told apart from a broken one without changing
// what they return, so they stay the canary's job rather than being reported
// here as false alarms.
//
// Budget: one KV read and at most one KV write per hour, on a single key.

import { getEasternTimeStr } from './timeutil.js';
import { getStatusCards } from './scraper.js';
import { getDistrictStatuses } from './districts.js';
import { getNewsFeedItemCount } from './crosscheck.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { postLog } from './panel.js';

export const SOURCE_HEALTH_KEY = 'source_health';

// Minute of each hour the sweep runs. A pure time gate so the per-minute cron
// costs nothing on the other 59 minutes.
export const SWEEP_MINUTE = 7;

// `staleAfterHours` is how long a source may return nothing before it counts
// as broken — generous enough that a quiet weekend never trips it.
export const SOURCE_EXPECTATIONS = {
  scraper: { label: 'HCPSS status page', staleAfterHours: 6 },
  districts: { label: 'Neighboring districts', staleAfterHours: 12 },
  news_feed: { label: 'HCPSS News RSS', staleAfterHours: 48 }
};

export function isSweepMinute(etStr) {
  const [, m] = String(etStr).split(':').map(Number);
  return m === SWEEP_MINUTE;
}

// Pure: the sources whose last good read is older than their threshold.
// Sources never yet observed are skipped — a fresh deploy is not an outage.
export function computeStaleSources(health, nowMs = Date.now()) {
  const out = [];
  for (const [name, spec] of Object.entries(SOURCE_EXPECTATIONS)) {
    const entry = health && health[name];
    if (!entry || !Number(entry.lastData)) continue;
    const ageHours = (nowMs - Number(entry.lastData)) / 3600000;
    if (ageHours >= spec.staleAfterHours) {
      out.push({ name, label: spec.label, ageHours: Math.round(ageHours), detail: entry.detail || '' });
    }
  }
  return out.sort((a, b) => b.ageHours - a.ageHours);
}

// Pure formatter for /health and the owner panel.
export function formatSourceHealth(health, nowMs = Date.now()) {
  const names = Object.keys(SOURCE_EXPECTATIONS);
  const lines = names.map(name => {
    const spec = SOURCE_EXPECTATIONS[name];
    const entry = health && health[name];
    if (!entry || !Number(entry.lastData)) {
      return `• ⚪ **${spec.label}** — no data recorded yet`;
    }
    const ageHours = (nowMs - Number(entry.lastData)) / 3600000;
    const stale = ageHours >= spec.staleAfterHours;
    const when = `<t:${Math.floor(Number(entry.lastData) / 1000)}:R>`;
    const detail = stale && entry.detail ? ` — \`${entry.detail}\`` : '';
    return `• ${stale ? '🔴' : '🟢'} **${spec.label}** — last returned data ${when}${detail}`;
  });
  return lines.join('\n');
}

export async function getSourceHealth(env) {
  try {
    const raw = await env.STATUS_KV.get(SOURCE_HEALTH_KEY);
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

// Probes the three always-expect sources through their real getters, which
// are KV-cached — so the sweep is nearly free and, more importantly, sees
// exactly what the status post would see. Returns { name: { ok, detail } }.
async function probeSources(env) {
  const results = {};

  try {
    const fetched = await getStatusCards(env);
    const cards = fetched && fetched.cards;
    results.scraper = cards && cards.length
      ? { ok: true }
      : { ok: false, detail: String((fetched && fetched.error && fetched.error.message) || 'no cards parsed').slice(0, 120) };
  } catch (e) {
    results.scraper = { ok: false, detail: String((e && e.message) || e).slice(0, 120) };
  }

  try {
    const districts = await getDistrictStatuses(env);
    const list = Array.isArray(districts) ? districts : [];
    const live = list.filter(d => d && d.status !== 'unavailable');
    // Every district failing at once is the selector-change signature; one or
    // two being down is an ordinary bad day for someone else's website.
    results.districts = live.length
      ? { ok: true }
      : { ok: false, detail: `all ${list.length || 0} district sources unavailable` };
  } catch (e) {
    results.districts = { ok: false, detail: String((e && e.message) || e).slice(0, 120) };
  }

  try {
    const count = await getNewsFeedItemCount(env);
    // null = a cache entry written before the counter existed. That's an
    // unknown, not a failure, so record nothing this hour rather than
    // reporting a healthy feed as broken.
    if (count !== null) {
      results.news_feed = count > 0
        ? { ok: true }
        : { ok: false, detail: count === 0 ? 'feed parsed to 0 items' : 'feed unreachable' };
    }
  } catch (e) {
    results.news_feed = { ok: false, detail: String((e && e.message) || e).slice(0, 120) };
  }

  return results;
}

// Pure: folds this hour's probe into the stored record. `lastData` only moves
// forward on a good read, which is what makes "quiet for N hours" detectable.
export function mergeObservations(health, results, nowMs) {
  const next = { ...(health && typeof health === 'object' ? health : {}) };
  for (const [name, res] of Object.entries(results || {})) {
    const prev = next[name] && typeof next[name] === 'object' ? next[name] : {};
    next[name] = {
      lastCheck: nowMs,
      lastData: res && res.ok ? nowMs : Number(prev.lastData) || 0,
      detail: res && res.ok ? '' : String((res && res.detail) || '').slice(0, 120)
    };
  }
  return next;
}

// Runs from the per-minute cron; probes once an hour. Never throws.
export async function maybeSweepSourceHealth(env, now = new Date()) {
  if (!env || !env.STATUS_KV) return { swept: false };
  if (!isSweepMinute(getEasternTimeStr(now))) return { swept: false };

  const nowMs = now.getTime();
  const health = await getSourceHealth(env);

  // Guard against a duplicated cron tick inside the same minute.
  const lastSweep = Number(health.__lastSweep) || 0;
  if (nowMs - lastSweep < 55 * 60 * 1000) return { swept: false };

  const results = await probeSources(env);
  const merged = mergeObservations(health, results, nowMs);
  merged.__lastSweep = nowMs;

  const stale = computeStaleSources(merged, nowMs);

  // One alert per source per day: the log channel is for staff, and a source
  // that has been down for a week shouldn't say so every hour.
  const alerted = merged.__alerted && typeof merged.__alerted === 'object' ? { ...merged.__alerted } : {};
  const dueForAlert = stale.filter(s => nowMs - (Number(alerted[s.name]) || 0) >= 24 * 60 * 60 * 1000);
  for (const s of dueForAlert) alerted[s.name] = nowMs;
  merged.__alerted = alerted;

  await env.STATUS_KV.put(SOURCE_HEALTH_KEY, JSON.stringify(merged)).catch(() => {});

  if (dueForAlert.length) {
    try {
      const cfg = getEffectiveConfig(await getConfig(env, env.DISCORD_GUILD_ID));
      if (cfg.toggle_error_alerts !== false && cfg.log_channel_id) {
        const body = dueForAlert
          .map(s => `• **${s.label}** — no data for ~${s.ageHours}h${s.detail ? ` (\`${s.detail}\`)` : ''}`)
          .join('\n');
        await postLog(
          env,
          cfg.log_channel_id,
          `🔇 **Source has gone quiet.** These feeds are returning nothing, which usually means the ` +
          `page or endpoint changed rather than that there's no news:\n${body}\n` +
          `Run \`node scripts/canary.mjs\` to confirm.`,
          {},
          env.DISCORD_GUILD_ID || ''
        );
      }
    } catch (e) {
      console.error('Source health alert failed:', e);
    }
  }

  return { swept: true, stale: stale.length, alerted: dueForAlert.length };
}
