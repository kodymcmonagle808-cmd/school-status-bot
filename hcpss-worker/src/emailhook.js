// HCPSS announcement emails, pushed by the external watcher
// (gas/nws-alert-watcher.js) from the bot owner's Gmail. HCPSS sometimes
// emails families about things that never appear on the status page or the
// news feed — this forwards those into each guild's alert channel as a side
// notice. Never part of a status post; per-guild toggleable
// (toggle_email_alerts); HCPSS-primary guilds only (a guild following
// Frederick has no use for Howard's mailing list).

import { discordFetch } from './discord.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { postLog } from './panel.js';

// Dedupe window for Gmail message ids. The Apps Script only re-sends when a
// worker ack was lost, so a week of memory is plenty.
const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function clamp(text, limit) {
  const s = String(text || '').trim();
  return s.length <= limit ? s : `${s.slice(0, limit - 1).trimEnd()}…`;
}

// Pure embed builder for tests. `footerText` is the guild's configured footer.
export function buildEmailEmbed({ subject, body, receivedAt }, footerText = 'School Status') {
  const ts = Number(receivedAt) > 0 ? new Date(Number(receivedAt)) : new Date();
  return {
    title: clamp(`📧 ${subject}`, 256),
    description: clamp(body, 2500),
    color: 0x3498DB,
    footer: { text: `${footerText} · via HCPSS email` },
    timestamp: ts.toISOString()
  };
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
  for (const gid of guildIds) {
    try {
      const cfg = getEffectiveConfig(await getConfig(env, gid));
      if (cfg.toggle_email_alerts === false || !cfg.alert_channel_id) continue;
      if (cfg.primary_district && cfg.primary_district !== 'hcpss') continue;

      const resp = await discordFetch(`https://discord.com/api/v10/channels/${cfg.alert_channel_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [buildEmailEmbed(payload, cfg.alert_embed_footer || 'School Status')],
          allowed_mentions: { parse: [] }
        })
      });
      if (resp.ok) {
        sent++;
        await postLog(env, cfg.log_channel_id, `📧 HCPSS email notice ("${clamp(subject, 80)}") posted to <#${cfg.alert_channel_id}>.`, {}, gid);
      } else {
        console.error(`Email notice post failed for guild ${gid}: ${resp.status}`);
      }
    } catch (e) {
      console.error(`Email notice failed for guild ${gid}:`, e);
    }
  }
  return { ok: true, sent };
}
