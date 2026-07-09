const HCPSS_URL = 'https://hcpss.org';
const EMBED_LIMIT = 4096;
const EMBED_SAFE = 3900;
const MAX_EMBEDS = 10;
const MANUAL_TRIGGER_HEADER = 'x-manual-trigger-token';
const EPHEMERAL_FLAG = 64;

async function fetchHtml(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Fetch failed ' + r.status);
  return await r.text();
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function formatCheckedAt(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(date);
}

function formatStatusDate(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

function normalizeStatusDate(dateText, fallbackDate) {
  if (!dateText) return formatStatusDate(fallbackDate);

  const parsed = new Date(dateText);
  if (!Number.isNaN(parsed.getTime())) return formatStatusDate(parsed);

  return dateText.replace(/,\s*\d{1,2}:\d{2}\s*[AP]M\s*[A-Z]{2,4}$/i, '').trim();
}

function footerWithCheckedAt(label, checkedAt) {
  return `${label} - Last checked ${formatCheckedAt(checkedAt)}`;
}

function getManualTriggerToken(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  const headerToken = request.headers.get(MANUAL_TRIGGER_HEADER);
  return headerToken ? headerToken.trim() : '';
}

function validateManualTrigger(request, env) {
  if (!env.MANUAL_TRIGGER_TOKEN) {
    return new Response('Manual trigger disabled: MANUAL_TRIGGER_TOKEN is not configured.', { status: 403 });
  }

  const providedToken = getManualTriggerToken(request);
  if (!providedToken || providedToken !== env.MANUAL_TRIGGER_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }

  return null;
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

async function verifyDiscordRequest(rawBody, signatureHex, timestamp, publicKeyHex) {
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

function extractCards(html) {
  const parts = html.split(/<div[^>]+class=["']views-row["'][^>]*>/i).slice(1);
  const cards = [];
  for (const p of parts) {
    const dateMatch = p.match(/<div[^>]*class=["']views-field-changed["'][^>]*>(.*?)<\/div>/is);
    const titleMatch = p.match(/<(?:h1|h2|h3)[^>]*>(.*?)<\/(?:h1|h2|h3)>/is);
    const bodyMatch = p.match(/<div[^>]*class=["']alert-content["'][^>]*>(.*?)<\/div>/is) || p.match(/<p[^>]*>(.*?)<\/p>/is);
    const stripTags = s => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const dateText = stripTags(dateMatch && dateMatch[1]);
    const titleText = stripTags(titleMatch && titleMatch[1]);
    const bodyText = stripTags(bodyMatch && bodyMatch[1]);
    if (titleText || bodyText) {
      cards.push({ date: dateText, title: titleText, body: bodyText });
    }
  }
  return cards;
}

function assembleDescription(cards) {
  if (!cards.length) {
    return '## **Normal Operations**\n\nStaff and students report in accordance with the HCPSS calendar.';
  }
  return cards.map(c => {
    let md = '';
    if (c.title) md += `## **${c.title}**\n\n`;
    if (c.body) md += `${c.body}\n`;
    return md;
  }).join('\n___\n\n');
}

function splitEmbeds(title, description, url, color, footer, checkedAt = new Date()) {
  const chunks = [];
  let rem = (description || '').trim();
  while (rem.length) {
    if (rem.length <= EMBED_LIMIT) {
      chunks.push(rem);
      break;
    }
    let splitAt = rem.lastIndexOf('\n', EMBED_SAFE);
    if (splitAt <= 0) splitAt = EMBED_SAFE;
    chunks.push(rem.slice(0, splitAt).trim());
    rem = rem.slice(splitAt).trim();
  }
  if (!chunks.length) chunks.push('');

  return chunks.map((c, idx) => {
    const embed = {
      color,
      description: c,
      footer: { text: footerWithCheckedAt(footer || 'HCPSS Status Monitor', checkedAt) },
      timestamp: checkedAt.toISOString()
    };
    if (idx === 0) {
      embed.title = title;
      embed.url = url;
    } else {
      embed.title = `${title} (cont. ${idx + 1})`;
    }
    return embed;
  });
}

function buildCheckAgainComponents() {
  return [{ type: 1, components: [{ type: 2, style: 1, label: 'Check again', custom_id: 'check_again' }] }];
}

async function buildStatusEmbeds(footer = 'HCPSS Status Monitor') {
  const checkedAt = new Date();
  const html = await fetchHtml(HCPSS_URL);
  const cards = extractCards(html);
  const desc = assembleDescription(cards);
  const primaryDate = normalizeStatusDate(cards[0] && cards[0].date, checkedAt);
  const color = cards.some(c => c.title && !/normal operations/i.test(c.title)) ? 15158332 : 3066993;
  return splitEmbeds(`HCPSS Status for ${primaryDate}`, desc, HCPSS_URL, color, footer, checkedAt).slice(0, MAX_EMBEDS);
}

function buildStatusErrorEmbeds(error, footer = 'HCPSS Status Monitor') {
  const checkedAt = new Date();
  const detail = error && error.message ? `\n\nTechnical detail: ${error.message}` : '';
  return [{
    title: 'HCPSS status check failed',
    url: HCPSS_URL,
    description: `The monitor could not fetch the HCPSS status page right now. Try again in a minute or check https://hcpss.org directly.${detail}`,
    color: 15158332,
    footer: { text: footerWithCheckedAt(footer, checkedAt) },
    timestamp: checkedAt.toISOString()
  }];
}

async function buildStatusPayload({ includeComponents = false, footer = 'HCPSS Status Monitor' } = {}) {
  try {
    const payload = {
      content: '',
      embeds: await buildStatusEmbeds(footer)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents();
    return { payload, isError: false };
  } catch (error) {
    const payload = {
      content: '',
      embeds: buildStatusErrorEmbeds(error, footer)
    };
    if (includeComponents) payload.components = buildCheckAgainComponents();
    return { payload, isError: true, error };
  }
}

async function postMessageToChannel(env, payload) {
  const token = env.DISCORD_BOT_TOKEN;
  const channelId = env.DISCORD_CHANNEL_ID;
  if (!token || !channelId) throw new Error('Missing token or channel id');

  return await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

async function doCheckAndPost(env) {
  const builtStatus = await buildStatusPayload({ includeComponents: true });
  const postResult = await postMessageToChannel(env, builtStatus.payload);

  if (!postResult.ok) {
    const postError = await postResult.text();
    return { ok: false, error: postError, status: postResult.status };
  }

  const postedMessage = await postResult.json();
  const postedMessageId = postedMessage.id;
  const previousMessageId = await env.STATUS_KV.get('last_message_id');
  await env.STATUS_KV.put('last_message_id', postedMessageId);

  if (previousMessageId && previousMessageId !== postedMessageId) {
    await fetch(`https://discord.com/api/v10/channels/${env.DISCORD_CHANNEL_ID}/messages/${previousMessageId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
    }).catch(() => {});
  }

  return {
    ok: true,
    id: postedMessageId,
    isError: builtStatus.isError,
    error: builtStatus.error && builtStatus.error.message
  };
}

function interactionResponse(data) {
  return jsonResponse({ type: 4, data });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      if (url.pathname === '/health') {
        return jsonResponse({
          ok: true,
          worker: 'hcpss-worker',
          timestamp: new Date().toISOString(),
          manualTriggerConfigured: !!env.MANUAL_TRIGGER_TOKEN
        });
      }
      return new Response('HCPSS Worker: POST signed Discord interactions here, or POST with a manual trigger token to publish a check.', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const sig = request.headers.get('x-signature-ed25519');
    const ts = request.headers.get('x-signature-timestamp');
    if (sig && ts) {
      const ok = await verifyDiscordRequest(request.clone(), sig, ts, env.DISCORD_PUBLIC_KEY);
      if (!ok) return new Response('Invalid request signature', { status: 401 });

      const body = await request.json();
      if (body.type === 1) return jsonResponse({ type: 1 });

      if (body.type === 3 && body.data && body.data.custom_id === 'check_again') {
        const builtStatus = await buildStatusPayload({ footer: 'HCPSS Status Monitor - Only you can see this' });
        return interactionResponse({
          content: '',
          embeds: builtStatus.payload.embeds,
          flags: EPHEMERAL_FLAG
        });
      }

      return interactionResponse({
        content: 'Interaction received.',
        flags: EPHEMERAL_FLAG
      });
    }

    const manualTriggerError = validateManualTrigger(request, env);
    if (manualTriggerError) return manualTriggerError;

    try {
      const result = await doCheckAndPost(env);
      if (result.ok) {
        const prefix = result.isError ? 'Posted error embed' : 'Posted';
        return new Response(`${prefix}: ${result.id}`, { status: 200 });
      }
      return new Response('Post failed: ' + (result.error || result.status), { status: 500 });
    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500 });
    }
  }
};

export async function scheduled(event, env) {
  event.waitUntil((async () => {
    try {
      await doCheckAndPost(env);
    } catch (e) {
      console.error('Scheduled run failed', e);
    }
  })());
}
