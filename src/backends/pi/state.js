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
// That is Codex's model (read the store, not the terminal), one step weaker: Codex STATES its state
// (`task_started`/`task_complete`), Pi's is INFERRED from which line exists. A crashed pi would leave
// the last user prompt dangling and read as busy forever, so it is bounded by a staleness window.
//
// The staleness window alone, though, lies in the other direction: a long turn that writes nothing for
// minutes (deep reasoning, a slow tool) would flip to idle while pi is still working. So the PTY stream
// gets ONE job — to say "the process is still talking". It may keep a running turn alive; it may NEVER
// declare one. That distinction is the whole point: generic PTY *activity* as a state source is what the
// plan proposed and it is a bad signal (a spinner frame is activity, so is an echoed keystroke), but as
// a LIVENESS signal it is exactly right — it is what Claude's spinner effectively gives us for free.
'use strict';

const fs = require('fs');
const { fileSig } = require('../livestate-cache');

const BUSY = 'busy';
const IDLE = 'idle';

// A turn that has written nothing for this long is over — unless the process is still producing output.
const ACTIVITY_WINDOW_MS = 3 * 60 * 1000;

// How recently the PTY must have said something for a silent turn to still count as running.
const OUTPUT_LIVENESS_MS = 60 * 1000;

/**
 * The CEILING on that net (#166) — the same rule, and the same reason, as Hermes'.
 *
 * `lastOutputMs` is refreshed on every PTY data chunk: a spinner frame, a clock, an echoed keystroke, a
 * repaint. Without an outer bound, a session stuck in the running-turn branch stays "working" for ever as
 * long as its TUI twitches once a minute. Five activity windows — long enough for a real turn that is
 * thinking, short enough that a wedged one heals itself. Past it, the STORE is the state.
 */
const OUTPUT_LIVENESS_CEILING_MS = 5 * ACTIVITY_WINDOW_MS;   // 15 minutes

const TAIL_BYTES = 64 * 1024;

/**
 * Derive from a row/parse state ({ lastRole | lastStopReason, lastEntryAt }).
 *
 * `opts.lastOutputMs` = when this session's PTY last produced output (main.js tracks it). It can only
 * ever KEEP a turn busy past the staleness window, never start one.
 */
function deriveState(row, now = Date.now(), opts = {}) {
  if (!row) return null;

  const running = row.lastRole === 'user'
    || (row.lastRole !== 'assistant' && !row.lastStopReason);   // parse-state form: no answered turn yet

  const lastMs = row.lastEntryAt ? Date.parse(row.lastEntryAt) : NaN;
  const stale = Number.isFinite(lastMs) && now - lastMs > ACTIVITY_WINDOW_MS;

  if (!running) return IDLE;                                    // an answered turn is an answered turn
  if (!stale) return BUSY;

  // Silent for longer than the ceiling: over, whatever the terminal is doing (#166).
  if (Number.isFinite(lastMs) && now - lastMs >= OUTPUT_LIVENESS_CEILING_MS) return IDLE;

  // Silent for a while. Is the process still alive and talking?
  const out = Number(opts.lastOutputMs || 0);
  if (out && now - out <= OUTPUT_LIVENESS_MS) return BUSY;      // still working, just not writing
  return IDLE;                                                  // gone quiet everywhere -> it is over
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

// #283: the tail READ, split from the time-based DERIVE below so the read can be signature-gated. Returns
// the last message's role/stopReason/timestamp when a complete line is in view, else `{ noLine: true,
// mtimeMs }` for the mtime fallback, or null when unreadable. This is the expensive part (open + a 64 KB–
// 4 MB readSync); everything below it is arithmetic on `now`.
function readTailFacts(filePath) {
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

      if (lastRole) return { lastRole, lastStopReason, lastEntryAt };
      if (len >= size) break;                    // the whole file was in view — widening won't help
    }

    // No complete line anywhere in view (one message longer than the cap). The mtime is the last resort.
    return { noLine: true, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// The time-based derive over the tail facts — re-run with a fresh `now` on every call (cached or not), so
// the staleness edge (a quiet turn flipping to idle) is unaffected by the read gate.
function deriveFromFacts(facts, now, opts) {
  if (!facts) return null;
  if (facts.noLine) {
    // Quiet for the activity window = the turn is over — unless the process is still producing output, in
    // which case it is simply mid-write (the PTY liveness signal keeps it alive, never declares it busy).
    if (now - facts.mtimeMs <= ACTIVITY_WINDOW_MS) return null;
    const out = Number(opts.lastOutputMs || 0);
    return (out && now - out <= OUTPUT_LIVENESS_MS) ? null : IDLE;
  }
  return deriveState({ lastRole: facts.lastRole, lastStopReason: facts.lastStopReason, lastEntryAt: facts.lastEntryAt }, now, opts);
}

function deriveStateFromFileTail(filePath, now = Date.now(), opts = {}) {
  return deriveFromFacts(readTailFacts(filePath), now, opts);
}

// Signature-gated variant (#283): skip the tail read when the rollout's (mtime, size) is unchanged and
// reuse the last facts; the derive still re-runs with a fresh `now`. adopt.updateBackendLiveStates calls
// this on every watcher flush (any backend), so an idle Pi rollout is no longer re-read several times a
// second. The symmetric #282-lever-1 gate the file backends never got. FIFO-bounded.
const _factsCache = new Map();   // filePath -> { sig, facts }
const FACTS_CACHE_MAX = 256;

function deriveStateFromFileTailGated(filePath, now = Date.now(), opts = {}) {
  const sig = fileSig(filePath);
  let entry = _factsCache.get(filePath);
  if (!entry || entry.sig !== sig) {
    const facts = readTailFacts(filePath);
    if (!facts) return null;   // unreadable -> caller leaves the state untouched, don't cache a miss
    entry = { sig, facts };
    _factsCache.set(filePath, entry);
    if (_factsCache.size > FACTS_CACHE_MAX) _factsCache.delete(_factsCache.keys().next().value);
  }
  return deriveFromFacts(entry.facts, now, opts);
}

/** Test seam: drop the gate's memo. */
function _clearFactsCache() { _factsCache.clear(); }

module.exports = {
  deriveState, deriveStateFromFileTail, deriveStateFromFileTailGated, _clearFactsCache,
  ACTIVITY_WINDOW_MS, OUTPUT_LIVENESS_MS, OUTPUT_LIVENESS_CEILING_MS,
  BUSY, IDLE,
};
