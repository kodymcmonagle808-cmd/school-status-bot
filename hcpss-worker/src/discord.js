// Discord API helpers: request verification, interaction responses, message
// posting, and small parsers for interaction payloads.

import { EPHEMERAL_FLAG } from './constants.js';
import { delay } from './timeutil.js';

// Don't sleep longer than this waiting out a rate limit — storm mornings run
// many guilds in sequence and a long stall would push later guilds past the
// cron invocation budget.
const RETRY_MAX_WAIT_MS = 5000;

// fetch() for the Discord API with one retry on 429 (honoring retry_after) and
// on 5xx/network errors. Storm mornings burst dozens of API calls back to
// back, which is exactly when rate limits and transient errors show up — a
// single silent drop there means a guild misses its status post.
export async function discordFetch(url, init = {}, attempts = 2) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    let resp;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      lastErr = e;
      if (i + 1 < attempts) {
        await delay(500);
        continue;
      }
      throw e;
    }

    if (resp.status === 429 && i + 1 < attempts) {
      let waitMs = 1000;
      try {
        const body = await resp.clone().json();
        if (body && typeof body.retry_after === 'number') waitMs = Math.ceil(body.retry_after * 1000);
      } catch {}
      const headerSec = Number(resp.headers.get('Retry-After'));
      if (Number.isFinite(headerSec) && headerSec > 0) waitMs = Math.max(waitMs, headerSec * 1000);
      if (waitMs > RETRY_MAX_WAIT_MS) return resp;
      await delay(waitMs);
      continue;
    }

    if (resp.status >= 500 && i + 1 < attempts) {
      await delay(500);
      continue;
    }

    return resp;
  }
  throw lastErr;
}

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function interactionResponse(data) {
  return jsonResponse({ type: 4, data });
}

export function deferredInteractionResponse() {
  return jsonResponse({
    type: 5,
    data: { flags: EPHEMERAL_FLAG }
  });
}

function hexToUint8(hex) {
  if (hex.startsWith('0x')) hex = hex.slice(2);
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

export async function verifyDiscordRequest(rawBody, signatureHex, timestamp, publicKeyHex) {
  try {
    const sig = hexToUint8(signatureHex);
    const pub = hexToUint8(publicKeyHex);
    const enc = new TextEncoder();
    const message = new Uint8Array(enc.encode(timestamp));
    const bodyBytes = new Uint8Array(await rawBody.arrayBuffer());
    const data = new Uint8Array(message.length + bodyBytes.length);
    data.set(message, 0);
    data.set(bodyBytes, message.length);

    const key = await crypto.subtle.importKey('raw', pub, { name: 'NODE-ED25519' }, false, ['verify']).catch(() => null);
    if (key) {
      const ok = await crypto.subtle.verify({ name: 'NODE-ED25519' }, key, sig, data).catch(() => false);
      if (ok) return true;
    }

    const key2 = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']).catch(() => null);
    if (key2) {
      return !!(await crypto.subtle.verify({ name: 'Ed25519' }, key2, sig, data).catch(() => false));
    }

    return false;
  } catch (e) {
    return false;
  }
}

export async function postMessageToChannel(env, payload) {
  const token = env.DISCORD_BOT_TOKEN;
  const channelId = payload && payload.__channelId ? payload.__channelId : env.DISCORD_CHANNEL_ID;
  if (!token || !channelId) throw new Error('Missing token or channel id');

  const cleaned = { ...payload };
  delete cleaned.__channelId;

  return await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cleaned)
  });
}

export async function updateInteractionOriginal(env, interactionToken, payload) {
  const applicationId = env.DISCORD_APPLICATION_ID;
  if (!applicationId || !interactionToken) return;

  await discordFetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

export async function createGuildRole(guildId, roleName, token) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/roles`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: roleName,
      mentionable: true
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Discord API error creating role '${roleName}': ${response.status} ${errText}`);
  }
  const data = await response.json();
  return data.id;
}

export function memberIsAdmin(member) {
  const perms = member && member.permissions;
  if (!perms) return false;
  try {
    // ADMINISTRATOR = 0x8
    return (BigInt(perms) & 8n) === 8n;
  } catch {
    return false;
  }
}

export function memberHasRole(member, roleId) {
  return !!roleId && Array.isArray(member && member.roles) && member.roles.includes(roleId);
}

export function getModalInputValue(body, customId) {
  if (!body || !body.data || !Array.isArray(body.data.components)) return '';
  for (const row of body.data.components) {
    if (row && Array.isArray(row.components)) {
      const found = row.components.find(c => c && c.custom_id === customId);
      if (found) return found.value;
    }
  }
  return '';
}

export function getCommandOption(options, name) {
  if (!Array.isArray(options)) return undefined;
  const found = options.find(o => o && o.name === name);
  return found ? found.value : undefined;
}

export function getInvokerId(body) {
  return (body && body.member && body.member.user && body.member.user.id) ||
    (body && body.user && body.user.id) || null;
}
