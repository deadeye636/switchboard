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

// Read the last task-lifecycle event straight from a rollout file's TAIL.
//
// Claude reports busy/idle through OSC title sequences in the PTY stream; Codex emits NO OSC at all,
// so a live Codex session would otherwise sit permanently "idle" in the UI. Its rollout file is the
// signal instead: `task_started` when the agent begins working, `task_complete` when the turn ends.
//
// Only the tail is read (bounded), never the whole file — a long session's rollout runs to megabytes
// and this is called on every file-change event.
const fs = require('fs');
const TAIL_BYTES = 64 * 1024;

// The window GROWS. A busy turn writes reasoning, tool calls and output into the rollout, so
// `task_started` scrolls out of a fixed 64 KB tail long before `task_complete` arrives — and the old
// code then returned IDLE, actively pushing the wrong edge while Codex was working. (The same class of
// bug the Pi gate found; Codex was never re-checked.)
const TAIL_WINDOWS = [TAIL_BYTES, 8 * TAIL_BYTES, 64 * TAIL_BYTES];   // 64 KB → 512 KB → 4 MB

function scanWindow(fd, size, len) {
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  const lines = buf.toString('utf8').split('\n');
  // Walk backwards to the most recent task event; the window's first line may be truncated.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const t = entry && entry.payload && entry.payload.type;
    if (t === 'task_started') return BUSY;
    if (t === 'task_complete') return IDLE;
  }
  return null;   // no lifecycle event in view — say NOTHING rather than guess IDLE
}

function deriveStateFromFileTail(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    for (const window of TAIL_WINDOWS) {
      const len = Math.min(window, size);
      const state = scanWindow(fd, size, len);
      if (state) return state;
      if (len >= size) break;   // the whole file was in view — a wider window cannot help
    }
    // Nothing anywhere: leave the state alone instead of claiming the session is idle.
    return null;
  } catch {
    return null; // unreadable -> caller leaves the state untouched
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

module.exports = { deriveState, deriveStateFromFileTail, TAIL_WINDOWS, BUSY, IDLE };
