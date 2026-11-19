// Cloudflare Workers AI integration for school-status-bot.
//
// Generates concise summaries of lengthy school announcement emails and
// newsletters using free Cloudflare Workers AI models (@cf/meta/llama-3.1-8b-instruct).
// Never throws; degrades cleanly to null if AI is disabled or unavailable.

export const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const MIN_SUMMARY_BODY_LENGTH = 140;

/**
 * Executes a Workers AI model call, routing through Cloudflare AI Gateway
 * for edge caching and rate limiting when configured, with automatic fallback
 * to direct execution if the gateway is unavailable.
 *
 * @param {object} env - Cloudflare Worker environment object
 * @param {string} model - AI model identifier
 * @param {object} input - Input parameters for the model
 * @param {object} [options={}] - Additional call options
 * @returns {Promise<any>} Model output response or null
 */
export async function runWorkersAiWithGateway(env, model, input, options = {}) {
  if (!env || !env.AI || typeof env.AI.run !== 'function') return null;

  const gatewayId = env.AI_GATEWAY_ID || 'school-status-gateway';
  const enableGateway = env.USE_AI_GATEWAY !== 'false';

  if (enableGateway && gatewayId) {
    try {
      return await env.AI.run(model, input, {
        gateway: {
          id: gatewayId,
          skipCache: false,
          cacheTtl: 3600
        },
        ...options
      });
    } catch (gwErr) {
      console.warn(`Workers AI Gateway "${gatewayId}" warning, falling back to direct run:`, gwErr && gwErr.message ? gwErr.message : gwErr);
    }
  }

  return await env.AI.run(model, input, options);
}

/**
 * Generates a 2-3 bullet point summary of a school announcement email.
 *
 * @param {object} env - Cloudflare Worker environment object
 * @param {object} email - Object containing subject and body
 * @returns {Promise<string|null>} Formatted summary or null
 */
export async function generateEmailSummary(env, { subject = '', body = '' } = {}) {
  if (!env || !env.AI || typeof env.AI.run !== 'function') {
    return null;
  }

  const cleanBody = String(body || '').trim();
  if (cleanBody.length < MIN_SUMMARY_BODY_LENGTH) {
    return null; // Email is already brief
  }

  const cleanSubject = String(subject || '').trim();
  const promptInput = `Subject: ${cleanSubject}\n\nEmail Content:\n${cleanBody.slice(0, 3000)}`;

  try {
    const response = await runWorkersAiWithGateway(env, AI_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'You are an assistant for a school community Discord server. Provide a concise summary of the school announcement email using 2 to 3 short bullet points (under 50 words total). Highlight key dates, schedule changes, actions required, or deadlines. Do not add intro/outro text. Only return the bullet points.'
        },
        {
          role: 'user',
          content: promptInput
        }
      ],
      max_tokens: 160,
      temperature: 0.3
    });

    const output = response && typeof response.response === 'string'
      ? response.response.trim()
      : '';

    if (!output) return null;

    // Normalize bullets
    const lines = output
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !/^here (is|are)|^summary:?/i.test(l));

    if (!lines.length) return null;

    const formatted = lines.map(line => {
      if (line.startsWith('•') || line.startsWith('-') || line.startsWith('*')) {
        return `• ${line.replace(/^[-*•]\s*/, '')}`;
      }
      return `• ${line}`;
    }).slice(0, 3).join('\n');

    return formatted;
  } catch (err) {
    console.error('Workers AI summary error:', err && err.message ? err.message : err);
    return null;
  }
}
