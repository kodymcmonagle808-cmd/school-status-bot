// Cloudflare Vectorize integration for school-status-bot.
//
// Provides vector embeddings and semantic search across archived school
// announcements, emails, calendar events, and weather closures.
// Uses free Cloudflare Workers AI embeddings (@cf/baai/bge-small-en-v1.5)
// and Cloudflare Vectorize (30,000 queries/month, 5M vector dimensions free).
//
// Automatically falls back to SQL LIKE or keyword search when VECTORIZE
// is not bound, maintaining 100% backward compatibility.

import { searchEmailsInD1 } from './db.js';

export const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
export const VECTOR_DIMENSION = 384;

/**
 * Generates vector embeddings for a given text using Workers AI.
 *
 * @param {object} env - Cloudflare Worker environment object
 * @param {string} text - Text to embed
 * @returns {Promise<Array<number>|null>} 384-dimensional embedding vector or null
 */
export async function generateEmbedding(env, text) {
  if (!env?.AI || typeof env.AI.run !== 'function') return null;

  const cleanText = String(text || '').trim().slice(0, 1000);
  if (!cleanText) return null;

  try {
    const res = await env.AI.run(EMBEDDING_MODEL, {
      text: [cleanText]
    });

    const vector = res?.data?.[0] || (Array.isArray(res) ? res[0] : null);
    if (Array.isArray(vector) && vector.length > 0) {
      return vector;
    }
  } catch (err) {
    console.error('Failed to generate embedding with Workers AI:', err);
  }
  return null;
}

/**
 * Indexes a school announcement email in Cloudflare Vectorize.
 *
 * @param {object} env - Cloudflare Worker environment object
 * @param {object} email - Email object { id, guildId, subject, body, ts, url }
 * @returns {Promise<boolean>}
 */
export async function indexEmailVector(env, email = {}) {
  if (!env?.VECTORIZE || typeof env.VECTORIZE.upsert !== 'function') {
    return false;
  }

  const { id, guildId, subject, body, ts, url } = email;
  if (!id || !subject) return false;

  const textToEmbed = `${subject}\n${String(body || '').slice(0, 500)}`;
  const vector = await generateEmbedding(env, textToEmbed);
  if (!vector) return false;

  try {
    await env.VECTORIZE.upsert([
      {
        id: `email:${guildId || 'global'}:${id}`,
        values: vector,
        metadata: {
          type: 'email',
          emailId: String(id),
          guildId: String(guildId || ''),
          subject: String(subject).slice(0, 200),
          ts: Number(ts) || Date.now(),
          url: url ? String(url) : ''
        }
      }
    ]);
    return true;
  } catch (err) {
    console.error('Vectorize upsert error:', err);
    return false;
  }
}

/**
 * Performs semantic vector search on school announcements.
 * Falls back to D1 SQLite full-text search when Vectorize is unavailable.
 *
 * @param {object} env - Cloudflare Worker environment object
 * @param {string} query - User search query
 * @param {object} options - Options { guildId, topK }
 * @returns {Promise<{ results: Array<object>, source: 'vector'|'sql' }>}
 */
export async function semanticSearchEmails(env, query, { guildId = '', topK = 5 } = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return { results: [], source: 'sql' };

  // 1. Try Vectorize semantic search if available
  if (env?.VECTORIZE && env?.AI) {
    try {
      const queryVector = await generateEmbedding(env, cleanQuery);
      if (queryVector) {
        const matches = await env.VECTORIZE.query(queryVector, {
          topK: Math.min(topK * 2, 20),
          returnMetadata: true
        });

        const items = matches?.matches || (Array.isArray(matches) ? matches : []);
        const filtered = items.filter(m => {
          if (!m?.metadata) return false;
          if (m.metadata.type !== 'email') return false;
          if (guildId && m.metadata.guildId && m.metadata.guildId !== guildId) return false;
          return true;
        }).slice(0, topK);

        if (filtered.length > 0) {
          // If D1 is available, query full email records by ID for complete body and summaries
          if (env.DB) {
            try {
              const emailIds = filtered.map(m => m.metadata.emailId).filter(Boolean);
              if (emailIds.length > 0) {
                const placeholders = emailIds.map(() => '?').join(', ');
                const res = await env.DB.prepare(
                  `SELECT id, subject, body, channel_id, message_id, ts, url, image_url, ai_summary
                   FROM emails
                   WHERE id IN (${placeholders})`
                ).bind(...emailIds).all();

                if (res?.results?.length) {
                  const dbMap = new Map(res.results.map(r => [r.id, r]));
                  // Reorder to match vector similarity score ranking
                  const hydrated = filtered.map(m => dbMap.get(m.metadata.emailId) || {
                    id: m.metadata.emailId,
                    subject: m.metadata.subject,
                    ts: m.metadata.ts,
                    url: m.metadata.url
                  });
                  return { results: hydrated, source: 'vector' };
                }
              }
            } catch {}
          }

          // Return metadata-derived results if D1 fetch is bypassed
          return {
            results: filtered.map(m => ({
              id: m.metadata.emailId,
              subject: m.metadata.subject,
              ts: m.metadata.ts,
              url: m.metadata.url,
              score: m.score
            })),
            source: 'vector'
          };
        }
      }
    } catch (err) {
      console.error('Semantic search error in Vectorize:', err);
    }
  }

  // 2. Fallback to SQL LIKE search in D1
  if (env?.DB) {
    try {
      const d1Results = await searchEmailsInD1(env.DB, guildId, cleanQuery, topK);
      if (d1Results && d1Results.length > 0) {
        return { results: d1Results, source: 'sql' };
      }
    } catch {}
  }

  return { results: [], source: 'sql' };
}
