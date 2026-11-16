// "My notifications" panel: an ephemeral multi-select pre-checked with the
// member's current ping roles. Ephemeral responses are per-user, so defaults
// can reflect real role state — the shared status-post dropdown cannot.

import { ALL_STATUS_LABELS, EPHEMERAL_FLAG } from './constants.js';
import { getInvokerId } from './discord.js';

export const MY_PINGS_VALUE = 'my_pings';

export const WEATHER_PING_CATEGORIES = [
  { key: 'tornado', label: 'Tornado Alerts', hint: 'Tornado watch/warning', emoji: '🌪️' },
  { key: 'flood', label: 'Flood Alerts', hint: 'Flood/flash flood watch/warning', emoji: '🌊' },
  { key: 'winter', label: 'Winter Weather Alerts', hint: 'Snow/ice/winter storm/blizzard', emoji: '❄️' },
  { key: 'heat', label: 'Heat Alerts', hint: 'Heat advisory/excessive heat warning', emoji: '☀️' },
  { key: 'storm', label: 'Severe Storm Alerts', hint: 'Severe thunderstorm/wind/hurricane', emoji: '⛈️' },
  { key: 'minimal', label: 'Minor Advisories', hint: 'Minor weather advisories & statements', emoji: '⚠️' },
  { key: 'default', label: 'General Weather Alerts', hint: 'All other weather warnings & watches', emoji: '📢' }
];

function configuredPingRoles(cfg) {
  const mapping = (cfg && cfg.status_ping_roles) || {};
  return Object.entries(ALL_STATUS_LABELS)
    .filter(([key]) => mapping[key])
    .map(([key, label]) => ({ key, label, roleId: mapping[key] }));
}

function configuredWeatherPingRoles(cfg) {
  const raw = (cfg && cfg.ping_role_ids) || {};
  const pingMap = Array.isArray(raw) ? { default: raw } : raw;
  const list = [];

  for (const cat of WEATHER_PING_CATEGORIES) {
    const rawRoles = pingMap[cat.key];
    const roleIds = Array.isArray(rawRoles) ? rawRoles : (rawRoles ? [String(rawRoles)] : []);
    if (roleIds.length > 0 && roleIds[0]) {
      list.push({
        key: cat.key,
        label: cat.label,
        hint: cat.hint,
        emoji: cat.emoji,
        roleId: String(roleIds[0])
      });
    }
  }
  return list;
}

export function buildMyPingsPanel(cfg, member) {
  const roles = configuredPingRoles(cfg);
  if (!roles.length) {
    return {
      content: '❌ No notification roles are configured in this server yet.',
      flags: EPHEMERAL_FLAG
    };
  }

  const memberRoles = (member && Array.isArray(member.roles)) ? member.roles : [];
  const options = roles.map(({ key, label, roleId }) => ({
    label,
    value: key,
    // Normal Operations pings on every scheduled post — warn in the option
    // itself since a multi-select submit has no confirmation step.
    description: key === 'normal_operations'
      ? '⚠️ Everyday status — expect pings on every scheduled post'
      : `Ping role for ${label}`,
    emoji: { name: key === 'normal_operations' ? '⚠️' : '🔔' },
    default: memberRoles.includes(roleId)
  }));

  const checkedCount = options.filter(o => o.default).length;
  return {
    content: `📋 **Your notification roles** — checked = you currently have it (${checkedCount}/${options.length}).\n` +
             'Select the full set you want and submit; unchecked roles are removed.',
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: 'my_pings_select',
        placeholder: 'Choose your notification roles...',
        options,
        min_values: 0,
        max_values: options.length
      }]
    }],
    flags: EPHEMERAL_FLAG
  };
}

export function buildMyWeatherPingsPanel(cfg, member) {
  const roles = configuredWeatherPingRoles(cfg);
  if (!roles.length) {
    return {
      content: '⛈️ **Weather Alert Roles**\n\n❌ No weather alert roles are configured in this server yet.\n*(Server staff can configure them in `/panel` under **NWS Ping Roles**.)*',
      flags: EPHEMERAL_FLAG
    };
  }

  const memberRoles = (member && Array.isArray(member.roles)) ? member.roles : [];
  const options = roles.map(({ key, label, hint, emoji, roleId }) => ({
    label,
    value: key,
    description: hint,
    emoji: { name: emoji },
    default: memberRoles.includes(roleId)
  }));

  const checkedCount = options.filter(o => o.default).length;
  return {
    content: `⛈️ **Your weather alert notification roles** — checked = you currently have it (${checkedCount}/${options.length}).\n` +
             'Select which weather hazard alerts you want to be pinged for, and submit; unchecked roles are removed.',
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: 'my_weather_pings_select',
        placeholder: 'Choose your weather alert roles...',
        options,
        min_values: 0,
        max_values: options.length
      }]
    }],
    flags: EPHEMERAL_FLAG
  };
}

export async function handleMyWeatherPingsSubmit(body, env, guildId, cfg) {
  const userId = getInvokerId(body);
  if (!userId) {
    return { content: '❌ Could not determine your user ID.', components: [] };
  }

  const selected = Array.isArray(body.data.values) ? body.data.values : [];
  const memberRoles = (body.member && Array.isArray(body.member.roles)) ? body.member.roles : [];
  const token = env.DISCORD_BOT_TOKEN;

  const added = [];
  const removed = [];
  let failures = 0;

  for (const { key, label, roleId } of configuredWeatherPingRoles(cfg)) {
    const want = selected.includes(key);
    const has = memberRoles.includes(roleId);
    if (want === has) continue;

    const resp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: want ? 'PUT' : 'DELETE',
      headers: {
        Authorization: `Bot ${token}`,
        'X-Audit-Log-Reason': 'Self-service weather alert role panel'
      }
    });
    if (resp.ok) (want ? added : removed).push(label);
    else failures++;
  }

  if (failures && !added.length && !removed.length) {
    return {
      content: '❌ Couldn\'t update your weather roles. The bot needs the **Manage Roles** permission, ' +
               'and its role must be above the weather notification roles in the role list.',
      components: []
    };
  }

  const lines = ['✅ **Weather alert notification roles updated!**'];
  if (added.length) lines.push(`🔔 Added: ${added.join(', ')}`);
  if (removed.length) lines.push(`🔕 Removed: ${removed.join(', ')}`);
  if (!added.length && !removed.length) lines.push('No changes — your selection already matched your weather roles.');
  if (failures) lines.push(`⚠️ ${failures} change(s) failed — check the bot's Manage Roles permission.`);

  return { content: lines.join('\n'), components: [] };
}

// Syncs the member's roles to exactly the submitted selection and returns the
// data for a type-7 update of the ephemeral panel.
export async function handleMyPingsSubmit(body, env, guildId, cfg) {
  const userId = getInvokerId(body);
  if (!userId) {
    return { content: '❌ Could not determine your user ID.', components: [] };
  }

  const selected = Array.isArray(body.data.values) ? body.data.values : [];
  const memberRoles = (body.member && Array.isArray(body.member.roles)) ? body.member.roles : [];
  const token = env.DISCORD_BOT_TOKEN;

  const added = [];
  const removed = [];
  let failures = 0;

  for (const { key, label, roleId } of configuredPingRoles(cfg)) {
    const want = selected.includes(key);
    const has = memberRoles.includes(roleId);
    if (want === has) continue;

    const resp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: want ? 'PUT' : 'DELETE',
      headers: {
        Authorization: `Bot ${token}`,
        'X-Audit-Log-Reason': 'Self-service HCPSS notification role panel'
      }
    });
    if (resp.ok) (want ? added : removed).push(label);
    else failures++;
  }

  if (failures && !added.length && !removed.length) {
    return {
      content: '❌ Couldn\'t update your roles. The bot needs the **Manage Roles** permission, ' +
               'and its role must be above the notification roles in the role list.',
      components: []
    };
  }

  const lines = ['✅ **Notification roles updated!**'];
  if (added.length) lines.push(`🔔 Added: ${added.join(', ')}`);
  if (removed.length) lines.push(`🔕 Removed: ${removed.join(', ')}`);
  if (!added.length && !removed.length) lines.push('No changes — your selection already matched your roles.');
  if (failures) lines.push(`⚠️ ${failures} change(s) failed — check the bot's Manage Roles permission.`);

  return { content: lines.join('\n'), components: [] };
}
