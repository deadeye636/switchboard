// Axis-B live sessions: identity adoption + busy/idle (T-4.5, T-5.3).
//
// Two problems, one root, and they apply to EVERY backend that names its own sessions:
//
//  1. IDENTITY. Claude accepts `--session-id`, so we choose the id. Codex and Hermes do not: they
//     create their own id in their own store. Until the two are reconciled the app shows two rows for
//     one session (our pending row + the scanned store row), the pending row never dies, and resuming
//     from the sidebar targets an id the tool never had.
//  2. BUSY/IDLE. Claude reports state through OSC title sequences in its PTY stream. Neither Codex nor
//     Hermes emits OSC, so a live session would sit permanently "idle". Their stores carry the signal
//     instead — and the backend watcher already fires whenever those stores change.
//
// Both are solved once, generically, via two optional descriptor hooks:
//     matchLiveSession({cwd, sinceMs, claimed}) -> {sessionId, ref, bornMs?} | null
//     liveState(ref)                            -> 'busy' | 'idle' | null
// A backend that names its own sessions implements them; anything else is simply skipped. Adding a
// third such backend needs no change here.
//
// `bornMs` — when the record was written — is optional and is what lets this file tell two unpaired
// sessions of one backend in one project apart (#527). The correlation itself knows only a directory
// and a time window, so without it the older session takes the record the younger one produced.
// A backend that cannot date its record simply omits it and keeps the behaviour it had.
//
// `liveStoreRef` and `liveBusy` live here because this is what maintains them — but main.js's PTY exit
// handler DELETES from them when a session dies. They are exported as the Maps themselves, not copies:
// same reference, so every writer sees every write. (#213 moved this out of main.js; the exit handler
// is what makes this block have to land before spawn does.)
'use strict';

const path = require('path');

const { shouldNoticeMissingRecord, missingRecordMessage } = require('../app/terminal/live-record-notice');
const { recordWindowStart, claimVerdict } = require('./record-claim');

// How much earlier than a session's own start a record may be born and still be that session's. The
// store writes it just after we spawn the process, and the two clocks are not the same one.
const CLAIM_GRACE_MS = 10000;

// How many records this session may set aside on one flush before giving up (#527). Each pass excludes
// one more, so this bounds a walk that is not free — and a session behind more than a handful of records
// it may not have is not a case any correlation is going to resolve on this tick.
const MAX_CLAIM_ATTEMPTS = 5;

let ctx = null;

const liveStoreRef = new Map();   // our sessionId -> the backend's record ref (rollout path / db id)
const liveBusy = new Map();       // our sessionId -> last busy state pushed to the renderer

/**
 * @param {object} context
 * @param {Map} context.activeSessions
 * @param {() => Electron.BrowserWindow|null} context.getMainWindow  a GETTER — a captured window would
 *   be the wrong one after a reopen, and the symptom is a UI that quietly stops updating.
 * @param {object} context.backends  the registry
 * @param {object} context.sessionBackends
 * @param {object} context.log
 */
function init(context) {
  ctx = context;
}

/**
 * Which STORE a backend reads. A template runs its base backend's binary and writes into that store, so
 * a template session and a base session compete for the same records — while carrying different
 * descriptor ids. Grouping by id instead would make them invisible to each other and leave #527's
 * mis-pairing standing for exactly that pair.
 */
const recordPoolId = (b) => (b && (b.baseId || b.id)) || null;

/**
 * Every live session reading the same store, in this project, that is not paired with a record yet —
 * the one asking included. `from` is the earliest moment each of them could have written one (#527).
 *
 * An empty answer is not a refusal: the caller then keeps the behaviour it had. A session with no
 * project path is the one way that happens, and it is the same session the correlation already asks
 * about with no `cwd` at all.
 */
function unpairedCandidates(asking, backend) {
  const here = asking.projectPath ? path.resolve(asking.projectPath) : null;
  if (!here) return [];
  const pool = recordPoolId(backend);
  const out = [];
  for (const [id, s] of ctx.activeSessions) {
    if (!s || s.exited || s.isPlainTerminal) continue;
    if (!s.projectPath || path.resolve(s.projectPath) !== here) continue;
    const mapped = ctx.sessionBackends.get(s.realSessionId || id);
    if (!mapped) continue;
    const theirs = ctx.backends.get(mapped.backendId);
    if (!theirs || recordPoolId(theirs) !== pool) continue;
    if (liveStoreRef.has(id) || (s.realSessionId && liveStoreRef.has(s.realSessionId))) continue;
    // One `recordAppearsAt` for the whole pool, taken from the backend that is asking. It is a property
    // of the STORE, and everything in this list writes into the same one — a template forwards its
    // base's answer (`src/backends/index.js`), so asking any member gives the same value. Reading it per
    // candidate instead would put two sessions competing for one record on two different clocks.
    out.push({ sessionId: id, from: recordWindowStart(s, backend.recordAppearsAt) });
  }
  return out;
}

function claimLiveRecord(sessionId, session, backend) {
  const existing = liveStoreRef.get(sessionId);
  if (existing) return existing;   // #282 lever 3: a CLAIMED session never reaches the full-store walk below

  // RESUME: our id already IS the backend's id, so there is nothing to correlate — just confirm the
  // record exists. This must come first: `matchLiveSession` only accepts records born after the spawn,
  // and a resumed session's record is by definition older, so correlation could never claim it — but it
  // WOULD happily claim the next new session's record in the same cwd and collapse two tabs onto one id.
  //
  // Only a RESUMED session can have a record under our id. A new one (fork included) is about to be
  // named by the backend itself, so asking is guaranteed to come back empty — and `liveRefFor` walks the
  // whole store, on every watcher flush, for every session not yet claimed. That walk bought nothing and
  // is simply not made (#155).
  //
  // For a resumed session the question IS asked on every flush until it answers, and deliberately so: a
  // null is not proof that the record is absent. Hermes' openDb() returns null while its DB is locked —
  // and the moment of heaviest write contention is right after a resume. Caching that first "no" would
  // leave the session without busy/idle for good, with nothing left to heal it, since matchLiveSession
  // can never claim a record older than the spawn. In practice this resolves on the first flush.
  if (typeof backend.liveRefFor === 'function' && session._resumed !== false) {
    let ownRef = null;
    try { ownRef = backend.liveRefFor(sessionId); } catch { ownRef = null; }
    if (ownRef) {
      liveStoreRef.set(sessionId, ownRef);
      return ownRef;
    }
  }

  const claimed = new Set(liveStoreRef.values());
  // Small grace window: the store record appears just AFTER we spawn the process.
  const sinceMs = (session._openedAt || 0) - CLAIM_GRACE_MS;

  // Could this session have written that record (#527)? The correlation knows a directory and a window,
  // and with two unpaired sessions of one backend in one project that is not enough — the older one is
  // asked first and takes the record the younger one's turn produced. A backend that does not date its
  // record answers 'unknown' and nothing changes.
  //
  // A record this session may NOT take must not hide the one it may. `matchLiveSession` offers the oldest
  // unclaimed record, so a single deferral would otherwise stop the walk there for every later flush —
  // the session's own record sits behind one it will never be allowed to have. So the deferred record is
  // set aside and the store is asked again. Bounded, because each pass sets one more aside.
  const candidates = unpairedCandidates(session, backend);
  let match = null;
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    let offer = null;
    try {
      offer = backend.matchLiveSession({ cwd: session.projectPath, sinceMs, claimed });
    } catch (err) {
      ctx.log.warn(`[${backend.id}] live match failed: ${err?.message || err}`);
      return null;
    }
    if (!offer || !offer.sessionId) return null;

    const verdict = claimVerdict({
      candidates,
      bornMs: offer.bornMs,
      askingId: sessionId,
      graceMs: CLAIM_GRACE_MS,
    });
    if (verdict !== 'defer') { match = offer; break; }

    // At `debug`, not `info`: this runs on every watcher flush for as long as it holds, and the state it
    // leaves behind — a session with no busy/idle — is already reported to the user by #151.
    ctx.log.debug(`[${backend.id}] session=${sessionId} leaves ${offer.sessionId} to an older live session`);
    if (!offer.ref || claimed.has(offer.ref)) return null;   // nothing new to set aside — stop, don't spin
    claimed.add(offer.ref);
  }
  if (!match) return null;

  // Adopt the backend's id. This is exactly Claude's temp->real transition, so it reuses that
  // plumbing: re-key the live session, move the backend overlay across, and tell the renderer to fold
  // its pending row onto the real one.
  const realId = match.sessionId;
  if (realId !== sessionId && !ctx.activeSessions.has(realId)) {
    ctx.log.info(`[${backend.id}] session ${sessionId} → ${realId} (adopting the backend's own session id)`);
    session.realSessionId = realId;
    ctx.activeSessions.delete(sessionId);
    ctx.activeSessions.set(realId, session);
    ctx.sessionBackends.rekeySession(sessionId, realId);
    liveStoreRef.set(realId, match.ref);
    const wasBusy = liveBusy.get(sessionId);
    liveBusy.delete(sessionId);
    if (wasBusy !== undefined) liveBusy.set(realId, wasBusy);
    // The timeline's own busy latch moves for the same reason this one does (#396): a turn that started
    // under the launch id ends under the adopted one, and a latch left behind turns the end of that turn
    // into "this session was never working" — so it is never recorded.
    if (ctx.rekeyTimelineSession) ctx.rekeyTimelineSession(sessionId, realId);
    const mainWindow = ctx.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-forked', sessionId, realId);
    }
  } else {
    // No adoption needed (or the target id is somehow already live). NOTE: the claim is deliberately
    // NOT recorded before a successful adoption — doing so would make the early-return above skip the
    // adoption forever if it ever failed.
    liveStoreRef.set(sessionId, match.ref);
  }
  return match.ref;
}

function updateBackendLiveStates() {
  // Snapshot: claimLiveRecord may re-key a session, which mutates activeSessions mid-iteration.
  for (const [sessionId, session] of [...ctx.activeSessions]) {
    if (session.exited) {
      // Drop the claim so the maps don't grow for the life of the app (and so a re-launched session
      // re-claims cleanly instead of inheriting a dead ref).
      const liveId = session.realSessionId || sessionId;
      liveStoreRef.delete(sessionId); liveStoreRef.delete(liveId);
      liveBusy.delete(sessionId); liveBusy.delete(liveId);
      continue;
    }
    if (session.isPlainTerminal) continue;

    const mapped = ctx.sessionBackends.get(session.realSessionId || sessionId);
    if (!mapped) continue;
    const backend = ctx.backends.get(mapped.backendId);
    if (!backend || typeof backend.matchLiveSession !== 'function' || typeof backend.liveState !== 'function') {
      continue;   // Claude & Axis-A: they report state through OSC and own their session id already.
    }

    const ref = claimLiveRecord(sessionId, session, backend);
    // claimLiveRecord may ADOPT the backend's own id here — re-keying session.realSessionId (Codex/Pi/agy
    // name their own sessions). Read the live id AFTER it, not before: on the adoption tick a busy/idle
    // edge computed from the pre-adoption id is sent to an id the renderer has just re-keyed away, so the
    // real card never receives it. agy then stops writing, the store watcher never flushes again, this
    // tick never re-runs — and the card is stuck on its launch state ("Running") for good.
    const liveId = session.realSessionId || sessionId;
    if (!ref) {
      // No record, and the session is plainly running in front of the user — so the tab will show no
      // state at all, forever. Hermes' degraded mode (it writes JSON when it cannot open its own DB) puts
      // it here. Say so once, rather than leaving a blank indicator the user cannot explain (#151). We do
      // NOT fabricate a state from PTY output: output is liveness, never busy (D21).
      // `recordAppearsAt` is the backend's own answer to WHEN its record shows up (#512). Codex writes
      // its rollout with the first turn, so a session left sitting at its prompt has nothing to pair
      // with and must not be reported — the clock starts at the turn, not at the spawn.
      if (shouldNoticeMissingRecord({
        openedAt: session._openedAt,
        alreadyNoticed: session._noRecordNoticed,
        recordAppearsAt: backend.recordAppearsAt,
        firstTurnAt: session._firstTurnAt,
      })) {
        session._noRecordNoticed = true;
        const message = missingRecordMessage(backend.label || backend.id);
        ctx.log.warn(`[${backend.id}] session=${liveId} has no store record — reporting no busy/idle state`);
        // Published as a STATE rather than sent as a toast (#460): the condition outlives any message
        // that fades, and the tab it explains is still blank minutes later.
        if (ctx.noteMissingStoreRecord) ctx.noteMissingStoreRecord(liveId, message);
      }
      continue;
    }

    // The record turned up after we had spoken up about it (#460). A session that pairs late shows its
    // state like any other, so the explanation goes with the condition. Both ids, because a session
    // noticed before adoption carries the marker under the id it launched with, and the row on screen
    // is drawn for the one the backend chose.
    if (session._noRecordNoticed && ctx.clearMissingStoreRecord) {
      ctx.clearMissingStoreRecord(liveId);
      if (sessionId !== liveId) ctx.clearMissingStoreRecord(sessionId);
    }

    let state;
    try { state = backend.liveState(ref, { lastOutputMs: session._lastOutputAt || 0 }); } catch { state = null; }
    if (state == null) continue;

    const busy = state === 'busy';
    if (liveBusy.get(liveId) === busy) continue;   // only push edges, not every watcher event
    liveBusy.set(liveId, busy);
    ctx.log.info(`[${backend.id}] session=${liveId} → ${busy ? 'BUSY' : 'IDLE'}`);
    const mainWindow = ctx.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cli-busy-state', liveId, busy);
    }
    // For these backends this watcher is the ONLY source of the fact, so without this the recap in a
    // window of its own would work for one backend and silently not for the others (#395). `source` is
    // deliberately not the backend's id — none of those may cross into renderer-visible data.
    if (ctx.sendTimelineSignal) {
      ctx.sendTimelineSignal(liveId, { kind: busy ? 'busy' : 'idle', source: 'store', reason: '' });
    }
  }
}

// Is any live session still waiting to be paired with its backend's store record? Only store-derived
// backends count — Claude owns its session id and reports state through the terminal, so it is never
// "unpaired" in this sense.
//
// A session we have ALREADY spoken up about stops counting. This tick exists to get us to that notice,
// and matchLiveSession is not free: on a file backend it walks the whole store and parses every candidate.
// Left counting, a session that can never be paired (a store that moved, a cwd that will not correlate)
// would drive that walk every 30 seconds for the life of the app. The record can still turn up later —
// the store watcher fires the moment anything is written, which is exactly when it would.
function hasUnclaimedStoreSession() {
  for (const [sessionId, session] of ctx.activeSessions) {
    if (session.exited || session.isPlainTerminal || session._noRecordNoticed) continue;
    const liveId = session.realSessionId || sessionId;
    if (liveStoreRef.has(sessionId) || liveStoreRef.has(liveId)) continue;
    const mapped = ctx.sessionBackends.get(liveId);
    if (!mapped) continue;
    const backend = ctx.backends.get(mapped.backendId);
    if (!backend || typeof backend.matchLiveSession !== 'function' || typeof backend.liveState !== 'function') continue;
    return true;
  }
  return false;
}

module.exports = {
  init,
  claimLiveRecord,
  updateBackendLiveStates,
  hasUnclaimedStoreSession,
  // The Maps themselves, not copies — main.js's PTY exit handler deletes from them.
  liveStoreRef,
  liveBusy,
};
