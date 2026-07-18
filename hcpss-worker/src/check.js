// The core check-and-post loop plus scraper health tracking (consecutive
// failure alerts and recovery notices).

import { getEasternTimeStr, matchesScheduleTime, formatYmdNY, stormTickSlot } from './timeutil.js';
import { getStatusCards } from './scraper.js';
import { getActiveWeatherAlerts, hasStormAlert } from './weather.js';
import { getDistrictStatuses } from './districts.js';
import { trackStatusHistory } from './history.js';
import { notifySubscribers } from './subscriptions.js';
import { getConfig, getEffectiveConfig } from './config.js';
import { buildStatusPayload } from './embeds.js';
import { postMessageToChannel } from './discord.js';
import { postLog } from './panel.js';

const MAX_FAILURES_THRESHOLD = 3;

// After this many consecutive failed posts to a guild's alert channel, warn
// the log channel and DM the server owner — the most likely causes (deleted
// channel, revoked permissions) are silent otherwise and the server just
// stops getting updates.
const ALERT_CHANNEL_FAILURE_THRESHOLD = 3;

async function recordAlertPostFailure(env, guildId, channelId, logChannelId) {
  const failKey = `alert_post_failures:${guildId}`;
  const failures = (parseInt(await env.STATUS_KV.get(failKey), 10) || 0) + 1;
  await env.STATUS_KV.put(failKey, String(failures));

  // Fire the escalation exactly once per streak.
  if (failures !== ALERT_CHANNEL_FAILURE_THRESHOLD) return;

  const warning = `🚨 **Alert channel broken?** The bot has failed to post to <#${channelId}> ` +
    `**${failures} times in a row**. Check that the channel still exists and the bot has ` +
    `**View Channel**, **Send Messages**, and **Embed Links** there — or pick a new alert ` +
    `channel in the control panel. Status updates are NOT reaching members until this is fixed.`;

  await postLog(env, logChannelId, warning, {}, guildId);

  // The log channel may be broken too, so also try to DM the server owner.
  try {
    const token = env.DISCORD_BOT_TOKEN;
    const guildResp = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${token}` }
    });
    if (!guildResp.ok) return;
    const ownerId = (await guildResp.json()).owner_id;
    if (!ownerId) return;

    const chResp = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: ownerId })
    });
    if (!chResp.ok) return;
    const dmChannel = await chResp.json();
    await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: warning })
    });
  } catch (e) {
    console.error('Owner DM for broken alert channel failed:', e);
  }
}

async function handleScraperFailure(env, logChannelId, config, error) {
  const currentFailures = Number(await env.STATUS_KV.get('scraper_failures_count') || 0) + 1;
  await env.STATUS_KV.put('scraper_failures_count', String(currentFailures));

  if (currentFailures >= MAX_FAILURES_THRESHOLD) {
    if (config && config.toggle_error_alerts === false) {
      return;
    }
    const alreadyAlerted = await env.STATUS_KV.get('scraper_failure_alerted') === 'true';
    if (!alreadyAlerted) {
      await env.STATUS_KV.put('scraper_failure_alerted', 'true');

      const staffRoleId = config.staff_role_id;
      const pingText = staffRoleId ? `<@&${staffRoleId}> ` : '';
      const errorMessage = error && error.message ? error.message : 'Unknown scraping error';

      const token = env.DISCORD_BOT_TOKEN;
      if (token && logChannelId) {
        await fetch(`https://discord.com/api/v10/channels/${logChannelId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            content: `⚠️ ${pingText}**SCRAPER FAILURE ALERT!**\nThe HCPSS status scraper has failed **${currentFailures} consecutive times**.\n` +
                     `• Latest Error: \`${errorMessage}\`\n` +
                     `• This warning will not repeat until the scraper recovers.`,
            allowed_mentions: staffRoleId ? { roles: [staffRoleId] } : { parse: [] }
          })
        }).catch(() => {});
      }
    }
  }
}

async function handleScraperSuccess(env, logChannelId, config) {
  const failures = Number(await env.STATUS_KV.get('scraper_failures_count') || 0);
  if (failures === 0) return;

  await env.STATUS_KV.put('scraper_failures_count', '0');

  const wasAlerted = await env.STATUS_KV.get('scraper_failure_alerted') === 'true';
  if (!wasAlerted) return;
  await env.STATUS_KV.delete('scraper_failure_alerted');

  // Staff got a failure alert, so close the loop with a recovery notice.
  if (config && config.toggle_error_alerts === false) return;
  const token = env.DISCORD_BOT_TOKEN;
  if (token && logChannelId) {
    await fetch(`https://discord.com/api/v10/channels/${logChannelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: `✅ **Scraper recovered.** The HCPSS status scraper is working again after **${failures} consecutive failure(s)**.`,
        allowed_mentions: { parse: [] }
      })
    }).catch(() => {});
  }
}

async function handleScraperSuccessOrFailure(env, scrapeFailed, error, targetGuildIds) {
  const defaultGuildConfig = getEffectiveConfig(await getConfig(env, env.DISCORD_GUILD_ID));
  const logChannelId = targetGuildIds.length > 0
    ? getEffectiveConfig(await getConfig(env, targetGuildIds[0])).log_channel_id
    : defaultGuildConfig.log_channel_id;

  if (scrapeFailed) {
    await handleScraperFailure(env, logChannelId, defaultGuildConfig, error);
  } else {
    await handleScraperSuccess(env, logChannelId, defaultGuildConfig);
  }
}

export async function doCheckAndPost(env, options = {}) {
  const start = Date.now();
  const isScheduled = options.source === 'scheduled';

  // Determine target guilds to post/check for.
  let targetGuildIds = [];
  if (options.guildId) {
    targetGuildIds = [options.guildId];
  } else {
    // Scheduled runs fire every minute, so read the cached guild index instead of
    // doing a KV list operation (list ops are limited to 1,000/day on the free plan).
    let haveIndex = false;
    if (isScheduled) {
      const rawIndex = await env.STATUS_KV.get('guild_index');
      if (rawIndex) {
        try {
          const parsedIndex = JSON.parse(rawIndex);
          if (Array.isArray(parsedIndex)) {
            targetGuildIds = parsedIndex.filter(Boolean);
            haveIndex = true;
          }
        } catch {}
      }
    }

    if (!haveIndex) {
      // Collect all guilds from KV keys starting with 'config:'
      try {
        const listResult = await env.STATUS_KV.list({ prefix: 'config:' });
        targetGuildIds = listResult.keys.map(k => k.name.replace(/^config:/, '')).filter(Boolean);
        if (isScheduled) {
          await env.STATUS_KV.put('guild_index', JSON.stringify(targetGuildIds));
        }
      } catch (e) {
        console.error('Failed to list configs in KV:', e);
      }
    }

    // Ensure default guild from environment is included if configured
    if (env.DISCORD_GUILD_ID && !targetGuildIds.includes(env.DISCORD_GUILD_ID)) {
      targetGuildIds.push(env.DISCORD_GUILD_ID);
    }
  }

  let activeGuildIds = [...targetGuildIds];
  let isStormCheck = false;

  if (isScheduled) {
    const now = new Date();
    const currentEtStr = getEasternTimeStr(now);
    const todayYmd = formatYmdNY(now);
    const matchedGuilds = [];
    for (const guildId of targetGuildIds) {
      const stored = await getConfig(env, guildId);
      const config = getEffectiveConfig(stored);
      const schedule = Array.isArray(config.check_schedule) ? config.check_schedule : [];
      const matchedTime = schedule.find(schedTime => matchesScheduleTime(currentEtStr, schedTime));
      if (!matchedTime) continue;

      // Dedupe: the cron fires every minute and the match window is 5 minutes
      // wide, so skip guilds whose matched slot already ran today.
      const slotKey = `last_sched_slot:${guildId}`;
      const slotVal = `${todayYmd} ${matchedTime}`;
      const lastSlot = await env.STATUS_KV.get(slotKey);
      if (lastSlot === slotVal) continue;
      await env.STATUS_KV.put(slotKey, slotVal);

      matchedGuilds.push(guildId);
    }
    activeGuildIds = matchedGuilds;

    // Storm mode: when no regular check matched, run extra checks every 15
    // minutes during the 4:30-7:30 AM ET decision window while a winter storm
    // alert is active. Storm checks only post (and ping) if the status changed.
    if (activeGuildIds.length === 0) {
      const stormSlot = stormTickSlot(currentEtStr);
      if (!stormSlot) {
        return { ok: true, skipped: true, message: 'No guilds scheduled for this time.' };
      }
      const alerts = await getActiveWeatherAlerts(env);
      if (!hasStormAlert(alerts)) {
        return { ok: true, skipped: true, message: 'Storm window, but no storm alert active.' };
      }
      const slotVal = `${todayYmd} ${stormSlot}`;
      if (await env.STATUS_KV.get('last_storm_slot') === slotVal) {
        return { ok: true, skipped: true, message: 'Storm slot already checked.' };
      }
      await env.STATUS_KV.put('last_storm_slot', slotVal);
      isStormCheck = true;
      activeGuildIds = [...targetGuildIds];
    }
  }

  if (activeGuildIds.length === 0) {
    return { ok: true, skipped: true, message: 'No guilds scheduled for this time.' };
  }

  // 1. Fetch HTML and extract cards once (falls back to the cached last-good
  // scrape when the live page is unreachable).
  const fetched = await getStatusCards(env);
  const cards = fetched.cards;
  const error = fetched.cards ? null : fetched.error;
  const isStale = fetched.stale;
  const staleAt = fetched.staleAt;
  const scrapeFailed = !!fetched.error;
  const latency = Date.now() - start;

  // Increment check counts in KV
  try {
    let stats = {};
    const rawStats = await env.STATUS_KV.get('status_stats');
    if (rawStats) {
      stats = JSON.parse(rawStats) || {};
    }
    stats.scrapes_total = (stats.scrapes_total || 0) + 1;
    if (scrapeFailed) {
      stats.scrapes_failed = (stats.scrapes_failed || 0) + 1;
    }
    await env.STATUS_KV.put('status_stats', JSON.stringify(stats));
  } catch (e) {
    console.error('Failed to update scraper statistics:', e);
  }

  // Fetch status once using a default/live payload to determine global history/failures tracking.
  const liveStatusResult = await buildStatusPayload(env, {
    includeComponents: true,
    cards,
    error,
    stale: isStale,
    staleAt
  });

  const firstEmbedGlobal = liveStatusResult.payload.embeds && liveStatusResult.payload.embeds[0];
  const liveStatusTextGlobal = firstEmbedGlobal ? (firstEmbedGlobal.description || '') : '';

  // Track global status history on change. A stale fallback repeats the cached
  // status, so it can never register as a change (or trigger DM notifications).
  let statusChanged = false;
  if (!liveStatusResult.isOverride && !liveStatusResult.isError && !isStale) {
    const lastKnownStatus = await env.STATUS_KV.get('last_known_status');
    if (lastKnownStatus !== liveStatusTextGlobal) {
      statusChanged = lastKnownStatus !== null;
      if (firstEmbedGlobal) {
        const statusTitle = firstEmbedGlobal.title || '';
        await trackStatusHistory(env, liveStatusTextGlobal, statusTitle, liveStatusResult.statusKey);
      }
      await env.STATUS_KV.put('last_known_status', liveStatusTextGlobal);
    }
  }

  // Guilds with a non-HCPSS primary district track changes against their own
  // district's announcements, not the HCPSS status page.
  const guildPrimaries = new Map();
  for (const gid of targetGuildIds) {
    const cfg = getEffectiveConfig(await getConfig(env, gid));
    guildPrimaries.set(gid, cfg.primary_district || 'hcpss');
  }
  const primaryDistrictIds = new Set([...guildPrimaries.values()].filter(id => id !== 'hcpss'));
  const changedDistricts = new Set();
  if (primaryDistrictIds.size) {
    try {
      const districtStatuses = await getDistrictStatuses(env);
      for (const id of primaryDistrictIds) {
        const d = districtStatuses.find(x => x.id === id);
        if (!d || d.status === 'unavailable') continue;
        const sig = `${d.status}|${d.detail || ''}`;
        const key = `last_district_status:${id}`;
        const prev = await env.STATUS_KV.get(key);
        if (prev !== sig) {
          // First observation is a baseline, not a change.
          if (prev !== null) changedDistricts.add(id);
          await env.STATUS_KV.put(key, sig);
        }
      }
    } catch (e) {
      console.error('District change tracking failed:', e);
    }
  }

  // Storm checks are silent unless the status actually changed — no reposts,
  // no pings, just fast detection of a new closing/delay announcement.
  if (isStormCheck && !statusChanged && changedDistricts.size === 0) {
    await handleScraperSuccessOrFailure(env, scrapeFailed, fetched.error, targetGuildIds);
    return { ok: true, skipped: true, message: 'Storm check: status unchanged.' };
  }

  const results = [];
  const sourceLabel = isStormCheck ? 'storm-mode' : (options.source || 'unknown');

  for (const guildId of activeGuildIds) {
    const stored = await getConfig(env, guildId);
    const config = getEffectiveConfig(stored);
    if (isStormCheck && config.toggle_storm_mode === false) {
      results.push({ guildId, ok: true, skipped: true, reason: 'Storm mode disabled' });
      continue;
    }
    const primary = guildPrimaries.get(guildId) || config.primary_district || 'hcpss';
    const guildSourceChanged = primary === 'hcpss' ? statusChanged : changedDistricts.has(primary);
    if (isStormCheck && !guildSourceChanged) {
      results.push({ guildId, ok: true, skipped: true, reason: 'Storm check: no change for this guild\'s district' });
      continue;
    }
    const channelId = config.alert_channel_id || (guildId === env.DISCORD_GUILD_ID ? env.DISCORD_CHANNEL_ID : null);
    const logChannelId = config.log_channel_id;
    if (!channelId) {
      // Guild hasn't configured an alert channel yet, but we should still update check timestamp & control panel
      await postLog(
        env,
        logChannelId,
        null,
        { latency },
        guildId
      );
      results.push({ guildId, ok: true, skipped: true, reason: 'No alert channel configured' });
      continue;
    }
    const pingRoleIds = Array.isArray(config.ping_role_ids) ? config.ping_role_ids : [];

    // Get the status payload for THIS guild (incorporates any active override for this guild)
    const builtStatus = await buildStatusPayload(env, {
      includeComponents: true,
      guildId,
      cards,
      error,
      stale: isStale,
      staleAt
    });

    const statusKey = builtStatus.statusKey || 'normal_operations';

    let roleId = undefined;
    if (config.status_ping_roles) {
      roleId = config.status_ping_roles[statusKey];
    }

    let rolesToPing = [];
    if (roleId) {
      rolesToPing = [roleId];
    } else if (roleId === undefined && statusKey !== 'normal_operations') {
      rolesToPing = pingRoleIds;
    }

    const pingsEnabled = config.toggle_pings !== false;
    const content = (pingsEnabled && rolesToPing.length) ? rolesToPing.map(id => `<@&${id}>`).join(' ') : '';
    const payload = {
      ...builtStatus.payload,
      content,
      allowed_mentions: (pingsEnabled && rolesToPing.length) ? { roles: rolesToPing } : { parse: [] },
      __channelId: channelId
    };

    // Every check posts the latest status, changed or not (the previous status
    // message is deleted after the new one goes out). The only exception is a
    // scraper error during a scheduled run — the failure alert system covers that.
    const shouldPostAlert = !isScheduled || !builtStatus.isError;

    let postedMessageId = null;
    if (shouldPostAlert) {
      const postResult = await postMessageToChannel(env, payload);
      if (!postResult.ok) {
        const postError = await postResult.text();
        await postLog(
          env,
          logChannelId,
          `❌ HCPSS status check failed (source: ${sourceLabel}): ${postError}`,
          { latency },
          guildId
        );
        await recordAlertPostFailure(env, guildId, channelId, logChannelId);
        results.push({ guildId, ok: false, error: postError, status: postResult.status });
        continue;
      }

      // A successful post ends any broken-channel failure streak.
      await env.STATUS_KV.delete(`alert_post_failures:${guildId}`).catch(() => {});

      const postedMessage = await postResult.json();
      postedMessageId = postedMessage.id;

      const previousMessageId = await env.STATUS_KV.get(`last_message_id:${guildId}`);
      const previousChannelId = await env.STATUS_KV.get(`last_channel_id:${guildId}`);

      await env.STATUS_KV.put(`last_message_id:${guildId}`, postedMessageId);
      await env.STATUS_KV.put(`last_channel_id:${guildId}`, channelId);

      if (previousMessageId && previousMessageId !== postedMessageId) {
        const deleteChannelId = previousChannelId || channelId;
        await fetch(`https://discord.com/api/v10/channels/${deleteChannelId}/messages/${previousMessageId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
        }).catch(() => {});
      }

      await postLog(
        env,
        logChannelId,
        `${isStale ? '⚠️' : isStormCheck ? '🌨️' : '✅'} HCPSS status check posted${isStale ? ' (stale fallback — live page unreachable)' : isStormCheck ? ' (storm mode detected a status change)' : ''} (source: ${sourceLabel}${options.invokerId ? `, by: <@${options.invokerId}>` : ''}) to <#${channelId}>. [Jump to Message](https://discord.com/channels/${guildId}/${channelId}/${postedMessageId})`,
        { latency },
        guildId
      );

      // DM subscribers only when this guild's source status actually changed.
      if (guildSourceChanged && !builtStatus.isOverride) {
        const dmCount = await notifySubscribers(env, guildId, builtStatus.payload.embeds);
        if (dmCount > 0) {
          await postLog(env, logChannelId, `🔔 Status change DM sent to ${dmCount} subscriber(s).`, {}, guildId);
        }
      }

      results.push({ guildId, ok: true, id: postedMessageId });
    } else {
      // Scheduled check hit a scraper error: don't post the error embed on a schedule.
      await postLog(
        env,
        logChannelId,
        `⚠️ HCPSS status check errored (source: ${sourceLabel}) — error status not posted.`,
        { latency },
        guildId
      );
      results.push({ guildId, ok: true, skipped: true });
    }
  }

  // Handle global scraper success/failure tracking. A stale fallback still
  // counts as a scrape failure so consecutive-failure alerts keep working.
  await handleScraperSuccessOrFailure(env, scrapeFailed, fetched.error, targetGuildIds);

  const successCount = results.filter(r => r.ok).length;
  const failureCount = results.filter(r => !r.ok).length;
  const isErr = liveStatusResult.isError || failureCount > 0;

  const firstSuccessId = results.find(r => r.ok && r.id)?.id || null;

  return {
    ok: failureCount === 0,
    id: firstSuccessId,
    isError: isErr,
    error: liveStatusResult.error && liveStatusResult.error.message,
    message: `Processed ${targetGuildIds.length} guilds. Success: ${successCount}, Failures: ${failureCount}`
  };
}
