// HCPSS announcement emails, pushed by the external watcher
// (gas/nws-alert-watcher.js) from the bot owner's Gmail. HCPSS sometimes
// emails families about things that never appear on the status page or the
// news feed — this forwards those into each guild's alert channel as a side
// notice. Never part of a status post; per-guild toggleable
// (toggle_email_alerts); HCPSS-primary guilds only (a guild following
// Frederick has no use for Howard's mailing list).

import { discordFetch } from './discord.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { logAction } from './actionlog.js';
import { postLog } from './panel.js';
import { generateEmailSummary } from './ai.js';
import { recordEmailToD1 } from './db.js';
import { indexEmailVector } from './vectorize.js';

// Dedupe window for Gmail message ids. The Apps Script only re-sends when a
// worker ack was lost, so a week of memory is plenty.
const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function clamp(text, limit) {
  const s = String(text || '').trim();
  return s.length <= limit ? s : `${s.slice(0, limit - 1).trimEnd()}…`;
}

// Pure embed builder for tests. `footerText` is the guild's configured footer.
export function buildEmailEmbed({ subject, body, receivedAt, imageUrl, webLink, aiSummary }, footerText = 'School Status') {
  const ts = Number(receivedAt) > 0 ? new Date(Number(receivedAt)) : new Date();
  const embed = {
    title: clamp(`📧 ${subject}`, 256),
    description: clamp(body, 2500),
    color: 0x3498DB,
    footer: { text: `${footerText} · via HCPSS email` },
    timestamp: ts.toISOString()
  };
  if (webLink && typeof webLink === 'string' && /^https?:\/\//i.test(webLink)) {
    embed.url = webLink.trim();
  }
  if (imageUrl && typeof imageUrl === 'string' && /^https?:\/\//i.test(imageUrl)) {
    embed.image = { url: imageUrl.trim() };
  }
  if (aiSummary && typeof aiSummary === 'string' && aiSummary.trim()) {
    embed.fields = [
      {
        name: '🤖 AI Summary',
        value: clamp(aiSummary.trim(), 1024),
        inline: false
      }
    ];
  }
  return embed;
}

// Validates and posts one forwarded email to every eligible guild. Returns
// { ok, sent } or { ok: false, error } for a malformed payload. Never throws.
export async function handleEmailHook(env, payload) {
  const subject = payload && typeof payload.subject === 'string' ? payload.subject.trim() : '';
  const body = payload && typeof payload.body === 'string' ? payload.body.trim() : '';
  const id = payload && typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!subject || !body || !id) {
    return { ok: false, error: 'id, subject, and body are required' };
  }

  if (!env || !env.STATUS_KV || !env.DISCORD_BOT_TOKEN) return { ok: true, sent: 0 };

  // Mark before posting so a retried delivery can't double-post.
  const seenKey = `email_hook_seen:${id}`;
  try {
    if (await env.STATUS_KV.get(seenKey)) return { ok: true, sent: 0, deduped: true };
    await env.STATUS_KV.put(seenKey, '1', { expirationTtl: SEEN_TTL_SECONDS });
  } catch {}

  let guildIds = [];
  try {
    const rawIndex = await env.STATUS_KV.get('guild_index');
    const parsed = rawIndex ? JSON.parse(rawIndex) : [];
    if (Array.isArray(parsed)) guildIds = parsed.filter(Boolean);
  } catch {}
  if (env.DISCORD_GUILD_ID && !guildIds.includes(env.DISCORD_GUILD_ID)) {
    guildIds.push(env.DISCORD_GUILD_ID);
  }

  let sent = 0;
  let aiSummary = null;
  if (env && env.AI) {
    try {
      aiSummary = await generateEmailSummary(env, { subject, body });
    } catch {}
  }

  for (const gid of guildIds) {
    try {
      const cfg = getEffectiveConfig(await getConfig(env, gid));
      if (cfg.toggle_email_alerts === false) continue;
      const targetChannelId = cfg.email_channel_id || cfg.alert_channel_id;
      if (!targetChannelId) continue;
      if (cfg.primary_district && cfg.primary_district !== 'hcpss') continue;

      // School-level filter (e.g. if guild is scoped to Centennial and email is specific to another school)
      if (cfg.school_filter && typeof cfg.school_filter === 'string') {
        const filter = cfg.school_filter.trim().toLowerCase();
        const content = `${subject} ${body}`.toLowerCase();
        if (!content.includes(filter) && !content.includes('all schools') && !content.includes('district') && !content.includes('hcpss')) {
          continue;
        }
      }

      const useAi = cfg.toggle_ai_summary !== false;
      const embedData = {
        ...payload,
        aiSummary: useAi ? aiSummary : null
      };

      const resp = await discordFetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [buildEmailEmbed(embedData, cfg.alert_embed_footer || 'School Status')],
          allowed_mentions: { parse: [] }
        })
      });
      if (resp.ok) {
        sent++;
        const postData = await resp.json().catch(() => null);
        const messageId = postData && postData.id;
        const jumpUrl = messageId ? `https://discord.com/channels/${gid}/${targetChannelId}/${messageId}` : '';
        logAction(`📧 HCPSS email notice ("${clamp(subject, 80)}") posted to <#${targetChannelId}>.`, { guildId: gid });

        if (env.DB) {
          try {
            await recordEmailToD1(env.DB, {
              id,
              guildId: gid,
              subject,
              body,
              channelId: targetChannelId,
              messageId: messageId || null,
              ts: Date.now(),
              url: payload.webLink || null,
              imageUrl: payload.imageUrl || null,
              aiSummary: aiSummary || null
            });
          } catch (err) {
            console.error('Failed to record email to D1:', err);
          }
        }

        if (env.VECTORIZE) {
          try {
            await indexEmailVector(env, {
              id,
              guildId: gid,
              subject,
              body,
              ts: Date.now(),
              url: payload.webLink || null
            });
          } catch (err) {
            console.error('Failed to index email in Vectorize:', err);
          }
        }

        try {
          const emailLogKey = `email_logs:${gid}`;
          let emailLogs = [];
          const rawLogs = await env.STATUS_KV.get(emailLogKey);
          if (rawLogs) {
            try { emailLogs = JSON.parse(rawLogs); } catch {}
          }
          if (!Array.isArray(emailLogs)) emailLogs = [];
          emailLogs.unshift({
            subject: clamp(subject, 100),
            channelId: targetChannelId,
            messageId: messageId || null,
            ts: Date.now(),
            url: payload.webLink || null,
            imageUrl: payload.imageUrl || null
          });
          await env.STATUS_KV.put(emailLogKey, JSON.stringify(emailLogs.slice(0, 20)));
        } catch (err) {
          console.error('Failed to save email log:', err);
        }

        if (cfg.log_channel_id) {
          const linkStr = jumpUrl ? `([Jump to Announcement](${jumpUrl}))` : `in <#${targetChannelId}>`;
          await postLog(env, cfg.log_channel_id, `📧 Email: "${clamp(subject, 40)}" posted ${linkStr}`, {}, gid).catch(() => {});
        }
      } else {
        console.error(`Email notice post failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error(`Email notice failed for guild ${gid}:`, e);
    }
  }
  return { ok: true, sent };
}
