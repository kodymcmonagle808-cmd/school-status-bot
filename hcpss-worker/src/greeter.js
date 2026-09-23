// Greeter service for welcoming new members via DM and asking for notification roles.
// Runs inside the scheduled cron job to maintain serverless operation.

import { getConfig, getEffectiveConfig } from './config.js';
import { jsonResponse } from './discord.js';
import { logAction } from './actionlog.js';

/**
 * Greeted users live in one JSON-array key per guild (like dm_subscribers)
 * instead of one KV key per user, keeping writes and list operations cheap.
 * Legacy per-user `greeted:{gid}:{uid}` keys are migrated in on first read.
 */
function greetedKey(guildId) {
  return `greeted_users:${guildId}`;
}

export async function getGreetedUserIds(env, guildId) {
  const raw = await env.STATUS_KV.get(greetedKey(guildId));
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed);
    } catch {}
    return new Set();
  }

  // One-time migration from the legacy per-user key format.
  const userIds = new Set();
  const legacyKeys = [];
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
        legacyKeys.push(key.name);
      }
    }
    cursor = listResult.list_complete ? undefined : listResult.cursor;
  } while (cursor);

  await env.STATUS_KV.put(greetedKey(guildId), JSON.stringify([...userIds]));
  for (const key of legacyKeys) {
    await env.STATUS_KV.delete(key).catch(() => {});
  }

  return userIds;
}

async function saveGreetedUserIds(env, guildId, userIds) {
  await env.STATUS_KV.put(greetedKey(guildId), JSON.stringify([...userIds]));
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

  const MAX_DMS_PER_RUN = 50; // Welcome up to 50 users per run to handle daily joins/backlogs safely

  for (const guildId of guildIds) {
    try {
      // 0. Check if we already completed today's run for this guild (using UTC date)
      const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const lastRunDateKey = `greeter_last_run_date:${guildId}`;
      const lastRunDate = await env.STATUS_KV.get(lastRunDateKey);
      
      if (lastRunDate === todayStr) {
        continue; // Already finished welcoming for today
      }

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
      let hitLimit = false;
      let greetedChanged = false;

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
        // We'll pick up the rest in the next run (minute) before marking today as complete
        if (dmsSentThisRun >= MAX_DMS_PER_RUN) {
          console.log(`Greeter: Hit max DMs limit (${MAX_DMS_PER_RUN}) for guild ${guildId} this run. Remaining users will be processed next minute.`);
          hitLimit = true;
          break;
        }

        // Send the welcome DM
        const sent = await sendWelcomeDM(env, userId, guildId, guildName);

        // Mark them as greeted (even if it failed, to avoid retrying DMs if they blocked DMs)
        greetedUserIds.add(userId);
        greetedChanged = true;

        if (sent) {
          dmsSentThisRun++;
          console.log(`Greeter: Welcomed user ${member.user.username} (${userId}) for guild ${guildId}`);
        }
      }

      // Persist the greeted set once per run instead of one write per user.
      if (greetedChanged) {
        await saveGreetedUserIds(env, guildId, greetedUserIds);
      }

      // If we went through all members without hitting the backlog limit,
      // it means everyone is fully welcomed for today. Mark today as completed.
      if (!hitLimit) {
        await env.STATUS_KV.put(lastRunDateKey, todayStr);
        console.log(`Greeter: Completed daily welcoming for guild ${guildId}.`);
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

/**
 * Scans all configured guilds for members who joined before the join-logs
 * system was set up and still don't have the configured giveRole.
 * Posts a "Legacy User Pending Info" card to the join-logs channel for each
 * one, with the same "fill in information" button the live join handler uses.
 *
 * Processed user IDs are persisted in KV (`joinlogs_processed:{guildId}`)
 * so the scan is idempotent — restarting the worker never re-posts.
 *
 * The scan runs once after deploy: a KV flag (`joinlogs_legacy_done:{guildId}`)
 * is set after the first complete pass, and subsequent cron ticks skip the work.
 */
export async function checkLegacyJoinLogs(env) {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return;

  const rawIndex = await env.STATUS_KV.get('guild_index');
  const guildIds = rawIndex ? JSON.parse(rawIndex) : [];
  if (!Array.isArray(guildIds) || guildIds.length === 0) return;

  const MAX_POSTS_PER_RUN = 20;

  for (const guildId of guildIds) {
    try {
      // Skip if we already completed the legacy scan for this guild.
      const doneKey = `joinlogs_legacy_done:${guildId}`;
      if (await env.STATUS_KV.get(doneKey)) continue;

      // Read the joinlogs config from KV.
      const rawJoinLogs = await env.STATUS_KV.get(`joinlogs_config:${guildId}`);
      if (!rawJoinLogs) continue;

      let joinlogs;
      try { joinlogs = JSON.parse(rawJoinLogs); } catch { continue; }
      const { channel: channelId, pingRole, giveRole } = joinlogs;
      if (!channelId || !giveRole) continue;

      // Fetch guild members (up to 1000) via REST.
      const membersResp = await fetch(
        `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`,
        { headers: { Authorization: `Bot ${token}` } }
      );
      if (!membersResp.ok) {
        console.error(`LegacyJoinLogs: Failed to fetch members for ${guildId} (${membersResp.status})`);
        continue;
      }
      const members = await membersResp.json();
      if (!Array.isArray(members)) continue;

      // Load the set of already-processed user IDs from KV.
      const processedKey = `joinlogs_processed:${guildId}`;
      const rawProcessed = await env.STATUS_KV.get(processedKey);
      const processed = new Set(rawProcessed ? JSON.parse(rawProcessed) : []);

      let posted = 0;
      let hitLimit = false;

      for (const member of members) {
        if (!member.user || member.user.bot) continue;
        const userId = member.user.id;

        // Already has the role → mark processed, skip.
        if (member.roles && member.roles.includes(giveRole)) {
          processed.add(userId);
          continue;
        }

        // Already posted for this user → skip.
        if (processed.has(userId)) continue;

        if (posted >= MAX_POSTS_PER_RUN) {
          hitLimit = true;
          break;
        }

        // Post a join-log card to the channel.
        const embed = {
          title: 'Legacy User Pending Info',
          description: `User: <@${userId}>\n\n**Set name:** (Empty)\n**Email:** (Empty)\n**School:** (Empty)`,
          color: 0xFFA500 // Orange
        };
        const components = [{
          type: 1,
          components: [{
            type: 2,
            style: 1,
            label: 'fill in information',
            custom_id: `join_fill_${userId}_${giveRole}`
          }]
        }];

        const postResp = await fetch(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bot ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              content: pingRole ? `<@&${pingRole}> (Legacy user missing role)` : '',
              embeds: [embed],
              components
            })
          }
        );

        if (postResp.ok) {
          posted++;
          console.log(`LegacyJoinLogs: Posted for ${member.user.username} (${userId}) in guild ${guildId}`);
        } else {
          console.error(`LegacyJoinLogs: Failed to post for ${userId} in channel ${channelId} (${postResp.status})`);
        }

        processed.add(userId);
      }

      // Persist the processed set.
      await env.STATUS_KV.put(processedKey, JSON.stringify([...processed]));

      // If we got through everyone without hitting the limit, mark this guild done.
      if (!hitLimit) {
        await env.STATUS_KV.put(doneKey, '1');
        logAction(env, guildId, `📋 Legacy join-logs scan complete. Posted ${posted} card(s).`);
      } else {
        console.log(`LegacyJoinLogs: Hit limit (${MAX_POSTS_PER_RUN}) for guild ${guildId}, will continue next tick.`);
      }

    } catch (err) {
      console.error(`LegacyJoinLogs: Error for guild ${guildId}:`, err);
    }
  }
}
