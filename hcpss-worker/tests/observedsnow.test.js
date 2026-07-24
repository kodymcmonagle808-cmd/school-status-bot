import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLocalStormReports,
  summarizeObservedSnowfall,
  formatObservedSnowfallLines,
  OBSERVED_MAX_AGE_MS
} from '../src/snowfall.js';

// A real-shaped LSR bulletin from the Baltimore/Washington (LWX) office.
const BULLETIN = `
NWUS51 KLWX 062055
LSRLWX

PRELIMINARY LOCAL STORM REPORT...SUMMARY
NATIONAL WEATHER SERVICE BALTIMORE MD/WASHINGTON DC
355 PM EST MON JAN 06 2025

..TIME...   ...EVENT...      ...CITY LOCATION...     ...LAT.LON...
..DATE...   ....MAG....      ..COUNTY LOCATION..ST.. ...SOURCE....
            ..REMARKS..

0300 PM     SNOW             1 SW ELLICOTT CITY      39.26N 76.83W
01/06/2025  M6.0 INCH        HOWARD             MD   TRAINED SPOTTER

0330 PM     SNOW             COLUMBIA                39.20N 76.86W
01/06/2025  M5.5 INCH        HOWARD             MD   PUBLIC

0400 PM     SNOW             3 NNE FREDERICK         39.45N 77.40W
01/06/2025  M8.0 INCH        FREDERICK          MD   COCORAHS

0415 PM     HEAVY RAIN       BALTIMORE               39.29N 76.61W
01/06/2025  M1.5 INCH        BALTIMORE          MD   PUBLIC

0430 PM     SNOW             4 E BOWIE               38.95N 76.65W
01/06/2025  M3.0 INCH        PRINCE GEORGES     MD   BROADCAST MEDIA
`;

// 4 PM EST on the day of the bulletin.
const NOW = Date.UTC(2025, 0, 6, 21, 0);

test('parses the two-line LSR record format', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  assert.equal(reports.length, 4, 'four snow reports, rain excluded');

  const first = reports[0];
  assert.equal(first.county, 'HOWARD');
  assert.equal(first.state, 'MD');
  assert.equal(first.inches, 6);
  assert.equal(first.event, 'SNOW');
  assert.equal(first.place, '1 SW ELLICOTT CITY');
});

test('non-snow events with an inch magnitude are excluded', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  assert.ok(!reports.some(r => r.county === 'BALTIMORE'), 'heavy rain is not snowfall');
});

test('multi-word county names survive the column split', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  const pg = reports.find(r => r.inches === 3);
  assert.equal(pg.county, 'PRINCE GEORGES');
  assert.equal(pg.state, 'MD');
});

test('reports older than the window are dropped', () => {
  const later = NOW + OBSERVED_MAX_AGE_MS + 3600000;
  assert.deepEqual(parseLocalStormReports(BULLETIN, later), []);
});

test('garbage in, empty list out — never a throw', () => {
  assert.deepEqual(parseLocalStormReports('', NOW), []);
  assert.deepEqual(parseLocalStormReports(null, NOW), []);
  assert.deepEqual(parseLocalStormReports('not remotely an LSR bulletin', NOW), []);
  // A bulletin whose columns drifted yields no reports rather than junk.
  assert.deepEqual(parseLocalStormReports('01/06/2025 M6.0 INCH HOWARD MD SPOTTER', NOW), []);
});

test('summarize takes the highest measured total for the county', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  const howard = summarizeObservedSnowfall(reports, 'Howard');
  assert.equal(howard.max, 6);
  assert.equal(howard.reportCount, 2);
  assert.equal(howard.place, '1 SW ELLICOTT CITY');
});

test('county matching is case-insensitive and district-aware', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  assert.equal(summarizeObservedSnowfall(reports, 'frederick').max, 8);
  assert.equal(summarizeObservedSnowfall(reports, "Prince Georges").max, 3);
  assert.equal(summarizeObservedSnowfall(reports, 'Carroll'), null, 'a county with no reports is null');
  assert.equal(summarizeObservedSnowfall([], 'Howard'), null);
  assert.equal(summarizeObservedSnowfall(null, 'Howard'), null);
});

test('formatting reads like a person wrote it', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  const line = formatObservedSnowfallLines(summarizeObservedSnowfall(reports, 'Howard'));
  assert.equal(line, '📏 **6"** measured at 1 SW Ellicott City · 2 spotter reports');

  // A lone report drops the count suffix.
  const single = formatObservedSnowfallLines(summarizeObservedSnowfall(reports, 'Frederick'));
  assert.equal(single, '📏 **8"** measured at 3 NNE Frederick');

  assert.equal(formatObservedSnowfallLines(null), '');
});
