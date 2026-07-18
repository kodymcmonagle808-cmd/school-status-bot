// "My notifications" panel: an ephemeral multi-select pre-checked with the
// member's current ping roles. Ephemeral responses are per-user, so defaults
// can reflect real role state — the shared status-post dropdown cannot.

import { ALL_STATUS_LABELS, EPHEMERAL_FLAG } from './constants.js';
import { getInvokerId } from './discord.js';

export const MY_PINGS_VALUE = 'my_pings';

function configuredPingRoles(cfg) {
  const mapping = (cfg && cfg.status_ping_roles) || {};
  return Object.entries(ALL_STATUS_LABELS)
    .filter(([key]) => mapping[key])
    .map(([key, label]) => ({ key, label, roleId: mapping[key] }));
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
    description: `Ping role for ${label}`,
    emoji: { name: '🔔' },
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
