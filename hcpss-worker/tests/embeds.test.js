import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceEmbedBudget, embedTotalSize, splitEmbeds } from '../src/embeds.js';

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
