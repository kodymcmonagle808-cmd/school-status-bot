import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBusAlert, classifyActivityAlert, classifySchoolNotice, isWithinBusAlertHours } from '../src/busalerts.js';

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

test('classifyActivityAlert flags after-school/athletics cancellations', () => {
  assert.equal(classifyActivityAlert('All after-school and evening activities are canceled today, January 6'), true);
  assert.equal(classifyActivityAlert('All HCPSS athletic events and practices are canceled this afternoon'), true);
  assert.equal(classifyActivityAlert('Field trips scheduled for today are canceled'), true);
  assert.equal(classifyActivityAlert('Evening activities are postponed due to expected ice'), true);
  assert.equal(classifyActivityAlert('After-school programs called off ahead of the storm'), true);
});

test('classifyActivityAlert ignores schedules and as-planned posts', () => {
  assert.equal(classifyActivityAlert('High school sports schedules announced'), false);
  assert.equal(classifyActivityAlert('Evening activities will continue as scheduled'), false);
  assert.equal(classifyActivityAlert('Athletic boosters meeting Thursday'), false);
  assert.equal(classifyActivityAlert('Schools closed today due to snow'), false);
  assert.equal(classifyActivityAlert(''), false);
  assert.equal(classifyActivityAlert(null), false);
});

test('bus alerts outrank activity alerts for the same post', () => {
  // A post about canceled bus routes is a transportation alert, not an
  // activities one — the scanner checks classifyBusAlert first.
  const text = 'Several bus routes to after-school activities are canceled';
  assert.equal(classifyBusAlert(text), true);
  assert.equal(classifyActivityAlert(text), true);
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
