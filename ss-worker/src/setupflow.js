// The /setup wizard: three stateless steps (log channel → alerts channel →
// staff role) with selections riding along in component custom_ids, plus the
// finalize step that creates notification roles. Split out of interactions.js.

import { EPHEMERAL_FLAG } from './constants.js';
import {
  jsonResponse,
  deferredInteractionResponse,
  updateInteractionOriginal,
  createGuildRole
} from './discord.js';
import { getConfig, setConfig } from './config.js';
import { refreshPanelMessage } from './panel.js';
import { logAction } from './actionlog.js';

export function handleSetupCommand(body, env, guildId, setupDone) {
  if (setupDone === 'true') {
    return jsonResponse({
      type: 4,
      data: {
        content: '⚠️ **School Status Setup Alert**\n\nThis command has already been run in this server. Running setup again will create duplicate notification roles and may disrupt your current configuration.\n\nAre you sure you want to proceed?',
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 4,
                label: 'Proceed Anyway',
                custom_id: 'setup_proceed_anyway'
              },
              {
                type: 2,
                style: 2,
                label: 'Cancel Setup',
                custom_id: 'setup_cancel'
              }
            ]
          }
        ],
        flags: EPHEMERAL_FLAG
      }
    });
  }
  return jsonResponse({
    type: 4,
    data: {
      content: '⚙️ **School Status Setup — Step 1 of 3**\n\nWhich channel should the bot post **system logs and the control panel** to?',
      components: [
        {
          type: 1,
          components: [
            {
              type: 8,
              custom_id: 'setup_select_log_channel',
              placeholder: 'Select logging channel',
              min_values: 1,
              max_values: 1,
              channel_types: [0, 5]
            }
          ]
        }
      ],
      flags: EPHEMERAL_FLAG
    }
  });
}

// Steps 2 and 3 of the setup wizard. Selections so far ride along in the
// custom_id so the flow is stateless: setup_alert:<logId>, then
// setup_staff:<logId>:<alertId> / setup_skipstaff:<logId>:<alertId>.
export function setupAlertChannelStep(logChannelId) {
  return jsonResponse({
    type: 7,
    data: {
      content: `⚙️ **School Status Setup — Step 2 of 3**\n\n` +
               `• Log channel: <#${logChannelId}>\n\n` +
               `Which channel should **status alerts** be posted to? (This is the channel members will see.)`,
      components: [{
        type: 1,
        components: [{
          type: 8,
          custom_id: `setup_alert:${logChannelId}`,
          placeholder: 'Select alerts channel',
          min_values: 1,
          max_values: 1,
          channel_types: [0, 5]
        }]
      }]
    }
  });
}

export function setupStaffRoleStep(logChannelId, alertChannelId) {
  return jsonResponse({
    type: 7,
    data: {
      content: `⚙️ **School Status Setup — Step 3 of 3**\n\n` +
               `• Log channel: <#${logChannelId}>\n` +
               `• Alerts channel: <#${alertChannelId}>\n\n` +
               `Which role should count as **bot staff** (allowed to use commands and the control panel)? ` +
               `Pick a role, or choose *Skip* below to allow Administrators only.`,
      components: [
        {
          type: 1,
          components: [{
            type: 6,
            custom_id: `setup_staff:${logChannelId}:${alertChannelId}`,
            placeholder: 'Select staff role',
            min_values: 1,
            max_values: 1
          }]
        },
        {
          type: 1,
          components: [{
            type: 3,
            custom_id: `setup_skipstaff:${logChannelId}:${alertChannelId}`,
            placeholder: 'Or finish without a staff role...',
            options: [{
              label: 'Skip — Administrators only',
              value: 'skip',
              description: 'Finish setup without a staff role (can be set later in Settings)',
              emoji: { name: '⏭️' }
            }],
            min_values: 1,
            max_values: 1
          }]
        }
      ]
    }
  });
}

export function handleSetupFinalize(body, env, ctx, guildId, selectedChannelId, alertChannelId, staffRoleId) {
  const setupDoneKey = `setup_done:${guildId}`;

  ctx.waitUntil((async () => {
    try {
      await updateInteractionOriginal(env, body.token, {
        content: '⚙️ **School Status Setup**\n\n⏳ Creating status notification roles and configuring the bot...',
        components: []
      });

      const token = env.DISCORD_BOT_TOKEN;
      const rolesToCreate = [
        { key: 'normal_operations', name: 'HCPSS Normal Operations' },
        { key: 'schools_closed', name: 'HCPSS Schools Closed' },
        { key: 'schools_and_offices_closed', name: 'HCPSS Schools and Offices Closed' },
        { key: 'schools_open_2_hours_late', name: 'HCPSS Schools Open 2 Hours Late' },
        { key: 'schools_close_3_hours_early', name: 'HCPSS Schools Close 3 Hours Early' },
        { key: 'unknown_alert', name: 'HCPSS Other/Unknown Alert' }
      ];

      const stored = await getConfig(env, guildId);
      const config = { ...stored };
      config.log_channel_id = selectedChannelId;
      if (alertChannelId) config.alert_channel_id = alertChannelId;
      if (staffRoleId) config.staff_role_id = staffRoleId;
      // First-setup timestamp: per-server stats and history start here.
      if (!config.created_at) config.created_at = Date.now();
      if (!config.status_ping_roles) config.status_ping_roles = {};

      // Fetch guild roles to check if they already exist in the server
      let guildRoles = [];
      try {
        const rolesUrl = `https://discord.com/api/v10/guilds/${guildId}/roles`;
        const rolesResp = await fetch(rolesUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json'
          }
        });
        if (rolesResp.ok) {
          guildRoles = await rolesResp.json();
        }
      } catch (err) {
        console.error('Failed to fetch guild roles, falling back to config check only:', err);
      }

      const createdRoles = await Promise.all(
        rolesToCreate.map(async (role) => {
          const existingId = config.status_ping_roles[role.key];

          // 1. Check if the ID stored in config exists in the server
          if (existingId && guildRoles.some(r => r.id === existingId)) {
            return { key: role.key, name: role.name, id: existingId };
          }

          // 2. Check if a role with the same name exists in the server
          const matchByName = guildRoles.find(r => r.name === role.name);
          if (matchByName) {
            return { key: role.key, name: role.name, id: matchByName.id };
          }

          // 3. Otherwise, create a new role
          const roleId = await createGuildRole(guildId, role.name, token);
          return { key: role.key, name: role.name, id: roleId };
        })
      );

      for (const r of createdRoles) {
        config.status_ping_roles[r.key] = r.id;
      }

      await setConfig(env, guildId, config);
      await env.STATUS_KV.put(setupDoneKey, 'true');

      logAction('Bot setup completed successfully. Notification roles created and registered.', { guildId });
      // This is what publishes the control panel message for the first time.
      await refreshPanelMessage(env, selectedChannelId, guildId);

      const roleList = createdRoles.map(r => `• **${r.name}**: <@&${r.id}>`).join('\n');
      await updateInteractionOriginal(env, body.token, {
        content: `✅ **Setup Complete!**\n\n` +
                 `• Log channel: <#${selectedChannelId}>\n` +
                 (alertChannelId ? `• Alerts channel: <#${alertChannelId}>\n` : '') +
                 `• Staff role: ${staffRoleId ? `<@&${staffRoleId}>` : '*Administrators only (set one later in Settings)*'}\n` +
                 `• Created and configured notification roles:\n${roleList}\n\n` +
                 `The Control Panel has been published to <#${selectedChannelId}>.`,
        components: []
      });
    } catch (err) {
      console.error('Setup failed:', err);
      await updateInteractionOriginal(env, body.token, {
        content: `❌ **Setup Failed:** ${err.message}`,
        components: []
      });
    }
  })());

  return deferredInteractionResponse();
}
