// Outlook accuracy: every storm evening at 7 PM ET, snapshot the Closure
// Outlook for the default (HCPSS) district as a prediction about tomorrow;
// the next day after noon ET (when the morning call is settled), grade it
// against what actually happened. Graded predictions feed the Outlook
// Accuracy section of /stats — the outlook earns trust with a track record.

import { getEasternTimeStr, matchesScheduleTime, formatYmdNY } from './timeutil.js';
import { getActiveWeatherAlerts, hasStormAlert } from './weather.js';
import { getDistrictStatuses, HCPSS_COUNTY } from './districts.js';
import { computeClosureOutlook, OUTLOOK_LEVELS } from './outlook.js';
import { getBgeOutages, getCountyOutage, outagePercent } from './outages.js';
import { getStatusHistory } from './history.js';

export const PREDICTION_TIME = '19:00';
const PREDICTIONS_KEY = 'outlook_predictions';
const PREDICTIONS_LIMIT = 80;
const GRADE_AFTER_MIN = 12 * 60; // grade from noon ET onward

// A prediction "verifies" when the predicted morning brings one of the
// morning-call statuses. Early closings are same-day calls, not something the
// night-before outlook claims to predict.
export const OUTLOOK_HIT_KEYS = [
  'schools_closed',
  'schools_and_offices_closed',
  'schools_open_2_hours_late'
];

export async function getOutlookPredictions(env) {
  const raw = await env.STATUS_KV.get(PREDICTIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Grades every pending prediction whose day is decided: any day before today,
// or today itself once past noon ET. Mutates nothing; returns
// { predictions, changed }. History supplies the outcomes.
export function gradePredictions(predictions, history, todayYmd, pastNoon) {
  const incidentDates = new Set(
    (Array.isArray(history) ? history : [])
      .filter(h => h && OUTLOOK_HIT_KEYS.includes(h.status_key))
      .map(h => formatYmdNY(new Date(h.timestamp)))
  );

  let changed = false;
  const next = (Array.isArray(predictions) ? predictions : []).map(p => {
    if (!p || p.graded || !p.date) return p;
    const decided = p.date < todayYmd || (p.date === todayYmd && pastNoon);
    if (!decided) return p;
    changed = true;
    return { ...p, graded: true, hit: incidentDates.has(p.date) };
  });
  return { predictions: next, changed };
}

// Per-level hit counts over graded predictions, e.g.
// { high: { hits: 5, total: 6 }, ... }. Only levels with data appear.
export function summarizeOutlookAccuracy(predictions) {
  const summary = {};
  for (const p of Array.isArray(predictions) ? predictions : []) {
    if (!p || !p.graded || !p.level) continue;
    if (!summary[p.level]) summary[p.level] = { hits: 0, total: 0 };
    summary[p.level].total++;
    if (p.hit) summary[p.level].hits++;
  }
  return summary;
}

export function formatOutlookAccuracyLines(summary) {
  const order = ['very_high', 'high', 'moderate', 'low'];
  const lines = [];
  for (const level of order) {
    const s = summary && summary[level];
    if (!s || !s.total) continue;
    const meta = OUTLOOK_LEVELS[level];
    const pct = Math.round((s.hits / s.total) * 100);
    lines.push(`• ${meta.emoji} **${meta.label}** evenings: \`${s.hits}/${s.total}\` followed by a closing or delay (${pct}%)`);
  }
  return lines.join('\n');
}

// Runs from the per-minute cron. Records at most one prediction per evening
// (only on storm evenings — quiet days have nothing to predict) and grades
// pending predictions once per day after noon. Never throws.
export async function maybeTrackOutlookAccuracy(env) {
  if (!env || !env.STATUS_KV) return { recorded: false, graded: 0 };
  const now = new Date();
  const etStr = getEasternTimeStr(now);
  const todayYmd = formatYmdNY(now);
  const [h, m] = etStr.split(':').map(Number);
  const nowMin = h * 60 + m;
  let recorded = false;
  let graded = 0;

  // Evening snapshot at 7 PM ET, deduped per day.
  if (matchesScheduleTime(etStr, PREDICTION_TIME) &&
      await env.STATUS_KV.get('last_outlook_prediction_day') !== todayYmd) {
    await env.STATUS_KV.put('last_outlook_prediction_day', todayYmd);

    const alerts = await getActiveWeatherAlerts(env);
    if (hasStormAlert(alerts)) {
      const districts = await getDistrictStatuses(env);
      const outageSummary = await getBgeOutages(env);
      const outlook = computeClosureOutlook(alerts, districts, {
        outagePercent: outagePercent(getCountyOutage(outageSummary, HCPSS_COUNTY))
      });
      if (outlook.level !== 'none') {
        const tomorrowYmd = formatYmdNY(new Date(now.getTime() + 24 * 60 * 60 * 1000));
        const predictions = await getOutlookPredictions(env);
        // One prediction per predicted day; a re-run never duplicates.
        if (!predictions.some(p => p && p.date === tomorrowYmd)) {
          predictions.unshift({
            date: tomorrowYmd,
            level: outlook.level,
            score: outlook.score,
            at: Date.now(),
            graded: false,
            hit: null
          });
          await env.STATUS_KV.put(PREDICTIONS_KEY, JSON.stringify(predictions.slice(0, PREDICTIONS_LIMIT)));
          recorded = true;
        }
      }
    }
  }

  // Daily grading pass after noon ET, deduped per day.
  if (nowMin >= GRADE_AFTER_MIN &&
      await env.STATUS_KV.get('last_outlook_grade_day') !== todayYmd) {
    await env.STATUS_KV.put('last_outlook_grade_day', todayYmd);

    const predictions = await getOutlookPredictions(env);
    if (predictions.some(p => p && !p.graded)) {
      const history = await getStatusHistory(env);
      const result = gradePredictions(predictions, history, todayYmd, true);
      if (result.changed) {
        graded = result.predictions.filter((p, i) => p.graded && !(predictions[i] && predictions[i].graded)).length;
        await env.STATUS_KV.put(PREDICTIONS_KEY, JSON.stringify(result.predictions));
      }
    }
  }

  return { recorded, graded };
}
