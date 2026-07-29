// Control panel component handlers: navigation, quick actions, schedule
// editing, modals launchers, and the scraper test alert. Split out of
// interactions.js.

import {
  EPHEMERAL_FLAG,
  MAX_EMBEDS,
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
  followupInteractionMessage,
  getInvokerId
} from './discord.js';
import { delay, formatScheduleTimeLabel } from './timeutil.js';
import { HCPSS_URL } from './scraper.js';
import { getConfig, setConfig, getEffectiveConfig, canConfigure, clearOverride } from './config.js';
import { splitEmbeds } from './embeds.js';
import { PANEL_NAV_TABS, buildControlPanelPayload, buildBotStatusPayload, buildWorkerUpdatesPayload } from './panel.js';
import { logAction } from './actionlog.js';
import { isGuildBlocked, setGuildBlocked } from './blocklist.js';
import { doCheckAndPost } from './check.js';
import {
  runHistoryCommand,
  runLogsCommand,
  handlePanelSpeed,
  handlePanelKvDebug,
  handlePanelCheck,
  handlePanelRefresh,
  handlePanelClearLogs
} from './commands.js';

// Panel page navigation replies with a type-7 message update: an inline edit
// of the panel message that is the interaction's direct response, so it always
// renders. The payload build stays fast (buildControlPanelPayload fans its KV
// reads out with Promise.all) so it clears Discord's 3-second component
// deadline. `target` is passed as the page override so the render doesn't race
// the KV write of the same key (KV is not read-your-own-write consistent).
async function renderPanelNav(env, body, guildId, target) {
  await env.STATUS_KV.put(`panel_page:${guildId}`, target);
  const payload = await buildControlPanelPayload(env, guildId, null, target);
  return jsonResponse({ type: 7, data: payload });
}

export async function handlePanelComponent(body, env, ctx, guildId) {
  const customId = body.data.custom_id;

  if (customId === 'panel_nav_select') {
    const selected = Array.isArray(body.data.values) && body.data.values[0];

    // Owner-only page: delivered ephemerally (never rendered into the shared
    // panel message). The initial response is a type-7 re-render of the
    // panel's stored page so the nav select doesn't stay stuck on "Worker
    // Updates"; the actual content goes out as an ephemeral follow-up.
    // OWNER_ID is a worker secret; unset means the page is locked for everyone.
    if (selected === 'worker_updates') {
      const ownerId = String(env.OWNER_ID || '').trim();
      const isOwner = ownerId && getInvokerId(body) === ownerId;
      // Ack instantly (type 6 — deferred update) so slow page builds can't
      // hit Discord's 3-second deadline, then reset the shared panel to its
      // stored page (un-sticking the select) and deliver the owner page — or
      // the lock notice — as an ephemeral follow-up.
      ctx.waitUntil((async () => {
        try {
          const panelPayload = await buildControlPanelPayload(env, guildId);
          await updateInteractionOriginal(env, body.token, panelPayload);
        } catch (e) {
          console.error('Panel reset after worker_updates select failed:', e);
        }
        if (!isOwner) {
          await followupInteractionMessage(env, body.token, {
            content: '🔒 Worker Updates is only visible to the bot owner.',
            flags: EPHEMERAL_FLAG
          });
          return;
        }
        try {
          const ownerPayload = await buildWorkerUpdatesPayload(env);
          await followupInteractionMessage(env, body.token, { ...ownerPayload, flags: EPHEMERAL_FLAG });
        } catch {
          await followupInteractionMessage(env, body.token, {
            content: '⚠️ Could not build the Worker Updates page — try again in a minute.',
            flags: EPHEMERAL_FLAG
          });
        }
      })());
      return jsonResponse({ type: 6 });
    }

    const target = PANEL_NAV_TABS.some(t => t.value === selected) ? selected : 'dashboard';
    return renderPanelNav(env, body, guildId, target);
  }

  // Owner-only: toggle a server's lockdown from the Worker Updates page.
  // Lives on an ephemeral message only the owner can see, but verify anyway.
  if (customId === 'panel_owner_lock_select') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({
        content: '🔒 Only the bot owner can manage server lockdowns.',
        flags: EPHEMERAL_FLAG
      });
    }
    const target = Array.isArray(body.data.values) && body.data.values[0];
    if (!target || target === env.DISCORD_GUILD_ID) {
      return interactionResponse({ content: '❌ The home server cannot be locked down.', flags: EPHEMERAL_FLAG });
    }
    const nowBlocked = !(await isGuildBlocked(env, target));
    await setGuildBlocked(env, target, nowBlocked);
    const payload = await buildWorkerUpdatesPayload(env);
    return jsonResponse({ type: 7, data: { ...payload, flags: EPHEMERAL_FLAG } });
  }

  if (customId === 'panel_view_select') {
    const selected = Array.isArray(body.data.values) && body.data.values[0];
    const allowed = ['dashboard_logs', 'dashboard_bot_status'];
    const target = allowed.includes(selected) ? selected : 'dashboard_logs';
    return renderPanelNav(env, body, guildId, target);
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
      const payload = await runLogsCommand(env, guildId, getInvokerId(body));
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
    const payload = await runLogsCommand(env, guildId, getInvokerId(body));
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
    return renderPanelNav(env, body, guildId, NAV_BUTTON_PAGES[customId]);
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
    // The type-7 response below re-renders the panel message itself, so this
    // needs no panel write — only the Cloudflare log line.
    logAction(`🗓️ Check schedule reset to defaults${invokerId ? ` by <@${invokerId}>` : ''}.`, { guildId });
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
    logAction(`🗓️ Check time added: **${formatScheduleTimeLabel(newTime)}**${invokerId ? ` by <@${invokerId}>` : ''}.`, { guildId });

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

export function handleTestAlert(body, env, ctx, guildId) {
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
      const customFooter = config.alert_embed_footer || 'School Status';
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

      logAction(`🧪 Scraper test alert for '${statusKey}' triggered by <@${invokerId}>. Sent to <#${alertChannelId}>.`, { guildId });

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
