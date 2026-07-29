// Modal submit handlers: announce, embed color/footer, calendar events, and
// status overrides. Split out of interactions.js.

import { EPHEMERAL_FLAG, STATUS_LABELS } from './constants.js';
import {
  jsonResponse,
  interactionResponse,
  getModalInputValue,
  getInvokerId
} from './discord.js';
import {
  getConfig,
  setConfig,
  canUseCommands,
  canConfigure,
  setOverride
} from './config.js';
import { buildControlPanelPayload } from './panel.js';
import { logAction } from './actionlog.js';
import { doCheckAndPost } from './check.js';
import { putCalendarEvent, deleteCalendarEvent } from './calendar.js';

export async function handleModalSubmit(body, env, ctx, guildId) {
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
      footer: announceFooter ? { text: announceFooter } : { text: 'School Status' },
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

    logAction(`📣 Announcement posted to <#${channelId}>${invokerId ? ` by <@${invokerId}>` : ''}.`, { guildId });

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
      logAction(`📅 Calendar event added: **${dateStr}** - *${descStr}*${invokerId ? ` by <@${invokerId}>` : ''}.`, { guildId });
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
      logAction(`📅 Calendar event removed for date: **${dateStr}**${invokerId ? ` by <@${invokerId}>` : ''}.`, { guildId });
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
    logAction(`🛠️ Status override enabled: **${statusLabel}** for **${daysParsed} days**${invokerId ? ` by <@${invokerId}>` : ''}.`, { guildId });

    // The check this kicks off posts the override and re-renders the panel, so
    // the dashboard's "Active Override" line updates without a log write here.
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
