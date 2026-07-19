import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSchoolImpactIssuance, summarizeWeatherAlerts } from '../src/weather.js';
import { pickNewAlerts, formatIssuanceLines, issuanceEmbedColor } from '../src/weatheralerts.js';

test('isSchoolImpactIssuance matches winter and heat watch/warning/advisory events', () => {
  assert.ok(isSchoolImpactIssuance({ event: 'Winter Storm Warning', severity: 'Severe' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Winter Storm Watch', severity: 'Moderate' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Winter Weather Advisory', severity: 'Minor' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Ice Storm Warning', severity: 'Severe' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Wind Chill Advisory', severity: 'Minor' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Heat Advisory', severity: 'Minor' }));
  assert.ok(isSchoolImpactIssuance({ event: 'Excessive Heat Warning', severity: 'Severe' }));
});

test('isSchoolImpactIssuance includes Extreme severity regardless of event name', () => {
  assert.ok(isSchoolImpactIssuance({ event: 'Tornado Warning', severity: 'Extreme' }));
});

test('isSchoolImpactIssuance excludes summer noise and non-alert products', () => {
  assert.ok(!isSchoolImpactIssuance({ event: 'Severe Thunderstorm Warning', severity: 'Severe' }));
  assert.ok(!isSchoolImpactIssuance({ event: 'Flood Advisory', severity: 'Minor' }));
  assert.ok(!isSchoolImpactIssuance({ event: 'Special Weather Statement', severity: 'Moderate' }));
  assert.ok(!isSchoolImpactIssuance({ event: 'Winter Outlook', severity: 'Minor' })); // no watch/warning/advisory level
  assert.ok(!isSchoolImpactIssuance(null));
});

test('summarizeWeatherAlerts carries onset and headline for issuance notices', () => {
  const alerts = summarizeWeatherAlerts([{
    properties: {
      event: 'Winter Storm Warning',
      severity: 'Severe',
      status: 'Actual',
      onset: '2026-01-15T21:00:00Z',
      ends: '2026-01-16T15:00:00Z',
      headline: 'Winter Storm Warning issued January 15 at 1:02PM EST until January 16 at 10:00AM EST'
    }
  }]);
  assert.equal(alerts[0].onsetMs, Date.parse('2026-01-15T21:00:00Z'));
  assert.match(alerts[0].headline, /^Winter Storm Warning issued/);
});

test('pickNewAlerts announces unseen events and marks them until their end time', () => {
  const now = 1_000_000;
  const ends = now + 3_600_000;
  const { newAlerts, updatedSeen } = pickNewAlerts(
    [{ event: 'Winter Storm Warning', endsMs: ends }],
    {},
    now
  );
  assert.equal(newAlerts.length, 1);
  assert.equal(updatedSeen['Winter Storm Warning'], ends);
});

test('pickNewAlerts stays quiet for already-seen events and prunes expired ones', () => {
  const now = 1_000_000;
  const seen = {
    'Winter Storm Warning': now + 1000, // still active — skip
    'Old Advisory': now - 1000 // expired — pruned
  };
  const { newAlerts, updatedSeen } = pickNewAlerts(
    [{ event: 'Winter Storm Warning', endsMs: now + 5000 }],
    seen,
    now
  );
  assert.equal(newAlerts.length, 0);
  assert.ok(!('Old Advisory' in updatedSeen));
  assert.equal(updatedSeen['Winter Storm Warning'], now + 1000);
});

test('pickNewAlerts falls back to 24h when the alert has no end time', () => {
  const now = 1_000_000;
  const { updatedSeen } = pickNewAlerts([{ event: 'Winter Storm Watch', endsMs: 0 }], {}, now);
  assert.equal(updatedSeen['Winter Storm Watch'], now + 24 * 60 * 60 * 1000);
});

test('formatIssuanceLines renders window and headline', () => {
  const out = formatIssuanceLines([{
    event: 'Winter Storm Warning',
    onsetMs: 1750000000000,
    endsMs: 1750050000000,
    headline: 'Heavy snow expected'
  }]);
  assert.match(out, /\*\*Winter Storm Warning\*\* from <t:1750000000:f> until <t:1750050000:f>/);
  assert.match(out, /> Heavy snow expected/);
});

test('issuanceEmbedColor escalates with severity', () => {
  assert.equal(issuanceEmbedColor([{ severity: 'Minor' }]), 0xF1C40F);
  assert.equal(issuanceEmbedColor([{ severity: 'Severe' }]), 0xE67E22);
  assert.equal(issuanceEmbedColor([{ severity: 'Severe' }, { severity: 'Extreme' }]), 0xE74C3C);
});
