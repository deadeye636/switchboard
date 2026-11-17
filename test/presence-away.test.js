// #882: is the user away right now — asked by things that must not run for nobody (the issues refresh).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const presence = require('../src/app/presence');

const MIN = 60_000;
const T0 = new Date('2026-06-12T10:00:00.000Z').getTime();

function fresh(minutes = 5) {
  presence.init({ getSetting: () => ({ awayIdleMinutes: minutes }), log: { info() {} } });
}

test('no sign of life yet is not away', () => {
  fresh();
  assert.equal(presence.isUserAway(T0), false);
});

test('under the threshold is present, at it and over it is away', () => {
  fresh(5);
  presence.recordActivity(T0);
  assert.equal(presence.isUserAway(T0 + 4 * MIN + 59_000), false);
  assert.equal(presence.isUserAway(T0 + 5 * MIN), true);
  assert.equal(presence.isUserAway(T0 + 60 * MIN), true);
});

test('a new sign of life ends it, and the threshold is the settings\'', () => {
  fresh(5);
  presence.recordActivity(T0);
  presence.recordActivity(T0 + 30 * MIN);
  assert.equal(presence.isUserAway(T0 + 31 * MIN), false);
  fresh(10);
  presence.recordActivity(T0);
  assert.equal(presence.isUserAway(T0 + 6 * MIN), false);
});
