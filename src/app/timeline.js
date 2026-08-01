// timeline.js — main's half of the session timeline (#396).
//
// The record itself is `src/db/timeline-store.js`. This is what turns the signals main already produces
// into events in it, and it is deliberately the ONLY writer: one session gets one history because one
// process writes it, not because every window agrees to write the same thing.
//
// It sits on the seam the three status producers already share — `ctx.sendTimelineSignal`, called from
// `app/terminal/spawn.js` (the OSC heuristics), `watch/adopt.js` (the store-derived state for a backend
// that names its own sessions) and `app/hooks.js` (the Claude Code hook server). main.js composes this
// module in FRONT of that call, before `app/detach.js` decides whether a window needs to hear it: that
// routing answers "which window", and a session living in the main window has no owner to send to, so
// recording behind it would record everything except the ordinary case.
//
// WHAT IS DIFFERENT FROM THE RENDERER'S OLD RULE, and it is the decision #396 turns on: `response-ready`
// here means "the turn ended", with no condition about where the user was looking. The renderer's version
// asked whether the session was focused, which is a per-window fact — and a record that is per session
// cannot hold one. The question that condition was really asking ("did I miss this?") is answered by the
// absence, which `app/presence.js` already owns as one global fact. RAISING a ready session — the inbox
// flag, the ready class, the badge — keeps its focus condition untouched in the renderer; #391 split
// those two apart and this uses that seam rather than cutting a new one.
'use strict';

let ctx = null;

// The sessions that are WORKING, as far as the record is concerned. Membership is the whole state — an
// entry means busy, its absence means idle, so the map stays the size of what is running.
//
// Its own latch rather than a read of someone else's: the producers do not agree on debouncing (the OSC
// paths hold `session._cliBusy` and only fire on a change, the store-derived one reports what it sees),
// and `response-ready` must be written on a busy→idle EDGE. Without an edge of its own this module would
// write one per report, which on a spinner is one per frame.
const busyBySession = new Map();

const LABELS = {
  busy: ['busy', 'Agent working', 'Claude activity started.'],
  idle: ['idle', 'Agent idle', 'Claude activity stopped.'],
  ready: ['response-ready', 'Ready for review', 'Agent stopped producing output.'],
  attention: ['needs-attention', 'Needs human attention', ''],
};

function init(context) {
  ctx = context;
  busyBySession.clear();
  warnedAboutWrites = false;
}

// A write failure is reported ONCE at warn and then falls to debug. A broken record — a locked database,
// a full disk — makes the recap quietly empty, which is indistinguishable from "nothing happened" and is
// the one failure mode a user cannot diagnose. But the failure repeats per event, and a packaged build
// logs at info, so warning every time would bury the line that matters under thousands of its own copies.
let warnedAboutWrites = false;

function write(sessionId, [kind, label, defaultDetail], detail) {
  if (!ctx || typeof ctx.recordTimelineEvent !== 'function') return null;
  try {
    return ctx.recordTimelineEvent({
      sessionId,
      kind,
      label,
      detail: detail || defaultDetail,
    });
  } catch (err) {
    // A timeline that cannot be written must never take a session's status down with it.
    if (ctx.log) {
      if (!warnedAboutWrites) {
        warnedAboutWrites = true;
        ctx.log.warn(`[timeline] cannot write the session record — the "while you were away" recap will be empty: ${err.message}`);
      }
      ctx.log.debug(`[timeline] session=${sessionId} kind=${kind} not recorded: ${err.message}`);
    }
    return null;
  }
}

/**
 * Record what a status signal means, on the same normalized vocabulary the renderer's record-only twin
 * reads (`recordAttentionSignal`): busy / idle / ready / needs-attention, plus the subagent kinds this
 * has no surface for.
 *
 * Returns nothing. A caller must not be able to route differently because a record succeeded or failed.
 */
function recordSignal(sessionId, signal) {
  if (!sessionId || !signal || !signal.kind) return;
  const { kind, reason } = signal;

  if (kind === 'needs-attention') {
    write(sessionId, LABELS.attention, reason || '');
    return;
  }

  if (kind === 'busy') {
    if (busyBySession.has(sessionId)) return;
    busyBySession.set(sessionId, true);
    write(sessionId, LABELS.busy);
    return;
  }

  if (kind === 'ready' || kind === 'idle') {
    // Only a session this module has SEEN working can stop working. After a restart the latch is empty,
    // and an idle report about a session that was already idle is not the end of a turn — writing
    // "ready for review" for it would put an event in the recap that never happened.
    //
    // Deleting rather than storing `false` is what keeps the map the size of the sessions currently
    // WORKING rather than of every session ever reported on: idle is the absence of an entry, and the
    // delete's own return value is the edge.
    if (!busyBySession.delete(sessionId)) return;
    write(sessionId, LABELS.idle);
    write(sessionId, LABELS.ready);
  }
}

/** A session's process is gone — its busy latch is meaningless, and keeping it leaks one entry per session. */
function forgetSession(sessionId) {
  busyBySession.delete(sessionId);
}

/**
 * A session changed its id mid-flight — the latch moves with it (#396).
 *
 * A turn that STARTS under one id and ENDS under another is the ordinary case, not an edge: Claude's
 * first hook POST re-keys a brand-new session from the id we launched it under to the one the CLI chose,
 * and a fork does the same. The producers recompute the id per event, so without this the busy entry sits
 * under the old key, the idle edge looks like "this session was never working", and the end of the turn —
 * the one fact the recap exists to report — is silently never written.
 *
 * `watch/adopt.js` carries `liveBusy` across exactly this move for exactly this reason; this is the same
 * transfer for the record's own latch.
 */
function rekeySession(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  if (busyBySession.delete(fromId)) busyBySession.set(toId, true);
}

module.exports = {
  init,
  recordSignal,
  forgetSession,
  rekeySession,
  // For tests: the latch is the whole of this module's state.
  _busyBySession: busyBySession,
};
