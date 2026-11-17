import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, 'commands_schema.json');
const tomlPath = path.join(__dirname, '..', 'wrangler.toml');

const botToken = process.env.DISCORD_BOT_TOKEN;
if (!botToken) {
  console.error('❌ DISCORD_BOT_TOKEN environment variable is required.');
  process.exit(1);
}

// Read application ID from environment or wrangler.toml
let appId = process.env.DISCORD_APPLICATION_ID;
if (!appId && fs.existsSync(tomlPath)) {
  const toml = fs.readFileSync(tomlPath, 'utf8');
  const match = toml.match(/DISCORD_APPLICATION_ID\s*=\s*"([^"]+)"/);
  if (match) appId = match[1];
}

if (!appId) {
  console.error('❌ DISCORD_APPLICATION_ID not found in environment or wrangler.toml.');
  process.exit(1);
}

const commands = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
console.log(`📋 Loaded ${commands.length} commands from ${schemaPath}`);
console.log(`🤖 Target Discord Application ID: ${appId}`);

async function registerCommands() {
  const url = `https://discord.com/api/v10/applications/${appId}/commands`;
  console.log(`📡 Registering global slash commands with Discord API...`);

  let globalSuccess = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bot ${botToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(commands)
      });

      if (resp.ok) {
        const data = await resp.json();
        console.log(`✅ Successfully registered ${data.length} global slash commands with Discord!`);
        console.log(`Commands: ${data.map(c => '/' + c.name).join(', ')}`);
        globalSuccess = true;
        break;
      }

      if (resp.status === 429) {
        const rateLimit = await resp.json().catch(() => ({}));
        const retryAfter = Math.ceil(rateLimit.retry_after || 5);
        console.warn(`⏳ Rate limited by Discord. Retrying after ${retryAfter}s (attempt ${attempt}/3)...`);
        await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
        continue;
      }

      const errText = await resp.text();
      console.error(`❌ Discord API returned ${resp.status}: ${errText}`);
      if (attempt === 3) process.exit(1);
    } catch (e) {
      console.error(`❌ Fetch error on attempt ${attempt}:`, e.message);
      if (attempt === 3) process.exit(1);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // If a guild ID is provided, also register directly to that guild so they appear INSTANTLY!
  const guildId = process.env.DISCORD_GUILD_ID;
  if (guildId) {
    console.log(`⚡ Registering to guild ${guildId} for instant availability...`);
    try {
      const guildUrl = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;
      const gResp = await fetch(guildUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bot ${botToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(commands)
      });

      if (gResp.ok) {
        const gData = await gResp.json();
        console.log(`✅ Instantly registered ${gData.length} commands to guild ${guildId}!`);
      } else {
        const gErr = await gResp.text();
        console.warn(`⚠️ Guild command registration returned ${gResp.status}: ${gErr}`);
      }
    } catch (ge) {
      console.warn(`⚠️ Guild command registration skipped: ${ge.message}`);
    }
  }

  if (!globalSuccess) {
    process.exit(1);
  }
}

registerCommands();
