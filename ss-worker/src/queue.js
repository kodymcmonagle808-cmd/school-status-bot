// Cloudflare Queues integration for school-status-bot.
//
// Decouples alert dispatching across Discord guilds using Cloudflare Queues
// (1,000,000 operations/month free). Prevents hitting Discord API rate limits
// during storm mornings when dozens of servers receive concurrent updates.
//
// Automatically falls back to direct asynchronous HTTP requests when
// ALERT_QUEUE is not bound, ensuring zero-configuration local development
// and test compatibility.

import { discordFetch } from './discord.js';
import { logActionError } from './actionlog.js';

/**
 * Enqueues an alert for asynchronous delivery via Cloudflare Queues.
 *
 * @param {object} env - Cloudflare Worker environment object
 * @param {object} alertData - Payload and routing metadata
 * @returns {Promise<{ queued: boolean }>}
 */
export async function enqueueAlert(env, alertData) {
  if (env?.ALERT_QUEUE && typeof env.ALERT_QUEUE.send === 'function') {
    try {
      await env.ALERT_QUEUE.send({
        ...alertData,
        enqueuedAt: Date.now()
      });
      return { queued: true };
    } catch (err) {
      console.error('Failed to enqueue alert to ALERT_QUEUE:', err);
    }
  }
  return { queued: false };
}

/**
 * Enqueues a batch of alerts for delivery.
 *
 * @param {object} env - Cloudflare Worker environment object
 * @param {Array<object>} alerts - Array of alert objects
 * @returns {Promise<{ queued: boolean, count: number }>}
 */
export async function enqueueAlertBatch(env, alerts = []) {
  if (!Array.isArray(alerts) || !alerts.length) {
    return { queued: false, count: 0 };
  }

  if (env?.ALERT_QUEUE && typeof env.ALERT_QUEUE.sendBatch === 'function') {
    try {
      const messages = alerts.map(body => ({
        body: {
          ...body,
          enqueuedAt: Date.now()
        }
      }));
      await env.ALERT_QUEUE.sendBatch(messages);
      return { queued: true, count: alerts.length };
    } catch (err) {
      console.error('Failed to enqueue batch to ALERT_QUEUE:', err);
    }
  }
  return { queued: false, count: 0 };
}

/**
 * Dispatches a single queued message to Discord.
 *
 * @param {object} env - Cloudflare Worker environment object
 * @param {object} message - Message payload from queue
 */
export async function dispatchQueuedAlert(env, message) {
  if (!message || typeof message !== 'object') return;

  const { type, channelId, payload, guildId, previousMessageId, deletePrevious } = message;

  // 1. Channel post / status update
  if (channelId && payload) {
    // Delete previous message if requested (clean channel option)
    if (deletePrevious && previousMessageId) {
      try {
        await discordFetch(
          `https://discord.com/api/v10/channels/${channelId}/messages/${previousMessageId}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
          }
        );
      } catch {}
    }

    const resp = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const result = await resp.json().catch(() => null);

    // Save posted message ID to KV if guildId is provided
    if (result?.id && guildId && env.STATUS_KV?.put) {
      await env.STATUS_KV.put(`last_message_id:${guildId}`, result.id).catch(() => {});
      await env.STATUS_KV.put(`last_channel_id:${guildId}`, channelId).catch(() => {});
    }
    return result;
  }

  // 2. Direct message notice (e.g. status subscribers)
  if (type === 'dm_notice' && message.userId && payload) {
    try {
      const chResp = await discordFetch('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST',
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ recipient_id: message.userId })
      });
      if (chResp.ok) {
        const dmChannel = await chResp.json();
        if (dmChannel?.id) {
          await discordFetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
            method: 'POST',
            headers: {
              Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });
        }
      }
    } catch (err) {
      console.error(`Failed to dispatch DM notice to ${message.userId}:`, err);
    }
  }
}

/**
 * Handles incoming queue batches from Cloudflare Workers Queues consumer.
 *
 * @param {object} batch - Cloudflare Queue batch object
 * @param {object} env - Cloudflare Worker environment object
 * @param {object} ctx - Execution context
 */
export async function processAlertQueueBatch(batch, env, ctx) {
  if (!batch || !Array.isArray(batch.messages)) return;

  for (const msg of batch.messages) {
    try {
      await dispatchQueuedAlert(env, msg.body);
      if (typeof msg.ack === 'function') {
        msg.ack();
      }
    } catch (err) {
      console.error('Queue alert processing failed for message:', err);
      logActionError(`Queue alert processing failed: ${err.message}`);
      if (typeof msg.retry === 'function') {
        msg.retry();
      }
    }
  }
}
