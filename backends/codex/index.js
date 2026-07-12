// backends/codex/index.js — the Codex backend descriptor (Axis B: its own binary, own store, own format).
//
// Recon: docs/plans/research/codex-cli-recon.md (live install v0.142.2). Smoke-tested in our node-pty/
// ConPTY stack (T-0.1 = GO): the interactive TUI renders and takes raw-ANSI keystrokes, and
// `codex resume` finds the TTY. Two things that bite on Windows:
//   - spawn via CLEAN ARGV (spawnMode 'argv'), not a shell-quoted string — shell quoting mangles it.
//   - a fresh cwd shows a one-time "Do you trust this directory?" prompt before the main TUI. That is
//     an interactive gate, not a hang; the user answers it in the terminal tab.
//
// Store: (CODEX_HOME || ~/.codex)/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl — date-bucketed, so
// discovery RECURSES and the live watcher must survive midnight rollover (T-4.8). Project grouping keys
// off session_meta.cwd (central derive-project-path), never the date directory.
//
// Auth: OPENAI_API_KEY / CODEX_API_KEY as `$VAR`, resolved at spawn. We NEVER read ~/.codex/auth.json.
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const parser = require('./parser');
const { deriveState, deriveStateFromFileTail } = require('./state');

// CODEX_HOME overrides the whole dir; default ~/.codex. Resolved lazily so an env change (or a test)
// is honoured, and overridable via setHome().
let _home = null;

function codexHome() {
  if (_home) return _home;
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function setHome(dir) {
  _home = dir || null;
}

function sessionsRoot() {
  return path.join(codexHome(), 'sessions');
}

// Codex's own launch options (00 §4a) — NOT interchangeable with Claude's (a permission mode means
// nothing here). Drives the generated Configure dialog + the per-backend Launch-defaults panel.
const configFields = [
  { id: 'model', label: 'Model', type: 'text', default: '' },
  { id: 'approvalMode', label: 'Approval', type: 'select',
    choices: ['untrusted', 'on-failure', 'on-request', 'never'], default: 'on-request' },
  { id: 'sandbox', label: 'Sandbox', type: 'select',
    choices: ['read-only', 'workspace-write', 'danger-full-access'], default: 'workspace-write' },
];

/**
 * Build the Codex launch. Returns CLEAN ARGV (spawnMode 'argv') — the recon warns Codex is happiest
 * with execFile-style argv and Windows shell quoting mangles it.
 *   new:    `codex`                      (interactive TUI; -C/--cd sets the root)
 *   resume: `codex resume <sessionId>`   (binary-bound, §5.11 — no cross-binary resume)
 */
function buildLaunch({ cwd, resume, sessionId, options } = {}) {
  const opts = options || {};
  const args = [];

  if (resume && sessionId) {
    args.push('resume', String(sessionId));
  }

  if (opts.model) args.push('-m', String(opts.model));
  if (opts.approvalMode) args.push('-a', String(opts.approvalMode));
  if (opts.sandbox) args.push('-s', String(opts.sandbox));

  // Auth as $VAR refs only — resolved at spawn by env-refs, dropped if unset. Never read auth.json.
  const env = {
    OPENAI_API_KEY: '$OPENAI_API_KEY',
    CODEX_API_KEY: '$CODEX_API_KEY',
  };

  return { command: 'codex', args, env, cwd, spawnMode: 'argv' };
}

/** Is codex actually installed? (npm ships it as a .cmd shim on Windows — that counts.) */
function findExecutable() {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map(e => e.trim()).filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, 'codex' + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * { ok, reason }. Without this, an enabled-but-not-installed Codex is offered in the picker and the
 * launch drops a raw `'codex' is not recognized...` into the tab — the exact failure the availability
 * gate exists to prevent (D15), which had been implemented for Hermes and Pi but not here.
 */
function probe() {
  const exe = findExecutable();
  if (!exe) {
    return {
      ok: false,
      reason: 'The codex executable was not found. Install Codex (npm i -g @openai/codex), or add it to PATH.',
    };
  }
  return { ok: true, exe };
}

/** Recursively collect rollout-*.jsonl under the date-bucketed sessions tree. */
function walkRollouts(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkRollouts(p, out);
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      out.push(p);
    }
  }
}

/** FILE-mode discovery: one {kind:'file'} handle per rollout. */
function discoverSessions() {
  const files = [];
  walkRollouts(sessionsRoot(), files);
  return files.map(p => ({
    kind: 'file',
    path: p,
    // The filename UUID == the session id, but the parser takes it from session_meta (authoritative).
    sessionId: null,
    parentSessionId: null,
    root: sessionsRoot(),
  }));
}

/** STORE-level watch target: the sessions root. The watcher (T-4.8) must handle the date-bucketed
 *  subtree (a new YYYY/MM/DD dir appears at midnight and on the first session of a day). */
function watchTargets() {
  return [{ kind: 'dir', path: sessionsRoot(), recursive: true }];
}

// --- LIVE-session hooks (the identity seam) ---
//
// Codex has no `--session-id`: it names its rollout with an id IT generates. So the id we launched the
// session under is not the id Codex records, and until the two are reconciled the app shows two rows
// for one session and resume targets an id Codex never had. `matchLiveSession` is how the main process
// finds the store record belonging to a session it just spawned; it then adopts that id.
//
// Correlate by CREATION time, not "most recently touched": Codex writes the rollout header at startup,
// so birth time is what lines up with the spawn. Picking the newest mtime would let an already-working
// session's file be stolen by an older session whose own file is still just a header.
function matchLiveSession({ cwd, sinceMs, claimed } = {}) {
  const claimedSet = claimed instanceof Set ? claimed : new Set(claimed || []);
  let best = null;
  let bestBirth = Infinity;
  for (const handle of discoverSessions()) {
    if (claimedSet.has(handle.path)) continue;
    let st;
    try { st = fs.statSync(handle.path); } catch { continue; }
    const birth = st.birthtimeMs || st.mtimeMs;
    if (sinceMs != null && birth < sinceMs) continue;
    const row = parser.parseSession(handle);
    if (!row || !row.cwd || !row.sessionId) continue;
    if (cwd && path.resolve(row.cwd) !== path.resolve(cwd)) continue;
    if (birth < bestBirth) { best = { sessionId: row.sessionId, ref: handle.path }; bestBirth = birth; }
  }
  return best;
}

/**
 * The RESUME half of the seam. `matchLiveSession` only considers records BORN after the spawn, which a
 * resumed session's rollout never is — it already existed. So a resumed session would never claim its
 * own record (no busy/idle, and a re-scan of the whole store on every watcher flush), and the stale
 * claim could later adopt the id of the next NEW session in the same cwd. On resume we already hold
 * Codex's own id: just locate that rollout.
 */
function liveRefFor(sessionId) {
  if (!sessionId) return null;
  // The rollout filename ends in the session's UUID (`rollout-<ts>-<uuid>.jsonl`) — matching on it costs
  // a readdir, where parsing every rollout to read session_meta would cost the whole store.
  const suffix = `-${String(sessionId).toLowerCase()}.jsonl`;
  for (const handle of discoverSessions()) {
    if (handle.path && handle.path.toLowerCase().endsWith(suffix)) return handle.path;
  }
  return null;
}

/** Busy/idle for a live session, from the store record `matchLiveSession` returned. */
function liveState(ref) {
  return deriveStateFromFileTail(ref);
}

module.exports = {
  id: 'codex',
  label: 'Codex',
  tier: 1,
  axis: 'B',
  status: 'ready',
  monogram: 'Cx',
  colour: 'codex',
  // Codex has no confirmed fork flag. Declaring false HIDES the Fork button for its sessions — the
  // alternative is what shipped before: the button stays, `forkFrom` is dropped in buildLaunch, and the
  // user gets a brand-new empty session that has nothing to do with the one they forked.
  supportsFork: false,
  slashCommands: true,   // /init /compact /review /model … plus skills (which become slash commands)
  configFields,
  buildLaunch,
  probe,
  findExecutable,
  discoverSessions,
  parseSession: parser.parseSession,
  parseSessionIncremental: parser.parseSessionIncremental,
  PARSER_SCHEMA_VERSION: parser.PARSER_SCHEMA_VERSION,
  watchTargets,
  deriveState,
  deriveStateFromFileTail,
  matchLiveSession,
  liveRefFor,
  liveState,
  setHome,
  sessionsRoot,
};
