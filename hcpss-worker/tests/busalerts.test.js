import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBusAlert, classifySchoolNotice, isWithinBusAlertHours } from '../src/busalerts.js';

test('classifyBusAlert flags service-impact transportation posts', () => {
  assert.equal(classifyBusAlert('HCPSS Transportation Update: several bus routes suspended Monday'), true);
  assert.equal(classifyBusAlert('Bus 123 delayed 30 minutes due to mechanical issues'), true);
  assert.equal(classifyBusAlert('Superintendent Transportation Update – Several Routes Restored'), true);
  assert.equal(classifyBusAlert('Buses running late systemwide this afternoon'), true);
});

test('classifyBusAlert ignores newsletters and non-transportation posts', () => {
  assert.equal(classifyBusAlert('Transportation Reminders for the Start of the School Year'), false);
  assert.equal(classifyBusAlert('Schools closed today due to snow'), false);
  assert.equal(classifyBusAlert('Board of Education meeting delayed'), false);
  assert.equal(classifyBusAlert(''), false);
  assert.equal(classifyBusAlert(null), false);
});

test('classifySchoolNotice flags single-school impacts', () => {
  assert.equal(classifySchoolNotice('Centennial High School closed today due to a water main break'), true);
  assert.equal(classifySchoolNotice('Swansfield Elementary School students dismissed early after power outage'), true);
  assert.equal(classifySchoolNotice('Oakland Mills Middle School will reopen tomorrow'), true);
});

test('classifySchoolNotice ignores district-wide and unrelated posts', () => {
  // District-wide closures belong to the status scraper, not school notices.
  assert.equal(classifySchoolNotice('All HCPSS schools closed today due to snow'), false);
  assert.equal(classifySchoolNotice('HCPSS schools will open two hours late'), false);
  assert.equal(classifySchoolNotice('Ethics panel seeks new members'), false);
  assert.equal(classifySchoolNotice('High school sports schedules announced'), false);
  assert.equal(classifySchoolNotice(''), false);
});

test('isWithinBusAlertHours limits scanning to 5 AM - 10 PM ET', () => {
  assert.equal(isWithinBusAlertHours('5:00'), true);
  assert.equal(isWithinBusAlertHours('14:30'), true);
  assert.equal(isWithinBusAlertHours('21:59'), true);
  assert.equal(isWithinBusAlertHours('22:00'), false);
  assert.equal(isWithinBusAlertHours('4:59'), false);
  assert.equal(isWithinBusAlertHours('0:15'), false);
  assert.equal(isWithinBusAlertHours('garbage'), false);
});
