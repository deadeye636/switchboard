// backends/pi/turn-queue.js — does this Pi session still owe a turn? (#530, the seam is #495)
//
// The core holds a "the agent finished" signal when the CLI still has a prompt queued, and asks the
// descriptor whether that is the case. Only Claude could answer, so a `Stop` arriving with work still
// pending was believed for every other backend.
//
// **Why this is not the RPC the issue named.** Pi 0.84.4 added `clear_queue`, which retrieves and clears
// the queued steering and follow-up messages. Two things rule it out, both measured against the installed
// 0.84.4: it exists only in RPC mode — a separate headless run driven by JSON over stdin/stdout — and
// Switchboard spawns the interactive TUI, which has no RPC surface to ask. And there is no retrieve-only
// half: the one method clears what it returns, so a check would consume the user's queued work.
//
// **What answers instead.** `ctx.hasPendingMessages()` is on the ordinary extension context, so the
// per-spawn binding extension Switchboard already writes can report it — verified against a real Pi turn,
// where it arrives alongside `isIdle()` on every lifecycle event. It is a PUSH and the core's question is
// a synchronous PULL, so what it pushes is remembered here and read back when the core asks.
//
// **The honest limits of that, and both are why a stale answer is refused rather than guessed:**
//
//   - It is a BOOLEAN, not a depth. `{ queued: 1 }` means "at least one", and the hold only ever asks
//     whether the number is above zero. The log line will say "1 prompt(s)" where Claude would say three.
//   - It is only as fresh as the last event. A session Switchboard did not spawn — one adopted after a
//     restart, or running without the extension — has nothing here, and that answers `null`: "this
//     backend cannot tell", which is the core's word for today's behaviour, and deliberately not
//     "nothing is queued".
'use strict';

const path = require('path');

// A Pi transcript's filename: `<ISO-timestamp>_<uuid>.jsonl`. Anchored at BOTH ends on purpose — it is
// what tells a real parent reference from any other path that happens to contain an underscore (#193).
// The uuid group is what a fork's parent id is read from, and what names a session here.
//
// It lives in this module rather than in the descriptor because the descriptor imports this one; the other
// direction would be a cycle. `index.js` takes it from here, so there is one pattern rather than two that
// agree until somebody edits one of them.
//
// A binding is remembered per SESSION, and a session is named by its transcript because that is what the
// core hands to `readTurnQueue` (#211: the path comes from the descriptor, and for a file backend it is
// the row's own file). So the two ends meet without the core learning anything about either.
const PI_TRANSCRIPT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([0-9a-fA-F-]{36})\.jsonl$/;

// Bounded because it is fed by a running app and never by a user action. Well past any plausible number
// of live Pi sessions; the eviction exists so a long-running instance cannot grow it without limit.
const MAX_ENTRIES = 64;

// How long a report stays usable. The hold it feeds is itself capped at a minute (`app/turn-hold.js`), and
// the binding reports on every turn boundary, so anything older than this belongs to a session that has
// stopped talking — most likely one whose PTY is gone. Generous rather than tight: the cost of holding a
// stale entry a few minutes is one wrong answer to a question nobody is asking, and the cost of dropping a
// live one too early is the null answer, which is also safe.
const MAX_AGE_MS = 10 * 60 * 1000;

const states = new Map();   // sessionId -> { pending, busyAt, at }

function sessionIdFromTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  const m = PI_TRANSCRIPT_NAME.exec(path.basename(String(transcriptPath)));
  return m ? m[1] : null;
}

/**
 * Remember what the binding extension just reported.
 *
 * `turnStart` says this report came with a turn BEGINNING, which is the evidence that releases a hold.
 * Anything else only refreshes the queue answer.
 */
function noteTurnQueue(sessionId, { pending, turnStart } = {}, now = Date.now()) {
  if (!sessionId || typeof pending !== 'boolean') return;
  const prev = states.get(sessionId) || { busyAt: 0 };
  // Re-insert so eviction is by LAST USE rather than by age — a long-lived session that keeps reporting
  // must not be dropped because a burst of short ones happened after it started.
  states.delete(sessionId);
  if (states.size >= MAX_ENTRIES) states.delete(states.keys().next().value);
  states.set(sessionId, {
    pending,
    // `turnStart`, NOT the busy edge. The binding posts `busy` for the end of a UI prompt as well (#529),
    // and a prompt answered after the hold began would then read as the queued turn having started — the
    // hold would be released as "it ran" for a turn that never did, without even the ceiling to catch it.
    // The one thing that proves a queued prompt ran is a turn beginning, so that is what is recorded.
    busyAt: turnStart === true ? now : prev.busyAt,
    at: now,
  });
}

/**
 * `{ queued, turnStarted }` for one session, or null when nothing has reported for it.
 *
 * Null is not "nothing is queued" — it is "this backend cannot tell", and the core answers that with
 * today's behaviour. A session whose extension never loaded, or one adopted from before this app started,
 * lands here on purpose rather than being reported as idle.
 */
function readTurnQueue(transcriptPath, sinceMs = 0, now = Date.now()) {
  const sessionId = sessionIdFromTranscript(transcriptPath);
  if (!sessionId) return null;
  const state = states.get(sessionId);
  if (!state) return null;
  // A report only describes the moment it was made. Nothing tells this module that a session ended — the
  // PTY dying reaches the app, not the extension — so a `pending: true` from a killed session would sit
  // here answering about the past until it happened to be evicted. Past the bound it is dropped and the
  // answer goes back to "cannot tell", which is the honest one.
  if (now - state.at > MAX_AGE_MS) {
    forgetSession(sessionId);
    return null;
  }
  return {
    queued: state.pending ? 1 : 0,
    turnStarted: sinceMs > 0 && state.busyAt > sinceMs,
  };
}

/** A session that ended reports nothing more; its entry would only ever answer about the past. */
function forgetSession(sessionId) {
  if (sessionId) states.delete(sessionId);
}

module.exports = {
  PI_TRANSCRIPT_NAME,
  noteTurnQueue,
  readTurnQueue,
  forgetSession,
  MAX_AGE_MS,
  _sessionIdFromTranscript: sessionIdFromTranscript,
  _reset: () => states.clear(),
  _size: () => states.size,
  MAX_ENTRIES,
};
