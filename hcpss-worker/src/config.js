// Per-guild config and status overrides, stored in KV.

import { DEFAULT_STAFF_ROLE_ID, DEFAULT_LOG_CHANNEL_ID, DEFAULT_CHECK_SCHEDULE } from './constants.js';
import { memberIsAdmin, memberHasRole } from './discord.js';

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
  // avoid KV list operations.
  if (effectiveGuildId) {
    try {
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
  if (!next.log_channel_id) next.log_channel_id = DEFAULT_LOG_CHANNEL_ID;
  if (!Array.isArray(next.ping_role_ids)) next.ping_role_ids = [];
  if (!next.status_ping_roles) next.status_ping_roles = {};
  if (!next.status_embed_colors) next.status_embed_colors = {};
  if (!next.editing_status_key) next.editing_status_key = 'normal_operations';
  if (!Array.isArray(next.check_schedule)) {
    next.check_schedule = [...DEFAULT_CHECK_SCHEDULE];
  }
  if (typeof next.toggle_pings !== 'boolean') next.toggle_pings = true;
  if (typeof next.toggle_error_alerts !== 'boolean') next.toggle_error_alerts = true;
  if (typeof next.toggle_weather !== 'boolean') next.toggle_weather = true;
  if (typeof next.toggle_storm_mode !== 'boolean') next.toggle_storm_mode = true;
  if (typeof next.toggle_districts !== 'boolean') next.toggle_districts = true;
  if (typeof next.toggle_outlook !== 'boolean') next.toggle_outlook = true;
  if (typeof next.toggle_crosscheck !== 'boolean') next.toggle_crosscheck = true;
  if (typeof next.toggle_heads_up !== 'boolean') next.toggle_heads_up = true;
  if (typeof next.toggle_bus_alerts !== 'boolean') next.toggle_bus_alerts = true;
  if (typeof next.toggle_school_notices !== 'boolean') next.toggle_school_notices = true;
  if (typeof next.toggle_outages !== 'boolean') next.toggle_outages = true;
  if (typeof next.toggle_roads !== 'boolean') next.toggle_roads = true;
  if (typeof next.toggle_year_recap !== 'boolean') next.toggle_year_recap = true;
  if (!next.primary_district) next.primary_district = 'hcpss';
  return next;
}

export async function canUseCommands(member, env, guildId = '') {
  if (memberIsAdmin(member)) return true;
  const stored = await getConfig(env, guildId);
  const cfg = getEffectiveConfig(stored);
  return memberHasRole(member, cfg.staff_role_id);
}

export async function canConfigure(member, env, guildId = '') {
  return await canUseCommands(member, env, guildId);
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
