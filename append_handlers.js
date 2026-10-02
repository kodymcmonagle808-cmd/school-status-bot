const fs = require('fs');

const codeToAppend = `
  if (customId === 'owner_force_check_all') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    ctx.waitUntil(doCheckAndPost(env, { source: 'owner-force-all' }));
    return interactionResponse({ content: '🔄 Force check triggered for all servers! Results will appear in your log channels.', flags: EPHEMERAL_FLAG });
  }

  if (customId === 'owner_view_kv_stats') {
    const ownerId = String(env.OWNER_ID || '').trim();
    if (!ownerId || getInvokerId(body) !== ownerId) {
      return interactionResponse({ content: '🔒 Access denied.', flags: EPHEMERAL_FLAG });
    }
    let kvInfo = 'No KV analytics available.';
    try {
      const { getKvUsage, KV_FREE_LIMITS } = await import('./kvanalytics.js');
      const usage = await getKvUsage(env);
      if (usage) {
        const readPct = ((usage.reads / KV_FREE_LIMITS.reads) * 100).toFixed(1);
        const writePct = ((usage.writes / KV_FREE_LIMITS.writes) * 100).toFixed(1);
        const storagePct = ((usage.storedBytes / KV_FREE_LIMITS.storedBytes) * 100).toFixed(1);
        kvInfo = \`**Reads:** \${usage.reads.toLocaleString()} / \${KV_FREE_LIMITS.reads.toLocaleString()} (\${readPct}%)\\n\` +
                 \`**Writes:** \${usage.writes.toLocaleString()} / \${KV_FREE_LIMITS.writes.toLocaleString()} (\${writePct}%)\\n\` +
                 \`**Storage:** \${(usage.storedBytes / 1024 / 1024).toFixed(2)} MB / \${(KV_FREE_LIMITS.storedBytes / 1024 / 1024).toFixed(0)} MB (\${storagePct}%)\`;
      }
    } catch {}
    return interactionResponse({
      content: \`## 💾 KV Analytics\\n\${kvInfo}\`,
      flags: EPHEMERAL_FLAG
    });
  }

  if (customId === 'owner_view_all_configs') {
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
        const alertCh = cfg.alert_channel_id ? \`<#\${cfg.alert_channel_id}>\` : 'none';
        const logCh = cfg.log_channel_id ? \`<#\${cfg.log_channel_id}>\` : 'none';
        const toggles = [];
        if (cfg.enable_digest) toggles.push('digest');
        if (cfg.enable_headsup) toggles.push('headsup');
        if (cfg.enable_bus_alerts) toggles.push('bus');
        if (cfg.enable_weather_notices) toggles.push('weather');
        lines.push(\`**\${gid}**\\n  Alert: \${alertCh} · Log: \${logCh}\\n  Toggles: \${toggles.join(', ') || 'none'}\`);
      }
    } catch (e) { lines.push('Error reading configs: ' + e.message); }
    return interactionResponse({
      content: \`## 📋 Server Configs\\n\${lines.join('\\n\\n') || 'No servers found.'}\`,
      flags: EPHEMERAL_FLAG
    });
  }
`;

let code = fs.readFileSync('hcpss-worker/src/panelcomponents.js', 'utf8');

// Insert it right before the return null; at the end of handlePanelComponent
const marker = '  return null;\r\n}';
code = code.replace(marker, codeToAppend + '\n' + marker);

fs.writeFileSync('hcpss-worker/src/panelcomponents.js', code, 'utf8');
console.log("Appended properly inside handlePanelComponent");
