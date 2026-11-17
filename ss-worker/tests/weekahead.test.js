import test from 'node:test';
import assert from 'node:assert/strict';
import { isSundayEvening, getUpcomingWeekDays, buildWeekAheadEmbed, maybeSendWeekAheadPreviews } from '../src/weekahead.js';

test('isSundayEvening identifies 7:00 PM Eastern on Sunday', () => {
  // 2026-11-15 was a Sunday. 19:00 Eastern = 00:00 UTC on 2026-11-16 (Standard Time, UTC-5).
  const sun7pm = new Date('2026-11-16T00:15:00Z');
  assert.equal(isSundayEvening(sun7pm), true);

  // 18:00 Eastern is false
  const sun6pm = new Date('2026-11-15T23:15:00Z');
  assert.equal(isSundayEvening(sun6pm), false);

  // Monday 7pm Eastern is false
  const mon7pm = new Date('2026-11-17T00:15:00Z');
  assert.equal(isSundayEvening(mon7pm), false);
});

test('getUpcomingWeekDays returns Mon-Fri YMD array for the upcoming week', () => {
  // Starting from Sunday Nov 15, 2026 Eastern
  const sun = new Date('2026-11-16T00:15:00Z');
  const days = getUpcomingWeekDays(sun);
  assert.equal(days.length, 5);
  assert.equal(days[0], '2026-11-16'); // Monday
  assert.equal(days[1], '2026-11-17'); // Tuesday
  assert.equal(days[2], '2026-11-18'); // Wednesday
  assert.equal(days[3], '2026-11-19'); // Thursday
  assert.equal(days[4], '2026-11-20'); // Friday
});

test('buildWeekAheadEmbed formats schedule with A/B days and events', () => {
  const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'];
  const embed = buildWeekAheadEmbed(days, {
    district: 'hcpss',
    calendarEvents: [{ date: '2026-11-18', title: 'PTA Meeting' }],
    footer: 'Custom Footer'
  });

  assert.ok(embed.title.includes('Week of 11/16'));
  assert.equal(embed.footer.text, 'Custom Footer · Sunday Evening Preview');
  assert.ok(embed.description.includes('Monday (11/16)'));
  assert.ok(embed.description.includes('Wednesday (11/18)'));
  assert.ok(embed.description.includes('PTA Meeting'));
});

test('maybeSendWeekAheadPreviews skips on non-Sunday evening unless forced', async () => {
  const env = {
    STATUS_KV: { get: async () => null, put: async () => {} }
  };
  const monday = new Date('2026-11-16T15:00:00Z');
  const res = await maybeSendWeekAheadPreviews(env, monday);
  assert.equal(res, null);
});

test('maybeSendWeekAheadPreviews sends preview when forced or on Sunday evening', async () => {
  let postedMessage = null;
  const kv = new Map();
  kv.set('guild_index', JSON.stringify(['g1']));
  kv.set('config:g1', JSON.stringify({
    alert_channel_id: 'chan-123',
    alert_embed_footer: 'TestBot'
  }));

  const env = {
    __FORCE_WEEK_AHEAD: true,
    DISCORD_BOT_TOKEN: 'mock-token',
    STATUS_KV: {
      get: async (k) => kv.get(k) || null,
      put: async (k, v) => kv.set(k, v)
    }
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/channels/chan-123/messages')) {
      postedMessage = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'msg-999' }), { status: 200 });
    }
    return origFetch(url, init);
  };

  try {
    const res = await maybeSendWeekAheadPreviews(env, new Date('2026-11-16T00:15:00Z'));
    assert.equal(res.ok, true);
    assert.equal(res.sent, 1);
    assert.ok(postedMessage);
    assert.ok(postedMessage.embeds[0].title.includes('School Week Outlook'));
    assert.ok(kv.has('last_weekahead_date:g1'));
  } finally {
    globalThis.fetch = origFetch;
  }
});
