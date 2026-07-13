// backends/hermes/state.js — busy/idle for Hermes (T-5.3, corrected by #165).
//
// Hermes emits no OSC title, and its first-party status file (upstream PR #39575) was still unmerged at
// recon time — so there is no push signal to key on. What we DO have is its own database, which the
// watcher already re-reads on every WAL commit.
//
// The original rule was `ended_at IS NULL + recent messages -> BUSY`. It was wrong twice over, and a real
// store said so: **`ended_at` is never set** — null on every session, including ones finished the day
// before — so the one branch that could return IDLE never fired. What was left was "wrote something
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
 * Derive state from a parsed Hermes row. `nowMs` is injectable for tests.
 * `opts.lastOutputMs` = when this session's PTY last produced output (main.js). Liveness only.
 */
function deriveState(row, nowMs = Date.now(), opts = {}) {
  if (!row) return IDLE;
  if (row.isEnded) return IDLE;                     // kept for the day Hermes starts writing ended_at

  const role = row.lastRole || null;

  // The turn is answered — say so at once, not once an activity window has lapsed.
  if (role === 'assistant' && turnIsOver(row.lastFinishReason)) return IDLE;
  // Nobody has asked anything yet.
  if (!role) return IDLE;

  // A turn is running: an unanswered prompt, a tool result, or an assistant row whose reason says it is
  // not done (`tool_calls`) or says nothing we recognise.
  const last = Number(row.lastActivityMs);
  if (!Number.isFinite(last) || last <= 0) return IDLE;
  if ((nowMs - last) < ACTIVITY_WINDOW_MS) return BUSY;

  // Running, but nothing written for a long time: still working, or dead? The terminal knows — and it may
  // only keep this turn out of idle, never declare one busy (D21).
  const out = Number(opts.lastOutputMs || 0);
  return (out && nowMs - out <= OUTPUT_LIVENESS_MS) ? BUSY : IDLE;
}

module.exports = { deriveState, BUSY, IDLE, ACTIVITY_WINDOW_MS, OUTPUT_LIVENESS_MS };
