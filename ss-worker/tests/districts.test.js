import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDistrictText,
  parseThrillshareFeed,
  parseSharpSchoolAlerts,
  parseAtomEntries,
  parseMcpsEmergency,
  parsePgcpsAlert,
  summarizeDistrictEntries,
  formatDistrictLines,
  stripHtml,
  RECENT_WINDOW_MS
} from '../src/districts.js';

// Real phrasings from AACPS winter announcements.
test('classifyDistrictText detects closures, delays, early closings', () => {
  assert.equal(
    classifyDistrictText('4:30 p.m., 1/6/25: Due to inclement weather, all Anne Arundel County Public Schools and offices will be closed on Tuesday, January 7.'),
    'closed'
  );
  assert.equal(
    classifyDistrictText('All Anne Arundel County Public Schools will open two hours late on Thursday, Jan. 9.'),
    'delayed'
  );
  assert.equal(
    classifyDistrictText('Schools will close three hours early today due to deteriorating conditions.'),
    'early'
  );
  assert.equal(
    classifyDistrictText('Tomorrow will be a virtual learning day for all students.'),
    'virtual'
  );
});

test('classifyDistrictText ignores single-building and boardroom notices', () => {
  // A one-school facility closure must not read as a district-wide closure.
  assert.equal(
    classifyDistrictText('Phyllis E. Williams Spanish Immersion School will be closed July 14-24 while an electrical upgrade is completed.'),
    null
  );
  assert.equal(classifyDistrictText('Board of Education Closed Session - Wednesday, July 15'), null);
  assert.equal(classifyDistrictText('Congratulations to our rising seniors!'), null);
  assert.equal(classifyDistrictText(''), null);
});

test('parseThrillshareFeed keeps only recent posts', () => {
  const now = Date.parse('2026-01-07T12:00:00Z');
  const feed = {
    live_feeds: [
      { status: 'All schools closed today.', publishing_at: '2026-01-07T09:00:00.000-04:00' },
      { status: 'Old news from last month.', publishing_at: '2025-12-01T09:00:00.000-04:00' },
      { status: 'No timestamp', publishing_at: null }
    ]
  };
  const entries = parseThrillshareFeed(feed, now);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'All schools closed today.');
});

test('parseSharpSchoolAlerts handles empty and object alerts', () => {
  assert.deepEqual(parseSharpSchoolAlerts('{"d":[]}'), []);
  const entries = parseSharpSchoolAlerts({ d: [{ Title: 'Schools Closed', Description: 'All schools are closed today.', Id: 42 }] });
  assert.equal(entries.length, 1);
  assert.ok(entries[0].text.includes('Schools Closed'));
  assert.equal(entries[0].active, true);
  assert.deepEqual(parseSharpSchoolAlerts('not json'), []);
});

test('parseAtomEntries reads titles and filters stale entries', () => {
  const now = Date.parse('2026-01-07T12:00:00Z');
  const recent = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const stale = new Date(now - RECENT_WINDOW_MS - 1000).toISOString();
  const xml = `<?xml version="1.0"?><feed>
    <entry><title>Schools Closed January 7</title><updated>${recent}</updated></entry>
    <entry><title>Old post</title><updated>${stale}</updated></entry>
  </feed>`;
  const entries = parseAtomEntries(xml, now);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'Schools Closed January 7');
});

test('parseMcpsEmergency treats code green as no announcement', () => {
  assert.deepEqual(parseMcpsEmergency({ emsg: "<div class='emer-code-green'>Normal</div>" }), []);
  const entries = parseMcpsEmergency({ emsg: "<div class='emer-code-red'><h3>Important Message:</h3><p>All MCPS schools are closed today.</p></div>" });
  assert.equal(entries.length, 1);
  assert.ok(entries[0].text.includes('closed'));
  assert.deepEqual(parseMcpsEmergency({}), []);
});

test('parsePgcpsAlert extracts the server-rendered banner', () => {
  const html = '<body><section class="site-alert-component info js-site-alert"><h3 class="title">Schools closed tomorrow.</h3><div class="read-more"><p>Due to weather.</p></div></section></body>';
  const entries = parsePgcpsAlert(html);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].text.includes('Schools closed tomorrow.'));
  assert.deepEqual(parsePgcpsAlert('<body>no banner</body>'), []);
});

test('summarizeDistrictEntries classifies, falls back to notice, else none', () => {
  assert.equal(summarizeDistrictEntries([{ text: 'All schools will be closed today.', atMs: 1 }]).status, 'closed');
  const notice = summarizeDistrictEntries([{ text: 'Air quality advisory in effect.', atMs: 0, active: true }]);
  assert.equal(notice.status, 'notice');
  assert.ok(notice.detail.includes('Air quality'));
  // Plain news feed posts that do not classify are not a notice.
  assert.equal(summarizeDistrictEntries([{ text: 'Bus routes published.', atMs: 1 }]).status, 'none');
  assert.equal(summarizeDistrictEntries([]).status, 'none');
});

test('formatDistrictLines renders one labeled line per district', () => {
  const lines = formatDistrictLines([
    { id: 'bcps', name: 'Baltimore Co.', status: 'closed', detail: 'All schools closed.' },
    { id: 'mcps', name: 'Montgomery Co.', status: 'none', detail: '' },
    { id: 'pgcps', name: "Prince George's Co.", status: 'unavailable', detail: '' }
  ]);
  assert.ok(lines.includes('🔴 **Baltimore Co.** — Schools closed'));
  assert.ok(lines.includes('🟢 **Montgomery Co.** — No announcement'));
  assert.ok(lines.includes('⚪ **Prince George’s Co.** — Unavailable'.replace('’', "'")));
  // Detail only when requested.
  assert.ok(!lines.includes('All schools closed.'));
  const withDetail = formatDistrictLines([{ id: 'bcps', name: 'Baltimore Co.', status: 'closed', detail: 'All schools closed.' }], { includeDetail: true });
  assert.ok(withDetail.includes('> All schools closed.'));
});

test('stripHtml flattens markup and entities', () => {
  assert.equal(stripHtml('<p>Schools&nbsp;closed &amp; offices too</p>'), 'Schools closed & offices too');
});
