// backends/hermes/index.js — the Hermes backend descriptor (Axis B, and the FIRST non-file backend).
//
// Hermes is the reason the discovery seam is dual-mode: its history lives in SQLite, not in files. All
// the db-specific work sits in reader.js; this file is the thin descriptor over it.
//
// Recon (docs/plans/research/hermes-format.md — from a REAL install, not web inference):
//   - Store: %LOCALAPPDATA%\hermes (HERMES_HOME overrides; ~/.hermes only on Linux/WSL). state.db is WAL.
//   - The binary is a real .exe (not an npm shim), so argv-mode spawn genuinely applies here.
//   - The TUI drives fine in our node-pty/ConPTY stack (smoke-tested) — BUT it takes ~12s to become
//     usable (heavy Python import). A freshly launched tab looks dead for ~10s; that is not a failure.
//
// Auth: Hermes self-authenticates from its OWN ~/.hermes/.env or OAuth. We inject NOTHING and we never
// read its credential files — the same stance we take with Codex's auth.json.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const reader = require('./reader');
const { deriveState } = require('./state');

// Hermes' own launch options. Deliberately small: its model/provider config lives in its own
// config.yaml, and we do not want to fight it.
const configFields = [
  { id: 'model', label: 'Model', type: 'text', default: '' },
];

/**
 * Is Hermes actually installed? The recon showed it ships its OWN venv + uv, so probing for a system
 * Python/git would give a false negative — the honest probe is simply "does the executable resolve?".
 */
function findExecutable() {
  // 1. A hermes on PATH (any platform).
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map(e => e.trim()).filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, 'hermes' + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  // 2. The install's own venv, which is where the Windows installer puts it.
  const venv = path.join(reader.hermesHome(), 'hermes-agent', 'venv', 'Scripts',
    process.platform === 'win32' ? 'hermes.exe' : 'hermes');
  try { if (fs.statSync(venv).isFile()) return venv; } catch { /* not there */ }
  return null;
}

/** { ok, reason } — gates whether we offer Hermes for launch at all. */
function probe() {
  const exe = findExecutable();
  if (!exe) return { ok: false, reason: 'The hermes executable was not found. Install Hermes, or add it to PATH.' };
  return { ok: true, exe };
}

/**
 * Hermes launch. It is a real executable, so we ask for argv-mode spawn (no shell in between).
 * Resume: `hermes -r <id>` continues a specific session (`-c` continues the last one).
 * We inject NO auth env — see the note at the top of this file.
 */
function buildLaunch({ cwd, resume, sessionId, options } = {}) {
  const opts = options || {};
  const args = [];

  if (resume && sessionId) args.push('-r', String(sessionId));
  if (opts.model) args.push('--model', String(opts.model));

  const exe = findExecutable();

  return {
    command: exe || 'hermes',
    args,
    env: {},          // Hermes self-auths from its own .env/OAuth — inject nothing.
    cwd,
    spawnMode: 'argv',
  };
}

// --- LIVE-session hooks (the identity seam) ---
//
// Same problem Codex has, one layer down: Hermes creates its own session id in its DB, so the id we
// launched under is not the id it records. The main process uses these two hooks to find the store
// record for a session it just spawned, adopt that id, and then read busy/idle from it. Correlating by
// EARLIEST start (not latest activity) pairs sessions with their records in launch order.
function matchLiveSession({ cwd, sinceMs, claimed } = {}) {
  const claimedSet = claimed instanceof Set ? claimed : new Set(claimed || []);
  let best = null;
  let bestStart = Infinity;
  for (const handle of reader.discoverSessions()) {
    if (claimedSet.has(handle.sessionId)) continue;
    const row = reader.parseSession(handle);
    if (!row || !row.sessionId) continue;
    const startMs = row.startedAt ? Date.parse(row.startedAt) : NaN;
    if (!Number.isFinite(startMs)) continue;
    if (sinceMs != null && startMs < sinceMs) continue;
    if (cwd && row.cwd && path.resolve(row.cwd) !== path.resolve(cwd)) continue;
    if (cwd && !row.cwd) continue;   // a cwd-less session is not the one we just launched in a project
    if (startMs < bestStart) { best = { sessionId: row.sessionId, ref: row.sessionId }; bestStart = startMs; }
  }
  return best;
}

/** Busy/idle for a live session: re-read its row (the watcher fires on every WAL commit). */
function liveState(ref) {
  const row = reader.parseSession({ kind: 'db', sessionId: ref });
  if (!row) return null;
  return deriveState(row);
}

module.exports = {
  id: 'hermes',
  label: 'Hermes',
  tier: 1,
  axis: 'B',
  status: 'ready',
  monogram: 'H',
  colour: 'hermes',
  configFields,
  buildLaunch,
  probe,
  findExecutable,

  // --- the dual-mode seam, db side ---
  discoverSessions: reader.discoverSessions,
  parseSession: reader.parseSession,
  watchTargets: reader.watchTargets,
  deriveState,
  matchLiveSession,
  liveState,
  PARSER_SCHEMA_VERSION: reader.PARSER_SCHEMA_VERSION,

  // Sessions with no cwd (gateway/cron chats — a general agent genuinely has no working dir) group into
  // a backend-scoped bucket rather than being forced under a project (§5.9). The store root is a real
  // path, so the Projects view handles it like any other.
  sessionBucketPath: () => reader.hermesHome(),

  setHome: reader.setHome,
  dbPath: reader.dbPath,
};
