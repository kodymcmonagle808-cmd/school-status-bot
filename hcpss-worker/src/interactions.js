// Routes verified Discord interactions (slash commands, components, modals)
// to their handlers.

import {
  EPHEMERAL_FLAG,
  MAX_EMBEDS,
  POST_STATUS_COMMAND,
  OVERRIDE_COMMAND,
  ANNOUNCE_COMMAND,
  STATUS_LABELS,
  ALL_STATUS_LABELS,
  DEFAULT_CHECK_SCHEDULE,
  getDefaultStatusColor,
  getStatusThumbnail
} from './constants.js';
import {
  jsonResponse,
  interactionResponse,
  deferredInteractionResponse,
  updateInteractionOriginal,
  createGuildRole,
  memberIsAdmin,
  getModalInputValue,
  getInvokerId
} from './discord.js';
import { delay, formatScheduleTimeLabel } from './timeutil.js';
import { HCPSS_URL } from './scraper.js';
import { toggleSubscriber } from './subscriptions.js';
import {
  getConfig,
  setConfig,
  getEffectiveConfig,
  canUseCommands,
  canConfigure,
  setOverride,
  clearOverride
} from './config.js';
import { splitEmbeds, buildStatusPayload } from './embeds.js';
import {
  PANEL_NAV_TABS,
  buildControlPanelPayload,
  buildBotStatusPayload,
  applyConfigUpdate,
  postLog
} from './panel.js';
import { doCheckAndPost } from './check.js';
import { putCalendarEvent, deleteCalendarEvent } from './calendar.js';
import {
  runCalendarCommand,
  runHistoryCommand,
  runDistrictsCommand,
  runLogsCommand,
  runStatsCommand,
  runEventsCommand,
  runPostStatusCommand,
  runOverrideCommand,
  handlePanelSpeed,
  handlePanelKvDebug,
  handlePanelCheck,
  handlePanelRefresh,
  handlePanelClearLogs
} from './commands.js';
import { handleGreeterInteraction } from './greeter.js';

async function handleModalSubmit(body, env, ctx, guildId) {
  // Handle announce modal before the canConfigure gate (staff can announce)
  if (body.data && body.data.custom_id === 'modal_announce') {
    if (!(await canUseCommands(body.member, env, guildId))) {
      return interactionResponse({
        content: '❌ You do not have permission to use `/announce`.',
        flags: EPHEMERAL_FLAG
      });
    }

    const announceTitle = getModalInputValue(body, 'input_announce_title').trim();
    const announceBody = getModalInputValue(body, 'input_announce_body').trim();
    const announceFooter = getModalInputValue(body, 'input_announce_footer').trim();
    const channelId = body.channel_id || body.channel && body.channel.id || '';

    if (!announceTitle && !announceBody) {
      return interactionResponse({
        content: '❌ Please provide at least a title or message body.',
        flags: EPHEMERAL_FLAG
      });
    }

    if (!channelId) {
      return interactionResponse({
        content: '❌ Could not determine the channel to post in.',
        flags: EPHEMERAL_FLAG
      });
    }

    const invokerId = getInvokerId(body);
    const embed = {
      title: announceTitle || undefined,
      description: announceBody || undefined,
      color: 0x5865F2,
      footer: announceFooter ? { text: announceFooter } : { text: 'HCPSS Status Monitor' },
      timestamp: new Date().toISOString()
    };

    const postRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ embeds: [embed] })
    });

    if (!postRes.ok) {
      const errText = await postRes.text();
      console.error('Announce post failed:', errText);
      return interactionResponse({
        content: `❌ Failed to post announcement (Discord error ${postRes.status}). Make sure the bot has permission to send messages in this channel.`,
        flags: EPHEMERAL_FLAG
      });
    }

    const stored = await getConfig(env, guildId);
    const cfg = getEffectiveConfig(stored);
    await postLog(env, cfg.log_channel_id, `📣 Announcement posted to <#${channelId}>${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);

    return interactionResponse({
      content: `✅ Announcement posted to <#${channelId}>!`,
      flags: EPHEMERAL_FLAG
    });
  }

  if (!(await canConfigure(body.member, env, guildId))) {
    return interactionResponse({
      content: 'You do not have permission to configure this bot.',
      flags: EPHEMERAL_FLAG
    });
  }

  const modalId = body.data.custom_id;
  let config = await getConfig(env, guildId);
  let updated = false;

  if (modalId === 'modal_set_color') {
    const val = getModalInputValue(body, 'input_color').trim();
    const editingKey = config.editing_status_key || 'normal_operations';

    if (val.toLowerCase() === 'default' || val.toLowerCase() === 'none' || val.toLowerCase() === 'clear') {
      if (!config.status_embed_colors) config.status_embed_colors = {};
      delete config.status_embed_colors[editingKey];
      updated = true;
    } else {
      const hexMatch = val.match(/^#?([0-9A-Fa-f]{6})$/);
      if (hexMatch) {
        const colorInt = parseInt(hexMatch[1], 16);
        if (!config.status_embed_colors) config.status_embed_colors = {};
        config.status_embed_colors[editingKey] = colorInt;
        updated = true;
      } else {
        return interactionResponse({
          content: `❌ Invalid HEX color \`${val}\`. Use a 6-digit hex code (e.g. \`2ECC71\`).`,
          flags: EPHEMERAL_FLAG
        });
      }
    }
  }

  if (modalId === 'modal_set_footer') {
    const val = getModalInputValue(body, 'input_footer').trim();
    if (val.toLowerCase() === 'default' || val.toLowerCase() === 'none' || val.toLowerCase() === 'clear') {
      delete config.alert_embed_footer;
      updated = true;
    } else {
      config.alert_embed_footer = val.slice(0, 2048);
      updated = true;
    }
  }

  if (modalId === 'modal_add_event') {
    const dateStr = getModalInputValue(body, 'input_event_date').trim();
    const descStr = getModalInputValue(body, 'input_event_desc').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      await putCalendarEvent(env, guildId, dateStr, descStr);
      const invokerId = getInvokerId(body);
      await postLog(env, config.log_channel_id, `📅 Calendar event added: **${dateStr}** - *${descStr}*${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);
      updated = true;
    } else {
      return interactionResponse({
        content: '❌ Invalid date format. Please use `YYYY-MM-DD` (e.g. `2026-12-25`).',
        flags: EPHEMERAL_FLAG
      });
    }
  }

  if (modalId === 'modal_remove_event') {
    const dateStr = getModalInputValue(body, 'input_event_date').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      await deleteCalendarEvent(env, guildId, dateStr);
      const invokerId = getInvokerId(body);
      await postLog(env, config.log_channel_id, `📅 Calendar event removed for date: **${dateStr}**${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);
      updated = true;
    } else {
      return interactionResponse({
        content: '❌ Invalid date format. Please use `YYYY-MM-DD` (e.g. `2026-12-25`).',
        flags: EPHEMERAL_FLAG
      });
    }
  }

  if (modalId === 'modal_set_override') {
    const daysRaw = getModalInputValue(body, 'input_override_days').trim();
    const titleRaw = getModalInputValue(body, 'input_override_title').trim();
    const detailsRaw = getModalInputValue(body, 'input_override_details').trim();

    const daysParsed = parseInt(daysRaw, 10);
    if (isNaN(daysParsed) || daysParsed < 1 || daysParsed > 30) {
      return interactionResponse({
        content: '❌ Invalid duration. Please specify a number of days between 1 and 30.',
        flags: EPHEMERAL_FLAG
      });
    }

    const overrideStatusKey = config.editing_override_status_key || 'normal_operations';
    const statusLabel = STATUS_LABELS[overrideStatusKey] || 'Override';

    const overrideObj = {
      status_key: overrideStatusKey,
      status_label: statusLabel,
      details: detailsRaw,
      title: titleRaw,
      until: Date.now() + daysParsed * 24 * 60 * 60 * 1000
    };

    await setOverride(env, guildId, overrideObj);

    const invokerId = getInvokerId(body);
    await postLog(env, config.log_channel_id, `🛠️ Status override enabled: **${statusLabel}** for **${daysParsed} days**${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);

    ctx.waitUntil(doCheckAndPost(env, { source: 'override-set', invokerId, guildId }));

    await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_stats');
    delete config.editing_override_status_key;
    updated = true;
  }

  if (updated) {
    await setConfig(env, guildId, config);
  }

  const payload = await buildControlPanelPayload(env, guildId, updated ? config : null);
  return jsonResponse({
    type: 7,
    data: payload
  });
}

function handleSetupCommand(body, env, guildId, setupDone) {
  if (setupDone === 'true') {
    return jsonResponse({
      type: 4,
      data: {
        content: '⚠️ **HCPSS Status Monitor Setup Alert**\n\nThis command has already been run in this server. Running setup again will create duplicate notification roles and may disrupt your current configuration.\n\nAre you sure you want to proceed?',
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
      content: '⚙️ **HCPSS Status Monitor Setup — Step 1 of 3**\n\nWhich channel should the bot post **system logs and the control panel** to?',
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
function setupAlertChannelStep(logChannelId) {
  return jsonResponse({
    type: 7,
    data: {
      content: `⚙️ **HCPSS Status Monitor Setup — Step 2 of 3**\n\n` +
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

function setupStaffRoleStep(logChannelId, alertChannelId) {
  return jsonResponse({
    type: 7,
    data: {
      content: `⚙️ **HCPSS Status Monitor Setup — Step 3 of 3**\n\n` +
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

async function handlePanelComponent(body, env, ctx, guildId) {
  const customId = body.data.custom_id;

  if (customId === 'panel_nav_select') {
    const selected = Array.isArray(body.data.values) && body.data.values[0];
    const target = PANEL_NAV_TABS.some(t => t.value === selected) ? selected : 'dashboard';
    await env.STATUS_KV.put(`panel_page:${guildId}`, target);
    const payload = await buildControlPanelPayload(env, guildId);
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId === 'panel_view_select') {
    const selected = Array.isArray(body.data.values) && body.data.values[0];
    const allowed = ['dashboard_logs', 'dashboard_bot_status'];
    const target = allowed.includes(selected) ? selected : 'dashboard_logs';
    await env.STATUS_KV.put(`panel_page:${guildId}`, target);
    const payload = await buildControlPanelPayload(env, guildId);
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId === 'panel_action_select') {
    const action = Array.isArray(body.data.values) && body.data.values[0];
    if (action === 'panel_check') {
      ctx.waitUntil(handlePanelCheck(body, env));
      return deferredInteractionResponse();
    }
    if (action === 'panel_speed') {
      ctx.waitUntil(handlePanelSpeed(body, env));
      return deferredInteractionResponse();
    }
    if (action === 'panel_refresh') {
      ctx.waitUntil(handlePanelRefresh(body, env));
      return deferredInteractionResponse();
    }
    if (action === 'panel_history') {
      const payload = await runHistoryCommand(env, guildId);
      return interactionResponse(payload);
    }
    if (action === 'panel_logs') {
      const payload = await runLogsCommand(env, guildId);
      return interactionResponse(payload);
    }
    if (action === 'panel_kv_debug') {
      ctx.waitUntil(handlePanelKvDebug(body, env));
      return deferredInteractionResponse();
    }
    if (action === 'panel_clear_logs') {
      ctx.waitUntil(handlePanelClearLogs(body, env));
      return deferredInteractionResponse();
    }
    // Any other option value is dispatched as if a component with that
    // custom_id was used, so page action dropdowns can reuse the existing
    // navigation/modal handlers below.
    if (typeof action === 'string' && action.startsWith('panel_') && action !== 'panel_action_select') {
      const forwarded = { ...body, data: { ...body.data, custom_id: action, values: [] } };
      return await handlePanelComponent(forwarded, env, ctx, guildId);
    }
    return interactionResponse({ content: '❌ Unknown action.', flags: EPHEMERAL_FLAG });
  }

  // Direct-button variants of the quick actions (kept for older panel messages)
  if (customId === 'panel_speed') {
    ctx.waitUntil(handlePanelSpeed(body, env));
    return deferredInteractionResponse();
  }

  if (customId === 'panel_check') {
    ctx.waitUntil(handlePanelCheck(body, env));
    return deferredInteractionResponse();
  }

  if (customId === 'panel_history') {
    const payload = await runHistoryCommand(env, guildId);
    return interactionResponse(payload);
  }

  if (customId === 'panel_logs') {
    const payload = await runLogsCommand(env, guildId);
    return interactionResponse(payload);
  }

  if (customId === 'panel_refresh') {
    ctx.waitUntil(handlePanelRefresh(body, env));
    return deferredInteractionResponse();
  }

  if (customId === 'panel_clear_logs') {
    ctx.waitUntil(handlePanelClearLogs(body, env));
    return deferredInteractionResponse();
  }

  // Simple page-navigation buttons share one pattern: panel_to_<page>.
  const NAV_BUTTON_PAGES = {
    panel_to_config_general: 'config_general',
    panel_to_config_status: 'config_status',
    panel_to_config_schedule: 'config_schedule',
    panel_to_config_toggles: 'config_toggles',
    panel_to_config_calendar: 'config_calendar',
    panel_to_config_stats: 'config_stats',
    panel_to_config_override_select: 'config_override_select',
    panel_to_config_commands: 'config_commands',
    panel_to_dashboard: 'dashboard',
    panel_to_dashboard_logs: 'dashboard_logs'
  };
  if (NAV_BUTTON_PAGES[customId]) {
    await env.STATUS_KV.put(`panel_page:${guildId}`, NAV_BUTTON_PAGES[customId]);
    const payload = await buildControlPanelPayload(env, guildId);
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId === 'panel_to_dashboard_bot_status') {
    await env.STATUS_KV.put(`panel_page:${guildId}`, 'dashboard_bot_status');

    ctx.waitUntil((async () => {
      const frames = [0.15, 0.4, 0.7, 1];
      for (let i = 0; i < frames.length; i++) {
        const payload = await buildBotStatusPayload(env, guildId, frames[i]);
        await updateInteractionOriginal(env, body.token, payload);
        if (i < frames.length - 1) await delay(450);
      }
    })());

    return jsonResponse({ type: 6 });
  }

  if (customId === 'panel_btn_clear_override') {
    await clearOverride(env, guildId);
    const invokerId = getInvokerId(body);
    ctx.waitUntil(doCheckAndPost(env, { source: 'override-clear', invokerId, guildId }));
    await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_stats');
    const payload = await buildControlPanelPayload(env, guildId);
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId === 'panel_btn_reset_schedule') {
    if (!(await canConfigure(body.member, env, guildId))) {
      return interactionResponse({
        content: 'You do not have permission to configure this bot.',
        flags: EPHEMERAL_FLAG
      });
    }
    const storedCfg = await getConfig(env, guildId);
    storedCfg.check_schedule = [...DEFAULT_CHECK_SCHEDULE];
    await setConfig(env, guildId, storedCfg);
    const invokerId = getInvokerId(body);
    await postLog(env, getEffectiveConfig(storedCfg).log_channel_id, `🗓️ Check schedule reset to defaults${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);
    const payload = await buildControlPanelPayload(env, guildId, storedCfg);
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId === 'panel_btn_add_time') {
    const storedCfg = await getConfig(env, guildId);
    const effectiveCfg = getEffectiveConfig(storedCfg);
    if ((effectiveCfg.check_schedule || []).length >= 4) {
      return interactionResponse({
        content: '❌ You already have 4 check times. Remove one first.',
        flags: EPHEMERAL_FLAG
      });
    }
    await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_schedule_add');
    const payload = await buildControlPanelPayload(env, guildId, storedCfg, 'config_schedule_add');
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId.startsWith('panel_btn_confirm_add_time')) {
    if (!(await canConfigure(body.member, env, guildId))) {
      return interactionResponse({
        content: 'You do not have permission to configure this bot.',
        flags: EPHEMERAL_FLAG
      });
    }

    // The picked time is encoded in the button's custom_id so the add is
    // always exactly what the panel displayed, independent of KV staleness.
    const bits = customId.split(':');
    const hours = parseInt(bits[1], 10);
    const mm = bits[2] || '';
    if (isNaN(hours) || hours > 23 || !/^\d{2}$/.test(mm) || parseInt(mm, 10) > 59) {
      return interactionResponse({
        content: '❌ Could not read the picked time. Please try again.',
        flags: EPHEMERAL_FLAG
      });
    }
    const newTime = `${hours}:${mm}`;

    const storedCfg = await getConfig(env, guildId);
    const current = getEffectiveConfig(storedCfg).check_schedule || [];
    if (current.length >= 4 && !current.includes(newTime)) {
      return interactionResponse({
        content: '❌ You already have 4 check times. Remove one first.',
        flags: EPHEMERAL_FLAG
      });
    }

    const merged = current.includes(newTime) ? current.slice() : [...current, newTime];
    merged.sort((a, b) => {
      const [ah, am] = a.split(':').map(Number);
      const [bh, bm] = b.split(':').map(Number);
      return (ah * 60 + am) - (bh * 60 + bm);
    });
    storedCfg.check_schedule = merged;
    delete storedCfg.schedule_pick;
    await setConfig(env, guildId, storedCfg);

    const invokerId = getInvokerId(body);
    await postLog(env, getEffectiveConfig(storedCfg).log_channel_id, `🗓️ Check time added: **${formatScheduleTimeLabel(newTime)}**${invokerId ? ` by <@${invokerId}>` : ''}.`, {}, guildId);

    await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_schedule');
    const payload = await buildControlPanelPayload(env, guildId, storedCfg, 'config_schedule');
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId === 'panel_btn_add_event') {
    return jsonResponse({
      type: 9,
      data: {
        title: 'Add Calendar Event',
        custom_id: 'modal_add_event',
        components: [
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_event_date',
              style: 1,
              label: 'Date (YYYY-MM-DD)',
              placeholder: '2026-12-25',
              min_length: 10,
              max_length: 10,
              required: true
            }]
          },
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_event_desc',
              style: 1,
              label: 'Event Description',
              placeholder: 'Christmas Holiday - Schools Closed',
              max_length: 200,
              required: true
            }]
          }
        ]
      }
    });
  }

  if (customId === 'panel_btn_remove_event') {
    return jsonResponse({
      type: 9,
      data: {
        title: 'Remove Calendar Event',
        custom_id: 'modal_remove_event',
        components: [{
          type: 1,
          components: [{
            type: 4,
            custom_id: 'input_event_date',
            style: 1,
            label: 'Date of Event to Remove (YYYY-MM-DD)',
            placeholder: '2026-12-25',
            min_length: 10,
            max_length: 10,
            required: true
          }]
        }]
      }
    });
  }

  if (customId === 'panel_btn_override_details') {
    const config = await getConfig(env, guildId);
    const overrideStatusKey = config.editing_override_status_key || 'normal_operations';
    const statusLabel = STATUS_LABELS[overrideStatusKey] || 'Override';

    return jsonResponse({
      type: 9,
      data: {
        title: `Set Override: ${statusLabel.split(' ')[0]}`,
        custom_id: 'modal_set_override',
        components: [
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_override_days',
              style: 1,
              label: 'Duration in Days (1-30)',
              placeholder: '1',
              min_length: 1,
              max_length: 2,
              required: true
            }]
          },
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_override_title',
              style: 1,
              label: 'Embed Title Override (Optional)',
              placeholder: `HCPSS Status (Override) - ${statusLabel}`,
              required: false,
              max_length: 256
            }]
          },
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_override_details',
              style: 2,
              label: 'Details/Reason (Optional)',
              placeholder: 'Inclement weather conditions...',
              required: false,
              max_length: 1000
            }]
          }
        ]
      }
    });
  }

  if (customId === 'panel_btn_set_color') {
    const config = await getConfig(env, guildId);
    const editingKey = config.editing_status_key || 'normal_operations';
    const statusLabel = ALL_STATUS_LABELS[editingKey] || editingKey;

    return jsonResponse({
      type: 9,
      data: {
        title: `Set Color: ${statusLabel.split(' ')[0]}`,
        custom_id: 'modal_set_color',
        components: [{
          type: 1,
          components: [{
            type: 4,
            custom_id: 'input_color',
            style: 1,
            label: `HEX Color for ${statusLabel.split(' ')[0]} (or default)`,
            placeholder: '2ECC71',
            min_length: 1,
            max_length: 10,
            required: true
          }]
        }]
      }
    });
  }

  if (customId === 'panel_btn_set_footer') {
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

  return null;
}

function handleTestAlert(body, env, ctx, guildId) {
  const selectedStatusKey = body.data.values && body.data.values[0];
  if (!selectedStatusKey) {
    return interactionResponse({
      content: '❌ No status was selected.',
      flags: EPHEMERAL_FLAG
    });
  }

  ctx.waitUntil((async () => {
    try {
      const token = env.DISCORD_BOT_TOKEN;
      const invokerId = getInvokerId(body);
      const stored = await getConfig(env, guildId);
      const config = getEffectiveConfig(stored);
      const alertChannelId = config.alert_channel_id || (guildId === env.DISCORD_GUILD_ID ? env.DISCORD_CHANNEL_ID : null);
      const logChannelId = config.log_channel_id;

      if (!alertChannelId) {
        await updateInteractionOriginal(env, body.token, {
          content: '❌ Scraper test failed: Alert channel is not configured. Please set it in **General Config**.',
          components: []
        });
        return;
      }

      const MOCK_DATA = {
        normal_operations: {
          title: 'Normal Operations',
          body: 'All schools and offices will open on time. Staff and students report in accordance with the HCPSS calendar.'
        },
        schools_closed: {
          title: 'Schools Closed',
          body: 'All Howard County public schools are closed today. All evening activities are cancelled.'
        },
        schools_and_offices_closed: {
          title: 'Schools and Offices Closed',
          body: 'All Howard County public schools and offices are closed today. Emergency personnel report as scheduled.'
        },
        schools_open_2_hours_late: {
          title: 'Schools Open 2 Hours Late',
          body: 'All Howard County public schools will open two hours late today. Morning pre-K and half-day classes are cancelled.'
        },
        schools_close_3_hours_early: {
          title: 'Schools Close 3 Hours Early',
          body: 'All Howard County public schools will close three hours early today. Afternoon pre-K and evening activities are cancelled.'
        },
        unknown_alert: {
          title: 'Special Notice / Alert',
          body: 'The HCPSS status page has posted a custom/unknown weather notice. Please consult the HCPSS website for specific details.'
        }
      };

      const mock = MOCK_DATA[selectedStatusKey] || MOCK_DATA.unknown_alert;
      const cards = [{
        title: mock.title,
        body: `🧪 **[TEST ALERT - SIMULATED STATUS]**\n\n${mock.body}`
      }];

      const statusKey = selectedStatusKey;
      let roleId = undefined;
      if (config.status_ping_roles) {
        roleId = config.status_ping_roles[statusKey];
      }

      let rolesToPing = [];
      const pingRoleIds = Array.isArray(config.ping_role_ids) ? config.ping_role_ids : [];
      if (roleId) {
        rolesToPing = [roleId];
      } else if (roleId === undefined && statusKey !== 'normal_operations') {
        rolesToPing = pingRoleIds;
      }

      const content = rolesToPing.length ? rolesToPing.map(id => `<@&${id}>`).join(' ') : '';
      const customFooter = config.alert_embed_footer || 'HCPSS Status Monitor';
      const color = config.status_embed_colors && typeof config.status_embed_colors[statusKey] === 'number'
        ? config.status_embed_colors[statusKey]
        : getDefaultStatusColor(statusKey);

      const thumbnailUrl = getStatusThumbnail(statusKey);
      const embeds = splitEmbeds(
        `HCPSS Status for Today (Test)`,
        cards[0].body,
        HCPSS_URL,
        color,
        customFooter,
        new Date(),
        thumbnailUrl
      ).slice(0, MAX_EMBEDS);

      const postResp = await fetch(`https://discord.com/api/v10/channels/${alertChannelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content,
          embeds,
          allowed_mentions: rolesToPing.length ? { roles: rolesToPing } : { parse: [] }
        })
      });

      if (!postResp.ok) {
        const errTxt = await postResp.text();
        throw new Error(`Discord API error posting test message: ${postResp.status} ${errTxt}`);
      }

      await postLog(
        env,
        logChannelId,
        `🧪 Scraper test alert for '${statusKey}' triggered by <@${invokerId}>. Sent to <#${alertChannelId}>.`,
        {},
        guildId
      );

      await updateInteractionOriginal(env, body.token, {
        content: `✅ **Diagnostic Test Successful!**\n\n` +
                 `• Status Simulated: **${ALL_STATUS_LABELS[selectedStatusKey] || selectedStatusKey}**\n` +
                 `• Alert Channel: <#${alertChannelId}>\n` +
                 `• Role Pings: ${rolesToPing.length ? rolesToPing.map(id => `<@&${id}>`).join(', ') : '*(none)*'}\n\n` +
                 `Check <#${alertChannelId}> to see the rendered test embed card.`,
        components: []
      });
    } catch (err) {
      console.error('Test alert failed:', err);
      await updateInteractionOriginal(env, body.token, {
        content: `❌ **Test Alert Failed:** ${err.message}`,
        components: []
      });
    }
  })());

  return deferredInteractionResponse();
}

function handleSetupFinalize(body, env, ctx, guildId, selectedChannelId, alertChannelId, staffRoleId) {
  const setupDoneKey = `setup_done:${guildId}`;

  ctx.waitUntil((async () => {
    try {
      await updateInteractionOriginal(env, body.token, {
        content: '⚙️ **HCPSS Status Monitor Setup**\n\n⏳ Creating status notification roles and configuring the bot...',
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

      await postLog(env, selectedChannelId, 'Bot setup completed successfully. Notification roles created and registered.', {}, guildId);

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

  if (body.type === 2 && body.data && body.data.name === 'calendar') {
    const payload = await runCalendarCommand(env, guildId);
    return interactionResponse(payload);
  }

  if (body.type === 2 && body.data && body.data.name === 'history') {
    const payload = await runHistoryCommand(env, guildId);
    return interactionResponse(payload);
  }

  if (body.type === 2 && body.data && body.data.name === 'districts') {
    ctx.waitUntil((async () => {
      const payload = await runDistrictsCommand(env);
      await updateInteractionOriginal(env, body.token, payload);
    })());
    return deferredInteractionResponse();
  }

  if (body.type === 2 && body.data && body.data.name === 'events') {
    ctx.waitUntil(runEventsCommand(body, env));
    return deferredInteractionResponse();
  }

  if (body.type === 2 && body.data && body.data.name === 'stats') {
    const payload = await runStatsCommand(env, guildId);
    return interactionResponse(payload);
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
