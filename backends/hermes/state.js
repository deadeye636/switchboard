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
// That safety net has the flaw D21 identified for Pi, and it applies here just as much: Hermes states
// only that a turn ENDED, never that one is RUNNING — busy is inferred from "not ended + wrote
// recently". A turn that thinks, or runs a tool, for longer than the window without writing a message
// therefore reads as idle while it works. So the PTY stream gets the same single job it has for Pi: it
// says whether the process is still talking, which may keep a running turn out of idle, and may never
// declare one busy.
//
// The reader supplies the two facts this needs: `isEnded` and `lastActivityMs`.
'use strict';

const BUSY = 'busy';
const IDLE = 'idle';

// How long after the last message we still call a session "working". Hermes turns can run long (tool
// calls, subagents), so this is generous — `ended_at` is what normally ends it; this is the safety net.
const ACTIVITY_WINDOW_MS = 3 * 60 * 1000;

// How recently the PTY must have spoken for a silent, still-open turn to still count as running.
const OUTPUT_LIVENESS_MS = 60 * 1000;

/**
 * Derive state from a parsed Hermes row. `nowMs` is injectable for tests.
 * `opts.lastOutputMs` = when this session's PTY last produced output (main.js). Liveness only.
 */
function deriveState(row, nowMs = Date.now(), opts = {}) {
  if (!row) return IDLE;
  if (row.isEnded) return IDLE;                     // Hermes says the turn is over
  const last = Number(row.lastActivityMs);
  if (!Number.isFinite(last) || last <= 0) return IDLE;
  if ((nowMs - last) < ACTIVITY_WINDOW_MS) return BUSY;

  // Written nothing for a while, but not ended: still working, or dead? The terminal knows.
  const out = Number(opts.lastOutputMs || 0);
  return (out && nowMs - out <= OUTPUT_LIVENESS_MS) ? BUSY : IDLE;
}

module.exports = { deriveState, BUSY, IDLE, ACTIVITY_WINDOW_MS, OUTPUT_LIVENESS_MS };
