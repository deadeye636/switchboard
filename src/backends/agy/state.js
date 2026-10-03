// backends/agy/state.js — busy/idle derivation for agy (Antigravity CLI).
//
// agy 1.1.x stated it in `steps.status`: 8 while a step was running, 3 once it was done. Measured through
// a live turn, once a second (#510):
//
//   #5 t=15 status=3 bytes=37536     the previous turn, finished
//   #7 t=15 status=8 bytes=171       the turn starts — the model row is there already
//   #7 t=15 status=8 bytes=31555     the answer streams into it
//   #7 t=15 status=3 bytes=39265     finished
//
// agy 1.2.14 changed that contract (#735): user and tool steps remain status 3 while the turn is live, and
// status 8 can be a sub-second edge on the final model step. The stable turn shape is now the last step's
// TYPE: user (14) means the answer is owed; tool (9 in older stores, 132 now) means the model still owes its
// answer; model (15) means the turn is complete unless its status explicitly says it is still running.
//
// Which is also why the rule this replaced could not work. It read WHICH ROLE wrote the last message step
// — 14 (a user prompt) running, 15 (a model message) finished — but agy inserts the model row when the
// turn STARTS and fills it in as the answer streams. `lastRole` is 'assistant' from the first moment, so
// the session never once reported busy. That rule is kept as the fallback for a store that reports no
// status at all, where inferring from the role is still better than reporting nothing.
//
// Only those measured turn-bearing types may declare busy. Lifecycle/title steps and failed/cancelled tool
// statuses stay idle: a session stuck on Working is worse than one that stays Running.
//
// The one weaker point vs. Pi: agy's store has no timestamps, so "how long since the last write" is the
// `.db` file mtime, not an entry time. The safeguards are otherwise Pi's, kept identical on purpose (fix
// one, check its sibling): a crashed agy would leave a running step behind and read busy for ever, so the
// activity window bounds it; a long silent turn would flip to idle early, so the PTY liveness signal keeps
// it alive — but only KEEPS it, never DECLARES it — under a ceiling so a wedged session heals itself
// whatever its TUI is painting (#166).
'use strict';

const { driver } = require('../sqlite-driver');
const { dbSignature } = require('../livestate-cache');

const BUSY = 'busy';
const IDLE = 'idle';

// CortexStepStatus enum values from the agy protobuf descriptor:
//   0: UNSPECIFIED, 1: PENDING, 2: RUNNING, 3: DONE, 4: INVALID, 5: CLEARED,
//   6: CANCELED, 7: ERROR, 8: GENERATING, 9: WAITING, 11: QUEUED, 12: INTERRUPTED, 13: HALTED
const STEP_STATUS_PENDING = 1;
const STEP_STATUS_RUNNING = 2;
const STEP_STATUS_DONE = 3;
const STEP_STATUS_CANCELED = 6;
const STEP_STATUS_ERROR = 7;
const STEP_STATUS_GENERATING = 8;
const STEP_STATUS_WAITING = 9;
const STEP_STATUS_QUEUED = 11;
const STEP_STATUS_INTERRUPTED = 12;

const STEP_STATUSES_ACTIVE = new Set([
  STEP_STATUS_PENDING,
  STEP_STATUS_RUNNING,
  STEP_STATUS_GENERATING,
  STEP_STATUS_QUEUED,
]);

// CortexStepType values:
const STEP_TYPE_USER = 14;      // USER_INPUT
const STEP_TYPE_MODEL = 15;     // PLANNER_RESPONSE
const STEP_TYPE_MESSAGE = 101;  // SYSTEM_MESSAGE (subagent prompts, task notifications)
const STEP_TYPE_TITLE = 23;     // CHECKPOINT
const STEP_TYPE_HISTORY = 98;   // CONVERSATION_HISTORY

const STEP_TYPES_TOOL = new Set([
  8,    // VIEW_FILE
  9,    // LIST_DIRECTORY
  21,   // RUN_COMMAND
  31,   // READ_URL_CONTENT
  33,   // SEARCH_WEB
  38,   // MCP_TOOL
  112,  // SHELL_EXEC
  127,  // INVOKE_SUBAGENT
  132,  // GENERIC (view_file, run_command, write_to_file, etc.)
  138,  // ASK_QUESTION
]);

const STEP_TYPES_TURN = new Set([
  STEP_TYPE_USER,
  STEP_TYPE_MODEL,
  STEP_TYPE_MESSAGE,
  ...STEP_TYPES_TOOL,
]);

// Kept identical to Pi's — the same rule wants the same windows.
const ACTIVITY_WINDOW_MS = 3 * 60 * 1000;
const OUTPUT_LIVENESS_MS = 60 * 1000;
const OUTPUT_LIVENESS_CEILING_MS = 5 * ACTIVITY_WINDOW_MS;   // 15 minutes

// When a tool has finished (status 3), it briefly bridges until the model step appears (~1-5 s).
// If the turn was aborted with Esc or completed, no model step follows: settle to idle.
// Deliberately not extended by terminal output: once a tool finishes, terminal activity is prompt redraw/typing.
const TOOL_SETTLE_WINDOW_MS = 15 * 1000;

/**
 * Derive from a row/live shape ({ lastStatus, lastStepType, lastRole, lastEntryAt }).
 *
 * `opts.lastOutputMs` = when this session's PTY last produced output (main.js tracks it). It can only
 * ever KEEP a turn busy past the staleness window, never start one.
 */
function deriveState(row, now = Date.now(), opts = {}) {
  if (!row) return null;

  const lastStatus = row.lastStatus == null ? null : Number(row.lastStatus);
  const lastStepType = row.lastStepType == null ? null : Number(row.lastStepType);

  if (lastStatus != null) {
    // 1. Canceled, interrupted, error, or waiting statuses are immediately idle (e.g. Esc on permission prompt)
    if (lastStatus === STEP_STATUS_CANCELED ||
        lastStatus === STEP_STATUS_INTERRUPTED ||
        lastStatus === STEP_STATUS_ERROR ||
        lastStatus === STEP_STATUS_WAITING ||
        lastStatus === 4 || lastStatus === 5 || lastStatus === 13) {
      return IDLE;
    }

    // 2. Actively running or generating step (status 2 = running tool/shell/subagent, 8 = model generating)
    if (STEP_STATUSES_ACTIVE.has(lastStatus) && STEP_TYPES_TURN.has(lastStepType)) {
      const lastMs = row.lastEntryAt ? Date.parse(row.lastEntryAt) : NaN;
      const stale = Number.isFinite(lastMs) && now - lastMs > ACTIVITY_WINDOW_MS;
      if (!stale) return BUSY;
      if (Number.isFinite(lastMs) && now - lastMs >= OUTPUT_LIVENESS_CEILING_MS) return IDLE;
      const out = Number(opts.lastOutputMs || 0);
      if (out && now - out <= OUTPUT_LIVENESS_MS) return BUSY;
      return IDLE;
    }

    // 3. Completed step (status 3 = done)
    if (lastStatus === STEP_STATUS_DONE) {
      // Lifecycle step -> definitively idle
      if (lastStepType === STEP_TYPE_TITLE || lastStepType === STEP_TYPE_HISTORY) {
        return IDLE;
      }
      // Model step completed: if it invoked a tool call, bridge until the tool executes;
      // otherwise it is the final response to the user -> settle to idle.
      if (lastStepType === STEP_TYPE_MODEL) {
        if (row.hasToolCall) {
          const lastMs = row.lastEntryAt ? Date.parse(row.lastEntryAt) : NaN;
          if (Number.isFinite(lastMs) && now - lastMs <= TOOL_SETTLE_WINDOW_MS) {
            return BUSY;
          }
        }
        return IDLE;
      }
      // User prompt (14) or incoming message (101): turn started, model owes an answer
      if (lastStepType === STEP_TYPE_USER || lastStepType === STEP_TYPE_MESSAGE) {
        const lastMs = row.lastEntryAt ? Date.parse(row.lastEntryAt) : NaN;
        const stale = Number.isFinite(lastMs) && now - lastMs > ACTIVITY_WINDOW_MS;
        if (!stale) return BUSY;
        if (Number.isFinite(lastMs) && now - lastMs >= OUTPUT_LIVENESS_CEILING_MS) return IDLE;
        const out = Number(opts.lastOutputMs || 0);
        if (out && now - out <= OUTPUT_LIVENESS_MS) return BUSY;
        return IDLE;
      }
      // Tool step (132, 9, etc.) completed: brief bridge window while model computes next response.
      // Settle to idle if no next step appears (e.g. aborted with Esc or prompt finished).
      if (STEP_TYPES_TOOL.has(lastStepType)) {
        const lastMs = row.lastEntryAt ? Date.parse(row.lastEntryAt) : NaN;
        if (Number.isFinite(lastMs) && now - lastMs <= TOOL_SETTLE_WINDOW_MS) {
          return BUSY;
        }
        return IDLE;
      }
    }

    // Any other status -> idle (safer than stuck on working)
    return IDLE;
  }

  // Fallback for legacy stores or scanned rows without status column
  const running = row.lastRole === 'user' || (row.lastRole !== 'assistant' && !row.lastStopReason);
  const lastMs = row.lastEntryAt ? Date.parse(row.lastEntryAt) : NaN;
  const stale = Number.isFinite(lastMs) && now - lastMs > ACTIVITY_WINDOW_MS;

  if (!running) return IDLE;
  if (!stale) return BUSY;
  if (Number.isFinite(lastMs) && now - lastMs >= OUTPUT_LIVENESS_CEILING_MS) return IDLE;
  const out = Number(opts.lastOutputMs || 0);
  if (out && now - out <= OUTPUT_LIVENESS_MS) return BUSY;
  return IDLE;
}

function stepHasToolCall(payload) {
  if (!payload) return false;
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const str = buf.toString('latin1');
  return /call_[a-zA-Z0-9]+/.test(str) && str.includes('{"');
}

/**
 * Read the conversation `.db` and report the status of its last step, which role wrote the last message
 * step, and the file mtime as the last-activity edge. Read-only, short-lived — the same discipline the
 * parser uses.
 *
 * SQLite is not tail-readable, so these are small targeted queries, not a re-parse.
 */
function readDbFacts(dbPath) {
  const d = driver();
  if (!d) return null;
  let db;
  try { db = d.open(dbPath); } catch { return null; }
  try {
    // The LAST step of any type, not only a message one: a tool step runs too, and "has this finished"
    // is the same question about it. A store with no `status` column reports none and the derivation
    // falls back to the role rule rather than the read failing.
    let lastStatus = null;
    let lastStepType = null;
    let hasToolCall = false;
    try {
      const s = db.get('SELECT step_type AS stepType, status AS status FROM steps ORDER BY idx DESC LIMIT 1');
      if (s) {
        if (s.status != null) lastStatus = Number(s.status);
        if (s.stepType != null) lastStepType = Number(s.stepType);
        if (lastStepType === 15) {
          try {
            const p = db.get('SELECT step_payload AS payload FROM steps ORDER BY idx DESC LIMIT 1');
            if (p && p.payload) hasToolCall = stepHasToolCall(p.payload);
          } catch { /* no step_payload column in test fixture */ }
        }
      }
    } catch { /* no status column -> stays null */ }

    const row = db.get(
      'SELECT step_type AS stepType FROM steps WHERE step_type IN (14, 15, 101) ORDER BY idx DESC LIMIT 1'
    );
    const lastRole = row ? (Number(row.stepType) === 15 ? 'assistant' : 'user') : null;
    let mtimeMs = 0;
    try { mtimeMs = require('fs').statSync(dbPath).mtimeMs; } catch { /* leave 0 */ }
    const lastEntryAt = mtimeMs ? new Date(mtimeMs).toISOString() : null;
    return { lastStatus, lastStepType, lastRole, lastEntryAt, hasToolCall };
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

// #282 lever 1: the DB read is gated on a cheap file signature. adopt.updateBackendLiveStates re-reads
// liveState on EVERY watcher flush (any backend), so a claimed agy session's `.db` was re-opened several
// times a second even when nothing in it had changed. Re-open only when the `.db` (or its `-wal`) actually
// moved; otherwise reuse the last-read facts. The DERIVATION always re-runs with a fresh `now`, so the
// time-based staleness edge — a wedged turn that stopped writing (#166), which no write ever signals — is
// unaffected: the 30 s busy ticker keeps driving it through this same cached-facts path.
const _factsCache = new Map();   // dbPath -> { sig, facts }
// Bounded so the memo can't grow with every distinct conversation `.db` ever seen live over the app's
// lifetime (#286) — the same FIFO cap folder-parse.js puts on its `_fileReadState`. An evicted entry just
// costs one full re-read next time; live sessions are far fewer than this.
const FACTS_CACHE_MAX = 256;

/**
 * Busy/idle from the conversation `.db`, opening it only when it changed since the last read.
 */
function deriveStateFromDb(dbPath, now = Date.now(), opts = {}) {
  const sig = dbSignature(dbPath);
  let entry = _factsCache.get(dbPath);
  if (!entry || entry.sig !== sig) {
    const facts = readDbFacts(dbPath);
    if (!facts) return null;   // locked/unreadable -> retry next flush, don't cache a miss
    entry = { sig, facts };
    _factsCache.set(dbPath, entry);
    if (_factsCache.size > FACTS_CACHE_MAX) _factsCache.delete(_factsCache.keys().next().value);
  }
  return deriveState(entry.facts, now, opts);
}

/** Test seam: drop the gate's memo so a fixture mutated in place is re-read. */
function _clearFactsCache() { _factsCache.clear(); }

module.exports = {
  deriveState, deriveStateFromDb, readDbFacts, _clearFactsCache,
  STEP_STATUS_RUNNING, STEP_STATUS_GENERATING, STEP_STATUS_DONE,
  STEP_STATUS_CANCELED, STEP_STATUS_INTERRUPTED,
  STEP_TYPE_USER, STEP_TYPE_MODEL, STEP_TYPE_MESSAGE, STEP_TYPES_TOOL,
  ACTIVITY_WINDOW_MS, OUTPUT_LIVENESS_MS, OUTPUT_LIVENESS_CEILING_MS, TOOL_SETTLE_WINDOW_MS,
  BUSY, IDLE,
};
