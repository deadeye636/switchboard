// backends/codex/state.js — busy/idle derivation for Codex (T-4.5).
//
// Codex emits NO OSC title (unlike Claude), so we cannot read the terminal. It does, however, write
// lifecycle events into the rollout file itself, which we already tail for parsing:
//   event_msg / task_started  -> the agent is working   (BUSY)
//   event_msg / task_complete -> the turn finished      (IDLE)
// The parser records the last of these in `state.lastTaskEvent`, so state derivation is just a read of
// the rollout tail — the same file-watch model Claude uses, and strictly better than the generic
// PTY-activity fallback.
'use strict';

const BUSY = 'busy';
const IDLE = 'idle';

/**
 * Derive the session state from a Codex parse state (or from a raw list of tail events).
 * Accepts either the parser state object ({lastTaskEvent}) or an array of event payload types.
 */
function deriveState(input) {
  if (!input) return IDLE;

  // Array form: the last task-lifecycle event in the tail wins.
  if (Array.isArray(input)) {
    for (let i = input.length - 1; i >= 0; i--) {
      const t = typeof input[i] === 'string' ? input[i] : (input[i] && input[i].type);
      if (t === 'task_started') return BUSY;
      if (t === 'task_complete') return IDLE;
    }
    return IDLE;
  }

  // Parse-state form.
  if (input.lastTaskEvent === 'task_started') return BUSY;
  return IDLE; // task_complete, or nothing seen yet
}

module.exports = { deriveState, BUSY, IDLE };
