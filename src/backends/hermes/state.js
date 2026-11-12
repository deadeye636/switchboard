// backends/hermes/state.js — busy/idle for Hermes (T-5.3, corrected by #165).
//
// Hermes emits no OSC title, and its first-party status file (upstream PR #39575) was still unmerged at
// recon time — so there is no push signal to key on. What we DO have is its own database, which the
// watcher already re-reads on every WAL commit.
//
// The original rule was `ended_at IS NULL + recent messages -> BUSY`. It was wrong twice over, and a real
// store said so: **`ended_at` was null on every session** of the 0.21 store measured, including ones finished
// the day before — so the one branch that could return IDLE never fired. (Hermes 0.23 writes it on a graceful
// exit and a fork, but `-r` does not clear it and a second exit does not rewrite it, so it is read as "nothing
// happened since", never as a flag. A session left open at its prompt still has none. On a 0.23 store the turn
// ledger — `session_admissions` — decides first, see deriveState; the last row is the signal where that table
// is absent.) What was left was "wrote something
// recently → busy", and the agent's own ANSWER is something written recently. A session therefore sat at
// "working" for the whole activity window after every reply, while plainly waiting at its prompt.
//
// The transcript says whose turn it is, and it always did:
//
//   last row = user                                   -> BUSY   (asked, not yet answered)
//   last row = assistant, finish_reason = a tool one  -> BUSY   (it stopped in order to CALL something)
//   last row = assistant, finish_reason = none        -> BUSY   (still generating, or a cut-off stream)
//   last row = assistant, any other finish_reason     -> IDLE   (the message is complete: the turn is over)
//   last row = tool                                   -> BUSY   (mid-turn: a tool just answered the agent)
//   no rows at all                                    -> IDLE   (nobody has asked anything)
//
// This is Pi's rule, arrived at from the other side: a trailing user prompt means a turn is running.
//
// The activity window stays as a ceiling, not as the signal: a turn that has been "running" for longer
// than the window with nothing written and a silent terminal is a crashed or abandoned session, not a
// working one — it must not spin forever. And D21 still holds: the PTY stream may keep a long silent
// turn out of idle, and may NEVER declare one busy (a spinner frame is output; so is an echoed keystroke).
//
// The reader supplies the four facts: `isEnded`, `lastActivityMs`, `lastRole`, `lastFinishReason`.
'use strict';

const BUSY = 'busy';
const IDLE = 'idle';

// `finish_reason` answers "why did generation stop". Almost every answer to that means the assistant's
// message is COMPLETE — `stop`, `end_turn`, `length`, `content_filter`, and whatever a given provider calls
// its own variants (Gemini says `SAFETY`, `RECITATION`, `OTHER`). Only one family means the turn CONTINUES:
// the model stopped in order to call a tool.
//
// So this is a denylist, and the direction matters. The first cut was an allowlist of "over" reasons, which
// looked safer and was not: Hermes is multi-provider, the vocabulary of *terminal* reasons is open-ended,
// and an unrecognised one would have been read as "still running" — where the PTY-liveness net can hold a
// session busy for as long as its TUI keeps repainting. That is the "permanently working" bug this repo has
// already shipped twice, arriving through a different door.
//
// The vocabulary of *continuation* reasons, by contrast, is small and stable across providers, because they
// all copied it from each other.
const TURN_CONTINUES = new Set([
  'tool_calls',      // OpenAI convention — the one this schema mirrors (`tool_calls`, `tool_call_id`)
  'tool_use',        // Anthropic's name for the same thing
  'function_call',   // OpenAI's older name
  'function_calls',
]);

/** Did the assistant's message END the turn? A reason we do not know is still an ENDING (see above). */
function turnIsOver(finishReason) {
  if (!finishReason) return false;                 // no reason at all = still generating / cut off
  return !TURN_CONTINUES.has(String(finishReason).trim().toLowerCase());
}

// How long after the last message we still call a session "working". Hermes turns can run long (tool
// calls, subagents), so this is generous — `ended_at` is what normally ends it; this is the safety net.
const ACTIVITY_WINDOW_MS = 3 * 60 * 1000;

// How recently the PTY must have spoken for a silent, still-open turn to still count as running.
const OUTPUT_LIVENESS_MS = 60 * 1000;

/**
 * The CEILING on that net (#166). The terminal may keep a turn out of idle for a while; it may not do so
 * for ever.
 *
 * `lastOutputMs` is refreshed on every PTY data chunk, and that includes a spinner frame, a clock, an
 * echoed keystroke, a repaint. So a session STUCK in the running-turn branch — a store row that never got
 * its closing message: a crash, a lost write, a state we misread — sat at "working" indefinitely, as long
 * as its TUI twitched once a minute. This is the "permanently working" failure this repo has already
 * shipped twice, reachable through a third door.
 *
 * Five activity windows: long enough for the case the net exists for (a real turn thinking, or running a
 * long tool without writing a message), short enough that a wedged session heals itself well inside a
 * working session. Past it, the STORE is the state — output was only ever the tie-breaker.
 */
const OUTPUT_LIVENESS_CEILING_MS = 5 * ACTIVITY_WINDOW_MS;   // 15 minutes

/**
 * Derive state from a parsed Hermes row. `nowMs` is injectable for tests.
 * `opts.lastOutputMs` = when this session's PTY last produced output (main.js). Liveness only.
 */
function deriveState(row, nowMs = Date.now(), opts = {}) {
  if (!row) return IDLE;

  const last = Number(row.lastActivityMs);

  // `ended_at` (graceful exit, fork) is NOT cleared by `-r` and not rewritten when a resumed session exits
  // again (measured), so by itself it proves nothing about a session that is running now. It only says
  // "nothing has happened since" when the last activity is not newer than it.
  if (row.isEnded && !(Number(row.endedMs) > 0 && last > Number(row.endedMs))) return IDLE;

  // Hermes 0.23 states outright whether a turn runs (#864): an open admission in `session_admissions`
  // (`started`, or `queued` behind one), from ~0.36 s after Enter to the turn's terminal row. That replaces
  // the inference below — no admission means no turn, an interrupt placeholder or a half-written row
  // included. An unexpired turn lease (the model call, expires_at = acquired + 300 s) is corroboration and
  // keeps a turn busy past the quiet window on its own. An admission a crash left `started` has no
  // timestamp, so it is bounded like any quiet turn: the activity window, then the terminal, then the ceiling.
  if (row.hasLedger) {
    if (Number(row.leaseExpiresMs) > nowMs) return BUSY;
    if (!row.admission) return IDLE;
    const touched = Math.max(Number.isFinite(last) ? last : 0, Number(row.leaseAcquiredMs) || 0);
    return runningTurn(touched, nowMs, opts);
  }

  const role = row.lastRole || null;

  // The turn is answered — say so at once, not once an activity window has lapsed.
  if (role === 'assistant' && turnIsOver(row.lastFinishReason)) return IDLE;
  // Nobody has asked anything yet.
  if (!role) return IDLE;

  // A turn is running: an unanswered prompt, a tool result, or an assistant row whose reason says it is
  // not done (`tool_calls`) or says nothing we recognise.
  return runningTurn(last, nowMs, opts);
}

/** A turn that is believed to run, bounded by the activity window and the terminal (see the header). */
function runningTurn(last, nowMs, opts) {
  if (!Number.isFinite(last) || last <= 0) return IDLE;
  if ((nowMs - last) < ACTIVITY_WINDOW_MS) return BUSY;

  // Silent for longer than the ceiling: over, whatever the terminal is doing. The store is the state.
  if ((nowMs - last) >= OUTPUT_LIVENESS_CEILING_MS) return IDLE;

  // Running, but nothing written for a long time: still working, or dead? The terminal knows — and it may
  // only keep this turn out of idle, never declare one busy (D21).
  const out = Number(opts.lastOutputMs || 0);
  return (out && nowMs - out <= OUTPUT_LIVENESS_MS) ? BUSY : IDLE;
}

module.exports = { deriveState, BUSY, IDLE, ACTIVITY_WINDOW_MS, OUTPUT_LIVENESS_MS, OUTPUT_LIVENESS_CEILING_MS };
