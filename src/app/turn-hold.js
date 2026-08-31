// app/turn-hold.js — hold a "the agent finished" signal that is about to be wrong (#495).
//
// A CLI announces the END of a turn and the START of one through two different events, and nothing makes
// them arrive in that order. Claude fires `UserPromptSubmit` when a prompt is QUEUED; if the running turn
// then ends before the queue drains, its `Stop` lands after the busy edge and overwrites it — and the
// turn that the queued prompt starts announces nothing at all, because its event has already been spent.
// Measured: a session sat on "Ready" through fifteen minutes of work.
//
// THE CORE DOES NOT READ ANY TRANSCRIPT. "Is a turn still owed?" is a question about one CLI's own
// format, so it is a descriptor hook (`readTurnQueue`) and a backend that cannot answer declines by not
// declaring one. A null answer means today's behaviour, exactly: deliver the signal.
//
// WHAT RELEASES A HELD SIGNAL, because a hold that nothing can release is worse than the bug. Three ways
// out, and the last one exists precisely because the first two can both fail to happen:
//
//   the queue RAN      — an entry newer than the Stop proves the turn started. The busy state was right;
//                        drop the held signal and let that turn's own Stop end it.
//   the queue EMPTIED  — cancelled without running, and no further hook will ever say so. Deliver the
//                        signal now, late but true.
//   the clock ran out  — neither happened within MAX_HOLD_MS. Deliver it and say so in the log: an
//                        unresolvable hold must end in the honest answer, not in a session stuck on
//                        "Working" forever.
'use strict';

// How long before a held signal is looked at again. The releasing evidence — the queued prompt's first
// entry — is written within milliseconds of the Stop, so this is not a race being waited out; it is the
// gap between the transcript being appended and being worth re-reading.
const RECHECK_MS = 4000;

// The ceiling on the whole hold. Long enough for a queue the user is still adding to, short enough that a
// wrong hold costs a minute of a stale "Working" rather than the rest of the session.
const MAX_HOLD_MS = 60 * 1000;

let ctx = null;
const held = new Map();   // sessionId -> { timer, since, at, deliver }

/**
 * @param {object} context
 * @param {(sessionId: string, sinceMs: number) => ({queued: number, turnStarted: boolean}|null)}
 *        context.readTurnQueue  the descriptor's answer, resolved per call. Null = this backend cannot
 *        tell, which is not the same as "nothing is queued".
 * @param {object} context.log
 * @param {number} [context.recheckMs]  overrides RECHECK_MS — a test cannot wait four seconds per case.
 * @param {number} [context.maxHoldMs]  overrides MAX_HOLD_MS, same reason.
 */
function init(context) {
  ctx = context;
  for (const entry of held.values()) clearTimeout(entry.timer);
  held.clear();
}

const recheckMs = () => (ctx && Number.isFinite(ctx.recheckMs) ? ctx.recheckMs : RECHECK_MS);
const maxHoldMs = () => (ctx && Number.isFinite(ctx.maxHoldMs) ? ctx.maxHoldMs : MAX_HOLD_MS);

function ask(sessionId, sinceMs) {
  if (!ctx || typeof ctx.readTurnQueue !== 'function') return null;
  try { return ctx.readTurnQueue(sessionId, sinceMs) || null; }
  catch { return null; }
}

function release(sessionId) {
  const entry = held.get(sessionId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  held.delete(sessionId);
  return entry;
}

/** A new signal for this session makes any held one moot — the state it described has moved on. */
function cancel(sessionId) {
  if (release(sessionId) && ctx && ctx.log) {
    ctx.log.debug(`[turn-hold] session=${sessionId} released by a newer signal`);
  }
}

function schedule(sessionId) {
  const entry = held.get(sessionId);
  if (!entry) return;
  entry.timer = setTimeout(() => recheck(sessionId), recheckMs());
  // Never a reason to keep the process alive on its own.
  if (typeof entry.timer.unref === 'function') entry.timer.unref();
}

function recheck(sessionId) {
  const entry = held.get(sessionId);
  if (!entry) return;

  const state = ask(sessionId, entry.at);
  if (state && state.turnStarted) {
    release(sessionId);
    if (ctx.log) ctx.log.info(`[turn-hold] session=${sessionId} the queued prompt started its turn — "ready" dropped`);
    return;
  }
  if (!state || state.queued === 0) {
    release(sessionId);
    if (ctx.log) ctx.log.info(`[turn-hold] session=${sessionId} the queue emptied without a turn — "ready" delivered late`);
    entry.deliver();
    return;
  }
  if (Date.now() - entry.since >= maxHoldMs()) {
    release(sessionId);
    if (ctx.log) ctx.log.warn(`[turn-hold] session=${sessionId} still queued after ${Math.round(maxHoldMs() / 1000)}s — "ready" delivered anyway`);
    entry.deliver();
    return;
  }
  schedule(sessionId);
}

/**
 * Should this "the agent finished" signal be held back?
 *
 * Returns true when the CLI still owes a turn — the caller then delivers nothing, and `deliver` is
 * called later from here if it turns out the turn never came. Returns false in every other case,
 * including every case where the answer is unknown: a signal is only ever withheld on evidence.
 *
 * @param {string} sessionId
 * @param {() => void} deliver  what the caller would have done now, kept so a late release does it.
 * @param {number} atMs  when the signal happened; entries newer than this are what prove a turn started.
 */
function holdReady(sessionId, deliver, atMs = Date.now()) {
  if (!sessionId || typeof deliver !== 'function') return false;
  release(sessionId);

  const state = ask(sessionId, 0);
  if (!state || !(state.queued > 0)) return false;

  held.set(sessionId, { timer: null, since: Date.now(), at: atMs, deliver });
  schedule(sessionId);
  if (ctx.log) {
    ctx.log.info(`[turn-hold] session=${sessionId} "ready" held — ${state.queued} prompt(s) still queued`);
  }
  return true;
}

/** Test seam: nothing is held across a test, and no timer outlives one. */
function _reset() {
  for (const entry of held.values()) clearTimeout(entry.timer);
  held.clear();
}

module.exports = { init, holdReady, cancel, _reset, RECHECK_MS, MAX_HOLD_MS };
