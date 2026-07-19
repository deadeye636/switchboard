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
const path = require('path');

const reader = require('./reader');
const { findOnPath } = require('../file-store');
const { deriveState } = require('./state');

// Hermes' own launch options — taken from its real `--help` (#160), not from its docs.
//
// The old comment here claimed the list was "deliberately small" because Hermes' config lives in its own
// config.yaml. That was half true and wholly misleading: Hermes self-authenticates and we inject no env,
// but it takes a dozen meaningful FLAGS, and declaring one of them meant a user could not configure it
// from Switchboard at all. Everything below is a top-level flag Hermes accepts on the interactive path.
//
// Deliberately NOT here: `--cli` / `--tui` (we run it in a PTY — its interactive mode is the whole
// point), `-z <prompt>` (the non-interactive one-shot; an earlier note here called it `-q/--query`, which
// its real `--help` does not have), and anything that moves its session store (we would then be watching
// the wrong place).
const configFields = [
  { id: 'model', label: 'Model', type: 'text', default: '',
    description: 'Model to use, e.g. anthropic/claude-sonnet-4. Empty = Hermes decides (config.yaml).' },
  { id: 'provider', label: 'Provider', type: 'text', default: '',
    description: 'Inference provider. Built-in, or a name you defined under `providers:` in Hermes\' config.yaml. Empty = auto.' },
  { id: 'toolsets', label: 'Toolsets', type: 'text', default: '',
    description: 'Comma-separated toolsets to enable for the session.' },
  { id: 'skills', label: 'Skills', type: 'text', default: '',
    description: 'Preload one or more skills, comma-separated.' },
  { id: 'worktree', label: 'Git worktree', type: 'toggle', default: false,
    description: 'Run in an isolated git worktree — for several agents on the same repo at once.' },
  { id: 'checkpoints', label: 'Checkpoints', type: 'toggle', default: false,
    description: 'Snapshot files before destructive operations, so /rollback can undo them.' },
  { id: 'safeMode', label: 'Safe mode', type: 'toggle', default: false,
    description: 'Hermes\' own restricted mode.' },
  { id: 'acceptHooks', label: 'Auto-accept hooks', type: 'toggle', default: false,
    description: 'Approve unseen shell hooks from config.yaml without prompting. Only for hooks you trust.' },
  { id: 'yolo', label: 'Bypass approvals (yolo)', type: 'toggle', default: false,
    description: 'Runs dangerous commands without asking. Hermes calls this "at your own risk", and so do we.' },
];

/**
 * Is Hermes actually installed? The recon showed it ships its OWN venv + uv, so probing for a system
 * Python/git would give a false negative — the honest probe is simply "does the executable resolve?".
 */
function findExecutable() {
  // 1. A hermes on PATH (any platform).
  const onPath = findOnPath('hermes');
  if (onPath) return onPath;
  // 2. The install's own venv, which is where the Windows installer puts it. Hermes is a db backend, so
  //    it composes nothing else from file-store.js — but PATH resolution is PATH resolution.
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
  if (opts.provider) args.push('--provider', String(opts.provider));
  if (opts.toolsets) args.push('--toolsets', String(opts.toolsets));
  if (opts.skills) args.push('--skills', String(opts.skills));
  if (opts.worktree) args.push('--worktree');
  if (opts.checkpoints) args.push('--checkpoints');
  if (opts.safeMode) args.push('--safe-mode');
  if (opts.acceptHooks) args.push('--accept-hooks');
  if (opts.yolo) args.push('--yolo');

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

/**
 * The RESUME half of the identity seam. `matchLiveSession` looks for a record that appeared AFTER we
 * spawned — which is right for a new session and impossible for a resumed one: `hermes -r <id>`
 * continues an existing row whose `started_at` long predates the relaunch. Without this hook a resumed
 * session would never find its record (so busy/idle would never fire, and the search would be re-run on
 * every watcher flush), and worse: the next NEW session in the same cwd is "newer than our launch", so
 * the stale claim would adopt ITS id and collapse two tabs onto one identity.
 *
 * On resume we already hold the backend's own id, so no correlation is needed — just confirm the store
 * really has that record.
 */
function liveRefFor(sessionId) {
  if (!sessionId) return null;
  const row = reader.parseSession({ kind: 'db', sessionId });
  return row && row.sessionId ? row.sessionId : null;
}

/**
 * Busy/idle for a live session: re-read its row (the watcher fires on every WAL commit).
 *
 * `ctx.lastOutputMs` matters here too (D21). Hermes states only that a session ENDED (`ended_at`); it
 * never says "I am working". Busy is inferred from "no end + recent messages", so a turn that thinks or
 * runs a tool for longer than the activity window without writing a message would read as idle while it
 * works. The PTY stream says whether the process is still talking — used only to keep such a turn out of
 * idle, never to declare one busy.
 */
function liveState(ref, ctx = {}) {
  // `readLiveState`, not `parseSession`: this fires on every WAL commit, and busy/idle needs two columns
  // — not the 500-message text pull and the metrics GROUP BY a full parse does (#155).
  const row = reader.readLiveState(ref);
  if (!row) return null;
  return deriveState(row, Date.now(), ctx);
}

// Where the CLI ITSELF writes (#241). Our scan override and the CLI's own env name the same thing here
// (the home dir holding state.db), so isolation is a straight hand-over. Null unless isolated.
function cliHomeEnv() {
  const store = process.env.SWITCHBOARD_STORE_HERMES;
  if (!store) return null;
  return { HERMES_HOME: store };
}

module.exports = {
  id: 'hermes',
  cliHomeEnv,
  label: 'Hermes',
  description: 'General AI agent with its own session store.',   // shown in the Backends settings list (#212)
  tier: 1,
  axis: 'B',
  status: 'ready',
  monogram: 'H',
  colour: 'hermes',
  supportsFork: false,   // no confirmed fork flag — do not offer what we cannot do (see codex/index.js)
  supportsSubagents: false,   // no subagent concept (#230)
  // Lineage (#193): Hermes records a real parent in its store (`parent_session_id`), which the reader
  // surfaces as `lineageParentRef`. A hard link.
  resolveLineage: (row) => (row && row.lineageParentRef ? { lineageParentId: row.lineageParentRef, lineageKind: 'parent' } : null),
  // Hermes sessions are rows in state.db, not files — there is no transcript path (#211).
  transcriptPathFor: (row) => (row && row.filePath) || null,
  // Hermes keeps no plans store and no per-project instruction files (#227).
  plansDir: () => null,
  memorySources: () => [],
  // No `deleteSessions` and no `rewriteProjectPath`: its sessions are rows in a database Switchboard
  // opens read-only and may never write (#2914). The Remove dialog offers no switch for Hermes and shows
  // this sentence instead of a control that could not do anything.
  deleteBlockedReason: 'its history lives in a database Switchboard may only read',
  // Its history is in SQLite: there IS no file another agent could open. Switchboard exports the
  // messages to a temp file when a fresh agent is asked to read this session. Any future db-backed
  // backend declares the same and gets the same treatment.
  transcriptAccess: 'export',
  // Hermes loads a heavy Python stack before its TUI paints — measured at ~12s on a warm machine
  // (T-5.0). Said out loud, because a silent black tab for 12 seconds reads as a crash.
  startupHint: 'Starting Hermes — its TUI takes about 10-15 seconds to appear.',
  // ...and until it HAS appeared it cannot take input. A handoff packet pasted into a Python process
  // that has not built its input loop yet is simply lost, so the seeding path waits this long before it
  // even starts looking for the terminal to settle (#148). Our own startup hint counts as output, so
  // "the terminal went quiet" is not a usable readiness signal here on its own.
  seedGraceMs: 20000,
  configFields,
  buildLaunch,
  probe,
  findExecutable,

  // --- the dual-mode seam, db side ---
  discoverSessions: reader.discoverSessions,
  parseSession: reader.parseSession,
  watchTargets: reader.watchTargets,
  // A db-store backend has no transcript file, so it supplies its messages directly — this is what
  // makes "View messages" and the handoff pre-fill work for it (#148).
  readMessages: reader.readMessages,
  deriveState,
  matchLiveSession,
  liveRefFor,
  liveState,
  PARSER_SCHEMA_VERSION: reader.PARSER_SCHEMA_VERSION,

  // No `projectTrust` (its config.yaml has no per-project trust gate — `trust_recent_files` is about
  // files, not projects) and no `rewriteProjectPath`: a Hermes session's cwd is a COLUMN in state.db,
  // which we open read-only and may never write (#2914). A remap therefore cannot move its sessions, and
  // the project manager says so instead of silently leaving them behind (#171).

  // Sessions with no cwd (gateway/cron chats — a general agent genuinely has no working dir) group into
  // a backend-scoped bucket rather than being forced under a project (§5.9). The store root is a real
  // path, so the Projects view handles it like any other.
  sessionBucketPath: () => reader.hermesHome(),

  setHome: reader.setHome,
  dbPath: reader.dbPath,
};
