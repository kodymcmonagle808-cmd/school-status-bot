// Per-guild config and status overrides, stored in KV.

import { DEFAULT_STAFF_ROLE_ID, DEFAULT_LOG_CHANNEL_ID, DEFAULT_CHECK_SCHEDULE } from './constants.js';
import { memberIsAdmin, memberHasRole } from './discord.js';
import { isGuildBlocked } from './blocklist.js';

function configKey(guildId) {
  return guildId ? `config:${guildId}` : 'config:default';
}

export async function getConfig(env, guildId = '') {
  const key = configKey(guildId || env.DISCORD_GUILD_ID);
  const raw = await env.STATUS_KV.get(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function setConfig(env, guildId, next) {
  const effectiveGuildId = guildId || env.DISCORD_GUILD_ID;
  const key = configKey(effectiveGuildId);
  await env.STATUS_KV.put(key, JSON.stringify(next));

  // Keep the cached guild index in sync so per-minute scheduled runs can
  // avoid KV list operations. Owner-blocked guilds stay out of the index.
  if (effectiveGuildId) {
    try {
      if (await isGuildBlocked(env, effectiveGuildId)) return;
      let index = [];
      const rawIndex = await env.STATUS_KV.get('guild_index');
      if (rawIndex) {
        try { index = JSON.parse(rawIndex); } catch {}
      }
      if (!Array.isArray(index)) index = [];
      if (!index.includes(effectiveGuildId)) {
        index.push(effectiveGuildId);
        await env.STATUS_KV.put('guild_index', JSON.stringify(index));
      }
    } catch (e) {
      console.error('Failed to update guild index:', e);
    }
  }
}

export function getEffectiveConfig(stored) {
  const next = { ...(stored || {}) };
  if (!next.staff_role_id) next.staff_role_id = DEFAULT_STAFF_ROLE_ID;
  if (!Array.isArray(next.staff_role_ids)) {
    next.staff_role_ids = next.staff_role_id ? [next.staff_role_id] : [];
  }
  if (!next.log_channel_id) next.log_channel_id = DEFAULT_LOG_CHANNEL_ID;
  // `ping_role_ids` may be a flat array (legacy format, treated as the
  // "default" category) or an object keyed by alert category:
  // { winter: [...], heat: [...], default: [...] }.
  if (Array.isArray(next.ping_role_ids)) {
    next.ping_role_ids = { default: next.ping_role_ids };
  } else if (!next.ping_role_ids || typeof next.ping_role_ids !== 'object') {
    next.ping_role_ids = {};
  }
  if (!next.status_ping_roles) next.status_ping_roles = {};
  if (!next.status_embed_colors) next.status_embed_colors = {};
  if (!next.editing_status_key) next.editing_status_key = 'normal_operations';
  if (!next.editing_nws_ping_key) next.editing_nws_ping_key = 'default';
  if (!Array.isArray(next.check_schedule)) {
    next.check_schedule = [...DEFAULT_CHECK_SCHEDULE];
  }
  if (typeof next.toggle_pings !== 'boolean') next.toggle_pings = true;
  if (typeof next.toggle_error_alerts !== 'boolean') next.toggle_error_alerts = true;
  if (typeof next.toggle_weather !== 'boolean') next.toggle_weather = true;
  if (typeof next.toggle_storm_mode !== 'boolean') next.toggle_storm_mode = true;
  if (typeof next.toggle_decision_watch !== 'boolean') next.toggle_decision_watch = true;
  if (typeof next.toggle_districts !== 'boolean') next.toggle_districts = true;
  if (typeof next.toggle_outlook !== 'boolean') next.toggle_outlook = true;
  if (typeof next.toggle_crosscheck !== 'boolean') next.toggle_crosscheck = true;
  if (typeof next.toggle_heads_up !== 'boolean') next.toggle_heads_up = true;
  if (typeof next.toggle_bus_alerts !== 'boolean') next.toggle_bus_alerts = true;
  if (typeof next.toggle_activity_alerts !== 'boolean') next.toggle_activity_alerts = true;
  if (typeof next.toggle_school_notices !== 'boolean') next.toggle_school_notices = true;
  if (typeof next.toggle_outages !== 'boolean') next.toggle_outages = true;
  if (typeof next.toggle_roads !== 'boolean') next.toggle_roads = true;
  if (typeof next.toggle_year_recap !== 'boolean') next.toggle_year_recap = true;
  if (typeof next.toggle_aqi_alerts !== 'boolean') next.toggle_aqi_alerts = true;
  if (typeof next.toggle_nws_alerts !== 'boolean') next.toggle_nws_alerts = true;
  if (typeof next.toggle_emergency_alerts !== 'boolean') next.toggle_emergency_alerts = true;
  if (typeof next.toggle_emergency_ping !== 'boolean') next.toggle_emergency_ping = true;
  if (typeof next.toggle_email_alerts !== 'boolean') next.toggle_email_alerts = true;
  if (typeof next.toggle_session_gate !== 'boolean') next.toggle_session_gate = true;
  if (typeof next.toggle_voice_announcements !== 'boolean') next.toggle_voice_announcements = false;
  if (typeof next.toggle_status_screenshot !== 'boolean') next.toggle_status_screenshot = true;
  if (typeof next.toggle_ai_summary !== 'boolean') next.toggle_ai_summary = true;
  if (typeof next.toggle_storm_workflow !== 'boolean') next.toggle_storm_workflow = true;
  if (typeof next.toggle_analytics_logging !== 'boolean') next.toggle_analytics_logging = true;
  if (!next.district_channels || typeof next.district_channels !== 'object') next.district_channels = {};
  if (!next.primary_district) next.primary_district = 'hcpss';
  return next;
}

export async function canUseCommands(member, env, guildId = '') {
  if (memberIsAdmin(member)) return true;
  const stored = await getConfig(env, guildId);
  const cfg = getEffectiveConfig(stored);
  const staffRoleIds = [
    ...(Array.isArray(cfg.staff_role_ids) ? cfg.staff_role_ids : []),
    ...(cfg.staff_role_id ? [cfg.staff_role_id] : [])
  ];
  return staffRoleIds.some(roleId => memberHasRole(member, roleId));
}

export async function canConfigure(member, env, guildId = '') {
  return await canUseCommands(member, env, guildId);
}

export const ALL_COMMANDS_META = [
  // General & Student Commands (default: everyone)
  { name: 'status', label: '/status', category: 'general', defaultTier: 'everyone', description: 'Check operating status' },
  { name: 'snowday', label: '/snowday', category: 'general', defaultTier: 'everyone', description: 'Snow day outlook' },
  { name: 'calendar', label: '/calendar', category: 'general', defaultTier: 'everyone', description: 'Upcoming calendar events' },
  { name: 'history', label: '/history', category: 'general', defaultTier: 'everyone', description: 'Operating status history' },
  { name: 'districts', label: '/districts', category: 'general', defaultTier: 'everyone', description: 'Neighboring school districts' },
  { name: 'outages', label: '/outages', category: 'general', defaultTier: 'everyone', description: 'Utility outage counts' },
  { name: 'stats', label: '/stats', category: 'general', defaultTier: 'everyone', description: 'Closure & check statistics' },
  { name: 'notify', label: '/notify', category: 'general', defaultTier: 'everyone', description: 'DM notifications on status changes' },
  { name: 'myschool', label: '/myschool', category: 'general', defaultTier: 'everyone', description: 'School-specific notice DMs' },
  { name: 'setupclasses', label: '/setupclasses', category: 'general', defaultTier: 'everyone', description: 'Class schedule & room numbers' },
  { name: 'mapmyclass', label: '/mapmyclass', category: 'general', defaultTier: 'everyone', description: 'Class route map generation' },
  { name: 'dankmemer', label: '/dankmemer', category: 'general', defaultTier: 'everyone', description: 'Dank Memer application' },
  { name: 'staffapplication', label: '/staffapplication', category: 'general', defaultTier: 'everyone', description: 'Staff application' },
  { name: 'requestannouncement', label: '/requestannouncement', category: 'general', defaultTier: 'everyone', description: 'Submit announcement request' },
  { name: 'searchemails', label: '/searchemails', category: 'general', defaultTier: 'everyone', description: 'Search archived school emails' },
  { name: 'terms', label: '/terms', category: 'general', defaultTier: 'everyone', description: 'Terms and Conditions' },
  { name: 'privacy', label: '/privacy', category: 'general', defaultTier: 'everyone', description: 'Privacy Policy' },
  { name: 'screenshot', label: '/screenshot', category: 'general', defaultTier: 'everyone', description: 'Capture live screenshot of official HCPSS school status page' },
  { name: 'widget', label: '/widget', category: 'general', defaultTier: 'everyone', description: 'Setup live school status widget on iPhone / iOS' },
  { name: 'help', label: '/help', category: 'general', defaultTier: 'everyone', description: 'Command list & help' },

  // Staff & Admin Commands (default: staff)
  { name: 'post-status', label: '/post-status', category: 'admin', defaultTier: 'staff', description: 'Force post status to alert channel' },
  { name: 'manualstatus', label: '/manualstatus', category: 'admin', defaultTier: 'staff', description: 'Set/clear manual school status' },
  { name: 'override', label: '/override', category: 'admin', defaultTier: 'staff', description: 'Status override' },
  { name: 'events', label: '/events', category: 'admin', defaultTier: 'staff', description: 'Add/remove calendar events' },
  { name: 'announce', label: '/announce', category: 'admin', defaultTier: 'staff', description: 'Post announcement embed' },
  { name: 'health', label: '/health', category: 'admin', defaultTier: 'staff', description: 'Bot health & diagnostics snapshot' },
  { name: 'refresh-panel', label: '/refresh-panel', category: 'admin', defaultTier: 'staff', description: 'Refresh log panel embed' },
  { name: 'panel', label: '/panel', category: 'admin', defaultTier: 'staff', description: 'Interactive control panel' },
  { name: 'chscontrols', label: '/chscontrols', category: 'admin', defaultTier: 'staff', description: 'CHS interactive control panel' },
  { name: 'setup', label: '/setup', category: 'admin', defaultTier: 'staff', description: 'Initial setup wizard' },
  { name: 'setupjoinlogs', label: '/setupjoinlogs', category: 'admin', defaultTier: 'staff', description: 'Configure join logs & auto-roles' },
  { name: 'emailchannel', label: '/emailchannel', category: 'admin', defaultTier: 'staff', description: 'Configure school email channel' },
  { name: 'addroledm', label: '/addroledm', category: 'admin', defaultTier: 'staff', description: 'Give role & DM member' },
  { name: 'dankstaffsetup', label: '/dankstaffsetup', category: 'admin', defaultTier: 'staff', description: 'Dank Memer application channel' },
  { name: 'staffappsetup', label: '/staffappsetup', category: 'admin', defaultTier: 'staff', description: 'Staff application review channel' },
  { name: 'social-link', label: '/social-link', category: 'admin', defaultTier: 'staff', description: 'Social media webhook generator' },
  { name: 'districtchannel', label: '/districtchannel', category: 'admin', defaultTier: 'staff', description: 'Configure dedicated channels for neighboring school districts' },
  { name: 'backup-db', label: '/backup-db', category: 'admin', defaultTier: 'staff', description: 'Snapshot Cloudflare D1 database to R2' },
  { name: 'mydata', label: '/mydata', category: 'admin', defaultTier: 'staff', description: 'View or erase server stored data' }
];

export function getCommandTier(config, commandName) {
  const meta = ALL_COMMANDS_META.find(c => c.name === commandName);
  const defaultTier = meta ? meta.defaultTier : 'staff';
  if (!config) return defaultTier;

  // Check legacy disabled_commands array
  if (Array.isArray(config.disabled_commands) && config.disabled_commands.includes(commandName)) {
    return 'disabled';
  }

  // Check command_permissions map: { [commandName]: 'everyone' | 'staff' | 'disabled' }
  if (config.command_permissions && typeof config.command_permissions[commandName] === 'string') {
    return config.command_permissions[commandName];
  }

  return defaultTier;
}

export async function canMemberExecuteCommand(commandName, member, env, guildId = '') {
  // Owner can always run any command
  const ownerId = String(env?.OWNER_ID || '').trim();
  const invokerId = member?.user?.id;
  if (ownerId && invokerId && invokerId === ownerId) {
    return { allowed: true };
  }

  const config = await getConfig(env, guildId);
  const tier = getCommandTier(config, commandName);

  if (tier === 'disabled') {
    return { allowed: false, reason: `❌ The \`/${commandName}\` command has been disabled on this server.` };
  }

  if (tier === 'everyone') {
    return { allowed: true };
  }

  // Tier is 'staff'
  const isStaff = await canUseCommands(member, env, guildId);
  if (!isStaff) {
    return { allowed: false, reason: `❌ You do not have permission to use the \`/${commandName}\` command (Staff Only).` };
  }

  return { allowed: true };
}

function overrideKey(guildId) {
  return guildId ? `override:${guildId}` : 'override:default';
}

export async function getActiveOverride(env, guildId = '') {
  const key = overrideKey(guildId || env.DISCORD_GUILD_ID);
  const raw = await env.STATUS_KV.get(key);
  if (!raw) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const until = typeof parsed.until === 'number' ? parsed.until : 0;
  if (!until) return null;

  const now = Date.now();
  if (now > until) {
    await env.STATUS_KV.delete(key).catch(() => {});
    return null;
  }

  return parsed;
}

export async function setOverride(env, guildId, override) {
  const key = overrideKey(guildId || env.DISCORD_GUILD_ID);
  await env.STATUS_KV.put(key, JSON.stringify(override));
}

export async function clearOverride(env, guildId) {
  const key = overrideKey(guildId || env.DISCORD_GUILD_ID);
  await env.STATUS_KV.delete(key);
}
