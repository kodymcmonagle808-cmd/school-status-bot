import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSnowDayBudget, formatSnowDayBudgetLines, INCLEMENT_WEATHER_BUDGET } from '../src/snowbudget.js';

// Mid-January of the 2026-27 school year.
const NOW = new Date('2027-01-20T12:00:00Z');

function closure(iso, key = 'schools_closed') {
  return { timestamp: Date.parse(iso), status: 'Closed', date: 'x', status_key: key };
}

test('computeSnowDayBudget counts only closures in the current school year', () => {
  const history = [
    closure('2027-01-10T10:00:00Z'),
    closure('2026-12-01T10:00:00Z', 'schools_and_offices_closed'),
    closure('2026-02-01T10:00:00Z'), // previous school year
    { timestamp: Date.parse('2027-01-05T10:00:00Z'), status_key: 'schools_open_2_hours_late' } // delay: no budget cost
  ];
  const budget = computeSnowDayBudget(history, NOW);
  assert.equal(budget.used, 2);
  assert.equal(budget.budget, INCLEMENT_WEATHER_BUDGET);
  assert.equal(budget.remaining, INCLEMENT_WEATHER_BUDGET - 2);
  assert.equal(budget.over, 0);
});

test('computeSnowDayBudget reports overage past the built-in days', () => {
  const history = [1, 2, 3, 4, 5].map(d => closure(`2027-01-0${d}T10:00:00Z`));
  const budget = computeSnowDayBudget(history, NOW);
  assert.equal(budget.used, 5);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.over, 5 - INCLEMENT_WEATHER_BUDGET);
});

test('formatSnowDayBudgetLines covers under, exhausted, and over budget', () => {
  const under = formatSnowDayBudgetLines({ used: 1, budget: 3, remaining: 2, over: 0 });
  assert.match(under, /1 of 3/);
  assert.match(under, /2 remaining/);

  const exhausted = formatSnowDayBudgetLines({ used: 3, budget: 3, remaining: 0, over: 0 });
  assert.match(exhausted, /All 3/);

  const over = formatSnowDayBudgetLines({ used: 5, budget: 3, remaining: 0, over: 2 });
  assert.match(over, /2 over/);
  assert.match(over, /Makeup days/);

  assert.equal(formatSnowDayBudgetLines(null), '');
});
