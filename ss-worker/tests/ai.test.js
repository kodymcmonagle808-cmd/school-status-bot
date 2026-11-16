import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateEmailSummary } from '../src/ai.js';
import { buildEmailEmbed } from '../src/emailhook.js';

test('generateEmailSummary: returns null when AI binding is missing', async () => {
  const res = await generateEmailSummary({}, { subject: 'Test', body: 'A long enough body for testing.'.repeat(10) });
  assert.equal(res, null);
});

test('generateEmailSummary: returns null when body is too short', async () => {
  const env = { AI: { async run() { return { response: 'summary' }; } } };
  const res = await generateEmailSummary(env, { subject: 'Test', body: 'Too short' });
  assert.equal(res, null);
});

test('generateEmailSummary: parses bullet points from AI model', async () => {
  const env = {
    AI: {
      async run(model, options) {
        assert.ok(options.messages);
        return {
          response: '• Schools opening 2 hours late on Friday.\n• Morning half-day prekindergarten canceled.\n• Field trips postponed.'
        };
      }
    }
  };

  const res = await generateEmailSummary(env, {
    subject: 'Inclement Weather Schedule Update',
    body: 'Due to icy road conditions across Howard County, all HCPSS schools and offices will open two hours late on Friday morning. Please stay tuned for further updates.'.repeat(3)
  });

  assert.ok(res);
  assert.match(res, /• Schools opening 2 hours late/);
  assert.match(res, /• Morning half-day prekindergarten/);
});

test('buildEmailEmbed: includes AI summary field when provided', () => {
  const embed = buildEmailEmbed({
    subject: 'Centennial High School Weekly Newsletter',
    body: 'Full long newsletter body...',
    aiSummary: '• Report cards available Friday.\n• Winter dance tickets on sale.'
  });

  assert.ok(embed.fields);
  assert.equal(embed.fields.length, 1);
  assert.equal(embed.fields[0].name, '🤖 AI Summary');
  assert.match(embed.fields[0].value, /Report cards available Friday/);
});
