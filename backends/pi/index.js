// backends/pi/index.js — the Pi backend descriptor (Axis B: own binary, own store, own format).
//
// Recon on a REAL install: docs/plans/research/pi-format.md. Smoke-tested in a pty (T-6.0 = GO): the TUI
// paints in ~50ms, takes keystrokes, and then goes completely quiet — the cmux flicker loop (#3831) did
// not reproduce.
//
// Store: (PI_CODING_AGENT_SESSION_DIR || ~/.pi/agent/sessions)/<cwd-encoded>/<ISO>_<uuid>.jsonl — one
// file per session, so this is the FILE mode of the discovery seam, exactly the path Codex proved. The
// folder name encodes the cwd, but the session header carries it verbatim; we read it there and never
// parse the folder.
//
// Auth: Pi is multi-provider (it switched anthropic -> openai-codex mid-session in the recon). Keys are
// injected as `$VAR` refs, resolved at spawn, dropped when unset. Gotcha: a prior `pi /login` stores
// OAuth credentials that take PRIORITY over env vars, so an injected key can be silently shadowed.
//
// Windows: `pi` installs as an npm `.cmd` shim, so argv mode falls back to the shell (D3) — declared
// anyway, since resolveArgvExecutable() decides per machine.
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const parser = require('./parser');
const { deriveState, deriveStateFromFileTail } = require('./state');

let _root = null;

/**
 * The sessions root. `PI_CODING_AGENT_SESSION_DIR` overrides it — read from OUR env, which is not the
 * user's shell env; a per-invocation `--session-dir` is undiscoverable and simply cannot be tracked.
 */
function sessionsRoot() {
  if (_root) return _root;
  return process.env.PI_CODING_AGENT_SESSION_DIR
    || path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

function setRoot(dir) {
  _root = dir || null;
}

// Pi's own launch options (§4a). Kept to what the CLI is known to accept; more can be added as data.
const configFields = [
  { id: 'model', label: 'Model', type: 'text', default: '' },
];

/** Is pi actually installed? */
function findExecutable() {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map(e => e.trim()).filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, 'pi' + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

/** The version of the node ON PATH (`v22.22.0`), or null when there is none. */
function systemNodeVersion() {
  try {
    const out = execFileSync('node', ['--version'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const v = String(out).trim();
    return /^v?\d+\./.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Is a bash available? Pi shells out to one — on Windows that means Git Bash / WSL / Cygwin. */
function findBash() {
  if (process.platform !== 'win32') return '/bin/sh';   // a POSIX box always has one
  const candidates = [
    process.env.SHELL,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'bash.exe'),   // WSL
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* keep looking */ }
  }
  // Last resort: anything named bash on PATH.
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, 'bash.exe');
    try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * { ok, reason }. Pi has two undocumented dependencies — Node ≥ 22.19, and a bash on Windows — and a
 * launch without either dies in the terminal with nothing the user can act on. Say it here instead: the
 * spawn path refuses with this reason and Settings shows it (D15).
 */
function probe() {
  const exe = findExecutable();
  if (!exe) {
    return {
      ok: false,
      reason: 'The pi executable was not found. Install Pi (npm i -g @earendil-works/pi-coding-agent), or add it to PATH.',
    };
  }

  // The Node that matters is the one on PATH — that is what the npm shim runs pi under. NOT
  // `process.versions.node`: inside Electron that is the app's own embedded Node (22.x), so a machine
  // whose real node is 18 would sail through the check and then die raw in the terminal, and a machine
  // that IS too old would be told a version number it cannot find anywhere.
  const nodeVersion = systemNodeVersion();
  if (nodeVersion) {
    const [maj, min] = nodeVersion.replace(/^v/, '').split('.').map(Number);
    if (maj < 22 || (maj === 22 && min < 19)) {
      return { ok: false, reason: `Pi needs Node 22.19 or newer; the node on your PATH is ${nodeVersion}.` };
    }
  }
  // No node on PATH at all: pi's npm shim cannot run. (A future non-npm distribution would make this
  // wrong — revisit then; today the shim is how it ships.)
  if (!nodeVersion) {
    return { ok: false, reason: 'Pi runs on Node, and no node was found on your PATH. Install Node 22.19 or newer.' };
  }

  if (!findBash()) {
    return {
      ok: false,
      reason: 'Pi needs a bash shell, and none was found. Install Git for Windows (Git Bash) or enable WSL.',
    };
  }
  return { ok: true, exe };
}

/**
 * new:    `pi`
 * resume: `pi --session <id>`      (binary-bound, §5.11 — a Pi session never resumes into another CLI)
 * fork:   `pi --fork <id>`         — the sidebar offers Fork on every session row, and Pi supports it.
 *                                    Dropping `forkFrom` (as the first cut did) does not disable the
 *                                    button: it launches a plain `pi`, i.e. an empty session with no
 *                                    relation to the one the user forked. Silently wrong beats loudly
 *                                    missing, so it is wired.
 */
function buildLaunch({ cwd, resume, sessionId, forkFrom, options } = {}) {
  const opts = options || {};
  const fork = forkFrom != null ? forkFrom : opts.forkFrom;
  const args = [];

  if (fork) args.push('--fork', String(fork));
  else if (resume && sessionId) args.push('--session', String(sessionId));
  if (opts.model) args.push('--model', String(opts.model));

  // $VAR refs only — resolved at spawn, dropped when unset. We never read Pi's own credential files.
  // NOTE: a stored `pi /login` OAuth session takes priority over these, so an injected key can be
  // shadowed without any error.
  const env = {
    ANTHROPIC_API_KEY: '$ANTHROPIC_API_KEY',
    OPENAI_API_KEY: '$OPENAI_API_KEY',
  };

  return { command: 'pi', args, env, cwd, spawnMode: 'argv' };
}

/** Collect the session transcripts under the cwd-encoded folders (one level deep, but walk anyway). */
function walkSessions(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSessions(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

/** FILE-mode discovery: one {kind:'file'} handle per transcript. */
function discoverSessions() {
  const files = [];
  walkSessions(sessionsRoot(), files);
  return files.map(p => ({
    kind: 'file',
    path: p,
    // The filename carries the id too, but the header is authoritative — the parser reads it there.
    sessionId: null,
    parentSessionId: null,
    root: sessionsRoot(),
  }));
}

/** STORE-level watch target: the sessions root (a new cwd folder appears with the first session in it). */
function watchTargets() {
  return [{ kind: 'dir', path: sessionsRoot(), recursive: true }];
}

// --- LIVE-session hooks (the identity seam, D10/D17) ---
//
// Pi names its own session (a uuid in its header), so the id we launch under is not the id it records.
// `matchLiveSession` finds the transcript a freshly spawned session created; `liveRefFor` claims a
// RESUMED session's own transcript (which predates the spawn, so correlation could never find it).
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
    if (!row || !row.sessionId || !row.cwd) continue;
    if (cwd && path.resolve(row.cwd) !== path.resolve(cwd)) continue;
    if (birth < bestBirth) { best = { sessionId: row.sessionId, ref: handle.path }; bestBirth = birth; }
  }
  return best;
}

function liveRefFor(sessionId) {
  if (!sessionId) return null;
  // The filename ends in `_<uuid>.jsonl` — a readdir match, where parsing every transcript to compare
  // header ids would read the whole store.
  const suffix = `_${String(sessionId).toLowerCase()}.jsonl`;
  for (const handle of discoverSessions()) {
    if (handle.path && handle.path.toLowerCase().endsWith(suffix)) return handle.path;
  }
  return null;
}

// `ctx.lastOutputMs` = when this session's PTY last said anything (main.js). Used ONLY to keep a
// silent-but-running turn from being declared idle — never to declare one busy.
function liveState(ref, ctx = {}) {
  return deriveStateFromFileTail(ref, Date.now(), ctx);
}

module.exports = {
  id: 'pi',
  label: 'Pi',
  tier: 1,
  axis: 'B',
  status: 'ready',
  monogram: 'Pi',
  colour: 'pi',
  supportsFork: true,     // `pi --fork <id>`
  // Shown on the backend's settings page. Pi is the only backend where injecting a key can appear to
  // work and quietly do nothing: a stored `pi /login` OAuth session takes PRIORITY over the env vars we
  // pass, with no error. A user chasing "why is it still on the old account" has no way to see that from
  // inside Switchboard, so say it where they configure it.
  caveat: 'If you have run `pi /login`, its stored OAuth account takes priority over any API key passed in — Pi will use the logged-in account, not the key.',
  configFields,
  buildLaunch,
  probe,
  findExecutable,

  // the dual-mode seam, file side
  discoverSessions,
  parseSession: parser.parseSession,
  parseSessionIncremental: parser.parseSessionIncremental,
  PARSER_SCHEMA_VERSION: parser.PARSER_SCHEMA_VERSION,
  watchTargets,
  deriveState,
  matchLiveSession,
  liveRefFor,
  liveState,

  sessionsRoot,
  setRoot,
};
