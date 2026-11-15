// Voice Announcement Dispatcher
// Dispatches voice announcement commands to the long-running Discord gateway bot (hcpss-greeter)
// via the internal GREET_BOT_COMMAND bridge protocol.

import { getConfig } from './config.js';
import { logAction, logActionError } from './actionlog.js';

/**
 * Dispatches a voice announcement command to be spoken 3 times across active voice channels.
 * 
 * @param {object} env - Cloudflare worker environment
 * @param {string} guildId - Discord Guild ID
 * @param {string} messageText - The announcement text to speak
 * @param {boolean} [force=false] - If true, dispatches regardless of toggle setting (for staff testing)
 * @returns {Promise<boolean>} - True if the command was dispatched
 */
export async function dispatchVoiceAnnouncement(env, guildId, messageText, force = false) {
  if (!env || !env.DISCORD_BOT_TOKEN) return false;
  try {
    const config = await getConfig(env, guildId);
    if (!force && config.toggle_voice_announcements !== true) {
      logAction(`🎙️ Voice announcements are disabled in settings; skipping: "${messageText}"`, { guildId });
      return false;
    }

    // Identify target text channel to route the bridge command through.
    // hcpss-greeter monitors the music channel, alert channel, log channel, or guild fallback.
    const targetChannelId = config.music_channel_id || config.voice_channel_id || config.log_channel_id || config.alert_channel_id || config.channel_id || (guildId === env.DISCORD_GUILD_ID ? env.DISCORD_CHANNEL_ID : null);
    if (!targetChannelId) {
      logAction(`🎙️ No channel configured to route voice bridge command for guild ${guildId}`, { guildId });
      return false;
    }

    const cleanText = String(messageText || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/[^a-zA-Z0-9 ,.?!'()-]/g, ' ')
      .trim();

    if (!cleanText) return false;

    const payload = {
      content: `GREET_BOT_COMMAND: ANNOUNCE_VOICE ${cleanText}`
    };

    const resp = await fetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      logActionError(`🎙️ Failed to dispatch voice command: HTTP ${resp.status} ${err}`, { guildId });
      return false;
    }

    const msg = await resp.json().catch(() => null);
    logAction(`🎙️ Dispatched voice announcement: "${cleanText}" (routed via <#${targetChannelId}>)`, { guildId });

    // Ensure the command message is deleted if the listener hasn't removed it after 2 seconds
    if (msg && msg.id) {
      setTimeout(async () => {
        try {
          await fetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages/${msg.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
          });
        } catch {}
      }, 2000);
    }

    return true;
  } catch (e) {
    logActionError(`🎙️ Voice dispatch error: ${e.message}`, { guildId });
    return false;
  }
}
