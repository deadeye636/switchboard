'use strict';
// project-registry.js — the decisions the project list rests on (#167). No database, no filesystem: if
// these are wrong, everything above them is wrong, and none of it would be obvious from the sidebar.

const { test } = require('node:test');
const assert = require('node:assert');

const registry = require('../project-registry');

const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);

// --- who may put a project on the list ---------------------------------------------------------------

test('an explicit act registers in BOTH modes — manual mode is about discovery, not about the user', () => {
  // Starting a session somewhere is not discovery, it is a decision. Manual mode means "nobody but me
  // writes to the list", and reading it as "I cannot start anything anywhere" would be absurd.
  for (const autoAdd of [true, false]) {
    assert.strictEqual(registry.shouldRegister(null, { source: 'user', autoAdd }), true);
  }
});

test('discovery registers a project it found a session in — and only in auto mode', () => {
  const found = { source: 'scan', sessionAt: iso(NOW) };
  assert.strictEqual(registry.shouldRegister(null, { ...found, autoAdd: true }), true);
  assert.strictEqual(registry.shouldRegister(null, { ...found, autoAdd: false }), false);
});

test('discovery does not re-register what is already on the list', () => {
  const state = { registered: 1 };
  assert.strictEqual(registry.shouldRegister(state, { source: 'scan', autoAdd: true, sessionAt: iso(NOW) }), false);
});

// --- the tombstone -----------------------------------------------------------------------------------

test('the sessions a removal left behind do not bring the project back; a NEW one does', () => {
  // The reason "remove" was never implemented: the transcripts stay on disk, so without a memory of WHEN
  // it was removed, the very next scan finds them and registers the project straight back.
  const removed = { registered: 0, removedAt: iso(NOW) };

  assert.strictEqual(
    registry.shouldRegister(removed, { source: 'scan', autoAdd: true, sessionAt: iso(NOW - 60_000) }),
    false, 'an older session is exactly what the tombstone exists to ignore');

  assert.strictEqual(
    registry.shouldRegister(removed, { source: 'scan', autoAdd: true, sessionAt: iso(NOW) }),
    false, 'and one from the same instant is not NEWER than the removal');

  assert.strictEqual(
    registry.shouldRegister(removed, { source: 'scan', autoAdd: true, sessionAt: iso(NOW + 60_000) }),
    true, 'a session that happened after it means the project is in use again');
});

test('a session with no timestamp never resurrects a removed project', () => {
  // A row with no `modified` is not evidence of anything recent. Treating "unknown" as "now" would make
  // every removal undone by the first badly-formed row in the store.
  const removed = { registered: 0, removedAt: iso(NOW) };
  assert.strictEqual(registry.shouldRegister(removed, { source: 'scan', autoAdd: true, sessionAt: null }), false);
  assert.strictEqual(registry.shouldRegister(removed, { source: 'scan', autoAdd: true, sessionAt: 'nonsense' }), false);
});

test('adding a removed project back by hand always works', () => {
  const removed = { registered: 0, removedAt: iso(NOW + 10_000) };   // even a tombstone from the future
  assert.strictEqual(registry.shouldRegister(removed, { source: 'user', autoAdd: false }), true);
});

// --- the sweep ---------------------------------------------------------------------------------------

test('a tombstone whose sessions still exist is never dropped', () => {
  // Drop it while the transcripts are there and the project resurrects itself on the next scan — the
  // cleanup would quietly undo the deletion. This is the criterion; the age is only the belt.
  const old = { removedAt: iso(NOW - 400 * 86400000) };
  assert.strictEqual(registry.shouldDropTombstone(old, { hasSessions: true, now: NOW }), false);
});

test('a tombstone with nothing left to guard is dropped — after the grace period, not before', () => {
  const justNow = { removedAt: iso(NOW - 1000) };
  assert.strictEqual(registry.shouldDropTombstone(justNow, { hasSessions: false, now: NOW }), false,
    'the belt: an unmounted network drive looks exactly like a deleted one');

  const ancient = { removedAt: iso(NOW - registry.TOMBSTONE_GRACE_MS - 1) };
  assert.strictEqual(registry.shouldDropTombstone(ancient, { hasSessions: false, now: NOW }), true,
    'with no session left, a genuinely new one there SHOULD register the project again');
});

test('there is nothing to sweep where there was no removal', () => {
  assert.strictEqual(registry.shouldDropTombstone({ removedAt: null }, { hasSessions: false, now: NOW }), false);
  assert.strictEqual(registry.shouldDropTombstone(null, { hasSessions: false, now: NOW }), false);
});

// --- what is shown ------------------------------------------------------------------------------------

test('the three invisible states are three, and only one of them means "not on the list"', () => {
  assert.strictEqual(registry.isVisible({ registered: 1 }), true);
  assert.strictEqual(registry.isVisible({ registered: 1, hidden: 1 }), false, 'hidden by the user');
  assert.strictEqual(registry.isVisible({ registered: 1, autoHidden: 1 }), false, 'hidden by staleness (#57)');
  assert.strictEqual(registry.isVisible({ registered: 0, removedAt: iso(NOW) }), false, 'removed');
  assert.strictEqual(registry.isVisible(null), false, 'and one nothing is known about is simply not there');
});

// --- the states the two acts leave behind --------------------------------------------------------------

test('a removal clears the hide flags: they qualify a LISTED project, and this one is not on the list', () => {
  const s = registry.removalState(iso(NOW));
  assert.strictEqual(s.registered, 0);
  assert.strictEqual(s.removedAt, iso(NOW));
  assert.strictEqual(s.hidden, 0);
  assert.strictEqual(s.autoHidden, 0);
});

test('a registration comes back VISIBLE and buries the tombstone', () => {
  // Anything else would silently swallow a project the user just re-added — and leave it invisible with
  // no control anywhere that says why.
  const s = registry.registrationState(iso(NOW));
  assert.strictEqual(s.registered, 1);
  assert.strictEqual(s.registeredAt, iso(NOW));
  assert.strictEqual(s.hidden, 0);
  assert.strictEqual(s.autoHidden, 0);
  assert.strictEqual(s.removedAt, null);
  assert.strictEqual(s.autoHideResetAt, iso(NOW), 'and it is not stale — the grace timer starts now (#57)');
});
