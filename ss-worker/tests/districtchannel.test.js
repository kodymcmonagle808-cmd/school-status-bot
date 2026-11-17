import test from 'node:test';
import assert from 'node:assert/strict';
import { runDistrictChannelCommand } from '../src/commands.js';
import { doCheckAndPost } from '../src/check.js';

test('runDistrictChannelCommand: rejects outside a server', async () => {
  const body = { guild_id: '' };
  const res = await runDistrictChannelCommand(body, {});
  assert.ok(res.content.includes('only be used in a server'));
});

test('runDistrictChannelCommand: rejects non-staff', async () => {
  const body = {
    guild_id: 'g1',
    member: { permissions: '0', roles: [] }
  };
  const env = {
    STATUS_KV: { get: async () => JSON.stringify({ staff_role_id: 'staff-role' }) }
  };
  const res = await runDistrictChannelCommand(body, env);
  assert.ok(res.content.includes('Only staff and administrators'));
});

test('runDistrictChannelCommand: set, list, and clear subcommands', async () => {
  const kv = new Map();
  kv.set('config:g1', JSON.stringify({ staff_role_id: 'staff-123' }));

  const env = {
    STATUS_KV: {
      get: async (k) => kv.get(k) || null,
      put: async (k, v) => kv.set(k, v)
    }
  };

  const adminMember = { permissions: '8', roles: [] };

  // 1. set districtchannel
  const setBody = {
    guild_id: 'g1',
    member: adminMember,
    data: {
      options: [
        {
          name: 'set',
          type: 1,
          options: [
            { name: 'district', value: 'bcps' },
            { name: 'channel', value: 'chan-bcps' }
          ]
        }
      ]
    }
  };

  const setRes = await runDistrictChannelCommand(setBody, env);
  assert.ok(setRes.content.includes('Baltimore Co.'));
  assert.ok(setRes.content.includes('chan-bcps'));

  // Verify KV saved
  const cfg1 = JSON.parse(kv.get('config:g1'));
  assert.equal(cfg1.district_channels.bcps, 'chan-bcps');

  // 2. list districtchannel
  const listBody = {
    guild_id: 'g1',
    member: adminMember,
    data: {
      options: [{ name: 'list', type: 1 }]
    }
  };
  const listRes = await runDistrictChannelCommand(listBody, env);
  assert.ok(listRes.content.includes('Baltimore Co.'));
  assert.ok(listRes.content.includes('chan-bcps'));

  // 3. clear single district
  const clearBody = {
    guild_id: 'g1',
    member: adminMember,
    data: {
      options: [
        {
          name: 'clear',
          type: 1,
          options: [{ name: 'district', value: 'bcps' }]
        }
      ]
    }
  };
  const clearRes = await runDistrictChannelCommand(clearBody, env);
  assert.ok(clearRes.content.includes('District channel cleared'));
  const cfg2 = JSON.parse(kv.get('config:g1'));
  assert.equal(cfg2.district_channels.bcps, undefined);
});

test('doCheckAndPost routes status changes to secondary district channels', async () => {
  const postedMessages = [];
  const kv = new Map();
  kv.set('guild_index', JSON.stringify(['g1']));
  kv.set('config:g1', JSON.stringify({
    primary_district: 'hcpss',
    alert_channel_id: 'chan-main',
    district_channels: { bcps: 'chan-bcps-alert' },
    toggle_storm_mode: true
  }));
  // Seed initial baseline for bcps
  kv.set('last_district_status:bcps', 'none|');
  // Seed last known status for hcpss so hcpss doesn't change
  kv.set('last_known_status', 'Normal Operations');

  // Seed cached district statuses
  kv.set('district_status_cache', JSON.stringify({
    at: Date.now(),
    districts: [
      { id: 'bcps', name: 'Baltimore Co.', status: 'closed', detail: 'All schools closed today.' },
      { id: 'mcps', name: 'Montgomery Co.', status: 'none', detail: '' }
    ]
  }));

  const env = {
    DISCORD_BOT_TOKEN: 'mock-token',
    STATUS_KV: {
      get: async (k) => kv.get(k) || null,
      put: async (k, v) => kv.set(k, v),
      delete: async (k) => kv.delete(k)
    }
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr.includes('api/v10/channels/')) {
      postedMessages.push({ url: urlStr, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'msg-dist-1' }), { status: 200 });
    }
    if (urlStr.includes('status.hcpss.org')) {
      return new Response('<html><div class="status-card-list"><h3>Normal Operations</h3><p>Schools open on time.</p></div></html>', { status: 200 });
    }
    return origFetch(url, init);
  };

  try {
    const result = await doCheckAndPost(env, { source: 'hook' });
    assert.equal(result.ok, true);

    // Verify district post reached chan-bcps-alert
    const bcpsPost = postedMessages.find(m => m.url.includes('/channels/chan-bcps-alert/messages'));
    assert.ok(bcpsPost, 'Should post to secondary district channel');
    assert.ok(bcpsPost.body.embeds[0].title.includes('Baltimore Co.'));
    assert.ok(bcpsPost.body.embeds[0].description.includes('Schools closed'));
  } finally {
    globalThis.fetch = origFetch;
  }
});
