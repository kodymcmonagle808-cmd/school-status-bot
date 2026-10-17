// The Apps Script watcher (gas/nws-alert-watcher.js) decides whether the
// Worker gets pinged at all, so a fingerprint that reacts to noise costs KV
// ops on every trigger run. It can't be imported — it's plain Apps Script,
// pasted into script.google.com, with no module system — so the pure helpers
// are evaluated out of the source file in a vm context.
//
// The load-bearing test here is the cross-check against the Worker's own
// summarizeWeatherAlerts: the watcher's alert filter is a hand-copy of it, and
// if the two drift apart the watcher starts pinging for alerts the Worker
// discards. That is exactly the bug this file exists to prevent regressing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import { summarizeWeatherAlerts, isWeaAlert } from '../src/weather.js';

const here = dirname(fileURLToPath(import.meta.url));
const gasSource = readFileSync(join(here, '..', '..', 'gas', 'nws-alert-watcher.js'), 'utf8');

// The file's top level is only `var` declarations and function declarations,
// so evaluating it just publishes the helpers into the sandbox.
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(gasSource, sandbox);

// Arrays built inside the vm carry that realm's Array prototype, which
// deepStrictEqual rejects — copy them back into this realm before asserting.
const alertFingerprintParts = (features) => [...sandbox.alertFingerprintParts(features)];
const aqiFingerprintParts = (md, dc, today) => {
  const parts = sandbox.aqiFingerprintParts(md, dc, today);
  return parts === null ? null : [...parts];
};
const { statusFingerprintText } = sandbox;

const feature = (props) => ({ id: props.id || 'urn:oid:1', properties: props });

// The real shape of the message that caused the drain: NWS puts one of these
// on some zones every 10 minutes, all day, every day.
const keepalive = () => feature({
  id: '2.49.0.1.840.0-KEEPALIVE-22940',
  event: 'Test Message',
  status: 'Test',
  messageType: 'Alert',
  severity: 'Unknown',
  sent: '2026-07-25T15:15:33+00:00',
  ends: '2026-07-25T15:25:33+00:00'
});

const winterWarning = (over) => feature(Object.assign({
  event: 'Winter Storm Warning',
  status: 'Actual',
  messageType: 'Alert',
  severity: 'Severe',
  sent: '2026-01-06T09:00:00+00:00',
  ends: '2026-01-07T12:00:00+00:00'
}, over || {}));

test('alertFingerprintParts ignores NWS keepalive test messages', () => {
  assert.deepEqual(alertFingerprintParts([keepalive()]), []);

  // A zone carrying nothing but keepalives must look identical to a quiet one,
  // or every 10-minute rebroadcast reads as a change.
  const quiet = alertFingerprintParts([]).join('|');
  const testOnly = alertFingerprintParts([keepalive()]).join('|');
  assert.equal(testOnly, quiet);
});

test('alertFingerprintParts is stable across a reissue of the same alert', () => {
  const first = alertFingerprintParts([winterWarning({ id: 'a', sent: '2026-01-06T09:00:00+00:00' })]);
  const reissued = alertFingerprintParts([winterWarning({ id: 'b', sent: '2026-01-06T09:45:00+00:00' })]);
  assert.deepEqual(reissued, first);
});

test('alertFingerprintParts still moves on the changes that matter', () => {
  const base = alertFingerprintParts([winterWarning()]);

  const extended = alertFingerprintParts([winterWarning({ ends: '2026-01-07T18:00:00+00:00' })]);
  assert.notDeepEqual(extended, base, 'a new end time changes the "until" line and the outlook');

  const upgraded = alertFingerprintParts([winterWarning({ severity: 'Extreme' })]);
  assert.notDeepEqual(upgraded, base, 'severity drives storm and power-threat gating');

  const added = alertFingerprintParts([winterWarning(), feature({
    event: 'High Wind Warning', status: 'Actual', severity: 'Severe', ends: '2026-01-07T12:00:00+00:00'
  })]);
  assert.notDeepEqual(added, base, 'a newly issued alert must ping');

  assert.deepEqual(alertFingerprintParts([]), [], 'expiry back to quiet must ping');
  assert.notDeepEqual(alertFingerprintParts([]), base);
});

test('alertFingerprintParts is order-independent', () => {
  const a = feature({ event: 'Winter Storm Warning', status: 'Actual', severity: 'Severe', ends: 'x' });
  const b = feature({ event: 'High Wind Warning', status: 'Actual', severity: 'Severe', ends: 'y' });
  assert.deepEqual(alertFingerprintParts([a, b]), alertFingerprintParts([b, a]));
});

test('alertFingerprintParts keeps exactly the alerts the Worker keeps', () => {
  // Anti-drift guard: the watcher's filter is a copy of summarizeWeatherAlerts.
  // If someone loosens or tightens one, this fails.
  const features = [
    keepalive(),
    winterWarning(),
    feature({ event: 'Cold Weather Advisory', status: 'Actual', messageType: 'Cancel', severity: 'Minor' }),
    feature({ event: 'Heat Advisory', status: 'Actual', messageType: 'Update', severity: 'Moderate', ends: '2026-07-25T22:00:00+00:00' }),
    feature({ event: 'Winter Storm Warning', status: 'Actual', messageType: 'Alert', severity: 'Severe', ends: 'later' }),
    feature({ event: 'Flood Watch', status: 'Exercise', severity: 'Moderate' }),
    feature({ status: 'Actual', severity: 'Severe' })
  ];

  const workerEvents = summarizeWeatherAlerts(features).map(a => a.event).sort();
  const watcherEvents = alertFingerprintParts(features).map(p => p.split('|')[0]).sort();

  assert.deepEqual(watcherEvents, workerEvents);
  assert.deepEqual(workerEvents, ['Heat Advisory', 'Winter Storm Warning']);
});

// --- WEA tier ---
//
// The watcher decides whether the Worker is pinged at all, so an upgrade it
// can't see is an upgrade the Worker announces up to an hour late — for the
// one alert class where minutes are the entire point.

const tstorm = (over) => feature(Object.assign({
  event: 'Severe Thunderstorm Warning',
  status: 'Actual',
  messageType: 'Alert',
  severity: 'Severe',
  ends: '2026-08-10T16:45:00-04:00'
}, over || {}));

const ordinaryParams = { windThreat: ['OBSERVED'], BLOCKCHANNEL: ['EAS', 'NWEM', 'CMAS'] };
const destructiveParams = {
  windThreat: ['RADAR INDICATED'],
  thunderstormDamageThreat: ['DESTRUCTIVE'],
  BLOCKCHANNEL: ['EAS', 'NWEM'],
  WEAHandling: ['Imminent Threat']
};

test('alertFingerprintParts moves when a warning is upgraded to the WEA tier', () => {
  // The real 2026-08-10 sequence: same event, same severity, same end time.
  // Without the WEA flag in the fingerprint this is byte-identical and nothing
  // is ever pushed.
  const ordinary = alertFingerprintParts([tstorm({ parameters: ordinaryParams })]);
  const destructive = alertFingerprintParts([tstorm({ parameters: destructiveParams })]);
  assert.notDeepEqual(destructive, ordinary, 'the destructive upgrade must push');
});

test('alertFingerprintParts prefers the WEA product when both share a name', () => {
  const both = [tstorm({ parameters: ordinaryParams }), tstorm({ parameters: destructiveParams })];
  const reversed = [both[1], both[0]];
  assert.deepEqual(alertFingerprintParts(both), alertFingerprintParts(reversed), 'feed order must not decide');
  assert.ok(alertFingerprintParts(both)[0].endsWith('|WEA'));
});

test('the watcher and the Worker agree on which alerts are WEA', () => {
  // Anti-drift guard: isWeaAlert is hand-copied into the Apps Script file,
  // which CI does not deploy. If the two ever disagree, the watcher either
  // withholds an emergency or pushes for one the Worker treats as routine.
  const cases = [
    ordinaryParams,
    destructiveParams,
    { thunderstormDamageThreat: ['CONSIDERABLE'], BLOCKCHANNEL: ['EAS', 'NWEM', 'CMAS'] },
    { tornadoDamageThreat: ['CATASTROPHIC'] },
    { flashFloodDamageThreat: ['CATASTROPHIC'] },
    { flashFloodDamageThreat: ['CONSIDERABLE'] },
    { WEAHandling: ['Imminent Threat'], BLOCKCHANNEL: ['EAS', 'NWEM', 'CMAS'] },
    { BLOCKCHANNEL: ['EAS'] },
    {}
  ];
  for (const parameters of cases) {
    const props = { event: 'X', status: 'Actual', severity: 'Severe', parameters };
    assert.equal(
      sandbox.isWeaAlert(props),
      isWeaAlert(props),
      `watcher and Worker disagree on ${JSON.stringify(parameters)}`
    );
  }
  assert.equal(sandbox.isWeaAlert(null), isWeaAlert(null));
});

test('aqiFingerprintParts only reacts to today, which is all the Worker reads', () => {
  const row = (area, validDate, category, dataType) =>
    ({ reportingArea: area, validDate, category, dataType, isActionDay: false });

  const today = '07/25/26';
  const md = JSON.stringify([
    row('Metro Baltimore', today, 'Good', 'O'),
    row('Metro Baltimore', '07/26/26', 'Moderate', 'F'),
    row('Metro Baltimore', '07/31/26', 'Good', 'F'),
    row('Somewhere Else', today, 'Unhealthy', 'O')
  ]);
  const dc = JSON.stringify([row('Suburban DC', today, 'Moderate', 'F')]);

  const base = aqiFingerprintParts(md, dc, today);
  assert.deepEqual(base, ['Metro Baltimore|O|Good|', 'Suburban DC|F|Moderate|']);

  // A revision to a future forecast day must not ping.
  const revisedFuture = JSON.stringify([
    row('Metro Baltimore', today, 'Good', 'O'),
    row('Metro Baltimore', '07/26/26', 'Unhealthy', 'F'),
    row('Metro Baltimore', '07/31/26', 'Moderate', 'F'),
    row('Somewhere Else', today, 'Good', 'O')
  ]);
  assert.deepEqual(aqiFingerprintParts(revisedFuture, dc, today), base);

  // Today's category moving is the whole point of the watcher.
  const worseToday = JSON.stringify([row('Metro Baltimore', today, 'Unhealthy', 'O')]);
  assert.notDeepEqual(aqiFingerprintParts(worseToday, dc, today), base);

  // A failed fetch is not a change.
  assert.equal(aqiFingerprintParts(null, dc, today), null);
  assert.equal(aqiFingerprintParts(md, null, today), null);
  assert.equal(aqiFingerprintParts('not json', dc, today), null);
});

test('statusFingerprintText ignores the date rollover but not the status', () => {
  const page = (date, status) =>
    `<h2>Important Status Message</h2><p>${date}</p><h3>${status}</h3><p>Staff and students report normally.</p>`;

  const today = statusFingerprintText(page('July 25, 2026', 'Normal Operations'));
  const tomorrow = statusFingerprintText(page('July 26, 2026', 'Normal Operations'));
  assert.equal(tomorrow, today, 'midnight alone must not trigger a check pass');

  const closed = statusFingerprintText(page('July 26, 2026', 'Schools Closed'));
  assert.notEqual(closed, today);

  assert.ok(!/2026/.test(today), 'the date is gone');
  assert.ok(/Normal Operations/.test(today), 'the status text is not');
  assert.equal(statusFingerprintText(''), '');
});
