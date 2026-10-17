import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChartIncidents, incidentsForCounty, formatRoadLines } from '../src/roads.js';

function incidentXml({ county, type = 'Other', description, closed = 'false', trafficAlert = 'false' }) {
  return `<Incident><closed>${closed}</closed><county>${county}</county><description>${description}</description><incidentType>${type}</incidentType><trafficAlert>${trafficAlert}</trafficAlert></Incident>`;
}

const XML = '<Incidents>' +
  incidentXml({ county: 'Howard', type: 'Collision, Personal Injury', description: 'Crash on US 29 SB at MD 108, two lanes closed' }) +
  incidentXml({ county: 'Howard', description: 'Icy conditions reported on I-70 near Marriottsville Rd' }) +
  incidentXml({ county: 'Howard', description: 'Action Event @ MD 108 [Opticom Fire Pre-Emption Signal]' }) +
  incidentXml({ county: 'Carroll', type: 'Weather Closure', description: 'MD 32 closed due to snow' }) +
  incidentXml({ county: 'Howard', type: 'Collision', description: 'Old crash, cleared', closed: 'true' }) +
  incidentXml({ county: 'Montgomery', description: 'Signal timing work', trafficAlert: 'true' }) +
  '</Incidents>';

test('parseChartIncidents keeps open, meaningful incidents only', () => {
  const incidents = parseChartIncidents(XML);
  assert.equal(incidents.length, 4);
  assert.ok(incidents.every(i => i.county && i.description));
  // The Opticom noise and closed crash are dropped; the trafficAlert one is kept.
  assert.ok(!incidents.some(i => /Opticom/.test(i.description)));
  assert.ok(incidents.some(i => i.county === 'Montgomery' && i.trafficAlert));
});

test('parseChartIncidents tolerates junk input', () => {
  assert.deepEqual(parseChartIncidents(''), []);
  assert.deepEqual(parseChartIncidents(null), []);
  assert.deepEqual(parseChartIncidents('<Incidents></Incidents>'), []);
});

test('incidentsForCounty filters by county', () => {
  const incidents = parseChartIncidents(XML);
  assert.equal(incidentsForCounty(incidents, 'Howard').length, 2);
  assert.equal(incidentsForCounty(incidents, 'Frederick').length, 0);
});

test('formatRoadLines renders capped lines with a +N overflow note', () => {
  const incidents = parseChartIncidents(XML);
  const out = formatRoadLines(incidents, 'Howard');
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^🚧 /);
  assert.equal(formatRoadLines(incidents, 'Frederick'), '');

  const many = incidents.concat([
    { county: 'Howard', type: 'Collision', description: 'Third crash', trafficAlert: true },
    { county: 'Howard', type: 'Collision', description: 'Fourth crash', trafficAlert: false }
  ]);
  const overflow = formatRoadLines(many, 'Howard').split('\n');
  assert.equal(overflow.length, 3);
  assert.match(overflow[0], /^🚨 /); // traffic alerts sort first
  assert.match(overflow[2], /and 2 more active incident/);
});
