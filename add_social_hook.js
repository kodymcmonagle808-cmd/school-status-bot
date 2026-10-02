const fs = require('fs');

let code = fs.readFileSync('hcpss-worker/src/index.js', 'utf8');

const hookLogic = `
    if (url.pathname === '/social-hook') {
      const guildId = url.searchParams.get('guild_id');
      const token = url.searchParams.get('token');
      if (!guildId || !token) {
        return new Response('Missing parameters', { status: 400 });
      }

      // Verify the token
      const channelId = await env.STATUS_KV.get(\`social_hook:\${guildId}:\${token}\`);
      if (!channelId) {
        return new Response('Invalid or revoked webhook token', { status: 401 });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response('Invalid JSON payload', { status: 400 });
      }

      const { text, author, url: postUrl, image } = payload;
      if (!text && !image) {
        return new Response('Missing text or image', { status: 400 });
      }

      const embed = {
        title: author ? \`New Post from \${author}\` : 'New Social Media Post',
        description: text || '',
        url: postUrl || null,
        color: 0x1DA1F2,
        timestamp: new Date().toISOString(),
        footer: { text: 'Social Webhook Forwarder' }
      };

      if (image && typeof image === 'string' && image.startsWith('http')) {
        embed.image = { url: image };
      }

      // Send to Discord
      const postResp = await fetch(\`https://discord.com/api/v10/channels/\${channelId}/messages\`, {
        method: 'POST',
        headers: {
          Authorization: \`Bot \${env.DISCORD_BOT_TOKEN}\`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          embeds: [embed]
        })
      });

      if (!postResp.ok) {
        return new Response('Failed to post to Discord', { status: 502 });
      }

      // Log it
      const { logAction } = await import('./actionlog.js');
      ctx.waitUntil(logAction(env, guildId, \`📢 Forwarded social post to <#\${channelId}>\`));

      return jsonResponse({ success: true });
    }
`;

const marker = "    if (url.pathname === '/push-data') {";
code = code.replace(marker, hookLogic + '\n' + marker);

fs.writeFileSync('hcpss-worker/src/index.js', code, 'utf8');
console.log("Added /social-hook endpoint");
