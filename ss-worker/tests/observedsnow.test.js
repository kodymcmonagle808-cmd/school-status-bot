import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLocalStormReports,
  summarizeObservedSnowfall,
  formatObservedSnowfallLines,
  OBSERVED_MAX_AGE_MS
} from '../src/snowfall.js';

// An LSR bulletin in the real LWX format: mixed case, M/E magnitude prefixes,
// and the fixed-width columns the live product actually uses (verified against
// api.weather.gov — an earlier all-caps guess at this format parsed nothing).
const BULLETIN = `
000
NWUS51 KLWX 062055
LSRLWX

Preliminary Local Storm Report
National Weather Service Baltimore MD/Washington DC
355 PM EST Tue Jan 06 2026

..TIME...   ...EVENT...      ...CITY LOCATION...     ...LAT.LON...
..DATE...   ....MAG....      ..COUNTY LOCATION..ST.. ...SOURCE....
            ..REMARKS..

0300 PM     Snow             1 SW Ellicott City      39.26N  76.83W
01/06/2026  M6.0 Inch        Howard             MD   Trained Spotter

0330 PM     Snow             Columbia                39.20N  76.86W
01/06/2026  E5.5 Inch        Howard             MD   Public

0400 PM     Heavy Snow       3 NNE Frederick         39.45N  77.40W
01/06/2026  M8.0 Inch        Frederick          MD   CoCoRaHS

0410 PM     Hail             Waldorf                 38.62N  76.90W
01/06/2026  M1.5 Inch        Charles            MD   Public

0415 PM     Tstm Wnd Gst     2 NNE California        38.32N  76.48W
01/06/2026  M59 mph          St. Marys          MD   Mesonet

0430 PM     Sleet            4 E Bowie               38.95N  76.65W
01/06/2026  M3.0 Inch        Prince Georges     MD   Broadcast Media

0445 PM     Tornado          2 S Lehew               39.18N  78.44W
01/06/2026                   Hampshire          WV   NWS Storm Survey
`;

// 4 PM EST on the day of the bulletin.
const NOW = Date.UTC(2026, 0, 6, 21, 0);

test('parses the two-line LSR record format', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  assert.equal(reports.length, 4, 'snow/sleet only: hail, wind, and tornado excluded');

  const first = reports[0];
  assert.equal(first.county, 'Howard');
  assert.equal(first.state, 'MD');
  assert.equal(first.inches, 6);
  assert.equal(first.event, 'Snow');
  assert.equal(first.place, '1 SW Ellicott City');
});

test('estimated magnitudes count too', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  // "E5.5 Inch" — estimated rather than measured.
  assert.ok(reports.some(r => r.inches === 5.5), 'E-prefixed magnitudes parse');
});

test('hail is measured in inches but is not snowfall', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  assert.ok(!reports.some(r => r.county === 'Charles'), 'a 1.5 inch hailstone is not accumulation');
});

test('records with no magnitude at all are skipped', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  assert.ok(!reports.some(r => r.county === 'Hampshire'), 'the tornado record carries no magnitude');
});

test('non-snow magnitudes in other units are skipped', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  assert.ok(!reports.some(r => r.county === 'St. Marys'), '59 mph is not 59 inches');
});

test('county names with spaces and periods survive the column split', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  const pg = reports.find(r => r.inches === 3);
  assert.equal(pg.county, 'Prince Georges');
  assert.equal(pg.state, 'MD');
  assert.equal(pg.event, 'Sleet');
});

test('reports older than the window are dropped', () => {
  const later = NOW + OBSERVED_MAX_AGE_MS + 3600000;
  assert.deepEqual(parseLocalStormReports(BULLETIN, later), []);
});

test('garbage in, empty list out — never a throw', () => {
  assert.deepEqual(parseLocalStormReports('', NOW), []);
  assert.deepEqual(parseLocalStormReports(null, NOW), []);
  assert.deepEqual(parseLocalStormReports('not remotely an LSR bulletin', NOW), []);
  // The header legend itself must not parse as a record.
  assert.deepEqual(parseLocalStormReports('..DATE...   ....MAG....      ..COUNTY LOCATION..ST..', NOW), []);
});

test('a bulletin whose padding drifts still parses via the fallback', () => {
  // Same record, single-spaced columns: the fixed-width slice misses, so the
  // county/state split falls back to the remainder regex.
  const drifted = [
    '0300 PM     Snow             1 SW Ellicott City      39.26N  76.83W',
    '01/06/2026  M6.0 Inch        Howard  MD  Trained Spotter'
  ].join('\n');
  const reports = parseLocalStormReports(drifted, NOW);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].county, 'Howard');
  assert.equal(reports[0].inches, 6);
});

test('summarize takes the highest measured total for the county', () => {
  const reports = parseLocalStormReports(BULLETIN, NOW);
  const howard = summarizeObservedSnowfall(reports, 'Howard');
  assert.equal(howard.max, 6);
  assert.equal(howard.reportCount, 2);
  assert.equal(howard.place, '1 SW Ellicott City');
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
