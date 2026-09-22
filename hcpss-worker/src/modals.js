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

  if (body.data && body.data.custom_id === 'modal_music_song') {
    const link = getModalInputValue(body, 'input_music_link').trim();
    return interactionResponse({
      content: `🎵 **The music bot only listens to real people!**\nCopy and send this command into the chat:\n\`\`\`\nm!play ${link}\n\`\`\``,
      flags: EPHEMERAL_FLAG
    });
  }

  if (body.data && body.data.custom_id === 'modal_dank_apply') {
    const firstName = getModalInputValue(body, 'dank_firstname').trim();
    const lastName = getModalInputValue(body, 'dank_lastname').trim();
    const eSignature = getModalInputValue(body, 'dank_esignature').trim();
    const invokerId = getInvokerId(body);
    const dankChannelId = await env.STATUS_KV.get(`dank_channel:${guildId}`);

    if (!dankChannelId) {
      return interactionResponse({
        content: '❌ Dank Memer applications are not configured on this server. Staff must run `/dankstaffsetup` first.',
        flags: EPHEMERAL_FLAG
      });
    }

    const embed = {
      title: 'New Dank Memer Application',
      color: 0xF1C40F, // yellow
      fields: [
        { name: 'User', value: `<@${invokerId}> (${invokerId})` },
        { name: 'Name', value: `${firstName} ${lastName}` },
        { name: 'E-signature', value: eSignature }
      ],
      timestamp: new Date().toISOString()
    };

    const postRes = await fetch(`https://discord.com/api/v10/channels/${dankChannelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: [embed],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Approve', custom_id: `dank_approve:${invokerId}` },
            { type: 2, style: 4, label: 'Disapprove', custom_id: `dank_disapprove:${invokerId}` }
          ]
        }]
      })
    });

    if (!postRes.ok) {
      return interactionResponse({
        content: `❌ Failed to send application to the staff channel. Discord API returned ${postRes.status}.`,
        flags: EPHEMERAL_FLAG
      });
    }

    await env.STATUS_KV.put(`dank_applied:${guildId}:${invokerId}`, 'true');

    return interactionResponse({
      content: '✅ Your application has been submitted to the staff. You will receive a DM when it is reviewed.',
      flags: EPHEMERAL_FLAG
    });
  }

  if (body.data && body.data.custom_id === 'modal_staff_apply') {
    const reason = getModalInputValue(body, 'staff_reason').trim();
    const experience = getModalInputValue(body, 'staff_experience').trim();
    const conflict = getModalInputValue(body, 'staff_conflict').trim();
    const age = getModalInputValue(body, 'staff_age').trim();
    const invokerId = getInvokerId(body);
    const staffAppChannelId = await env.STATUS_KV.get(`staffapp_channel:${guildId}`);

    if (!staffAppChannelId) {
      return interactionResponse({
        content: '❌ Staff applications are not configured on this server. Staff must run `/staffappsetup` first.',
        flags: EPHEMERAL_FLAG
      });
    }

    const embed = {
      title: 'New Staff Application',
      color: 0x3498DB, // blue
      fields: [
        { name: 'User', value: `<@${invokerId}> (${invokerId})` },
        { name: 'Why do you want to join the staff team?', value: reason.substring(0, 1024) },
        { name: 'Do you have any prior experience?', value: experience.substring(0, 1024) },
        { name: 'How do you handle conflict?', value: conflict.substring(0, 1024) },
        { name: 'What is your age?', value: age.substring(0, 1024) }
      ],
      timestamp: new Date().toISOString()
    };

    const postRes = await fetch(`https://discord.com/api/v10/channels/${staffAppChannelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: [embed],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Approve', custom_id: `staff_approve:${invokerId}` },
            { type: 2, style: 4, label: 'Disapprove', custom_id: `staff_disapprove:${invokerId}` }
          ]
        }]
      })
    });

    if (!postRes.ok) {
      return interactionResponse({
        content: `❌ Failed to send application to the staff channel. Discord API returned ${postRes.status}.`,
        flags: EPHEMERAL_FLAG
      });
    }

    await env.STATUS_KV.put(`staffapp_applied:${guildId}:${invokerId}`, 'true');

    return interactionResponse({
      content: '✅ Your staff application has been submitted to the team. You will receive a DM when it is reviewed.',
      flags: EPHEMERAL_FLAG
    });
  }

  if (body.data && body.data.custom_id === 'modal_join_apply') {
    const school = getModalInputValue(body, 'join_school').trim();
    const email = getModalInputValue(body, 'join_email').trim();
    const name = getModalInputValue(body, 'join_name').trim();
    const invokerId = getInvokerId(body);
    const joinAppChannelId = await env.STATUS_KV.get(`joinapp_channel:${guildId}`);
    const joinAppRoleId = await env.STATUS_KV.get(`joinapp_role:${guildId}`);

    if (!joinAppChannelId || !joinAppRoleId) {
      return interactionResponse({
        content: '❌ Server join applications are not fully configured. Staff must run `/joinsetup` first.',
        flags: EPHEMERAL_FLAG
      });
    }

    const embed = {
      title: 'New Join Application',
      color: email.endsWith('@inst.hcpss.org') ? 0x2ECC71 : 0xE67E22,
      fields: [
        { name: 'User', value: `<@${invokerId}> (${invokerId})` },
        { name: 'Name', value: name.substring(0, 1024) },
        { name: 'School', value: school.substring(0, 1024) },
        { name: 'Email', value: email.substring(0, 1024) }
      ],
      timestamp: new Date().toISOString()
    };

    let logMessage = '';

    if (email.endsWith('@inst.hcpss.org')) {
      const resp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${invokerId}/roles/${joinAppRoleId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          'X-Audit-Log-Reason': 'Auto-approved join application via verified email'
        }
      });
      if (!resp.ok) {
        logMessage = `⚠️ <@${invokerId}> provided a valid HCPSS email, but I failed to assign the role (Discord API ${resp.status}). Please assign it manually.`;
      } else {
        logMessage = `✅ <@${invokerId}> was **auto-approved** based on their provided HCPSS email.`;
      }
    } else {
      logMessage = `⚠️ <@${invokerId}> provided a non-HCPSS email (\`${email}\`). Please review manually.`;
    }

    const postRes = await fetch(`https://discord.com/api/v10/channels/${joinAppChannelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: logMessage,
        embeds: [embed]
      })
    });

    if (!postRes.ok) {
      return interactionResponse({
        content: `❌ Failed to send application to the staff log channel. Discord API returned ${postRes.status}.`,
        flags: EPHEMERAL_FLAG
      });
    }

    await env.STATUS_KV.put(`joinapp_applied:${guildId}:${invokerId}`, 'true');

    return interactionResponse({
      content: email.endsWith('@inst.hcpss.org') 
        ? '✅ Your application has been automatically approved and you should receive access shortly.'
        : '✅ Your application has been submitted and is pending manual review by staff.',
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

  if (modalId === 'modal_set_playlist') {
    const val = getModalInputValue(body, 'input_playlist').trim();
    if (!val || val.toLowerCase() === 'clear' || val.toLowerCase() === 'none') {
      delete config.music_playlist_url;
      updated = true;
    } else {
      config.music_playlist_url = val;
      updated = true;
    }
    // No need to redirect page, staying on config_music
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
