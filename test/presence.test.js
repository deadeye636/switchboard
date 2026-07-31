// #386 — was the user away, and for how long?
//
// The recap used to be triggered by a focus change on one session, so it fired while the user sat
// there switching sessions and stayed silent when they walked away from a window that stayed in
// front. Presence is a fact about the MACHINE, so main owns it; this covers the decision it makes.

const test = require('node:test');
const assert = require('node:assert/strict');

const presence = require('../src/app/presence');
const { absenceEnded, resolveIdleMs, MIN_ABSENCE_MS, DEFAULT_IDLE_MINUTES } = presence;

const MIN = 60_000;
const T0 = new Date('2026-06-12T10:00:00.000Z').getTime();

test('the idle threshold defaults to ten minutes and takes whole minutes', () => {
  assert.equal(resolveIdleMs(undefined), DEFAULT_IDLE_MINUTES * MIN);
  assert.equal(resolveIdleMs(25), 25 * MIN);
  assert.equal(resolveIdleMs('25'), 25 * MIN);
  assert.equal(resolveIdleMs(3.7), 3 * MIN);
});

test('a threshold under a minute is refused rather than honoured', () => {
  // Under a minute every pause for thought is an absence, and the recap then fires constantly —
  // which is the defect this issue is about, reached from the other side.
  for (const bad of [0, -5, 0.5, 'x', null, NaN, Infinity]) {
    assert.equal(resolveIdleMs(bad), DEFAULT_IDLE_MINUTES * MIN, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('a gap past the threshold is an absence, and it started at the last activity', () => {
  const out = absenceEnded({ lastActivityAt: T0, now: T0 + 20 * MIN, idleMs: 10 * MIN });
  assert.deepEqual(out, { awaySince: T0, awayMs: 20 * MIN });
});

test('a gap under the threshold is not an absence', () => {
  assert.equal(absenceEnded({ lastActivityAt: T0, now: T0 + 9 * MIN, idleMs: 10 * MIN }), null);
});

test('the floor holds even when the threshold is set below it', () => {
  // `resolveIdleMs` cannot produce under a minute, but the floor is applied here too rather than
  // trusted from one caller away: this is the function that decides.
  assert.equal(absenceEnded({ lastActivityAt: T0, now: T0 + 30_000, idleMs: 1_000 }), null);
  assert.equal(MIN_ABSENCE_MS, MIN);
});

test('the first sign of life is not an absence — nobody was away from a launch', () => {
  assert.equal(absenceEnded({ lastActivityAt: null, now: T0, idleMs: 10 * MIN }), null);
  assert.equal(absenceEnded({ lastActivityAt: undefined, now: T0, idleMs: 10 * MIN }), null);
});

test('a clock that went backwards reports nothing rather than a negative absence', () => {
  assert.equal(absenceEnded({ lastActivityAt: T0, now: T0 - 5 * MIN, idleMs: 10 * MIN }), null);
  assert.equal(absenceEnded({ lastActivityAt: T0, now: T0, idleMs: 10 * MIN }), null);
});

test('activity is recorded across calls, and only the gap that crosses the threshold reports', () => {
  presence.init({ getSetting: () => ({ awayIdleMinutes: 10 }), log: { info() {} } });

  assert.equal(presence.recordActivity(T0), null, 'the first report has nothing to compare against');
  assert.equal(presence.recordActivity(T0 + 2 * MIN), null, 'still here');
  assert.deepEqual(presence.recordActivity(T0 + 40 * MIN), { awaySince: T0 + 2 * MIN, awayMs: 38 * MIN },
    'away from the last sign of life, not from the first');
  assert.equal(presence.recordActivity(T0 + 41 * MIN), null, 'and back is only reported once');
});

test('a settings store that throws does not stop presence being tracked', () => {
  presence.init({ getSetting: () => { throw new Error('no db'); }, log: { info() {} } });
  assert.equal(presence.recordActivity(T0), null);
  assert.deepEqual(presence.recordActivity(T0 + 30 * MIN), { awaySince: T0, awayMs: 30 * MIN },
    'falls back to the default threshold rather than reporting nothing');
});
