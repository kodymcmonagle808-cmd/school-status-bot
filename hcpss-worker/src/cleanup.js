// Purges KV data for guilds the bot is no longer a member of, keeping the
// Privacy Policy's promise that server data is deleted automatically after
// the bot is removed. Runs from the cron tick at most once per day.

const CLEANUP_DAY_KEY = 'last_guild_cleanup_day';

// Every exact KV key that stores data for a single guild. Keep in sync with
// the modules that write them (config, panel, check, digest, headsup,
// subscriptions, greeter, interactions).
function guildKeys(guildId) {
  return [
    `config:${guildId}`,
    `override:${guildId}`,
    `setup_done:${guildId}`,
    `panel_logs:${guildId}`,
    `panel_page:${guildId}`,
    `last_check_latency:${guildId}`,
    `last_check_time:${guildId}`,
    `last_message_id:${guildId}`,
    `last_channel_id:${guildId}`,
    `log_panel_message_id:${guildId}`,
    `dm_subscribers:${guildId}`,
    `school_subs:${guildId}`,
    `decision_watch:${guildId}`,
    `last_digest_day:${guildId}`,
    `last_headsup_day:${guildId}`,
    `last_sched_slot:${guildId}`,
    `greeter_last_run_date:${guildId}`,
    `greeted_users:${guildId}`,
    `last_recap_year:${guildId}`,
    `last_aqi_day:${guildId}`,
    `last_storm_recap:${guildId}`,
    `alert_post_failures:${guildId}`
  ];
}

// Key families with per-guild prefixes and variable suffixes.
function guildPrefixes(guildId) {
  return [
    `calendar_event:${guildId}:`,
    `greeted:${guildId}:`
  ];
}

// Returns 'in', 'out', or 'unknown'. Only a definitive 404 Unknown Guild
// (code 10004) counts as 'out' — rate limits, network errors, and anything
// ambiguous must never trigger a purge.
async function botGuildMembership(env, guildId) {
  try {
    const resp = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
    });
    if (resp.ok) return 'in';
    if (resp.status === 404) {
      const data = await resp.json().catch(() => null);
      if (data && data.code === 10004) return 'out';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// Also used by /mydata delete for on-demand purges.
export async function purgeGuildData(env, guildId) {
  for (const key of guildKeys(guildId)) {
    await env.STATUS_KV.delete(key).catch(() => {});
  }

  for (const prefix of guildPrefixes(guildId)) {
    let cursor = undefined;
    do {
      const listResult = await env.STATUS_KV.list({ prefix, cursor });
      for (const key of listResult.keys) {
        await env.STATUS_KV.delete(key.name).catch(() => {});
      }
      cursor = listResult.list_complete ? undefined : listResult.cursor;
    } while (cursor);
  }
}

export async function removeFromGuildIndex(env, guildId) {
  try {
    const rawIndex = await env.STATUS_KV.get('guild_index');
    if (!rawIndex) return;
    const index = JSON.parse(rawIndex);
    if (!Array.isArray(index) || !index.includes(guildId)) return;
    await env.STATUS_KV.put('guild_index', JSON.stringify(index.filter(id => id !== guildId)));
  } catch (e) {
    console.error('Failed to update guild index during cleanup:', e);
  }
}

// Once per UTC day: find every guild with stored config, ask Discord whether
// the bot is still in it, and purge the data of guilds it has left.
export async function maybeCleanupDepartedGuilds(env) {
  if (!env || !env.STATUS_KV || !env.DISCORD_BOT_TOKEN) return { purged: [] };

  const todayStr = new Date().toISOString().split('T')[0];
  const lastRun = await env.STATUS_KV.get(CLEANUP_DAY_KEY);
  if (lastRun === todayStr) return { purged: [] };
  await env.STATUS_KV.put(CLEANUP_DAY_KEY, todayStr);

  let guildIds = [];
  try {
    let cursor = undefined;
    do {
      const listResult = await env.STATUS_KV.list({ prefix: 'config:', cursor });
      for (const key of listResult.keys) {
        guildIds.push(key.name.replace(/^config:/, ''));
      }
      cursor = listResult.list_complete ? undefined : listResult.cursor;
    } while (cursor);
  } catch (e) {
    console.error('Cleanup: failed to list configs:', e);
    return { purged: [] };
  }

  // 'config:default' belongs to the env-configured primary guild, not a
  // per-guild record — only real snowflake IDs can be checked and purged.
  guildIds = guildIds.filter(id => /^\d+$/.test(id));

  const purged = [];
  for (const guildId of guildIds) {
    const membership = await botGuildMembership(env, guildId);
    if (membership !== 'out') continue;
    try {
      await purgeGuildData(env, guildId);
      await removeFromGuildIndex(env, guildId);
      purged.push(guildId);
      console.log(`Cleanup: purged data for departed guild ${guildId}`);
    } catch (e) {
      console.error(`Cleanup: failed to purge guild ${guildId}:`, e);
    }
  }

  return { purged };
}
