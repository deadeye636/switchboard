// backends/pi/state.js — busy/idle derivation for Pi (T-6.3).
//
// Pi gives us less to work with than Codex or Hermes:
//   - no OSC title (so the PTY stream says nothing, unlike Claude),
//   - its rich lifecycle events exist ONLY in `--mode json` / `--mode rpc`, which are mutually
//     exclusive with the interactive TUI we launch. Choosing them would mean giving up the live tab.
//
// What its transcript DOES show: a completed assistant turn is written with a `stopReason` (`stop`,
// `error`, …). While a turn is running, no assistant message exists yet — the file's last message is
// the user's prompt. So:
//   last message is a USER prompt        -> the agent is working   (BUSY)
//   last message is an assistant turn    -> the turn finished      (IDLE)
//
// This is weaker than Codex's explicit task_started/task_complete (a crashed pi leaves the last user
// prompt dangling and reads as busy forever), so it is bounded by a staleness window: no write for
// ACTIVITY_WINDOW_MS means idle, whatever the transcript's last line says.
'use strict';

const fs = require('fs');

const BUSY = 'busy';
const IDLE = 'idle';

// A turn that has produced nothing for this long is not running any more.
const ACTIVITY_WINDOW_MS = 3 * 60 * 1000;

const TAIL_BYTES = 64 * 1024;

/**
 * Derive from a parsed row (or parse state): { lastStopReason, lastEntryAt } — plus `now` for tests.
 * A row whose last assistant turn has a stopReason is finished. A row whose last entry is a user
 * prompt is mid-turn, unless it has gone quiet.
 */
function deriveState(row, now = Date.now()) {
  if (!row) return null;

  const lastMs = row.lastEntryAt ? Date.parse(row.lastEntryAt) : NaN;
  if (Number.isFinite(lastMs) && now - lastMs > ACTIVITY_WINDOW_MS) return IDLE;

  // `lastRole` is what the tail reader below reports; the parser reports lastStopReason instead.
  if (row.lastRole === 'user') return BUSY;
  if (row.lastRole === 'assistant') return IDLE;
  return row.lastStopReason ? IDLE : BUSY;
}

/**
 * Read the transcript's TAIL and report which role wrote last. Bounded — this runs on every file-change
 * event and a long session's JSONL is large.
 *
 * The window GROWS when it has to. A single Pi message is one JSONL line, and an assistant turn that
 * dumps a large diff easily exceeds 64 KB — then the whole window sits *inside* that one line, no line
 * in it starts with `{`, and a fixed-size tail read finds nothing. The caller treats "nothing" as "no
 * change", so the session would keep the last edge it was given — BUSY (its last complete line was the
 * user's prompt) — and sit there forever although the turn finished. So: widen until a complete line is
 * in view, up to a cap.
 *
 * If even the cap yields nothing, fall back on the file's own mtime: a transcript that has not been
 * written to for the activity window is not mid-turn, whatever its last line looks like.
 */
const TAIL_WINDOWS = [TAIL_BYTES, 8 * TAIL_BYTES, 64 * TAIL_BYTES];   // 64 KB → 512 KB → 4 MB

function readTail(fd, size, len) {
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  return buf.toString('utf8');
}

function deriveStateFromFileTail(filePath, now = Date.now()) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return null; }
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;

    for (const window of TAIL_WINDOWS) {
      const len = Math.min(window, size);
      let lastRole = null;
      let lastStopReason = null;
      let lastEntryAt = null;

      for (const line of readTail(fd, size, len).split('\n')) {
        const s = line.trim();
        if (!s || s[0] !== '{') continue;        // the window's partial leading line
        let entry;
        try { entry = JSON.parse(s); } catch { continue; }
        if (typeof entry.timestamp === 'string') lastEntryAt = entry.timestamp;
        if (entry.type !== 'message' || !entry.message) continue;
        lastRole = entry.message.role || null;
        lastStopReason = entry.message.stopReason || null;
      }

      if (lastRole) return deriveState({ lastRole, lastStopReason, lastEntryAt }, now);
      if (len >= size) break;                    // the whole file was in view — widening won't help
    }

    // No complete line anywhere in view (one message longer than the cap). The file's own mtime is the
    // honest last resort: quiet for the activity window = the turn is over.
    return (now - stat.mtimeMs > ACTIVITY_WINDOW_MS) ? IDLE : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { deriveState, deriveStateFromFileTail, ACTIVITY_WINDOW_MS, BUSY, IDLE };
