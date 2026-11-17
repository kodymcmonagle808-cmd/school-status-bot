import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from '../src/interactions.js';

test('Autocomplete: searchemails returns default suggestions when no D1 query', async () => {
  const body = {
    type: 4,
    guild_id: 'g1',
    data: {
      name: 'searchemails',
      options: [{ name: 'query', value: 'del', focused: true }]
    }
  };

  const env = {
    STATUS_KV: { get: async () => null, put: async () => {} }
  };

  const res = await handleInteraction(body, env, {});
  const data = await res.json();
  assert.equal(data.type, 8);
  assert.ok(Array.isArray(data.data.choices));
  assert.ok(data.data.choices.some(c => c.name.toLowerCase().includes('delay')));
});

test('Autocomplete: manualstatus returns status choices', async () => {
  const body = {
    type: 4,
    guild_id: 'g1',
    data: {
      name: 'manualstatus',
      options: [{ name: 'status', value: 'closed', focused: true }]
    }
  };

  const env = {
    STATUS_KV: { get: async () => null }
  };

  const res = await handleInteraction(body, env, {});
  const data = await res.json();
  assert.equal(data.type, 8);
  assert.ok(Array.isArray(data.data.choices));
  assert.ok(data.data.choices.some(c => c.value === 'schools_closed'));
});

test('Autocomplete: districtchannel returns neighboring districts', async () => {
  const body = {
    type: 4,
    guild_id: 'g1',
    data: {
      name: 'districtchannel',
      options: [
        {
          name: 'set',
          type: 1,
          options: [{ name: 'district', value: 'bcps', focused: true }]
        }
      ]
    }
  };

  const env = {
    STATUS_KV: { get: async () => null }
  };

  const res = await handleInteraction(body, env, {});
  const data = await res.json();
  assert.equal(data.type, 8);
  assert.ok(Array.isArray(data.data.choices));
  assert.ok(data.data.choices.some(c => c.value === 'bcps'));
});

test('Autocomplete: events returns filtered custom calendar events', async () => {
  const body = {
    type: 4,
    guild_id: 'g1',
    data: {
      name: 'events',
      options: [{ name: 'title', value: 'exam', focused: true }]
    }
  };

  const env = {
    STATUS_KV: {
      get: async (k) => {
        if (k === 'config:g1') {
          return JSON.stringify({
            calendar_events: [
              { title: 'Final Exams', date: '2026-12-18' },
              { title: 'Winter Break', date: '2026-12-23' }
            ]
          });
        }
        return null;
      }
    }
  };

  const res = await handleInteraction(body, env, {});
  const data = await res.json();
  assert.equal(data.type, 8);
  assert.ok(Array.isArray(data.data.choices));
  assert.equal(data.data.choices.length, 1);
  assert.equal(data.data.choices[0].value, 'Final Exams');
});
