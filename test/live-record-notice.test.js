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
  isTurnSubmission,
  hasPrintableInput,
  markTurnSubmitted,
  noteInputForTurnClock,
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

// ---------------------------------------------------------------------------
// When the record appears is the BACKEND's answer (#512)
// ---------------------------------------------------------------------------

test('a first-turn backend that has been asked nothing is never reported', () => {
  // The bug: a Codex session launched and left at its prompt picked up the muted dot after a minute
  // while it was alive and usable. Its rollout does not exist yet, so there is nothing to pair with —
  // and nothing to explain either.
  const sitting = { openedAt: opened(NO_RECORD_GRACE_MS * 10), recordAppearsAt: 'first-turn', firstTurnAt: 0 };
  assert.equal(shouldNoticeMissingRecord(sitting, NOW), false);
});

test('a first-turn backend starts its clock at the turn, not at the spawn', () => {
  const base = { openedAt: opened(NO_RECORD_GRACE_MS * 10), recordAppearsAt: 'first-turn' };
  assert.equal(shouldNoticeMissingRecord({ ...base, firstTurnAt: opened(5_000) }, NOW), false);
  assert.equal(shouldNoticeMissingRecord({ ...base, firstTurnAt: opened(NO_RECORD_GRACE_MS - 1) }, NOW), false);
  assert.equal(shouldNoticeMissingRecord({ ...base, firstTurnAt: opened(NO_RECORD_GRACE_MS) }, NOW), true);
});

test('a spawn backend is unchanged by a turn it never needed', () => {
  const late = { openedAt: opened(NO_RECORD_GRACE_MS * 2), recordAppearsAt: 'spawn', firstTurnAt: 0 };
  assert.equal(shouldNoticeMissingRecord(late, NOW), true);
  // …and the default is 'spawn', so a backend that declares nothing behaves as it did before #512.
  assert.equal(shouldNoticeMissingRecord({ openedAt: opened(NO_RECORD_GRACE_MS * 2) }, NOW), true);
});

// ---------------------------------------------------------------------------
// What counts as "the user asked for a turn"
// ---------------------------------------------------------------------------

const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);
const LF = String.fromCharCode(10);

test('text and then Enter is a turn', () => {
  assert.equal(isTurnSubmission('fix the tests' + CR), true);
  assert.equal(isTurnSubmission(CR, true), true, '…or Enter after something typed earlier in the session');
  // xterm's unbracketed paste normalises every newline to CR, i.e. it submits. Counted, deliberately.
  assert.equal(isTurnSubmission('one line' + CR + 'two' + CR), true);
});

test('Enter with nothing typed is a dialog answer, not a turn', () => {
  // A trust gate, an empty composer and a menu all answer to Enter and write no record. Counting one
  // would start the clock on a session nobody has asked anything — #512, one dialog downstream.
  assert.equal(isTurnSubmission(CR), false);
  assert.equal(isTurnSubmission(ESC + '[B' + CR), false, 'a selection moved, then confirmed');
});

test('ESC CR is a newline, not a turn', () => {
  // Codex' "newline, not submit" sequence (#493), sent as one chunk by the newline routing. Counting
  // it would start the clock on a prompt the user is still writing.
  assert.equal(isTurnSubmission('half a prompt' + ESC + CR), false);
  assert.equal(isTurnSubmission(ESC + CR, true), false);
});

test('Enter is recognised in the kitty spelling too', () => {
  // A CLI that turns the kitty keyboard protocol on sends no CR at all. Missing it there would suppress
  // the notice for that backend for good — the opposite failure, and the worse one.
  assert.equal(isTurnSubmission(ESC + '[13u', true), true);
  assert.equal(isTurnSubmission('prompt' + ESC + '[13;1u'), true);
  // …but not Shift+Enter, which MEANS "newline, not submit".
  assert.equal(isTurnSubmission('prompt' + ESC + '[13;2u'), false);
});

test('ordinary keystrokes are not a turn', () => {
  assert.equal(isTurnSubmission('n'), false);
  assert.equal(isTurnSubmission(ESC + '[A', true), false, 'arrow up');
  assert.equal(isTurnSubmission(''), false);
  assert.equal(isTurnSubmission(undefined), false);
});

test('a bracketed paste carries no submit', () => {
  // The renderer normalises every CR inside the packet to LF before it sends it, precisely so a pasted
  // block cannot submit itself.
  assert.equal(isTurnSubmission(ESC + '[200~one' + LF + 'two' + ESC + '[201~'), false);
});

test('hasPrintableInput sees through an escape sequence', () => {
  assert.equal(hasPrintableInput('hello'), true);
  assert.equal(hasPrintableInput(ESC + '[A'), false, 'an arrow key is not the letter A');
  assert.equal(hasPrintableInput(ESC + '[200~text' + ESC + '[201~'), true, 'what a paste carries does count');
  assert.equal(hasPrintableInput(CR), false);
  assert.equal(hasPrintableInput(''), false);
});

// ---------------------------------------------------------------------------
// The latch on the session object
// ---------------------------------------------------------------------------

test('the clock starts on the Enter that follows typing, once', () => {
  const session = {};
  noteInputForTurnClock(session, 'fix the', 1000);
  assert.equal(session._firstTurnAt, undefined);
  noteInputForTurnClock(session, ' tests', 1100);
  noteInputForTurnClock(session, CR, 1200);
  assert.equal(session._firstTurnAt, 1200, 'the typing was remembered across chunks');
  noteInputForTurnClock(session, 'more' + CR, 5000);
  assert.equal(session._firstTurnAt, 1200, 'the FIRST turn, not the latest');
});

test('markTurnSubmitted is the way in for a submit that never touched the keyboard', () => {
  // The trigger watcher writes its command and its Enter straight to the PTY.
  const session = {};
  markTurnSubmitted(session, 4242);
  assert.equal(session._firstTurnAt, 4242);
  markTurnSubmitted(session, 9999);
  assert.equal(session._firstTurnAt, 4242);
  assert.doesNotThrow(() => markTurnSubmitted(null));
});

test('an unrecognised recordAppearsAt falls back to the default, not to a third behaviour', () => {
  const late = { openedAt: opened(NO_RECORD_GRACE_MS * 2), recordAppearsAt: 'firstTurn', firstTurnAt: 0 };
  assert.equal(shouldNoticeMissingRecord(late, NOW), true, 'a typo must not silently reinstate #512');
});
