// Routes verified Discord interactions (slash commands, components, modals)
// to their handlers. The handlers themselves live in commands.js, modals.js,
// setupflow.js, and panelcomponents.js.

import {
  EPHEMERAL_FLAG,
  POST_STATUS_COMMAND,
  OVERRIDE_COMMAND,
  ANNOUNCE_COMMAND,
  ALL_STATUS_LABELS
} from './constants.js';
import {
  jsonResponse,
  interactionResponse,
  deferredInteractionResponse,
  updateInteractionOriginal,
  memberIsAdmin,
  getInvokerId
} from './discord.js';
import { toggleSubscriber } from './subscriptions.js';
import { getConfig, getEffectiveConfig, canUseCommands, canConfigure } from './config.js';
import { buildStatusPayload } from './embeds.js';
import { buildControlPanelPayload, applyConfigUpdate } from './panel.js';
import {
  runCalendarCommand,
  runHistoryCommand,
  runDistrictsCommand,
  runStatsCommand,
  runEventsCommand,
  runTermsCommand,
  runPrivacyCommand,
  runStatusCommand,
  runHelpCommand,
  runSnowdayCommand,
  runNotifyCommand,
  runMyDataViewCommand,
  runMyDataDeletePrompt,
  runPostStatusCommand,
  runOverrideCommand,
  handlePanelRefresh
} from './commands.js';
import { handleModalSubmit } from './modals.js';
import {
  handleSetupCommand,
  setupAlertChannelStep,
  setupStaffRoleStep,
  handleSetupFinalize
} from './setupflow.js';
import { handlePanelComponent, handleTestAlert } from './panelcomponents.js';
import { purgeGuildData, removeFromGuildIndex } from './cleanup.js';
import { handleGreeterInteraction } from './greeter.js';

export async function handleInteraction(body, env, ctx) {
  if (body.type === 1) return jsonResponse({ type: 1 });

  const guildId = body.guild_id || '';

  if (body.type === 5) {
    return await handleModalSubmit(body, env, ctx, guildId);
  }

  if (body.type === 2 && body.data && body.data.name === 'setup') {
    if (!memberIsAdmin(body.member)) {
      return interactionResponse({
        content: '❌ This command is only allowed for users with Administrator permissions.',
        flags: EPHEMERAL_FLAG
      });
    }
    const setupDone = await env.STATUS_KV.get(`setup_done:${guildId}`);
    return handleSetupCommand(body, env, guildId, setupDone);
  }

  // /mydata — admin-only data transparency, per the Privacy Policy.
  if (body.type === 2 && body.data && body.data.name === 'mydata') {
    if (!memberIsAdmin(body.member)) {
      return interactionResponse({
        content: '❌ This command is only allowed for users with Administrator permissions.',
        flags: EPHEMERAL_FLAG
      });
    }
    const options = Array.isArray(body.data.options) ? body.data.options : [];
    const sub = options[0] && options[0].type === 1 ? String(options[0].name) : '';
    if (sub === 'delete') {
      return interactionResponse(runMyDataDeletePrompt());
    }
    return interactionResponse(await runMyDataViewCommand(env, guildId));
  }

  // Read-only informational commands are open to every member (all ephemeral).
  if (body.type === 2 && body.data) {
    const name = body.data.name;

    if (name === 'terms') return interactionResponse(runTermsCommand());
    if (name === 'privacy') return interactionResponse(runPrivacyCommand());
    if (name === 'help') return interactionResponse(runHelpCommand());
    if (name === 'notify') return interactionResponse(await runNotifyCommand(body, env));

    if (name === 'status') {
      ctx.waitUntil(runStatusCommand(body, env));
      return deferredInteractionResponse();
    }

    if (name === 'snowday') {
      ctx.waitUntil(runSnowdayCommand(body, env));
      return deferredInteractionResponse();
    }

    if (name === 'calendar') {
      return interactionResponse(await runCalendarCommand(env, guildId));
    }

    if (name === 'history') {
      return interactionResponse(await runHistoryCommand(env, guildId));
    }

    if (name === 'districts') {
      ctx.waitUntil((async () => {
        const payload = await runDistrictsCommand(env);
        await updateInteractionOriginal(env, body.token, payload);
      })());
      return deferredInteractionResponse();
    }

    if (name === 'stats') {
      return interactionResponse(await runStatsCommand(env, guildId));
    }
  }

  if (body.type === 2 && !(await canUseCommands(body.member, env, guildId))) {
    return interactionResponse({
      content: 'You do not have permission to use this bot command.',
      flags: EPHEMERAL_FLAG
    });
  }

  if (body.type === 2 && body.data && body.data.name === POST_STATUS_COMMAND) {
    ctx.waitUntil(runPostStatusCommand(body, env));
    return deferredInteractionResponse();
  }

  if (body.type === 2 && body.data && body.data.name === OVERRIDE_COMMAND) {
    ctx.waitUntil(runOverrideCommand(body, env));
    return deferredInteractionResponse();
  }

  if (body.type === 2 && body.data && body.data.name === 'events') {
    ctx.waitUntil(runEventsCommand(body, env));
    return deferredInteractionResponse();
  }

  if (body.type === 2 && body.data && body.data.name === 'refresh-panel') {
    ctx.waitUntil(handlePanelRefresh(body, env));
    return deferredInteractionResponse();
  }

  if (body.type === 2 && body.data && body.data.name === ANNOUNCE_COMMAND) {
    return jsonResponse({
      type: 9,
      data: {
        title: '📣 Post an Announcement',
        custom_id: 'modal_announce',
        components: [
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_announce_title',
              style: 1,
              label: 'Title',
              placeholder: 'e.g. Important Notice',
              max_length: 256,
              required: false
            }]
          },
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_announce_body',
              style: 2,
              label: 'Message',
              placeholder: 'Type the full announcement here...',
              max_length: 3900,
              required: true
            }]
          },
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_announce_footer',
              style: 1,
              label: 'Footer (optional)',
              placeholder: 'e.g. HCPSS Administration',
              max_length: 256,
              required: false
            }]
          }
        ]
      }
    });
  }

  // /mydata delete confirmation buttons.
  if (body.type === 3 && body.data && body.data.custom_id === 'mydata_delete_cancel') {
    return jsonResponse({
      type: 7,
      data: { content: '❎ Deletion cancelled. No data was removed.', components: [] }
    });
  }

  if (body.type === 3 && body.data && body.data.custom_id === 'mydata_delete_confirm') {
    if (!memberIsAdmin(body.member)) {
      return interactionResponse({
        content: '❌ Only users with Administrator permissions can delete server data.',
        flags: EPHEMERAL_FLAG
      });
    }
    ctx.waitUntil((async () => {
      try {
        await purgeGuildData(env, guildId);
        await removeFromGuildIndex(env, guildId);
        await updateInteractionOriginal(env, body.token, {
          content: '🗑️ **All server data deleted.** Configuration, subscriber lists, calendar events, ' +
            'greeter records, and logs have been erased. Run `/setup` if you want to use the bot here again.',
          components: []
        });
      } catch (err) {
        console.error('Data deletion failed:', err);
        await updateInteractionOriginal(env, body.token, {
          content: `❌ **Data deletion failed:** ${err.message}. Please try again.`,
          components: []
        });
      }
    })());
    return jsonResponse({ type: 6 });
  }

  if (body.type === 3 && body.data && typeof body.data.custom_id === 'string' && body.data.custom_id.startsWith('panel_') && body.data.custom_id !== 'panel_trigger_test_alert') {
    if (!(await canUseCommands(body.member, env, guildId))) {
      return interactionResponse({
        content: 'You do not have permission to use the control panel.',
        flags: EPHEMERAL_FLAG
      });
    }

    const response = await handlePanelComponent(body, env, ctx, guildId);
    if (response) return response;
  }

  if (body.type === 3 && body.data && body.data.custom_id === 'panel_trigger_test_alert') {
    if (!(await canConfigure(body.member, env, guildId))) {
      return interactionResponse({
        content: '❌ You do not have permission to run scraper diagnostics.',
        flags: EPHEMERAL_FLAG
      });
    }
    return handleTestAlert(body, env, ctx, guildId);
  }

  if (body.type === 3 && body.data && typeof body.data.custom_id === 'string' && body.data.custom_id.startsWith('greeter_role_select:')) {
    return await handleGreeterInteraction(body, env);
  }

  if (body.type === 3 && body.data && body.data.custom_id === 'role_toggle_select') {
    // Open to everyone — toggling only affects the user's own roles.
    const userId = getInvokerId(body);
    const statusKey = Array.isArray(body.data.values) && body.data.values[0];
    if (!userId || !statusKey) {
      return interactionResponse({ content: '❌ Could not determine your selection.', flags: EPHEMERAL_FLAG });
    }

    const cfg = getEffectiveConfig(await getConfig(env, guildId));
    const roleId = cfg.status_ping_roles && cfg.status_ping_roles[statusKey];
    if (!roleId) {
      return interactionResponse({
        content: '❌ No notification role is configured for that status anymore.',
        flags: EPHEMERAL_FLAG
      });
    }

    const hasRole = body.member && Array.isArray(body.member.roles) && body.member.roles.includes(roleId);
    const resp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: hasRole ? 'DELETE' : 'PUT',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'X-Audit-Log-Reason': 'Self-service HCPSS notification role toggle'
      }
    });
    if (!resp.ok) {
      return interactionResponse({
        content: `❌ Couldn't update your roles (Discord error ${resp.status}). ` +
                 `The bot needs the **Manage Roles** permission, and its role must be above the notification roles in the role list.`,
        flags: EPHEMERAL_FLAG
      });
    }

    const label = ALL_STATUS_LABELS[statusKey] || statusKey;
    return interactionResponse({
      content: hasRole
        ? `🔕 Removed <@&${roleId}> — you'll no longer be pinged for **${label}**.`
        : `🔔 Added <@&${roleId}> — you'll be pinged when **${label}** is announced.`,
      flags: EPHEMERAL_FLAG
    });
  }

  if (body.type === 3 && body.data && body.data.custom_id === 'dm_subscribe') {
    // Open to everyone — subscribing only affects the user's own DMs.
    const userId = getInvokerId(body);
    if (!userId) {
      return interactionResponse({ content: '❌ Could not determine your user ID.', flags: EPHEMERAL_FLAG });
    }
    const result = await toggleSubscriber(env, guildId, userId);
    if (result.full) {
      return interactionResponse({ content: '❌ The subscriber list for this server is full.', flags: EPHEMERAL_FLAG });
    }
    return interactionResponse({
      content: result.subscribed
        ? "🔔 **Subscribed!** I'll DM you whenever the HCPSS operating status changes (not on every scheduled repost). Make sure DMs from this server's members are enabled. Click the button again to unsubscribe."
        : '🔕 **Unsubscribed.** You will no longer get DMs when the status changes.',
      flags: EPHEMERAL_FLAG
    });
  }

  if (body.type === 3 && body.data && body.data.custom_id === 'check_again') {
    const builtStatus = await buildStatusPayload(env, { footer: 'HCPSS Status Monitor - Only you can see this', guildId });
    return interactionResponse({
      content: '',
      embeds: builtStatus.payload.embeds,
      flags: EPHEMERAL_FLAG
    });
  }

  if (body.type === 3 && body.data && body.data.custom_id === 'setup_cancel') {
    if (!memberIsAdmin(body.member)) {
      return interactionResponse({
        content: '❌ Only users with Administrator permissions can interact with setup.',
        flags: EPHEMERAL_FLAG
      });
    }
    return jsonResponse({
      type: 7,
      data: {
        content: '❌ Setup cancelled.',
        components: []
      }
    });
  }

  if (body.type === 3 && body.data && body.data.custom_id === 'setup_proceed_anyway') {
    if (!memberIsAdmin(body.member)) {
      return interactionResponse({
        content: '❌ Only users with Administrator permissions can interact with setup.',
        flags: EPHEMERAL_FLAG
      });
    }
    return jsonResponse({
      type: 7,
      data: {
        content: '⚙️ **HCPSS Status Monitor Setup (Force Rerun) — Step 1 of 3**\n\nWhich channel should the bot post **system logs and the control panel** to?',
        components: [
          {
            type: 1,
            components: [
              {
                type: 8,
                custom_id: 'setup_select_log_channel_force',
                placeholder: 'Select logging channel',
                min_values: 1,
                max_values: 1,
                channel_types: [0, 5]
              }
            ]
          }
        ]
      }
    });
  }

  if (body.type === 3 && body.data && typeof body.data.custom_id === 'string' &&
      (body.data.custom_id.startsWith('setup_select_log_channel') ||
       body.data.custom_id.startsWith('setup_alert:') ||
       body.data.custom_id.startsWith('setup_staff:') ||
       body.data.custom_id.startsWith('setup_skipstaff:'))) {
    if (!memberIsAdmin(body.member)) {
      return interactionResponse({
        content: '❌ Only users with Administrator permissions can complete the setup.',
        flags: EPHEMERAL_FLAG
      });
    }

    const setupId = body.data.custom_id;
    const selected = Array.isArray(body.data.values) && body.data.values[0];

    // Step 1 → 2: log channel chosen, ask for the alerts channel.
    if (setupId === 'setup_select_log_channel' || setupId === 'setup_select_log_channel_force') {
      if (setupId === 'setup_select_log_channel') {
        const setupDone = await env.STATUS_KV.get(`setup_done:${guildId}`);
        if (setupDone === 'true') {
          return interactionResponse({
            content: '❌ The `/setup` command has already been run in this server.',
            flags: EPHEMERAL_FLAG
          });
        }
      }
      if (!selected) {
        return interactionResponse({ content: '❌ No channel was selected.', flags: EPHEMERAL_FLAG });
      }
      return setupAlertChannelStep(selected);
    }

    // Step 2 → 3: alerts channel chosen, ask for the staff role.
    if (setupId.startsWith('setup_alert:')) {
      const logChannelId = setupId.slice('setup_alert:'.length);
      if (!selected) {
        return interactionResponse({ content: '❌ No channel was selected.', flags: EPHEMERAL_FLAG });
      }
      return setupStaffRoleStep(logChannelId, selected);
    }

    // Step 3: staff role chosen (or skipped) — finalize.
    const bits = setupId.split(':');
    const logChannelId = bits[1];
    const alertChannelId = bits[2];
    const staffRoleId = setupId.startsWith('setup_staff:') ? (selected || null) : null;
    if (!logChannelId || !alertChannelId) {
      return interactionResponse({ content: '❌ Setup state was lost — please run `/setup` again.', flags: EPHEMERAL_FLAG });
    }
    return handleSetupFinalize(body, env, ctx, guildId, logChannelId, alertChannelId, staffRoleId);
  }

  if (body.type === 3 && body.data && body.data.custom_id === 'cfg_general_action_select') {
    if (!(await canConfigure(body.member, env, guildId))) {
      return interactionResponse({
        content: 'You do not have permission to configure this bot.',
        flags: EPHEMERAL_FLAG
      });
    }

    const action = Array.isArray(body.data.values) && body.data.values[0];

    if (action === 'set_footer') {
      const config = await getConfig(env, guildId);
      const currentFooter = config.alert_embed_footer || '';
      return jsonResponse({
        type: 9,
        data: {
          title: 'Set Embed Footer Text',
          custom_id: 'modal_set_footer',
          components: [{
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_footer',
              style: 2,
              label: 'Custom Footer (or default)',
              placeholder: 'Howard County Public School System Daily Monitor',
              value: currentFooter,
              min_length: 1,
              max_length: 1000,
              required: true
            }]
          }]
        }
      });
    }

    if (action === 'to_schedule') {
      await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_schedule');
      const payload = await buildControlPanelPayload(env, guildId);
      return jsonResponse({ type: 7, data: payload });
    }

    if (action === 'to_toggles') {
      await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_toggles');
      const payload = await buildControlPanelPayload(env, guildId);
      return jsonResponse({ type: 7, data: payload });
    }

    return interactionResponse({ content: '❌ Unknown action.', flags: EPHEMERAL_FLAG });
  }

  if (body.type === 3 && body.data && typeof body.data.custom_id === 'string' && body.data.custom_id.startsWith('cfg_')) {
    if (!(await canConfigure(body.member, env, guildId))) {
      return interactionResponse({
        content: 'You do not have permission to configure this bot.',
        flags: EPHEMERAL_FLAG
      });
    }

    const freshConfig = await applyConfigUpdate(body, env);
    const cfgCustomId = body.data.custom_id;
    let pageHint = null;
    if (cfgCustomId.startsWith('cfg_schedpick_')) pageHint = 'config_schedule_add';
    else if (cfgCustomId === 'cfg_schedremove_select') pageHint = 'config_schedule';
    const payload = await buildControlPanelPayload(env, guildId, freshConfig, pageHint);
    return jsonResponse({
      type: 7,
      data: payload
    });
  }

  return interactionResponse({
    content: 'Interaction received.',
    flags: EPHEMERAL_FLAG
  });
}
