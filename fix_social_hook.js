const fs = require('fs');

let code = fs.readFileSync('hcpss-worker/src/index.js', 'utf8');

const oldSection = `        const { text, author, url: postUrl, image } = payload;
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
        }`;

const newSection = `        // Support both:
        // 1. Direct JSON: { text, author, url, image }
        // 2. Apify "run finished" webhook: { resource: { defaultDatasetId } }
        let posts = [];

        if (payload.resource && payload.resource.defaultDatasetId) {
          // Apify webhook format — fetch actual dataset items
          const datasetId = payload.resource.defaultDatasetId;
          try {
            const dataResp = await fetch(\`https://api.apify.com/v2/datasets/\${datasetId}/items?clean=true&limit=5\`);
            if (dataResp.ok) {
              const items = await dataResp.json();
              for (const item of items) {
                posts.push({
                  text: item.text || item.postText || item.message || item.description || '',
                  author: item.pageName || item.authorName || item.username || 'Facebook',
                  postUrl: item.url || item.postUrl || item.link || null,
                  image: item.topImage || (Array.isArray(item.images) && item.images[0]) || item.image || null
                });
              }
            }
          } catch (e) {
            console.error('Failed to fetch Apify dataset:', e);
            return new Response('Failed to fetch dataset: ' + e.message, { status: 500 });
          }
        } else {
          // Direct format
          const { text, author, url: postUrl, image } = payload;
          if (text || image) {
            posts.push({ text, author, postUrl, image });
          }
        }

        if (posts.length === 0) {
          return new Response('No posts found', { status: 400 });
        }

        // Post each item to Discord
        for (const { text, author, postUrl, image } of posts) {
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

          await fetch(\`https://discord.com/api/v10/channels/\${channelId}/messages\`, {
            method: 'POST',
            headers: {
              Authorization: \`Bot \${env.DISCORD_BOT_TOKEN}\`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ embeds: [embed] })
          });
        }

        // Dummy embed block so old code path below still works
        const embed = { dummy: true };
        if (false) {`;

code = code.replace(oldSection, newSection);

fs.writeFileSync('hcpss-worker/src/index.js', code, 'utf8');
console.log("Updated social-hook to handle Apify format");
