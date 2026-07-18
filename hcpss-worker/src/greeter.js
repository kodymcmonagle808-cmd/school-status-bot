// Greeter service for welcoming new members via DM and asking for notification roles.
// Runs inside the scheduled cron job to maintain serverless operation.

import { getConfig, getEffectiveConfig } from './config.js';
import { jsonResponse } from './discord.js';

/**
 * Helper to fetch all greeted user IDs for a guild from KV to optimize reads.
 */
async function getGreetedUserIds(env, guildId) {
  const userIds = new Set();
  let cursor = undefined;
  
  do {
    const listResult = await env.STATUS_KV.list({
      prefix: `greeted:${guildId}:`,
      cursor
    });
    for (const key of listResult.keys) {
      const parts = key.name.split(':');
      if (parts[2]) {
        userIds.add(parts[2]);
      }
    }
    cursor = listResult.list_complete ? undefined : listResult.cursor;
  } while (cursor);
  
  return userIds;
}

/**
 * Checks for members in all configured guilds who don't have status roles and haven't been greeted.
 */
export async function checkNewMembersAndDM(env) {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('Greeter: DISCORD_BOT_TOKEN is missing');
    return;
  }

  // Get list of configured guilds from KV index
  const rawIndex = await env.STATUS_KV.get('guild_index');
  const guildIds = rawIndex ? JSON.parse(rawIndex) : [];
  if (!Array.isArray(guildIds) || guildIds.length === 0) {
    return;
  }

  const MAX_DMS_PER_RUN = 5; // Safe rate limit to avoid Discord spam/rate limit blocks

  for (const guildId of guildIds) {
    try {
      // 1. Fetch guild config to know what status roles are configured
      const storedConfig = await getConfig(env, guildId);
      const config = getEffectiveConfig(storedConfig);
      const roleMappings = config.status_ping_roles || {};
      const statusRoleIds = Object.values(roleMappings).filter(id => !!id);

      // If no status roles are set up yet, we can't welcome them to select roles
      if (statusRoleIds.length === 0) {
        continue;
      }

      // 2. Fetch guild details to get server name
      const guildResp = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
        headers: { Authorization: `Bot ${token}` }
      });
      if (!guildResp.ok) {
        console.error(`Greeter: Failed to fetch guild ${guildId} (status ${guildResp.status})`);
        continue;
      }
      const guild = await guildResp.json();
      const guildName = guild.name;

      // 3. Fetch guild members (up to 1000)
      // Note: Requires GUILD_MEMBERS privileged intent enabled in Discord Developer Portal!
      const membersResp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`, {
        headers: { Authorization: `Bot ${token}` }
      });
      if (!membersResp.ok) {
        console.error(`Greeter: Failed to fetch members for guild ${guildId} (status ${membersResp.status}). Ensure the GUILD_MEMBERS intent is enabled.`);
        continue;
      }
      const members = await membersResp.json();
      if (!Array.isArray(members)) {
        continue;
      }

      // 4. Get all previously greeted users to avoid individual KV gets
      const greetedUserIds = await getGreetedUserIds(env, guildId);

      let dmsSentThisRun = 0;

      // 5. Check each member
      for (const member of members) {
        if (!member.user || member.user.bot) continue;

        const userId = member.user.id;

        // Skip if already greeted
        if (greetedUserIds.has(userId)) continue;

        // Skip if they already have one or more status notification roles
        const hasStatusRole = member.roles && member.roles.some(roleId => statusRoleIds.includes(roleId));
        if (hasStatusRole) continue;

        // If we hit the rate limit for this cron run, stop DMs for this guild
        if (dmsSentThisRun >= MAX_DMS_PER_RUN) {
          console.log(`Greeter: Hit max DMs limit (${MAX_DMS_PER_RUN}) for guild ${guildId} this run. Remaining users will be processed next minute.`);
          break;
        }

        // Send the welcome DM
        const sent = await sendWelcomeDM(env, userId, guildId, guildName);
        
        // Mark them as greeted (even if it failed, to avoid retrying DMs if they blocked DMs)
        const greetedKey = `greeted:${guildId}:${userId}`;
        await env.STATUS_KV.put(greetedKey, sent ? 'true' : 'failed');
        
        if (sent) {
          dmsSentThisRun++;
          console.log(`Greeter: Welcomed user ${member.user.username} (${userId}) for guild ${guildId}`);
        }
      }

    } catch (e) {
      console.error(`Greeter error for guild ${guildId}:`, e);
    }
  }
}

/**
 * Opens a DM channel and sends the welcome message with role selection dropdown.
 */
async function sendWelcomeDM(env, userId, guildId, guildName) {
  const token = env.DISCORD_BOT_TOKEN;

  try {
    // 1. Create DM channel
    const dmChannelResp = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ recipient_id: userId })
    });
    if (!dmChannelResp.ok) {
      console.error(`Greeter: Failed to create DM channel for ${userId} (status ${dmChannelResp.status})`);
      return false;
    }
    const dmChannel = await dmChannelResp.json();
    const dmChannelId = dmChannel.id;

    // 2. Send welcome message with Select Menu component
    const messageResp = await fetch(`https://discord.com/api/v10/channels/${dmChannelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: `Hi! Welcome to **${guildName}**. This server includes a bot that checks the HCPSS operating status and posts updates automatically.\n\nPlease select which status updates you would like to be notified (pinged) for:`,
        components: [
          {
            type: 1, // Action Row
            components: [
              {
                type: 3, // String Select
                custom_id: `greeter_role_select:${guildId}`,
                placeholder: 'Choose status notifications...',
                min_values: 0,
                max_values: 6,
                options: [
                  { label: 'Normal Operations', value: 'normal_operations', description: 'Schools open on time.' },
                  { label: 'Schools Closed', value: 'schools_closed', description: 'Schools closed today.' },
                  { label: 'Schools & Offices Closed', value: 'schools_and_offices_closed', description: 'All schools and offices closed.' },
                  { label: 'Schools Open 2 Hours Late', value: 'schools_open_2_hours_late', description: 'Two-hour delay.' },
                  { label: 'Schools Close 3 Hours Early', value: 'schools_close_3_hours_early', description: 'Three-hour early dismissal.' },
                  { label: 'Other / Unknown Alerts', value: 'unknown_alert', description: 'Custom alerts or special notices.' }
                ]
              }
            ]
          }
        ]
      })
    });

    if (!messageResp.ok) {
      const errText = await messageResp.text();
      console.error(`Greeter: Failed to send DM message to ${userId} (status ${messageResp.status} ${errText})`);
      return false;
    }

    return true;
  } catch (e) {
    console.error(`Greeter: Error sending welcome DM to user ${userId}:`, e);
    return false;
  }
}

/**
 * Handles the select menu interaction from the DM.
 */
export async function handleGreeterInteraction(body, env) {
  const customId = body.data.custom_id;
  const guildId = customId.replace('greeter_role_select:', '');
  const userId = body.user ? body.user.id : null;
  if (!userId) {
    return jsonResponse({
      type: 4,
      data: { content: '❌ Could not determine your user ID.', flags: 64 }
    });
  }

  // Get selected status keys
  const selectedValues = body.data.values || [];

  try {
    // 1. Fetch guild config to map status keys to role IDs
    const storedConfig = await getConfig(env, guildId);
    const config = getEffectiveConfig(storedConfig);
    const roleMappings = config.status_ping_roles || {};

    // 2. Fetch the member's current roles in the guild
    const token = env.DISCORD_BOT_TOKEN;
    const memberResp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${token}` }
    });
    if (!memberResp.ok) {
      return jsonResponse({
        type: 4,
        data: { content: '❌ You must be in the server to assign roles.', flags: 64 }
      });
    }
    const member = await memberResp.json();
    const currentRoles = member.roles || [];

    // All possible status keys and their roles
    const allStatusKeys = [
      'normal_operations',
      'schools_closed',
      'schools_and_offices_closed',
      'schools_open_2_hours_late',
      'schools_close_3_hours_early',
      'unknown_alert'
    ];

    const added = [];
    const removed = [];

    // 3. Update roles on Discord
    for (const key of allStatusKeys) {
      const roleId = roleMappings[key];
      if (!roleId) continue; // Skip if this role isn't configured in the server

      const wantRole = selectedValues.includes(key);
      const hasRole = currentRoles.includes(roleId);

      if (wantRole && !hasRole) {
        // Add role
        const addResp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bot ${token}`,
            'X-Audit-Log-Reason': 'Self-service welcome DM role assignment'
          }
        });
        if (addResp.ok) added.push(roleId);
      } else if (!wantRole && hasRole) {
        // Remove role
        const removeResp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bot ${token}`,
            'X-Audit-Log-Reason': 'Self-service welcome DM role assignment'
          }
        });
        if (removeResp.ok) removed.push(roleId);
      }
    }

    // 4. Return success response and update the DM message to clear components
    return jsonResponse({
      type: 4, // Respond to interaction
      data: {
        content: `✅ **Notification preferences updated!**\n` +
                 (added.length ? `Added: ${added.map(id => `<@&${id}>`).join(', ')}\n` : '') +
                 (removed.length ? `Removed: ${removed.map(id => `<@&${id}>`).join(', ')}\n` : '') +
                 `You can update this at any time in the server using the role toggles.`,
        flags: 64 // Ephemeral
      }
    });

  } catch (error) {
    console.error('Error handling greeter interaction:', error);
    return jsonResponse({
      type: 4,
      data: {
        content: '❌ An error occurred while updating your roles. Ensure the bot has the correct permissions (Manage Roles) and its role is placed above the notification roles.',
        flags: 64
      }
    });
  }
}
