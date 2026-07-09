const HCPSS_URL = 'https://hcpss.org';
const EMBED_LIMIT = 4096;
const EMBED_SAFE = 3900;

async function fetchHtml(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Fetch failed ' + r.status);
  return await r.text();
}

function extractCards(html) {
  const parts = html.split(/<div[^>]+class=["']views-row["'][^>]*>/i).slice(1);
  const cards = [];
  for (const p of parts) {
    const dateMatch = p.match(/<div[^>]*class=["']views-field-changed["'][^>]*>(.*?)<\/div>/is);
    const titleMatch = p.match(/<(?:h1|h2|h3)[^>]*>(.*?)<\/(?:h1|h2|h3)>/is);
    const bodyMatch = p.match(/<div[^>]*class=["']alert-content["'][^>]*>(.*?)<\/div>/is) || p.match(/<p[^>]*>(.*?)<\/p>/is);
    const stripTags = s => (s||'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
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
    return `## **Normal Operations**\n\nStaff and students report in accordance with the HCPSS calendar.`;
  }
  return cards.map(c => {
    let md = '';
    if (c.title) md += `## **${c.title}**\n\n`;
    if (c.body) md += `${c.body}\n`;
    return md;
  }).join("\n___\n\n");
}

function splitEmbeds(title, description, url, color, footer) {
  const chunks = [];
  let rem = (description || '').trim();
  while (rem.length) {
    if (rem.length <= EMBED_LIMIT) { chunks.push(rem); break; }
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
      footer: { text: footer || '' },
      timestamp: new Date().toISOString()
    };
    if (idx === 0) { embed.title = title; embed.url = url; }
    else { embed.title = `${title} (cont. ${idx+1})`; }
    return embed;
  });
}

async function postMessageToChannel(env, payload) {
  const token = env.DISCORD_BOT_TOKEN;
  const channelId = env.DISCORD_CHANNEL_ID;
  if (!token || !channelId) throw new Error('Missing token or channel id');
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  return res;
}

async function doCheckAndPost(env) {
  const html = await fetchHtml(HCPSS_URL);
  const cards = extractCards(html);
  const desc = assembleDescription(cards);
  const primaryDate = cards[0] ? (cards[0].date || new Date().toLocaleDateString()) : new Date().toLocaleDateString();
  const color = cards.some(c => c.title && !/normal operations/i.test(c.title)) ? 15158332 : 3066993;
  const embeds = splitEmbeds(`🗓️ Status for ${primaryDate}`, desc, HCPSS_URL, color, 'HCPSS Status Monitor');

  const components = [{ type: 1, components: [{ type: 2, style: 2, label: 'Check again', custom_id: 'check_again' }] }];
  const payload = { content: '', embeds, components };

  const res = await postMessageToChannel(env, payload);
  if (res.ok) {
    const data = await res.json();
    const newId = data.id;
    const oldId = await env.STATUS_KV.get('last_message_id');
    await env.STATUS_KV.put('last_message_id', newId);
    if (oldId && oldId !== newId) {
      await fetch(`https://discord.com/api/v10/channels/${env.DISCORD_CHANNEL_ID}/messages/${oldId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
      }).catch(()=>{});
    }
    return { ok: true, id: newId };
  } else {
    const text = await res.text();
    return { ok: false, error: text, status: res.status };
  }
}

export default {
  async fetch(request, env) {
    // simple manual trigger or interaction placeholder
    if (request.method === 'POST') {
      // NOTE: Interaction verification not implemented here. See README to enable secure interactions.
      try {
        const result = await doCheckAndPost(env);
        if (result.ok) return new Response('Posted: ' + result.id, { status: 200 });
        return new Response('Post failed: ' + (result.error || result.status), { status: 500 });
      } catch (err) {
        return new Response('Error: ' + err.message, { status: 500 });
      }
    }

    // GET returns a small status page
    return new Response('HCPSS Worker: POST to trigger a check.', { status: 200 });
  }
};

export async function scheduled(event, env) {
  event.waitUntil((async () => {
    try {
      await doCheckAndPost(env);
    } catch (e) {
      // log but don't throw
      console.error('Scheduled run failed', e);
    }
  })());
}
