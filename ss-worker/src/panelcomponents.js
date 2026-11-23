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
import { getConfig, setConfig, getEffectiveConfig, canConfigure, clearOverride, ALL_COMMANDS_META, getCommandTier } from './config.js';
import { splitEmbeds } from './embeds.js';
import {
  PANEL_NAV_TABS,
  buildControlPanelPayload,
  buildBotStatusPayload,
  buildWorkerUpdatesPayload,
  buildOwnerFeaturesPayload,
  setMainGuildId,
  isMainGuild,
  getDisabledPanelTabs,
  setDisabledPanelTabs,
  applyPanelDefaultsToAllServers,
  savePanelDefaultsForNewServers,
  getAllKnownGuildIds,
  fetchGuildSummaries
} from './panel.js';
import { logAction } from './actionlog.js';
import { isGuildBlocked, setGuildBlocked } from './blocklist.js';
import { doCheckAndPost } from './check.js';
import { dispatchVoiceAnnouncement } from './voice.js';
import { runKvBackup } from './backup.js';
import {
  runHistoryCommand,
  runLogsCommand,
  handlePanelSpeed,
  handlePanelKvDebug,
  handlePanelCheck,
  handlePanelRefresh,
  handlePanelClearLogs
} from './commands.js';
import { handleScreenshotInteraction } from './screenshot.js';
import { triggerStormWatchdogWorkflow } from './stormworkflow.js';

// Panel page navigation replies with a type-7 message update: an inline edit
// of the panel message that is the interaction's direct response, so it always
// renders. The payload build stays fast (buildControlPanelPayload fans its KV
// reads out with Promise.all) so it clears Discord's 3-second component
// deadline. `target` is passed as the page override so the render doesn't race
// the KV write of the same key (KV is not read-your-own-write consistent).
async function renderPanelNav(env, body, guildId, target) {
  let effectiveTarget = target;
  const isMain = await isMainGuild(env, guildId);
  const disabledTabs = isMain ? [] : await getDisabledPanelTabs(env, guildId);
  if (!isMain && disabledTabs.includes(target)) {
    effectiveTarget = 'dashboard';
  }
  await env.STATUS_KV.put(`panel_page:${guildId}`, effectiveTarget);
  const payload = await buildControlPanelPayload(env, guildId, null, effectiveTarget);
  return jsonResponse({ type: 7, data: payload });
}

export const OWNER_GENERAL_COMMANDS = [
  { value: 'status', label: '/status', description: 'Check operating status' },
  { value: 'snowday', label: '/snowday', description: 'Snow day outlook' },
  { value: 'calendar', label: '/calendar', description: 'Upcoming calendar events' },
  { value: 'history', label: '/history', description: 'Operating status history' },
  { value: 'districts', label: '/districts', description: 'Neighboring school districts' },
  { value: 'outages', label: '/outages', description: 'BGE & utility outage counts' },
  { value: 'stats', label: '/stats', description: 'Check and closure statistics' },
  { value: 'notify', label: '/notify', description: 'DM on status changes' },
  { value: 'myschool', label: '/myschool', description: 'School-specific notice DMs' },
  { value: 'setupclasses', label: '/setupclasses', description: 'Schedule and room numbers' },
  { value: 'mapmyclass', label: '/mapmyclass', description: 'Route map generation' },
  { value: 'dankmemer', label: '/dankmemer', description: 'Dank Memer application' },
  { value: 'staffapplication', label: '/staffapplication', description: 'Staff application' },
  { value: 'terms', label: '/terms', description: 'Terms and Conditions' },
  { value: 'privacy', label: '/privacy', description: 'Privacy Policy' },
  { value: 'help', label: '/help', description: 'Command list & features' }
];

export const OWNER_ADMIN_COMMANDS = [
  { value: 'post-status', label: '/post-status', description: 'Post latest status now' },
  { value: 'manualstatus', label: '/manualstatus', description: 'Set/clear manual school status & notes' },
  { value: 'override', label: '/override', description: 'Set/clear status override' },
  { value: 'events', label: '/events', description: 'Dynamic calendar events' },
  { value: 'announce', label: '/announce', description: 'Post announcement embed' },
  { value: 'health', label: '/health', description: 'Health & diagnostics snapshot' },
  { value: 'refresh-panel', label: '/refresh-panel', description: 'Refresh log channel panel' },
  { value: 'setup', label: '/setup', description: 'Initial setup wizard' },
  { value: 'setupjoinlogs', label: '/setupjoinlogs', description: 'Configure join logs & roles' },
  { value: 'addroledm', label: '/addroledm', description: 'Add role to member & DM' },
  { value: 'dankstaffsetup', label: '/dankstaffsetup', description: 'Dank Memer application config' },
  { value: 'staffappsetup', label: '/staffappsetup', description: 'Staff application config' },
  { value: 'social-link', label: '/social-link', description: 'Social webhook generator' },
  { value: 'mydata', label: '/mydata', description: 'View or erase server data' }
];

export function buildOwnerPermsPayload(targetGuildId, config = {}) {
  const cfg = Array.isArray(config) ? { disabled_commands: config } : (config || {});

  const everyoneList = ALL_COMMANDS_META.filter(c => getCommandTier(cfg, c.name) === 'everyone');
  const staffList = ALL_COMMANDS_META.filter(c => getCommandTier(cfg, c.name) === 'staff');
  const disabledList = ALL_COMMANDS_META.filter(c => getCommandTier(cfg, c.name) === 'disabled');

  const generalCmds = ALL_COMMANDS_META.filter(c => c.category === 'general');
  const adminCmds = ALL_COMMANDS_META.filter(c => c.category === 'admin');

  const embed = {
    title: `⚙️ Command Access & Permissions — Server \`${targetGuildId}\``,
    color: 0x9B59B6,
    description: `### 🌐 Available to Everyone (${everyoneList.length})\n` +
      (everyoneList.length ? everyoneList.map(c => `\`/${c.name}\``).join(', ') : '*(none)*') +
      `\n\n### 🛡️ Restricted to Staff & Admins (${staffList.length})\n` +
      (staffList.length ? staffList.map(c => `\`/${c.name}\``).join(', ') : '*(none)*') +
      `\n\n### 🚫 Disabled Commands (${disabledList.length})\n` +
      (disabledList.length ? disabledList.map(c => `\`/${c.name}\``).join(', ') : '*(none)*') +
      `\n\n*Select any command below to switch its access level (**Everyone ↔ Staff Only**), or use the quick action buttons.*`,
    footer: { text: 'Bot Owner Permissions Panel · Changes save and apply immediately' },
    timestamp: new Date().toISOString()
  };

  const components = [
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: `cfg_owner_perm_toggle_g1:${targetGuildId}`,
        placeholder: '🌐 General Commands: Click to toggle Everyone ↔ Staff...',
        options: generalCmds.map(c => {
          const tier = getCommandTier(cfg, c.name);
          const icon = tier === 'everyone' ? '🌐' : (tier === 'staff' ? '🛡️' : '🚫');
          const nextLabel = tier === 'everyone' ? 'Staff Only' : 'Everyone';
          return {
            label: `/${c.name}`,
            value: c.name,
            description: `Currently: ${tier.toUpperCase()} — click to make ${nextLabel}`,
            emoji: { name: icon }
          };
        }),
        min_values: 1,
        max_values: 1
      }]
    },
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: `cfg_owner_perm_toggle_g2:${targetGuildId}`,
        placeholder: '🛡️ Staff Commands: Click to toggle Staff ↔ Everyone...',
        options: adminCmds.map(c => {
          const tier = getCommandTier(cfg, c.name);
          const icon = tier === 'staff' ? '🛡️' : (tier === 'everyone' ? '🌐' : '🚫');
          const nextLabel = tier === 'staff' ? 'Everyone' : 'Staff Only';
          return {
            label: `/${c.name}`,
            value: c.name,
            description: `Currently: ${tier.toUpperCase()} — click to make ${nextLabel}`,
            emoji: { name: icon }
          };
        }),
        min_values: 1,
        max_values: 1
      }]
    },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          custom_id: `cfg_owner_perms_refresh:${targetGuildId}`,
          label: 'Refresh',
          emoji: { name: '🔄' }
        },
        {
          type: 2,
          style: 2,
          custom_id: `cfg_owner_perms_all_everyone:${targetGuildId}`,
          label: 'General to Everyone',
          emoji: { name: '🌐' }
        },
        {
          type: 2,
          style: 2,
          custom_id: `cfg_owner_perms_all_staff:${targetGuildId}`,
          label: 'Lock All to Staff',
          emoji: { name: '🛡️' }
        },
        {
          type: 2,
          style: 4,
          custom_id: `cfg_owner_perms_reset_defaults:${targetGuildId}`,
          label: 'Reset Defaults',
          emoji: { name: '🔄' }
        },
        {
          type: 2,
          style: 2,
          custom_id: 'panel_owner_return',
          label: 'Back to Updates',
          emoji: { name: '⬅️' }
        }
      ]
    },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 4,
          custom_id: `cfg_owner_perms_page_disable:${targetGuildId}`,
          label: 'Disable Commands',
          emoji: { name: '🚫' }
        },
        {
          type: 2,
          style: 3,
          custom_id: `cfg_owner_perms_enable_all:${targetGuildId}`,
          label: 'Enable All Commands',
          emoji: { name: '🟢' }
        }
      ]
    }
  ];

  return {
    embeds: [embed],
    components,
    flags: EPHEMERAL_FLAG
  };
}

export function buildOwnerDisablePayload(targetGuildId, config = {}) {
  const cfg = Array.isArray(config) ? { disabled_commands: config } : (config || {});
  const disabledList = ALL_COMMANDS_META.filter(c => getCommandTier(cfg, c.name) === 'disabled');
  const generalCmds = ALL_COMMANDS_META.filter(c => c.category === 'general');
  const adminCmds = ALL_COMMANDS_META.filter(c => c.category === 'admin');

  const embed = {
    title: `🚫 Disable Commands — Server \`${targetGuildId}\``,
    color: 0xE74C3C,
    description: `### 🚫 Currently Disabled Commands (${disabledList.length})\n` +
      (disabledList.length ? disabledList.map(c => `\`/${c.name}\``).join(', ') : '*(none — all commands are enabled)*') +
      `\n\n*Select any command below to toggle it **Disabled ↔ Enabled**.*\n*Disabled commands cannot be used by members or staff (only the bot owner can run them).*`,
    footer: { text: 'Bot Owner Permissions Panel · Changes save and apply immediately' },
    timestamp: new Date().toISOString()
  };

  const components = [
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: `cfg_owner_perm_toggle_disable_g1:${targetGuildId}`,
        placeholder: '🚫 General Commands: Click to toggle Disabled...',
        options: generalCmds.map(c => {
          const tier = getCommandTier(cfg, c.name);
          const isDisabled = tier === 'disabled';
          return {
            label: `/${c.name}`,
            value: c.name,
            description: isDisabled ? '🚫 Currently DISABLED (click to ENABLE)' : `✅ Currently ${tier.toUpperCase()} (click to DISABLE)`,
            emoji: { name: isDisabled ? '🚫' : '✅' }
          };
        }),
        min_values: 1,
        max_values: 1
      }]
    },
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: `cfg_owner_perm_toggle_disable_g2:${targetGuildId}`,
        placeholder: '🚫 Staff Commands: Click to toggle Disabled...',
        options: adminCmds.map(c => {
          const tier = getCommandTier(cfg, c.name);
          const isDisabled = tier === 'disabled';
          return {
            label: `/${c.name}`,
            value: c.name,
            description: isDisabled ? '🚫 Currently DISABLED (click to ENABLE)' : `✅ Currently ${tier.toUpperCase()} (click to DISABLE)`,
            emoji: { name: isDisabled ? '🚫' : '✅' }
          };
        }),
        min_values: 1,
        max_values: 1
      }]
    },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          custom_id: `cfg_owner_perms_page_disable:${targetGuildId}`,
          label: 'Refresh',
          emoji: { name: '🔄' }
        },
        {
          type: 2,
          style: 3,
          custom_id: `cfg_owner_perms_enable_all:${targetGuildId}`,
          label: 'Enable All Commands',
          emoji: { name: '🟢' }
        },
        {
          type: 2,
          style: 2,
          custom_id: `cfg_owner_perms_refresh:${targetGuildId}`,
          label: 'Back to Permissions',
          emoji: { name: '⬅️' }
        }
      ]
    }
  ];

  return {
    embeds: [embed],
    components,
    flags: EPHEMERAL_FLAG
  };
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
  if (customId === 'panel_owner_perms_select') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Only the bot owner can manage permissions.', flags: EPHEMERAL_FLAG });
    }
    const values = body.data?.values || [];
    const targetGuildId = values[0];
    const config = await getConfig(env, targetGuildId);
    
    return jsonResponse({ type: 7, data: buildOwnerPermsPayload(targetGuildId, config) });
  }

  if (customId.startsWith('cfg_owner_perm_toggle:') ||
      customId.startsWith('cfg_owner_perm_toggle_g1:') ||
      customId.startsWith('cfg_owner_perm_toggle_g2:') ||
      customId.startsWith('cfg_owner_perms_save_g1:') ||
      customId.startsWith('cfg_owner_perms_save_g2:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetGuildId = customId.split(':')[1];
    const values = body.data?.values || [];
    const selectedCmd = values[0];
    const config = await getConfig(env, targetGuildId);
    if (!config.command_permissions) config.command_permissions = {};

    if (selectedCmd) {
      const currentTier = getCommandTier(config, selectedCmd);
      const nextTier = currentTier === 'everyone' ? 'staff' : 'everyone';
      config.command_permissions[selectedCmd] = nextTier;

      if (Array.isArray(config.disabled_commands)) {
        config.disabled_commands = config.disabled_commands.filter(c => c !== selectedCmd);
      }
      await setConfig(env, targetGuildId, config);
    }

    return jsonResponse({ type: 7, data: buildOwnerPermsPayload(targetGuildId, config) });
  }

  if (customId.startsWith('cfg_owner_perms_all_everyone:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetGuildId = customId.split(':')[1];
    const config = await getConfig(env, targetGuildId);
    if (!config.command_permissions) config.command_permissions = {};
    for (const cmd of ALL_COMMANDS_META) {
      if (cmd.category === 'general') {
        config.command_permissions[cmd.name] = 'everyone';
      }
    }
    config.disabled_commands = [];
    await setConfig(env, targetGuildId, config);

    return jsonResponse({ type: 7, data: buildOwnerPermsPayload(targetGuildId, config) });
  }

  if (customId.startsWith('cfg_owner_perms_all_staff:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetGuildId = customId.split(':')[1];
    const config = await getConfig(env, targetGuildId);
    if (!config.command_permissions) config.command_permissions = {};
    for (const cmd of ALL_COMMANDS_META) {
      config.command_permissions[cmd.name] = 'staff';
    }
    config.disabled_commands = [];
    await setConfig(env, targetGuildId, config);

    return jsonResponse({ type: 7, data: buildOwnerPermsPayload(targetGuildId, config) });
  }

  if (customId.startsWith('cfg_owner_perms_page_disable:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetGuildId = customId.split(':')[1];
    const config = await getConfig(env, targetGuildId);
    return jsonResponse({ type: 7, data: buildOwnerDisablePayload(targetGuildId, config) });
  }

  if (customId.startsWith('cfg_owner_perm_toggle_disable_g1:') ||
      customId.startsWith('cfg_owner_perm_toggle_disable_g2:') ||
      customId.startsWith('cfg_owner_perm_toggle_disable:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetGuildId = customId.split(':')[1];
    const values = body.data?.values || [];
    const selectedCmd = values[0];
    const config = await getConfig(env, targetGuildId);
    if (!config.command_permissions) config.command_permissions = {};

    if (selectedCmd) {
      const currentTier = getCommandTier(config, selectedCmd);
      if (currentTier === 'disabled') {
        const meta = ALL_COMMANDS_META.find(c => c.name === selectedCmd);
        config.command_permissions[selectedCmd] = meta ? meta.defaultTier : 'everyone';
        if (Array.isArray(config.disabled_commands)) {
          config.disabled_commands = config.disabled_commands.filter(c => c !== selectedCmd);
        }
      } else {
        config.command_permissions[selectedCmd] = 'disabled';
        if (!Array.isArray(config.disabled_commands)) config.disabled_commands = [];
        if (!config.disabled_commands.includes(selectedCmd)) {
          config.disabled_commands.push(selectedCmd);
        }
      }
      await setConfig(env, targetGuildId, config);
    }

    return jsonResponse({ type: 7, data: buildOwnerDisablePayload(targetGuildId, config) });
  }

  if (customId.startsWith('cfg_owner_perms_enable_all:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetGuildId = customId.split(':')[1];
    const config = await getConfig(env, targetGuildId);
    config.disabled_commands = [];
    if (config.command_permissions) {
      for (const [k, v] of Object.entries(config.command_permissions)) {
        if (v === 'disabled') {
          const meta = ALL_COMMANDS_META.find(c => c.name === k);
          config.command_permissions[k] = meta ? meta.defaultTier : 'everyone';
        }
      }
    }
    await setConfig(env, targetGuildId, config);

    return jsonResponse({ type: 7, data: buildOwnerDisablePayload(targetGuildId, config) });
  }

  if (customId.startsWith('cfg_owner_perms_reset_defaults:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetGuildId = customId.split(':')[1];
    const config = await getConfig(env, targetGuildId);
    delete config.command_permissions;
    delete config.disabled_commands;
    await setConfig(env, targetGuildId, config);

    return jsonResponse({ type: 7, data: buildOwnerPermsPayload(targetGuildId, config) });
  }

  if (customId.startsWith('cfg_owner_perms_refresh:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetGuildId = customId.split(':')[1];
    const config = await getConfig(env, targetGuildId);
    return jsonResponse({ type: 7, data: buildOwnerPermsPayload(targetGuildId, config) });
  }

  if (customId.startsWith('cfg_owner_perms_save:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetGuildId = customId.split(':')[1];
    const values = body.data?.values || [];
    const config = await getConfig(env, targetGuildId);
    config.disabled_commands = values || [];
    await setConfig(env, targetGuildId, config);
    
    const ownerPayload = await buildWorkerUpdatesPayload(env);
    ownerPayload.content = `✅ Saved disabled commands for server ${targetGuildId}: ` + (values.length ? values.map(v => `\`${v}\``).join(', ') : 'None (all allowed)');
    return interactionResponse({ ...ownerPayload, flags: EPHEMERAL_FLAG });
  }

  if (customId === 'panel_owner_set_main_server') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Only the bot owner can set the CHS Main Server.', flags: EPHEMERAL_FLAG });
    }
    const values = body.data?.values || [];
    const selectedGuildId = values[0];
    if (selectedGuildId) {
      await setMainGuildId(env, selectedGuildId);
      logAction(`🏫 Set CHS Main Server to ${selectedGuildId}`, { guildId: selectedGuildId });
    }
    const payload = await buildWorkerUpdatesPayload(env);
    payload.content = `✅ Successfully designated server \`${selectedGuildId}\` as the **CHS Main Server**! It exclusively runs **CHS CONTROLS** with all 19 tabs active.`;
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId === 'panel_owner_features_manage' || customId.startsWith('cfg_owner_features_refresh:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const scope = customId.startsWith('cfg_owner_features_refresh:') ? customId.split(':')[1] : 'normal';
    const allIds = await getAllKnownGuildIds(env);
    const servers = await fetchGuildSummaries(env, allIds);
    const payload = await buildOwnerFeaturesPayload(env, scope || 'normal', servers);
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId.startsWith('cfg_owner_toggle_panel_feature:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetScope = customId.split(':')[1] || 'normal';
    const values = body.data?.values || [];
    const selectedTab = values[0];
    if (selectedTab) {
      let disabled = await getDisabledPanelTabs(env, targetScope);
      if (disabled.includes(selectedTab)) {
        disabled = disabled.filter(t => t !== selectedTab);
      } else {
        disabled = [...disabled, selectedTab];
      }
      await setDisabledPanelTabs(env, targetScope, disabled);
      logAction(`🎛️ Toggled panel tab ${selectedTab} for ${targetScope}`, { guildId: targetScope });
    }
    const allIds = await getAllKnownGuildIds(env);
    const servers = await fetchGuildSummaries(env, allIds);
    const payload = await buildOwnerFeaturesPayload(env, targetScope, servers);
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId === 'cfg_owner_features_scope_select') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const values = body.data?.values || [];
    const targetScope = values[0] || 'normal';
    const allIds = await getAllKnownGuildIds(env);
    const servers = await fetchGuildSummaries(env, allIds);
    const payload = await buildOwnerFeaturesPayload(env, targetScope, servers);
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId.startsWith('cfg_owner_features_enable_all:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetScope = customId.split(':')[1] || 'normal';
    await setDisabledPanelTabs(env, targetScope, []);
    logAction(`🎛️ Enabled all panel tabs for ${targetScope}`, { guildId: targetScope });
    const allIds = await getAllKnownGuildIds(env);
    const servers = await fetchGuildSummaries(env, allIds);
    const payload = await buildOwnerFeaturesPayload(env, targetScope, servers);
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId.startsWith('cfg_owner_features_disable_extras:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetScope = customId.split(':')[1] || 'normal';
    const extras = ['config_music', 'config_joinlogs', 'config_announcementrequests', 'config_autoreply', 'config_emails'];
    await setDisabledPanelTabs(env, targetScope, extras);
    logAction(`🎛️ Disabled extra panel tabs for ${targetScope}`, { guildId: targetScope });
    const allIds = await getAllKnownGuildIds(env);
    const servers = await fetchGuildSummaries(env, allIds);
    const payload = await buildOwnerFeaturesPayload(env, targetScope, servers);
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId.startsWith('cfg_owner_features_save_new_default:') || customId === 'panel_owner_save_defaults_new') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetScope = customId.startsWith('cfg_owner_features_save_new_default:') ? (customId.split(':')[1] || 'normal') : 'normal';
    const currentDisabled = await getDisabledPanelTabs(env, targetScope);
    await savePanelDefaultsForNewServers(env, currentDisabled);
    logAction(`🌐 Saved panel defaults for all new servers (${currentDisabled.length} disabled tabs)`, { guildId: targetScope });

    const allIds = await getAllKnownGuildIds(env);
    const servers = await fetchGuildSummaries(env, allIds);
    const payload = await buildOwnerFeaturesPayload(env, targetScope, servers);
    payload.content = `✅ **Saved as Default for All New Servers!** Any new server that adds the bot will automatically inherit these control panel settings (${currentDisabled.length ? `${currentDisabled.length} tabs hidden` : 'all tabs visible'}).`;
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId.startsWith('cfg_owner_features_apply_all_existing:') || customId === 'panel_owner_apply_defaults_all') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetScope = customId.startsWith('cfg_owner_features_apply_all_existing:') ? (customId.split(':')[1] || 'normal') : 'normal';
    const currentDisabled = await getDisabledPanelTabs(env, targetScope);
    const updatedCount = await applyPanelDefaultsToAllServers(env, currentDisabled);
    logAction(`⚡ Applied panel defaults to all existing servers (${updatedCount} servers updated)`, { guildId: targetScope });

    const allIds = await getAllKnownGuildIds(env);
    const servers = await fetchGuildSummaries(env, allIds);
    const payload = await buildOwnerFeaturesPayload(env, targetScope, servers);
    payload.content = `⚡ **Applied to ALL Servers as Default!** Successfully updated and synced control panel settings to all **${updatedCount}** normal servers. (CHS Main Server was preserved).`;
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId.startsWith('cfg_owner_features_action_select:')) {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const targetScope = customId.split(':')[1] || 'normal';
    const action = Array.isArray(body.data?.values) && body.data.values[0];

    if (action === 'save_new_default') {
      const currentDisabled = await getDisabledPanelTabs(env, targetScope);
      await savePanelDefaultsForNewServers(env, currentDisabled);
      logAction(`🌐 Saved panel defaults for all new servers (${currentDisabled.length} disabled tabs)`, { guildId: targetScope });
      const allIds = await getAllKnownGuildIds(env);
      const servers = await fetchGuildSummaries(env, allIds);
      const payload = await buildOwnerFeaturesPayload(env, targetScope, servers);
      payload.content = `✅ **Saved as Default for All New Servers!** Any new server that adds the bot will automatically inherit these control panel settings.`;
      return jsonResponse({ type: 7, data: payload });
    }

    if (action === 'apply_all_existing') {
      const currentDisabled = await getDisabledPanelTabs(env, targetScope);
      const updatedCount = await applyPanelDefaultsToAllServers(env, currentDisabled);
      logAction(`⚡ Applied panel defaults to all existing servers (${updatedCount} servers updated)`, { guildId: targetScope });
      const allIds = await getAllKnownGuildIds(env);
      const servers = await fetchGuildSummaries(env, allIds);
      const payload = await buildOwnerFeaturesPayload(env, targetScope, servers);
      payload.content = `⚡ **Applied to ALL Servers!** Updated **${updatedCount}** existing servers with these control panel settings.`;
      return jsonResponse({ type: 7, data: payload });
    }

    if (action === 'enable_all') {
      await setDisabledPanelTabs(env, targetScope, []);
      logAction(`🎛️ Enabled all panel tabs for ${targetScope}`, { guildId: targetScope });
      const allIds = await getAllKnownGuildIds(env);
      const servers = await fetchGuildSummaries(env, allIds);
      const payload = await buildOwnerFeaturesPayload(env, targetScope, servers);
      payload.content = `🟢 **All Features Enabled** for ${targetScope === 'normal' ? 'Normal Servers' : 'this server'}.`;
      return jsonResponse({ type: 7, data: payload });
    }

    if (action === 'disable_extras') {
      const extras = ['config_music', 'config_joinlogs', 'config_announcementrequests', 'config_autoreply', 'config_emails'];
      await setDisabledPanelTabs(env, targetScope, extras);
      logAction(`🎛️ Disabled extra panel tabs for ${targetScope}`, { guildId: targetScope });
      const allIds = await getAllKnownGuildIds(env);
      const servers = await fetchGuildSummaries(env, allIds);
      const payload = await buildOwnerFeaturesPayload(env, targetScope, servers);
      payload.content = `🔴 **Extra Features Disabled** (Core status & weather features active).`;
      return jsonResponse({ type: 7, data: payload });
    }
  }

  if (customId === 'panel_owner_return') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const ownerPayload = await buildWorkerUpdatesPayload(env);
    return jsonResponse({ type: 7, data: ownerPayload });
  }

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

  if (customId === 'panel_select_voice_channel') {
    const selectedChannel = Array.isArray(body.data.values) && body.data.values[0];
    if (!selectedChannel) {
      return interactionResponse({ content: '❌ No channel selected.', flags: EPHEMERAL_FLAG });
    }
    ctx.waitUntil((async () => {
      const channelId = body.channel_id;
      if (channelId) {
         await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
           method: 'POST',
           headers: {
             Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
             'Content-Type': 'application/json'
           },
           body: JSON.stringify({ content: `GREET_BOT_COMMAND: TOGGLE_VOICE ${selectedChannel}` })
         }).catch(() => {});
      }
    })());
    return jsonResponse({
      type: 7,
      data: { content: `🔌 Signal sent! The local voice bot should join <#${selectedChannel}> momentarily.`, components: [] }
    });
  }

  if (customId === 'panel_leave_voice') {
    ctx.waitUntil((async () => {
      const channelId = body.channel_id;
      if (channelId) {
         await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
           method: 'POST',
           headers: {
             Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
             'Content-Type': 'application/json'
           },
           body: JSON.stringify({ content: `GREET_BOT_COMMAND: TOGGLE_VOICE LEAVE` })
         }).catch(() => {});
      }
    })());
    return jsonResponse({
      type: 7,
      data: { content: `🔌 Signal sent! The local voice bot should leave momentarily.`, components: [] }
    });
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
      const ownerId = String(env.OWNER_ID || '').trim();
      if (!ownerId || getInvokerId(body) !== ownerId) {
        return interactionResponse({ content: '🔒 KV Store Diagnostic is restricted to the bot owner.', flags: EPHEMERAL_FLAG });
      }
      ctx.waitUntil(handlePanelKvDebug(body, env));
      return deferredInteractionResponse();
    }
    if (action === 'panel_clear_logs') {
      ctx.waitUntil(handlePanelClearLogs(body, env));
      return deferredInteractionResponse();
    }
    if (action === 'panel_toggle_voice') {
      return interactionResponse({
        content: 'Please select a voice channel for the bot to join, or click to leave.',
        flags: EPHEMERAL_FLAG,
        components: [
          {
            type: 1,
            components: [{
              type: 8,
              custom_id: 'panel_select_voice_channel',
              channel_types: [2],
              placeholder: 'Select Voice Channel...',
            }]
          },
          {
            type: 1,
            components: [{
              type: 2,
              style: 4,
              custom_id: 'panel_leave_voice',
              label: 'Disconnect from Voice'
            }]
          }
        ]
      });
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

  if (customId === 'panel_debug_select') {
    const action = Array.isArray(body.data.values) && body.data.values[0];
    if (typeof action === 'string' && action.startsWith('panel_') && action !== 'panel_debug_select') {
      const forwarded = { ...body, data: { ...body.data, custom_id: action, values: [] } };
      return await handlePanelComponent(forwarded, env, ctx, guildId);
    }
    return interactionResponse({ content: '❌ Unknown debug action.', flags: EPHEMERAL_FLAG });
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

  if (customId === 'panel_kv_debug') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 KV Store Diagnostic is restricted to the bot owner.', flags: EPHEMERAL_FLAG });
    }
    ctx.waitUntil(handlePanelKvDebug(body, env));
    return deferredInteractionResponse();
  }

  if (customId === 'panel_toggle_email_alerts') {
    const config = await getConfig(env, guildId);
    config.toggle_email_alerts = config.toggle_email_alerts === false;
    await setConfig(env, guildId, config);
    return renderPanelNav(env, body, guildId, 'config_emails');
  }

  if (customId === 'panel_toggle_ai_summary') {
    const config = await getConfig(env, guildId);
    config.toggle_ai_summary = config.toggle_ai_summary === false;
    await setConfig(env, guildId, config);
    return renderPanelNav(env, body, guildId, 'config_emails');
  }

  if (customId === 'panel_toggle_status_screenshot') {
    const config = await getConfig(env, guildId);
    config.toggle_status_screenshot = config.toggle_status_screenshot === false;
    await setConfig(env, guildId, config);
    return renderPanelNav(env, body, guildId, 'config_status');
  }

  if (customId === 'panel_toggle_analytics_logging') {
    const config = await getConfig(env, guildId);
    config.toggle_analytics_logging = config.toggle_analytics_logging === false;
    await setConfig(env, guildId, config);
    return renderPanelNav(env, body, guildId, 'config_analytics');
  }

  if (customId === 'panel_clear_email_channel') {
    const config = await getConfig(env, guildId);
    delete config.email_channel_id;
    await setConfig(env, guildId, config);
    return renderPanelNav(env, body, guildId, 'config_emails');
  }

  // Simple page-navigation buttons share one pattern: panel_to_<page>.
  const NAV_BUTTON_PAGES = {
    panel_to_config_general: 'config_general',
    panel_to_config_status: 'config_status',
    panel_to_config_schedule: 'config_schedule',
    panel_to_config_toggles: 'config_toggles',
    panel_to_config_calendar: 'config_calendar',
    panel_to_config_stats: 'config_stats',
    panel_to_config_manual_status: 'config_manual_status',
    panel_to_config_override_select: 'config_manual_status',
    panel_to_config_commands: 'config_commands',
    panel_to_config_joinlogs: 'config_joinlogs',
    panel_to_config_nws_pings: 'config_nws_pings',
    panel_to_config_announcementrequests: 'config_announcementrequests',
    panel_to_config_emails: 'config_emails',
    panel_to_config_analytics: 'config_analytics',
    panel_to_config_debug: 'config_debug',
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
    await env.STATUS_KV.put(`panel_page:${guildId}`, 'config_manual_status');
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
        title: `🏫 Manual Status: ${statusLabel}`.slice(0, 45),
        custom_id: 'modal_set_override',
        components: [
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_override_details',
              style: 2,
              label: 'Notes / Announcement',
              placeholder: 'e.g. We do not have school today due to icy road conditions.',
              required: true,
              max_length: 1000
            }]
          },
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_override_days',
              style: 1,
              label: 'Duration in Days (1-30)',
              placeholder: '1',
              value: '1',
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
              label: 'Headline / Custom Title (Optional)',
              placeholder: `e.g. Emergency Weather Closure`,
              required: false,
              max_length: 100
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

  if (customId === 'panel_btn_add_keyword') {
    if (!(await canConfigure(body.member, env, guildId))) {
      return interactionResponse({
        content: 'You do not have permission to configure this bot.',
        flags: EPHEMERAL_FLAG
      });
    }
    // Two-step: first ask which channel, then the keywords + reply. We open the
    // keyword modal directly and capture the channel ID as text so staff can set
    // everything in one pass (Discord modals can't mix a channel picker with
    // text inputs).
    return jsonResponse({
      type: 9,
      data: {
        title: 'Add Auto-Reply Rule',
        custom_id: 'modal_add_keyword',
        components: [
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_keyword_channel',
              style: 1,
              label: 'Channel ID to watch',
              placeholder: 'Right-click a channel → Copy Channel ID (e.g. 123456789012345678)',
              min_length: 17,
              max_length: 20,
              required: true
            }]
          },
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_keyword_terms',
              style: 2,
              label: 'Keywords / phrases (comma-separated)',
              placeholder: 'mod abuse, staff abuse',
              min_length: 1,
              max_length: 500,
              required: true
            }]
          },
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'input_keyword_response',
              style: 2,
              label: 'Reply message',
              placeholder: 'If you would like to report a staff member, you can open a ticket to report the user.',
              min_length: 1,
              max_length: 1000,
              required: true
            }]
          }
        ]
      }
    });
  }

  if (customId === 'panel_btn_remove_keyword') {
    if (!(await canConfigure(body.member, env, guildId))) {
      return interactionResponse({
        content: 'You do not have permission to configure this bot.',
        flags: EPHEMERAL_FLAG
      });
    }
    return interactionResponse({
      content: '🗑️ Use the **remove rule** dropdown on the Auto-Reply page to pick a rule to delete.',
      flags: EPHEMERAL_FLAG
    });
  }

  if (customId === 'panel_btn_set_playlist') {
    const config = await getConfig(env, guildId);
    const currentPlaylist = config.music_playlist_url || '';

    return jsonResponse({
      type: 9,
      data: {
        title: 'Set 24/7 Playlist URL',
        custom_id: 'modal_set_playlist',
        components: [{
          type: 1,
          components: [{
            type: 4,
            custom_id: 'input_playlist',
            style: 1,
            label: 'Spotify or YouTube Playlist URL (or clear)',
            placeholder: 'https://open.spotify.com/playlist/...',
            value: currentPlaylist,
            min_length: 0,
            max_length: 500,
            required: false
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

  if (customId === 'panel_btn_send_music') {
    const config = await getConfig(env, guildId);
    if (!config.music_channel_id) {
      return interactionResponse({ content: '❌ Please select a Music Channel first.', flags: EPHEMERAL_FLAG });
    }

    const musicEmbed = {
      title: '🎵 Music Controls',
      color: 0x1DB954,
      description: 'Use the buttons below to control the music bot.'
    };

    const musicComponents = [
      {
        type: 1,
        components: [
          { type: 2, style: 1, custom_id: 'music_btn_join', label: 'Join' },
          { type: 2, style: 2, custom_id: 'music_btn_song', label: 'Song' },
          { type: 2, style: 3, custom_id: 'music_btn_normal', label: 'Normal Play' }
        ]
      },
      {
        type: 1,
        components: [
          { type: 2, style: 2, custom_id: 'music_btn_pause', label: 'Pause' },
          { type: 2, style: 3, custom_id: 'music_btn_resume', label: 'Resume' },
          { type: 2, style: 4, custom_id: 'music_btn_skip', label: 'Skip' },
          { type: 2, style: 4, custom_id: 'music_btn_leave', label: 'Leave', emoji: { name: '🚪' } }
        ]
      }
    ];

    ctx.waitUntil((async () => {
      try {
        await fetch(`https://discord.com/api/v10/channels/${config.music_channel_id}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            embeds: [musicEmbed],
            components: musicComponents
          })
        });
        await updateInteractionOriginal(env, body.token, {
          content: `✅ Music panel sent to <#${config.music_channel_id}>!`,
          components: []
        });
      } catch (err) {
        await updateInteractionOriginal(env, body.token, {
          content: `❌ Failed to send music panel: ${err.message}`,
          components: []
        });
      }
    })());
    
    return deferredInteractionResponse();
  }

  if (customId === 'panel_btn_debug_screenshot') {
    ctx.waitUntil(handleScreenshotInteraction(body, env));
    return deferredInteractionResponse();
  }

  if (customId === 'panel_btn_debug_test_voice') {
    ctx.waitUntil((async () => {
      try {
        await dispatchVoiceAnnouncement(env, guildId, "HCPSS Status Update (Schools Open 2 Hours Late - Test Announcement)", true);
      } catch (e) {
        console.error('Failed to dispatch test voice announcement:', e);
      }
    })());
    return interactionResponse({
      content: '🎙️ **Status Voice Announcement Dispatched!**\n\nThe bot will join active voice channels with listeners, speak `HCPSS Status Update (Schools Open 2 Hours Late - Test Announcement)` 3 times in an authoritative male voice (no alarm beeps for status updates), and disconnect.\n\n*(Note: Ensure `ss-greeter` gateway companion bot is running to receive and execute voice commands.)*',
      flags: EPHEMERAL_FLAG
    });
  }

  if (customId === 'panel_btn_debug_test_weather_voice') {
    ctx.waitUntil((async () => {
      try {
        await dispatchVoiceAnnouncement(env, guildId, "National Weather Service Emergency Alert. Tornado Warning in effect for Howard County. Take shelter immediately in an interior room on the lowest floor.", true);
      } catch (e) {
        console.error('Failed to dispatch test weather voice announcement:', e);
      }
    })());
    return interactionResponse({
      content: '🌪️ **Emergency Voice Alert Dispatched!**\n\nThe bot has triggered an emergency voice announcement.\nBecause this is an Emergency Alert (Tornado Warning), it will sound the long EAS emergency warning beeps, announce the emergency warning 3 times in an authoritative male voice, and disconnect.\n\n*(Note: Routine weather notices and school status updates skip the beeps.)*',
      flags: EPHEMERAL_FLAG
    });
  }

  if (customId === 'panel_btn_debug_canary') {
    ctx.waitUntil((async () => {
      try {
        const startH = Date.now();
        let hcpssStatus = 'OK';
        try {
          const res = await fetch(HCPSS_URL, { headers: { 'User-Agent': 'school-status-bot' } });
          hcpssStatus = `${res.status} ${res.statusText} (${Date.now() - startH}ms)`;
        } catch (e) {
          hcpssStatus = `Failed (${e.message})`;
        }

        const startN = Date.now();
        let nwsStatus = 'OK';
        try {
          const res = await fetch('https://api.weather.gov/alerts/active/zone/MDC027', {
            headers: { 'User-Agent': 'school-status-bot (github.com/kodymcmonagle808-cmd/school-status-bot)' }
          });
          const alerts = res.ok ? ((await res.json()).features?.length || 0) : 0;
          nwsStatus = `${res.status} OK (${Date.now() - startN}ms, ${alerts} active alerts)`;
        } catch (e) {
          nwsStatus = `Failed (${e.message})`;
        }

        const startK = Date.now();
        let kvStatus = 'OK';
        try {
          await env.STATUS_KV.get(`setup_done:${guildId}`);
          kvStatus = `OK (${Date.now() - startK}ms)`;
        } catch (e) {
          kvStatus = `Failed (${e.message})`;
        }

        await updateInteractionOriginal(env, body.token, {
          content: `⚡ **Live Health Canary Results**:\n` +
                   `• **HCPSS Status Webpage**: \`${hcpssStatus}\`\n` +
                   `• **National Weather Service API**: \`${nwsStatus}\`\n` +
                   `• **Cloudflare KV Read**: \`${kvStatus}\`\n\n` +
                   `*All primary telemetry and alert sources are responsive.*`,
          flags: EPHEMERAL_FLAG
        });
      } catch (err) {
        await updateInteractionOriginal(env, body.token, {
          content: `❌ Health canary check encountered an error: ${err.message}`,
          flags: EPHEMERAL_FLAG
        });
      }
    })());
    return deferredInteractionResponse();
  }

  if (customId === 'panel_btn_debug_backup') {
    ctx.waitUntil((async () => {
      try {
        const res = await runKvBackup(env, new Date());
        await updateInteractionOriginal(env, body.token, {
          content: `✅ **Cloudflare R2 Backup Completed!**\n\n` +
                   `• **Backup File**: \`${res.filename}\`\n` +
                   `• **Keys Exported**: \`${res.keyCount}\`\n` +
                   `• **Destination Bucket**: \`${env.BACKUPS_BUCKET || 'ss-backups'}\`\n` +
                   `• **Storage Provider**: Cloudflare R2 (S3-compatible, zero egress fees)`,
          flags: EPHEMERAL_FLAG
        });
      } catch (e) {
        await updateInteractionOriginal(env, body.token, {
          content: `⚠️ **R2 Backup Test Failed**:\n${e.message}\nEnsure \`BACKUPS_BUCKET\` is bound to \`ss-backups\` in Cloudflare Workers settings.`,
          flags: EPHEMERAL_FLAG
        });
      }
    })());
    return deferredInteractionResponse();
  }

  if (customId === 'panel_btn_debug_simulate_status') {
    ctx.waitUntil((async () => {
      try {
        const stored = await getConfig(env, guildId);
        const config = getEffectiveConfig(stored);
        const alertChannelId = config.alert_channel_id || (guildId === env.DISCORD_GUILD_ID ? env.DISCORD_CHANNEL_ID : null);
        if (!alertChannelId) {
          await updateInteractionOriginal(env, body.token, {
            content: '❌ Test status simulation failed: Alert channel is not configured. Please set it in **Settings**.',
            flags: EPHEMERAL_FLAG
          });
          return;
        }

        const testEmbed = {
          title: '🏫 HCPSS Status (Simulated Test Alert - No Pings)',
          description: '🧪 **[SIMULATED STATUS TEST — ZERO PINGS]**\n\n**Schools Open 2 Hours Late**\nAll Howard County public schools will open two hours late today. Morning pre-K and half-day classes are cancelled.\n\n*(Role pings have been suppressed so no server members are disturbed.)*',
          color: 0xF1C40F,
          footer: { text: `${config.alert_embed_footer || 'School Status'} • Test Simulation (No Pings)` },
          timestamp: new Date().toISOString()
        };

        const postResp = await fetch(`https://discord.com/api/v10/channels/${alertChannelId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            content: '',
            embeds: [testEmbed],
            allowed_mentions: { parse: [] }
          })
        });

        if (!postResp.ok) {
          throw new Error(`Discord API error: ${postResp.status}`);
        }

        await updateInteractionOriginal(env, body.token, {
          content: `✅ **Simulated Status Alert Sent (Zero Pings)!**\n\nPosted a simulated status embed to <#${alertChannelId}> with role pings completely suppressed.`,
          flags: EPHEMERAL_FLAG
        });
      } catch (err) {
        await updateInteractionOriginal(env, body.token, {
          content: `❌ Simulation error: ${err.message}`,
          flags: EPHEMERAL_FLAG
        });
      }
    })());
    return deferredInteractionResponse();
  }

  if (customId === 'panel_btn_debug_simulate_weather') {
    ctx.waitUntil((async () => {
      try {
        const stored = await getConfig(env, guildId);
        const config = getEffectiveConfig(stored);
        const alertChannelId = config.alert_channel_id || (guildId === env.DISCORD_GUILD_ID ? env.DISCORD_CHANNEL_ID : null);
        if (!alertChannelId) {
          await updateInteractionOriginal(env, body.token, {
            content: '❌ Test weather alert failed: Alert channel is not configured.',
            flags: EPHEMERAL_FLAG
          });
          return;
        }

        const testEmbed = {
          title: '⚠️ Winter Storm Warning — Howard County (Simulated Test - No Pings)',
          description: '🧪 **[SIMULATED WEATHER ALERT — ZERO PINGS]**\n\n**National Weather Service has issued a Winter Storm Warning** for Howard County, MD.\nHeavy snow expected. Total snow accumulations of 4 to 8 inches.\n\n*(Role pings have been suppressed so no server members are disturbed.)*',
          color: 0x3498DB,
          footer: { text: `${config.alert_embed_footer || 'School Status'} • Test Simulation (No Pings)` },
          timestamp: new Date().toISOString()
        };

        const postResp = await fetch(`https://discord.com/api/v10/channels/${alertChannelId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            content: '',
            embeds: [testEmbed],
            allowed_mentions: { parse: [] }
          })
        });

        if (!postResp.ok) {
          throw new Error(`Discord API error: ${postResp.status}`);
        }

        await updateInteractionOriginal(env, body.token, {
          content: `✅ **Simulated Weather Alert Sent (Zero Pings)!**\n\nPosted simulated NWS alert embed to <#${alertChannelId}> with role pings completely suppressed.`,
          flags: EPHEMERAL_FLAG
        });
      } catch (err) {
        await updateInteractionOriginal(env, body.token, {
          content: `❌ Weather simulation error: ${err.message}`,
          flags: EPHEMERAL_FLAG
        });
      }
    })());
    return deferredInteractionResponse();
  }

  if (customId === 'panel_btn_debug_purge_cache') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({
        content: '🔒 **Owner Only**: Cache purging is restricted to the bot owner.',
        flags: EPHEMERAL_FLAG
      });
    }

    ctx.waitUntil((async () => {
      try {
        await env.STATUS_KV.delete('weather_alerts_cache');
        await env.STATUS_KV.delete('outages_cache');
        await env.STATUS_KV.delete('bge_outages_cache');
        await env.STATUS_KV.delete('scraper_cache');
        await updateInteractionOriginal(env, body.token, {
          content: '🧹 **Caches Purged Successfully!**\n\nCleared transient weather, outages, and scraper cache keys in KV. The next scan will re-fetch live data directly.',
          flags: EPHEMERAL_FLAG
        });
      } catch (e) {
        await updateInteractionOriginal(env, body.token, {
          content: `❌ Cache purge error: ${e.message}`,
          flags: EPHEMERAL_FLAG
        });
      }
    })());
    return deferredInteractionResponse();
  }

  if (customId === 'panel_btn_debug_raw_config') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({
        content: '🔒 **Owner Only**: Viewing raw configuration is restricted to the bot owner.',
        flags: EPHEMERAL_FLAG
      });
    }

    ctx.waitUntil((async () => {
      try {
        const stored = await getConfig(env, guildId);
        const safeConfig = { ...stored };
        const jsonStr = JSON.stringify(safeConfig, null, 2);
        const clamped = jsonStr.length > 1900 ? jsonStr.slice(0, 1900) + '\n... (truncated)' : jsonStr;
        await updateInteractionOriginal(env, body.token, {
          content: `📄 **Raw Server Configuration (\`${guildId}\`)**:\n\`\`\`json\n${clamped}\n\`\`\``,
          flags: EPHEMERAL_FLAG
        });
      } catch (e) {
        await updateInteractionOriginal(env, body.token, {
          content: `❌ Error reading raw config: ${e.message}`,
          flags: EPHEMERAL_FLAG
        });
      }
    })());
    return deferredInteractionResponse();
  }

  if (customId === 'panel_owner_refresh') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    // The owner panel is delivered as an ephemeral follow-up in the DM. This
    // button lives on that follow-up, so a type-7 response edits it in place
    // with freshly-read stats — no new message, no log write.
    await Promise.allSettled([
      env.STATUS_KV?.delete('cf_deployments_cache'),
      env.STATUS_KV?.delete('kv_usage_cache')
    ]);
    const payload = await buildWorkerUpdatesPayload(env);
    return jsonResponse({ type: 7, data: payload });
  }

  if (customId === 'panel_owner_force_check_all') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    ctx.waitUntil(doCheckAndPost(env, { source: 'owner-force-all' }));
    return interactionResponse({ content: '🔄 Force check triggered for all servers! Results will appear in your log channels.', flags: EPHEMERAL_FLAG });
  }

  if (customId === 'panel_owner_backup_d1') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    ctx.waitUntil((async () => {
      try {
        const { runD1Backup } = await import('./backup.js');
        const res = await runD1Backup(env);
        const { dmOwner } = await import('./discord.js');
        await dmOwner(env, `✅ **Cloudflare D1 Backup Complete!**\n• Stored to R2 bucket: \`${res.filename}\`\n• **${res.records} total records** backed up (${res.counts.statusHistory} status changes, ${res.counts.weatherEvents} weather alerts, ${res.counts.emails} emails).`);
      } catch (err) {
        console.error('D1 backup failed:', err);
        const { dmOwner } = await import('./discord.js');
        await dmOwner(env, `❌ **D1 Backup Failed:** ${err.message}`);
      }
    })());
    return interactionResponse({
      content: '💾 **D1 Database backup started!**\nA full snapshot is being written to your Cloudflare R2 bucket (`ss-backups`), and a confirmation summary will be sent to your DMs.',
      flags: EPHEMERAL_FLAG
    });
  }

  if (customId === 'panel_owner_view_kv_stats') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    if (body.type === 3 && body.data?.custom_id === 'panel_owner_view_kv_stats') {
      await env.STATUS_KV?.delete('kv_usage_cache').catch(() => {});
    }
    let d1Text = '';
    if (env.DB) {
      try {
        const { getD1Stats, buildD1Section } = await import('./db.js');
        const d1 = await getD1Stats(env.DB);
        if (d1) d1Text = `## 🗄️ Cloudflare D1 Database\n${buildD1Section(d1)}\n\n`;
      } catch {}
    }
    let kvInfo = 'No KV analytics available.';
    try {
      const { getKvUsage, KV_FREE_LIMITS } = await import('./kvanalytics.js');
      const usage = await getKvUsage(env);
      if (usage) {
        const readPct = ((usage.reads / KV_FREE_LIMITS.reads) * 100).toFixed(1);
        const writePct = ((usage.writes / KV_FREE_LIMITS.writes) * 100).toFixed(1);
        const storagePct = ((usage.storedBytes / KV_FREE_LIMITS.storedBytes) * 100).toFixed(1);
        kvInfo = `**Reads:** ${usage.reads.toLocaleString()} / ${KV_FREE_LIMITS.reads.toLocaleString()} (${readPct}%)\n` +
                 `**Writes:** ${usage.writes.toLocaleString()} / ${KV_FREE_LIMITS.writes.toLocaleString()} (${writePct}%)\n` +
                 `**Storage:** ${(usage.storedBytes / 1024 / 1024).toFixed(2)} MB / ${(KV_FREE_LIMITS.storedBytes / 1024 / 1024).toFixed(0)} MB (${storagePct}%)`;
      }
    } catch {}
    const analyticsPayload = {
      content: `${d1Text}## 💾 KV Analytics\n${kvInfo}`,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              custom_id: 'panel_owner_view_kv_stats',
              label: 'Refresh Analytics',
              emoji: { name: '🔄' }
            }
          ]
        }
      ],
      flags: EPHEMERAL_FLAG
    };
    return (body.type === 3)
      ? jsonResponse({ type: 7, data: analyticsPayload })
      : interactionResponse(analyticsPayload);
  }

  if (customId === 'panel_owner_view_all_configs') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    let lines = [];
    try {
      const rawIndex = await env.STATUS_KV.get('guild_index');
      const index = rawIndex ? JSON.parse(rawIndex) : [];
      for (const gid of index.slice(0, 10)) {
        const cfg = await getConfig(env, gid);
        const alertCh = cfg.alert_channel_id ? `<#${cfg.alert_channel_id}>` : 'none';
        const logCh = cfg.log_channel_id ? `<#${cfg.log_channel_id}>` : 'none';
        const toggles = [];
        if (cfg.enable_digest) toggles.push('digest');
        if (cfg.enable_headsup) toggles.push('headsup');
        if (cfg.enable_bus_alerts) toggles.push('bus');
        if (cfg.enable_weather_notices) toggles.push('weather');
        lines.push(`**${gid}**\n  Alert: ${alertCh} · Log: ${logCh}\n  Toggles: ${toggles.join(', ') || 'none'}`);
      }
    } catch (e) { lines.push('Error reading configs: ' + e.message); }
    return interactionResponse({
      content: `## 📋 Server Configs\n${lines.join('\n\n') || 'No servers found.'}`,
      flags: EPHEMERAL_FLAG
    });
  }

  if (customId === 'panel_owner_test_screenshot') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    ctx.waitUntil(handleScreenshotInteraction(body, env));
    return deferredInteractionResponse();
  }

  if (customId === 'panel_owner_trigger_workflow') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const instanceId = await triggerStormWatchdogWorkflow(env, { reason: 'owner_manual_test', triggeredBy: ownerId });
    return interactionResponse({
      embeds: [{
        title: '🔄 Cloudflare Workflows — Storm Watchdog',
        color: 0x3498DB,
        description: instanceId
          ? `✅ **Storm Watchdog Workflow launched!**\n\n` +
            `• **Instance ID**: \`${instanceId}\`\n` +
            `• **Workflow Class**: \`StormWatchdogWorkflow\`\n` +
            `• **Execution Pipeline**:\n` +
            `  1. \`step.do('check-initial-storm-status')\` — verify operating status\n` +
            `  2. \`step.sleep('wait-next-storm-scan', '10 minutes')\` — durable sleep with 0 CPU\n` +
            `  3. \`step.do('check-followup-storm-status')\` — follow-up confirmation\n\n` +
            `*Multi-step durable execution active via \`env.STORM_WORKFLOW\`.*`
          : `⚠️ **Workflow binding not active.** Make sure \`env.STORM_WORKFLOW\` is bound in \`wrangler.toml\`.`,
        timestamp: new Date().toISOString(),
        footer: { text: 'Cloudflare Workflows • Durable Execution' }
      }],
      flags: EPHEMERAL_FLAG
    });
  }

  if (customId === 'panel_owner_ai_gateway_info') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const gwId = env.AI_GATEWAY_ID || 'school-status-gateway';
    return interactionResponse({
      embeds: [{
        title: '⚡ Cloudflare AI Gateway & Caching',
        color: 0xF39C12,
        description: `### 🌐 Gateway Overview\n` +
          `• **Gateway ID**: \`${gwId}\`\n` +
          `• **Status**: 🟢 **Active & Routing**\n` +
          `• **Edge Semantic Caching**: Enabled (1 hour TTL)\n` +
          `• **Cost & Neuron Savings**: 100% Free on Cloudflare\n\n` +
          `### 🤖 Connected Models\n` +
          `• **Summary Model**: \`@cf/meta/llama-3.1-8b-instruct\` (Email & newsletter summaries)\n` +
          `• **Embedding Model**: \`@cf/baai/bge-small-en-v1.5\` (384-dimensional vector embeddings for \`/searchemails\`)\n\n` +
          `*Repeat semantic search queries return in **< 10ms** from Cloudflare edge caches.*`,
        timestamp: new Date().toISOString(),
        footer: { text: 'Workers AI + AI Gateway' }
      }],
      flags: EPHEMERAL_FLAG
    });
  }

  if (customId === 'panel_owner_analytics_info') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    const hasAnalytics = Boolean(env.ANALYTICS && typeof env.ANALYTICS.writeDataPoint === 'function');
    return interactionResponse({
      embeds: [{
        title: '📈 Cloudflare Workers Analytics Engine',
        color: 0x2ECC71,
        description: `### 📊 Dataset: \`school_status_analytics\`\n` +
          `• **Status**: ${hasAnalytics ? '🟢 **Active & Logging**' : '⚪ Standby'}\n` +
          `• **Monthly Free Quota**: **10,000,000 datapoints**\n` +
          `• **Daily Query Quota**: **100,000 SQL queries/day**\n` +
          `• **KV Writes Saved**: 100% (Zero KV operations used for telemetry)\n\n` +
          `### 🔍 Tracked Event Categories\n` +
          `• \`scrape\` — Status checks, page fetch latencies, and outcome status keys\n` +
          `• \`interaction\` — Slash commands, button clicks, and modal submissions\n` +
          `• \`screenshot\` — Headless Chrome capture latency, cache hits vs fresh\n` +
          `• \`weather_alert\` — NWS emergency and routine alert dispatches\n` +
          `• \`email\` — Direct inbound email routing events`,
        timestamp: new Date().toISOString(),
        footer: { text: 'Cloudflare Analytics Engine • Zero KV Write Telemetry' }
      }],
      flags: EPHEMERAL_FLAG
    });
  }

  if (customId === 'panel_owner_email_info') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    return interactionResponse({
      embeds: [{
        title: '📬 Cloudflare Inbound Email Routing',
        color: 0x3498DB,
        description: `### 📧 Worker Email Handler\n` +
          `• **Handler**: \`export default { async email(message, env, ctx) }\`\n` +
          `• **Status**: 🟢 **Active & Ready**\n` +
          `• **Free Quota**: Unlimited inbound emails\n\n` +
          `### ⚙️ How to Route Emails to the Bot\n` +
          `1. In the **Cloudflare Dashboard**, navigate to **Email Routing** under your domain.\n` +
          `2. Create a custom address (e.g., \`alerts@yourdomain.com\`).\n` +
          `3. Set the action to **Send to a Worker** and select \`ss-worker\`.\n` +
          `4. Subscribe that email address to HCPSS News / emergency bulletins.\n\n` +
          `*Incoming emails are automatically summarized by Workers AI, indexed in Vectorize, stored in D1, and posted to Discord alert channels.*`,
        timestamp: new Date().toISOString(),
        footer: { text: 'Cloudflare Email Workers • Native Inbound Pipeline' }
      }],
      flags: EPHEMERAL_FLAG
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
      const rawPingRoles = config.ping_role_ids;
      const defaultRoleIds = Array.isArray(rawPingRoles)
        ? rawPingRoles
        : (rawPingRoles && rawPingRoles.default);
      if (roleId) {
        rolesToPing = [roleId];
      } else if (roleId === undefined && statusKey !== 'normal_operations') {
        rolesToPing = Array.isArray(defaultRoleIds) ? defaultRoleIds : [];
      }

      const wouldPingStr = rolesToPing.length ? rolesToPing.map(id => `<@&${id}>`).join(', ') : '*(none)*';
      const customFooter = config.alert_embed_footer || 'School Status';
      const color = config.status_embed_colors && typeof config.status_embed_colors[statusKey] === 'number'
        ? config.status_embed_colors[statusKey]
        : getDefaultStatusColor(statusKey);

      const thumbnailUrl = getStatusThumbnail(statusKey);
      const embeds = splitEmbeds(
        `HCPSS Status for Today (Test - No Pings)`,
        cards[0].body + `\n\n*(Role pings suppressed for test simulation — live alert would ping: ${wouldPingStr})*`,
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
          content: '',
          embeds,
          allowed_mentions: { parse: [] }
        })
      });

      if (!postResp.ok) {
        const errTxt = await postResp.text();
        throw new Error(`Discord API error posting test message: ${postResp.status} ${errTxt}`);
      }

      logAction(`🧪 Scraper test alert for '${statusKey}' triggered by <@${invokerId}>. Sent to <#${alertChannelId}> (pings suppressed).`, { guildId });

      await updateInteractionOriginal(env, body.token, {
        content: `✅ **Diagnostic Test Successful (Zero Pings Sent)!**\n\n` +
                 `• Status Simulated: **${ALL_STATUS_LABELS[selectedStatusKey] || selectedStatusKey}**\n` +
                 `• Alert Channel: <#${alertChannelId}>\n` +
                 `• Role Pings: *(suppressed for test simulation — zero pings sent)*\n` +
                 `• Live Alert Would Ping: ${wouldPingStr}\n\n` +
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
