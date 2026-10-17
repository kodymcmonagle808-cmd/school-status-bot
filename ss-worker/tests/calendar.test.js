import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCalendarEvent,
  putCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents
} from '../src/calendar.js';

function mockKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) };
    }
  };
}

const GUILD = '123456789012345678';
const OTHER = '999999999999999999';

test('putCalendarEvent writes guild-scoped keys and getCalendarEvent reads them', async () => {
  const env = { STATUS_KV: mockKv() };
  await putCalendarEvent(env, GUILD, '2026-12-25', 'Winter Break');
  assert.equal(env.STATUS_KV.store.get(`calendar_event:${GUILD}:2026-12-25`), 'Winter Break');
  assert.equal(await getCalendarEvent(env, GUILD, '2026-12-25'), 'Winter Break');
  assert.equal(await getCalendarEvent(env, OTHER, '2026-12-25'), null);
});

test('getCalendarEvent falls back to legacy global keys', async () => {
  const env = { STATUS_KV: mockKv({ 'calendar_event:2026-11-03': 'Legacy Event' }) };
  assert.equal(await getCalendarEvent(env, GUILD, '2026-11-03'), 'Legacy Event');
  const scopedWins = { STATUS_KV: mockKv({
    'calendar_event:2026-11-03': 'Legacy Event',
    [`calendar_event:${GUILD}:2026-11-03`]: 'Scoped Event'
  }) };
  assert.equal(await getCalendarEvent(scopedWins, GUILD, '2026-11-03'), 'Scoped Event');
});

test('deleteCalendarEvent clears both scoped and legacy keys', async () => {
  const env = { STATUS_KV: mockKv({
    'calendar_event:2026-11-03': 'Legacy Event',
    [`calendar_event:${GUILD}:2026-11-03`]: 'Scoped Event'
  }) };
  await deleteCalendarEvent(env, GUILD, '2026-11-03');
  assert.equal(await getCalendarEvent(env, GUILD, '2026-11-03'), null);
});

test('listCalendarEvents merges legacy events, prefers scoped, and skips other guilds', async () => {
  const env = { STATUS_KV: mockKv({
    'calendar_event:2026-11-03': 'Legacy Only',
    'calendar_event:2026-12-25': 'Legacy Overridden',
    [`calendar_event:${GUILD}:2026-12-25`]: 'Scoped Winter Break',
    [`calendar_event:${GUILD}:2026-10-01`]: 'Scoped October',
    [`calendar_event:${OTHER}:2026-09-01`]: 'Other Guild Event'
  }) };
  const events = await listCalendarEvents(env, GUILD);
  assert.deepEqual(events, [
    { dateStr: '2026-10-01', eventStr: 'Scoped October' },
    { dateStr: '2026-11-03', eventStr: 'Legacy Only' },
    { dateStr: '2026-12-25', eventStr: 'Scoped Winter Break' }
  ]);
});
