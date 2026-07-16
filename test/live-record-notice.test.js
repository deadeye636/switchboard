// The "this backend cannot see your session" notice (#151).
//
// A store-derived backend (Codex, Hermes, Pi) reports busy/idle only once the live session has been
// paired with its store record. When that never happens — Hermes' degraded mode writes JSON because it
// could not open its own DB, and our reader IS the DB — the tab shows nothing at all and says nothing
// about why. These pin WHEN we speak up, and that we do it once.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldNoticeMissingRecord,
  missingRecordMessage,
  NO_RECORD_GRACE_MS,
} = require('../src/app/terminal/live-record-notice');

const NOW = 1_800_000_000_000;
const opened = (agoMs) => NOW - agoMs;

test('a session whose record was found says nothing', () => {
  assert.equal(shouldNoticeMissingRecord({ claimed: true, openedAt: opened(NO_RECORD_GRACE_MS * 5) }, NOW), false);
});

test('a young session says nothing — the record appears a moment after the spawn', () => {
  // Hermes alone needs ~12 s just to paint its TUI. Warning inside that window would cry wolf on every
  // healthy launch, which is how a warning stops being read.
  assert.equal(shouldNoticeMissingRecord({ openedAt: opened(5_000) }, NOW), false);
  assert.equal(shouldNoticeMissingRecord({ openedAt: opened(30_000) }, NOW), false);
  assert.equal(shouldNoticeMissingRecord({ openedAt: opened(NO_RECORD_GRACE_MS - 1) }, NOW), false);
});

test('an unpaired session past the grace window is worth saying out loud', () => {
  assert.equal(shouldNoticeMissingRecord({ openedAt: opened(NO_RECORD_GRACE_MS) }, NOW), true);
  assert.equal(shouldNoticeMissingRecord({ openedAt: opened(NO_RECORD_GRACE_MS * 10) }, NOW), true);
});

test('said once is enough — this runs on every watcher flush', () => {
  assert.equal(
    shouldNoticeMissingRecord({ openedAt: opened(NO_RECORD_GRACE_MS * 3), alreadyNoticed: true }, NOW),
    false,
  );
});

test('a session with no spawn time is not ours to judge', () => {
  assert.equal(shouldNoticeMissingRecord({ openedAt: 0 }, NOW), false);
  assert.equal(shouldNoticeMissingRecord({}, NOW), false);
  assert.equal(shouldNoticeMissingRecord(undefined, NOW), false);
});

test('the message names the backend and what the user loses', () => {
  const m = missingRecordMessage('Hermes');
  assert.match(m, /^Hermes /);
  assert.match(m, /working or idle/, 'says what is missing, not just that something is');
  // No backend label (an unregistered id) must still read as a sentence, not as "undefined ...".
  assert.match(missingRecordMessage(null), /^This backend /);
});
