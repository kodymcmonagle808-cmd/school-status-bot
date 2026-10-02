const fs = require('fs');

let code = fs.readFileSync('hcpss-worker/src/commands.js', 'utf8');

const codeToAppend = `
export async function runSocialLinkCommand(body, env) {
  const guildId = body.guild_id || '';
  if (!guildId) {
    return { content: '❌ This command can only be used in a server.', flags: 64 }; // EPHEMERAL_FLAG = 64
  }

  // Check permissions - assume admin
  const member = body.member;
  const isAdmin = member && member.permissions && (BigInt(member.permissions) & 8n) === 8n; // 8 = ADMINISTRATOR
  if (!isAdmin) {
    return { content: '❌ Only server administrators can configure social webhooks.', flags: 64 };
  }

  const options = body && body.data && Array.isArray(body.data.options) ? body.data.options : [];
  const channelId = getCommandOption(options, 'channel');
  if (!channelId) {
    return { content: '❌ Please select a channel.', flags: 64 };
  }

  // Generate a random token for this server's webhook
  // For security and simplicity, we'll store it in KV under social_hook:<guild_id>
  // Value will be the channel ID.
  // The secret will be a hash of the guild ID + DISCORD_PUBLIC_KEY to avoid saving raw secrets if we don't want to.
  // Actually, generating a random token and saving it in KV is best.
  
  const tokenBytes = new Uint8Array(16);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  
  await env.STATUS_KV.put(\`social_hook:\${guildId}:\${token}\`, channelId);

  // Use PUBLIC_BASE_URL if available, otherwise generic
  const baseUrl = env.PUBLIC_BASE_URL || 'https://hcpss-worker.kodymcmonagle808.workers.dev';
  const webhookUrl = \`\${baseUrl}/social-hook?guild_id=\${guildId}&token=\${token}\`;

  const instructions = \`✅ **Social Webhook Generated**

You can use this URL to automatically forward Facebook, Instagram, or Twitter posts into <#\${channelId}> using services like **IFTTT** or **Make.com**.

**Your Webhook URL:**
\`\`\`
\${webhookUrl}
\`\`\`
*(Keep this URL secret! Anyone with it can post to that channel as the bot.)*

### How to set it up (Make.com Example):
1. Create a new Scenario in Make.com.
2. For the trigger, choose **Facebook Pages** -> **Watch Posts**.
3. For the action, choose **HTTP** -> **Make a request**.
4. Set URL to the webhook URL above.
5. Set Method to **POST**.
6. Set Body Type to **Raw** -> **JSON**.
7. In the body, paste this template, dragging the variables from Facebook into the correct spots:
\`\`\`json
{
  "author": "YOUR_FACEBOOK_PAGE_NAME",
  "text": "{{message}}",
  "url": "{{url}}",
  "image": "{{picture}}"
}
\`\`\`
8. Turn it on! New posts will appear in Discord automatically.\`;

  return { content: instructions, flags: 64 };
}
`;

code += codeToAppend;

fs.writeFileSync('hcpss-worker/src/commands.js', code, 'utf8');
console.log("Appended runSocialLinkCommand");
