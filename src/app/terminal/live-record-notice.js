// --- "the backend cannot see this session" notice (pure logic, #151) ---
//
// A backend whose busy/idle comes from its STORE (Codex, Hermes, Pi) can only report a state once we
// have paired the live session with its store record. When that pairing never happens, the tab shows
// nothing at all: no working, no idle, forever — and nothing says why.
//
// Hermes has a documented degraded mode where it writes sessions as JSON files because it could not open
// its own database (docs/plans/multi_llm/research/hermes-format.md). Our reader is the database, so in that mode it
// sees no record for a session that is plainly running in front of the user.
//
// What we do NOT do is invent a state out of PTY output. That was the original plan, and it is wrong: a
// spinner frame is output, and so is an echoed keystroke. Output is a LIVENESS signal — it may keep a
// silent turn out of idle, and it may never declare one busy (D21). A backend whose TUI repaints at rest
// would otherwise read as "working" forever, which is exactly the bug that shipped twice.
//
// So: say the true thing. The state stays unknown, and the user is told that it is unknown, and why.
//
// Free of Electron/DOM so the decision is unit-tested (`test/live-record-notice.test.js`).
'use strict';

// How long a live session may go unpaired before we say so. Hermes alone needs ~12 s just to paint its
// TUI, so a minute is well past every honest delay — and a late notice beats a false one.
const NO_RECORD_GRACE_MS = 60 * 1000;

// WHEN a backend's record appears, declared by the backend (#512). This file used to assume "at the
// spawn" for all of them, and for Codex that is measurably wrong: across 29 rollouts on one machine not
// one has a `session_meta` header without a `task_started` beside it, and the header and the first turn
// are written in the same second. The file appears WITH the first turn — so a Codex session opened and
// left sitting at its prompt has nothing to pair with, and picked up the muted "no store record" dot a
// minute later while it was perfectly alive.
//
//   'spawn'      — the record is written when the process starts (Hermes' session row, Pi's transcript
//                  header). The grace runs from the spawn, as it always did.
//   'first-turn' — the record is written when the user first asks for something. The grace runs from
//                  that moment, and a session that has been asked nothing is never reported at all.
//
// The conservative direction is the one this file already argues for elsewhere: no notice beats a wrong
// one, and a session with no turn behind it has nothing to explain yet.
const RECORD_APPEARS_AT = ['spawn', 'first-turn'];

/**
 * Should we tell the user that this backend cannot see this session?
 *
 *   claimed         — have we paired the session with its store record? (then there is nothing to say)
 *   openedAt        — when the session was spawned (0/absent: not our session to judge)
 *   alreadyNoticed  — said once is enough; this runs on every watcher flush
 *   recordAppearsAt — the backend's answer to WHEN its record shows up
 *   firstTurnAt     — when the user first submitted a turn (0/absent: none yet)
 */
function shouldNoticeMissingRecord(
  { claimed = false, openedAt = 0, alreadyNoticed = false, recordAppearsAt = 'spawn', firstTurnAt = 0 } = {},
  nowMs = Date.now(),
) {
  if (claimed || alreadyNoticed) return false;
  // An unrecognised answer is the default, not a silent third behaviour: a misspelled `'firstTurn'`
  // would otherwise reinstate #512 with nothing to see. The value is pinned per backend in
  // test/backend-parity.test.js; this is what keeps the core honest if one ever drifts.
  const mode = RECORD_APPEARS_AT.includes(recordAppearsAt) ? recordAppearsAt : 'spawn';
  const since = mode === 'first-turn' ? firstTurnAt : openedAt;
  if (!since) return false;
  return (nowMs - since) >= NO_RECORD_GRACE_MS;
}

// An escape sequence, so what a keystroke MEANS is not mistaken for the letters it is spelled with:
// `ESC [ A` is an arrow key, not the letter A. CSI first, then OSC, then the two-character forms.
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|.)/g;

/**
 * Did the user TYPE something in these bytes — a character that would land in a composer?
 *
 * Escape sequences are removed first, so arrow keys, a bracketed-paste wrapper and a mouse report do
 * not count; what a paste carries between the wrappers does.
 */
function hasPrintableInput(data) {
  const s = typeof data === 'string' ? data : String(data || '');
  return /[^\x00-\x1f\x7f]/.test(s.replace(ESCAPES, ''));
}

// Enter as the kitty keyboard protocol spells it, unmodified: `ESC [ 13 u` or `ESC [ 13 ; 1 u`. Any
// other modifier is a different key — `ESC [ 13 ; 2 u` is Shift+Enter, which MEANS "newline, not
// submit" and is exactly what must not count.
const KITTY_PLAIN_ENTER = /\x1b\[13(?:;1)?u/;

/**
 * Did these bytes ask the CLI for a turn?
 *
 * The Enter the user pressed, and nothing else. Output cannot serve here — a TUI repaints at rest, and
 * D21 says output is liveness and never a turn — so the signal comes from the input side.
 *
 * Three things it is careful about, each because getting it wrong costs an acceptance criterion:
 *
 *   - `ESC CR` is not a submit. That is Codex' "newline, not submit" sequence (#493), sent as one chunk
 *     by the newline routing, and counting it would start the clock on a prompt still being written.
 *   - A CLI that turns the kitty keyboard protocol on sends no CR at all, so plain Enter is recognised
 *     in that spelling too — otherwise the clock would never start for such a backend and the notice
 *     would be suppressed for good, which is the opposite failure and a worse one.
 *   - **Enter alone is not a turn.** A trust gate ("Do you trust this directory?"), an empty composer
 *     and a menu all answer to Enter and write no record, so the clock would start on a session nobody
 *     has asked anything — the very bug this exists to fix, one dialog later. Something has to have been
 *     TYPED first: either earlier in the session (`typedBefore`) or ahead of the Enter in this chunk.
 */
function isTurnSubmission(data, typedBefore = false) {
  const s = typeof data === 'string' ? data : String(data || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\r') continue;
    if (i > 0 && s[i - 1] === '\x1b') continue;
    return typedBefore || hasPrintableInput(s.slice(0, i));
  }
  const kitty = s.search(KITTY_PLAIN_ENTER);
  if (kitty >= 0) return typedBefore || hasPrintableInput(s.slice(0, kitty));
  return false;
}

/**
 * A turn was asked for. The ONE writer of `session._firstTurnAt`.
 *
 * Called directly by anything that submits a turn WITHOUT going through the keyboard —
 * `src/watch/trigger-watcher.js` writes its command and its Enter straight to the PTY, so a session
 * driven entirely by triggers would otherwise never start its clock and could never be reported as one
 * its backend cannot see.
 */
function markTurnSubmitted(session, nowMs = Date.now()) {
  if (session && !session._firstTurnAt) session._firstTurnAt = nowMs;
}

/**
 * What one chunk of keyboard input means for the turn clock.
 *
 * Two pieces of state, and the order is load-bearing: the submission is judged against what was typed
 * BEFORE this chunk, then this chunk's own typing is remembered. Judging after would let a bare Enter
 * that arrives together with a paste count itself.
 */
function noteInputForTurnClock(session, data, nowMs = Date.now()) {
  if (!session) return;
  if (isTurnSubmission(data, !!session._sawTypedInput)) markTurnSubmitted(session, nowMs);
  if (!session._sawTypedInput && hasPrintableInput(data)) session._sawTypedInput = true;
}

/** What the user is told. Names the backend, says what is missing, and what it costs them. */
function missingRecordMessage(backendLabel) {
  const label = backendLabel || 'This backend';
  return `${label} has not recorded this session in its store, so the tab cannot show whether it is working or idle.`;
}

module.exports = {
  shouldNoticeMissingRecord,
  missingRecordMessage,
  isTurnSubmission,
  hasPrintableInput,
  markTurnSubmitted,
  noteInputForTurnClock,
  NO_RECORD_GRACE_MS,
  RECORD_APPEARS_AT,
};
