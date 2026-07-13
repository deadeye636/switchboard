// --- "the backend cannot see this session" notice (pure logic, #151) ---
//
// A backend whose busy/idle comes from its STORE (Codex, Hermes, Pi) can only report a state once we
// have paired the live session with its store record. When that pairing never happens, the tab shows
// nothing at all: no working, no idle, forever — and nothing says why.
//
// Hermes has a documented degraded mode where it writes sessions as JSON files because it could not open
// its own database (docs/plans/research/hermes-format.md). Our reader is the database, so in that mode it
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

// How long a live session may go unpaired before we say so. A backend writes its record when the session
// starts (Codex writes the rollout header, Hermes the session row, Pi the transcript header), so a record
// normally appears within seconds — but Hermes alone needs ~12 s just to paint its TUI. A minute is well
// past every honest delay, and a late notice beats a false one.
const NO_RECORD_GRACE_MS = 60 * 1000;

/**
 * Should we tell the user that this backend cannot see this session?
 *
 *   claimed        — have we paired the session with its store record? (then there is nothing to say)
 *   openedAt       — when the session was spawned (0/absent: not our session to judge)
 *   alreadyNoticed — said once is enough; this runs on every watcher flush
 */
function shouldNoticeMissingRecord({ claimed = false, openedAt = 0, alreadyNoticed = false } = {}, nowMs = Date.now()) {
  if (claimed || alreadyNoticed) return false;
  if (!openedAt) return false;
  return (nowMs - openedAt) >= NO_RECORD_GRACE_MS;
}

/** What the user is told. Names the backend, says what is missing, and what it costs them. */
function missingRecordMessage(backendLabel) {
  const label = backendLabel || 'This backend';
  return `${label} has not recorded this session in its store, so the tab cannot show whether it is working or idle.`;
}

module.exports = { shouldNoticeMissingRecord, missingRecordMessage, NO_RECORD_GRACE_MS };
