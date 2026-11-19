import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateEmbedding,
  indexEmailVector,
  semanticSearchEmails,
  VECTOR_DIMENSION
} from '../src/vectorize.js';

test('generateEmbedding: returns vector embedding using Workers AI', async () => {
  const fakeVector = new Array(VECTOR_DIMENSION).fill(0.123);
  const env = {
    AI: {
      async run(model, input) {
        assert.match(model, /bge-small-en/);
        assert.ok(Array.isArray(input.text));
        return { data: [fakeVector] };
      }
    }
  };

  const res = await generateEmbedding(env, 'School closed tomorrow due to snow');
  assert.ok(Array.isArray(res));
  assert.equal(res.length, VECTOR_DIMENSION);
  assert.equal(res[0], 0.123);
});

test('generateEmbedding: returns null when AI is missing or text is empty', async () => {
  const envNoAi = {};
  assert.equal(await generateEmbedding(envNoAi, 'test'), null);

  const env = { AI: { async run() { return {}; } } };
  assert.equal(await generateEmbedding(env, ''), null);
  assert.equal(await generateEmbedding(env, '   '), null);
});

test('indexEmailVector: upserts vector and metadata to VECTORIZE', async () => {
  const upserts = [];
  const fakeVector = new Array(VECTOR_DIMENSION).fill(0.5);

  const env = {
    AI: {
      async run() { return { data: [fakeVector] }; }
    },
    VECTORIZE: {
      async upsert(records) {
        upserts.push(...records);
      }
    }
  };

  const email = {
    id: 'em-101',
    guildId: 'g-202',
    subject: 'Emergency Weather Closing',
    body: 'All HCPSS schools will be closed today.',
    ts: 1752940000000,
    url: 'https://news.hcpss.org/1'
  };

  const ok = await indexEmailVector(env, email);
  assert.equal(ok, true);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].id, 'email:g-202:em-101');
  assert.equal(upserts[0].metadata.subject, 'Emergency Weather Closing');
  assert.equal(upserts[0].metadata.type, 'email');
  assert.equal(upserts[0].metadata.guildId, 'g-202');
});

test('semanticSearchEmails: queries Vectorize and hydrates from D1', async () => {
  const fakeVector = new Array(VECTOR_DIMENSION).fill(0.1);

  const env = {
    AI: {
      async run() { return { data: [fakeVector] }; }
    },
    VECTORIZE: {
      async query(vec, opts) {
        assert.ok(opts.returnMetadata);
        return {
          matches: [
            {
              id: 'email:g1:email-1',
              score: 0.95,
              metadata: { type: 'email', emailId: 'email-1', guildId: 'g1', subject: '2-Hour Delay' }
            }
          ]
        };
      }
    },
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async all() {
                return {
                  results: [
                    {
                      id: 'email-1',
                      subject: '2-Hour Delay Notice',
                      body: 'Schools opening late.',
                      channel_id: 'ch1',
                      message_id: 'm1',
                      ts: 1752940000000,
                      ai_summary: '• Two hour late opening'
                    }
                  ]
                };
              }
            };
          }
        };
      }
    }
  };

  const search = await semanticSearchEmails(env, 'delay', { guildId: 'g1', topK: 5 });
  assert.equal(search.source, 'vector');
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].subject, '2-Hour Delay Notice');
  assert.equal(search.results[0].ai_summary, '• Two hour late opening');
});

test('semanticSearchEmails: falls back to SQL D1 search when Vectorize is unbound', async () => {
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                return {
                  results: [
                    { id: 'sql-1', subject: 'Winter Storm Notice', body: 'Schools closed' }
                  ]
                };
              }
            };
          }
        };
      }
    }
  };

  const search = await semanticSearchEmails(env, 'storm', { guildId: 'g1' });
  assert.equal(search.source, 'sql');
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].subject, 'Winter Storm Notice');
});
