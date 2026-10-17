// Inclement weather day budget: HCPSS builds a fixed number of makeup days
// into each school-year calendar, and the question every family asks when a
// closure posts is "how many snow days are left?". Closure days come from the
// same history that powers /stats; the budget is HCPSS-specific, so district
// guilds never see it.

import { computeIncidentStats } from './history.js';

// Days built into the HCPSS calendar before makeup days start being used
// (the calendar marks June 9–16 as possible inclement weather makeup days).
export const INCLEMENT_WEATHER_BUDGET = 3;

// Computes { used, budget, remaining, over } for the school year containing
// `now`. Only full closures consume budget days — delays and early closings
// don't shorten the school year.
export function computeSnowDayBudget(history, now = new Date()) {
  const used = computeIncidentStats(history, now).snowDays;
  const remaining = Math.max(0, INCLEMENT_WEATHER_BUDGET - used);
  return {
    used,
    budget: INCLEMENT_WEATHER_BUDGET,
    remaining,
    over: Math.max(0, used - INCLEMENT_WEATHER_BUDGET)
  };
}

export function formatSnowDayBudgetLines(budget) {
  if (!budget) return '';
  const { used, budget: total, remaining, over } = budget;
  const meter = '❄️'.repeat(Math.min(used, total)) + '▫️'.repeat(remaining);
  if (over > 0) {
    return `${meter} **${used} closure day${used === 1 ? '' : 's'} used — ${over} over the ${total} built into the calendar.**\n` +
      `> Makeup days (June 9–16) are likely — the last day of school may move.`;
  }
  if (remaining === 0) {
    return `${meter} **All ${total} built-in inclement weather days are used.**\n` +
      `> The next closure would add a makeup day (June 9–16).`;
  }
  return `${meter} **${used} of ${total}** built-in inclement weather days used — ${remaining} remaining before makeup days kick in.`;
}
