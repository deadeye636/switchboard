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

/** Every window that draws a session, and therefore every window that keeps a copy of its history. */
function liveWindows() {
  const out = [];
  const main = ctx && typeof ctx.getMainWindow === 'function' ? ctx.getMainWindow() : null;
  if (main && !main.isDestroyed()) out.push(main);
  const others = ctx && typeof ctx.getDetachedWindows === 'function' ? ctx.getDetachedWindows() : [];
  for (const win of others || []) {
    if (win && !win.isDestroyed() && win !== main) out.push(win);
  }
  return out;
}

/**
 * Tell every window about an event that was just written.
 *
 * Broadcast rather than routed, and that is the point: a window keeps a read-through copy of the
 * histories it draws, and which window draws which session changes while the app runs. Routing would
 * make the copy correct only for as long as nothing moved. A window that has never heard of the session
 * simply has nothing to update — the renderer's own cache decides, because it is the only thing that
 * knows what it is holding.
 */
function announce(event) {
  if (!event) return;
  for (const win of liveWindows()) {
    try { win.webContents.send('timeline-appended', event); } catch { /* a window on its way out */ }
  }
}

function write(sessionId, [kind, label, defaultDetail], detail) {
  if (!ctx || typeof ctx.recordTimelineEvent !== 'function') return null;
  try {
    const stored = ctx.recordTimelineEvent({
      sessionId,
      kind,
      label,
      detail: detail || defaultDetail,
    });
    // Null means the store refused it — a duplicate from a second producer, or an event older than the
    // retention window. Announcing it would put a row on screen that is not in the record.
    if (stored) announce(stored);
    return stored;
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

/**
 * The lifecycle facts, which are not signals and have no edge: a session started, exited, was stopped,
 * was forked. Each has exactly one moment and one producer in main, so they are recorded where they
 * happen rather than derived from anything.
 *
 * Separate from `recordSignal` because they must NOT touch the busy latch. An exit is not the end of a
 * turn — a session killed mid-turn never finished one — and writing `response-ready` for it would put a
 * "ready for you" in the recap for work that was thrown away.
 */
function recordLifecycle(sessionId, kind, label, detail) {
  if (!sessionId || !kind) return;
  write(sessionId, [kind, label || kind, ''], detail || '');
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
  // The events already written move too, or the history splits in two at every /clear: everything before
  // the move would sit under an id nothing asks about again, and the session would look newly born.
  if (ctx && typeof ctx.rekeyTimeline === 'function') {
    try { ctx.rekeyTimeline(fromId, toId); } catch (err) {
      if (ctx.log) ctx.log.debug(`[timeline] could not move ${fromId} → ${toId}: ${err.message}`);
    }
  }
}

/**
 * The read side. One handler, because a renderer asks for exactly one thing: the history of a session it
 * is about to draw. Everything after that arrives on `timeline-appended`.
 *
 * Deliberately NOT a subscription the main process tracks. A window that closes, reloads or hands a
 * session to another window would each need to be unsubscribed, and the failure mode of getting that
 * wrong is a leak that grows with every reload. Broadcasting to live windows has no such bookkeeping.
 */
// What a RENDERER is allowed to add to a session's history.
//
// Deliberately a short list. Main sees every fact about a session's process and status, so the only
// things a window can contribute are things that happened in the UI and nowhere else. Restricting the
// kind rather than trusting the caller is what keeps "main is the only writer" true in substance: a
// window cannot forge a busy edge or an exit.
//
//   started       a handoff packet was seeded into a fresh session — from main's side that is just input
//   viewed        the user looked at this session. The recap needs it to know a first look from a return
//   file-touched  the agent opened or changed a file, via the MCP bridge the renderer receives
//
// The last two are what makes the recap survive a reload with the rest of the record (#396). They are
// deliberately NOT in the recap's list of things worth listing — they are how it decides, not what it says.
const NOTEABLE_KINDS = new Set(['started', 'viewed', 'file-touched']);

function registerIpc(ipc) {
  ipc.handle('timeline:for-session', (_event, sessionId) => {
    if (!ctx || typeof ctx.getTimelineEvents !== 'function' || !sessionId) return [];
    try {
      return ctx.getTimelineEvents(sessionId);
    } catch (err) {
      if (ctx.log) ctx.log.debug(`[timeline] session=${sessionId} could not be read: ${err.message}`);
      return [];
    }
  });

  // Everything that happened since a point in time, across EVERY session — the recap overview's one
  // query (#402). Per-session reads cannot answer it: the overview's whole job is to say WHICH sessions
  // changed, so asking per session would mean knowing the answer before asking.
  //
  // Answers `{ events, truncated }`. The truncation flag is passed through rather than dropped: a recap
  // that quietly loses a third of an absence looks exactly like one where less happened.
  ipc.handle('timeline:since', (_event, sinceMs) => {
    if (!ctx || typeof ctx.getTimelineEventsSince !== 'function') return { events: [], truncated: false };
    try {
      return ctx.getTimelineEventsSince(Number(sinceMs));
    } catch (err) {
      if (ctx.log) ctx.log.debug(`[timeline] could not read the record since ${sinceMs}: ${err.message}`);
      return { events: [], truncated: false };
    }
  });

  // A fact only the UI can know. Written here rather than by the renderer, so the record still has one
  // writer and every window still learns about it the same way.
  ipc.handle('timeline:note', (_event, sessionId, kind, label, detail) => {
    if (!NOTEABLE_KINDS.has(String(kind))) return false;
    recordLifecycle(sessionId, kind, label, detail);
    return true;
  });
}

module.exports = {
  init,
  registerIpc,
  recordSignal,
  recordLifecycle,
  forgetSession,
  rekeySession,
  // For tests: the latch is the whole of this module's state.
  _busyBySession: busyBySession,
};
