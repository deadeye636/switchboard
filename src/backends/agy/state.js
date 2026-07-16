// backends/agy/state.js — busy/idle derivation for agy (Antigravity CLI).
//
// agy states nothing a file read can see: no lifecycle event in the DB, and its `--print` mode is
// mutually exclusive with the interactive TUI. So busy/idle is INFERRED, exactly as Pi's is (read the
// store, not the terminal):
//   last message step is a USER prompt (step_type 14)   -> a turn is running   (BUSY)
//   last message step is a MODEL message (step_type 15)  -> the turn finished   (IDLE)
//
// The one weaker point vs. Pi: agy's store has no timestamps, so "how long since the last write" is the
// `.db` file mtime, not an entry time. The rule and the safeguards are otherwise Pi's, kept identical on
// purpose (fix one, check its sibling): a crashed agy would leave a trailing user step and read busy for
// ever, so the activity window bounds it; a long silent turn would flip to idle early, so the PTY
// liveness signal keeps it alive — but only KEEPS it, never DECLARES it — under a ceiling so a wedged
// session heals itself whatever its TUI is painting (#166).
'use strict';

const { driver } = require('../sqlite-driver');

const BUSY = 'busy';
const IDLE = 'idle';

// Kept identical to Pi's — the same rule wants the same windows.
const ACTIVITY_WINDOW_MS = 3 * 60 * 1000;
const OUTPUT_LIVENESS_MS = 60 * 1000;
const OUTPUT_LIVENESS_CEILING_MS = 5 * ACTIVITY_WINDOW_MS;   // 15 minutes

/**
 * Derive from a row/live shape ({ lastRole, lastEntryAt }).
 *
 * `opts.lastOutputMs` = when this session's PTY last produced output (main.js tracks it). It can only
 * ever KEEP a turn busy past the staleness window, never start one.
 */
function deriveState(row, now = Date.now(), opts = {}) {
  if (!row) return null;

  // A trailing user step = a turn is running. Anything that is not an answered (assistant) turn, with no
  // stop reason, is also treated as running — the same shape Pi's parse-state form uses.
  const running = row.lastRole === 'user'
    || (row.lastRole !== 'assistant' && !row.lastStopReason);

  const lastMs = row.lastEntryAt ? Date.parse(row.lastEntryAt) : NaN;
  const stale = Number.isFinite(lastMs) && now - lastMs > ACTIVITY_WINDOW_MS;

  if (!running) return IDLE;
  if (!stale) return BUSY;

  // Silent past the ceiling: over, whatever the terminal is doing (#166).
  if (Number.isFinite(lastMs) && now - lastMs >= OUTPUT_LIVENESS_CEILING_MS) return IDLE;

  const out = Number(opts.lastOutputMs || 0);
  if (out && now - out <= OUTPUT_LIVENESS_MS) return BUSY;    // still working, just not writing
  return IDLE;
}

/**
 * Read the conversation `.db` and report which role wrote the last message step, plus the file mtime as
 * the last-activity edge. Then derive. Read-only, short-lived — the same discipline the parser uses.
 *
 * SQLite is not tail-readable, so this is a small targeted query (last 14/15 step), not a re-parse.
 */
function deriveStateFromDb(dbPath, now = Date.now(), opts = {}) {
  const d = driver();
  if (!d) return null;
  let db;
  try { db = d.open(dbPath); } catch { return null; }
  try {
    const row = db.get(
      'SELECT step_type AS stepType FROM steps WHERE step_type IN (14, 15) ORDER BY idx DESC LIMIT 1'
    );
    const lastRole = row ? (Number(row.stepType) === 14 ? 'user' : 'assistant') : null;
    let mtimeMs = 0;
    try { mtimeMs = require('fs').statSync(dbPath).mtimeMs; } catch { /* leave 0 */ }
    const lastEntryAt = mtimeMs ? new Date(mtimeMs).toISOString() : null;
    return deriveState({ lastRole, lastEntryAt }, now, opts);
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

module.exports = {
  deriveState, deriveStateFromDb,
  ACTIVITY_WINDOW_MS, OUTPUT_LIVENESS_MS, OUTPUT_LIVENESS_CEILING_MS,
  BUSY, IDLE,
};
