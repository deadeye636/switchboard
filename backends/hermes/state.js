// backends/hermes/state.js — busy/idle for Hermes (T-5.3).
//
// Hermes emits no OSC title, and its first-party status file (upstream PR #39575) was still unmerged at
// recon time — so there is no push signal to key on. What we DO have is its own database, which the
// watcher already re-reads on every WAL commit:
//
//   ended_at IS NULL + recent message activity  -> BUSY   (the agent is mid-turn)
//   ended_at set                                -> IDLE   (the turn finished)
//
// A still-open session with no activity for a while is treated as IDLE anyway, so a crashed or
// abandoned session doesn't spin forever.
//
// The reader supplies the two facts this needs: `isEnded` and `lastActivityMs`.
'use strict';

const BUSY = 'busy';
const IDLE = 'idle';

// How long after the last message we still call a session "working". Hermes turns can run long (tool
// calls, subagents), so this is generous — `ended_at` is what normally ends it; this is the safety net.
const ACTIVITY_WINDOW_MS = 3 * 60 * 1000;

/** Derive state from a parsed Hermes row. `nowMs` is injectable for tests. */
function deriveState(row, nowMs = Date.now()) {
  if (!row) return IDLE;
  if (row.isEnded) return IDLE;                     // Hermes says the turn is over
  const last = Number(row.lastActivityMs);
  if (!Number.isFinite(last) || last <= 0) return IDLE;
  return (nowMs - last) < ACTIVITY_WINDOW_MS ? BUSY : IDLE;
}

module.exports = { deriveState, BUSY, IDLE, ACTIVITY_WINDOW_MS };
