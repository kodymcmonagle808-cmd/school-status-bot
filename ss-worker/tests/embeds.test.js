import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceEmbedBudget, embedTotalSize, splitEmbeds, buildStatusEmbeds } from '../src/embeds.js';

test('embedTotalSize counts title, description, footer, and fields', () => {
  const size = embedTotalSize({
    title: '12345',
    description: '1234567890',
    footer: { text: '123' },
    fields: [{ name: '12', value: '1234' }]
  });
  assert.equal(size, 5 + 10 + 3 + 2 + 4);
  assert.equal(embedTotalSize(null), 0);
});

test('enforceEmbedBudget drops trailing fields to stay under 6000 characters', () => {
  const embed = {
    title: 'T',
    description: 'd'.repeat(3900),
    footer: { text: 'f' },
    fields: [
      { name: 'keep', value: 'v'.repeat(1000) },
      { name: 'keep2', value: 'v'.repeat(1000) },
      { name: 'drop', value: 'v'.repeat(1000) }
    ]
  };
  enforceEmbedBudget(embed);
  assert.ok(embedTotalSize(embed) <= 6000);
  assert.equal(embed.fields.length, 2);
  assert.equal(embed.fields[1].name, 'keep2');
  assert.equal(embed.description.length, 3900); // description untouched when dropping fields suffices
});

test('enforceEmbedBudget trims the description as a last resort', () => {
  const embed = { title: 'T', description: 'd'.repeat(6500), footer: { text: 'f' }, fields: [] };
  enforceEmbedBudget(embed);
  assert.ok(embedTotalSize(embed) <= 6000);
  assert.ok(embed.description.endsWith('…'));
});

test('splitEmbeds output stays within the per-embed budget', () => {
  const embeds = splitEmbeds('Title', 'x\n'.repeat(3000), 'https://example.com', 0, 'footer');
  for (const e of embeds) {
    assert.ok(embedTotalSize(e) <= 6000);
    assert.ok(e.description.length <= 4096);
  }
});


// ---------------------------------------------------------------------------
// Tomorrow A/B day in the evening outlook
// ---------------------------------------------------------------------------

function makeKv(store = new Map()) {
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix || '')).map(name => ({ name }));
      return { keys, list_complete: true };
    }
  };
}

// A simple card for "Normal Operations" on a known date.
function normalOpsCards(dateStr = 'Sep 14, 2026') {
  return [{ date: dateStr, title: 'Normal Operations', body: 'All schools and offices are open today.' }];
}

// Collect all field values from a list of embeds whose name matches a pattern.
function fieldValues(embeds, namePattern) {
  const out = [];
  for (const e of embeds) {
    for (const f of e.fields || []) {
      if (namePattern.test(f.name)) out.push(f.value);
    }
  }
  return out;
}

test('evening outlook includes tomorrow A/B day when checked after 5 PM ET', async (t) => {
  // Mock fetch so weather alerts return an empty GeoJSON (no live calls).
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ features: [] }), { status: 200 })
  );

  // Monday Sep 14, 2026 at 11 PM ET = 2026-09-15T03:00:00Z (EDT, UTC-4).
  const checkedAt = new Date('2026-09-15T03:00:00Z');

  const env = { STATUS_KV: makeKv() };
  const cards = normalOpsCards('Sep 14, 2026');

  const embeds = await buildStatusEmbeds(env, 'School Status', cards, null, null, '', checkedAt);

  // The first embed should have a "Tomorrow Outlook" field.
  const outlookValues = fieldValues(embeds, /Tomorrow Outlook/);
  assert.ok(outlookValues.length > 0, 'Expected a Tomorrow Outlook field');

  // The outlook value should contain an A/B day line for tomorrow.
  const outlookText = outlookValues.join('\n');
  assert.match(outlookText, /Tomorrow:.*\*\*(A|B) Day\*\*/, `Tomorrow A/B day line missing from outlook: ${outlookText}`);
});

test('evening outlook does NOT include tomorrow A/B day before 5 PM ET', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ features: [] }), { status: 200 })
  );

  // Monday Sep 14, 2026 at 2 PM ET = 2026-09-14T18:00:00Z.
  const checkedAt = new Date('2026-09-14T18:00:00Z');

  const env = { STATUS_KV: makeKv() };
  const cards = normalOpsCards('Sep 14, 2026');

  const embeds = await buildStatusEmbeds(env, 'School Status', cards, null, null, '', checkedAt);

  // No Tomorrow Outlook field at all before 5 PM.
  const outlookValues = fieldValues(embeds, /Tomorrow Outlook/);
  assert.equal(outlookValues.length, 0, 'Tomorrow Outlook should not appear before 5 PM ET');
});

test('evening outlook omits tomorrow A/B day when AB day feature is toggled off', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ features: [] }), { status: 200 })
  );

  // Monday Sep 14, 2026 at 11 PM ET.
  const checkedAt = new Date('2026-09-15T03:00:00Z');

  const env = { STATUS_KV: makeKv() };
  const cards = normalOpsCards('Sep 14, 2026');
  const config = { toggle_ab_day: false };

  const embeds = await buildStatusEmbeds(env, 'School Status', cards, config, null, '', checkedAt);

  // If the outlook field appears it should NOT contain A/B day info.
  const outlookValues = fieldValues(embeds, /Tomorrow Outlook/);
  const outlookText = outlookValues.join('\n');
  assert.ok(!/\*\*(A|B) Day\*\*/.test(outlookText), 'A/B day should not appear when toggled off');
});
