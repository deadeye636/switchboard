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
const { createFileStore, findOnPath } = require('../file-store');
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

// Pi's own launch options (§4a) — taken from its real `--help` (#160).
//
// Deliberately NOT here:
//   `--api-key` — it would put a raw key on the COMMAND LINE, where every process listing on the machine
//     can read it. Pi reads its key from the environment; a template's env bundle ($VAR, resolved at
//     spawn, never written to disk) is the route for that, and the only one we will offer.
//   `--mode json|rpc`, `--print` — non-interactive modes; we run Pi in a terminal.
//   `--session-dir`, `--no-session`, `--session*` — they move or suppress the session store we watch.
const configFields = [
  { id: 'model', label: 'Model', type: 'text', default: '',
    description: 'Model pattern or id — supports "provider/id" and an optional ":<thinking>" suffix.' },
  { id: 'provider', label: 'Provider', type: 'text', default: '',
    description: 'Provider name. Empty = Pi\'s own default.' },
  { id: 'thinking', label: 'Thinking level', type: 'select',
    choices: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    choiceLabels: { '': 'Pi\'s default' },
    default: '',
    description: 'How hard the model thinks before answering.' },
  { id: 'tools', label: 'Tools (allowlist)', type: 'text', default: '',
    description: 'Comma-separated tool names to enable. Empty = all of them.' },
  { id: 'excludeTools', label: 'Tools (denylist)', type: 'text', default: '',
    description: 'Comma-separated tool names to disable. Applies to built-in, extension and custom tools.' },
  { id: 'appendSystemPrompt', label: 'Append to system prompt', type: 'text', default: '',
    description: 'Text (or a file path) appended to Pi\'s system prompt.' },
  { id: 'noContextFiles', label: 'Ignore AGENTS.md / CLAUDE.md', type: 'toggle', default: false,
    description: 'Do not load the project\'s context files for this session.' },
];

/** Is pi actually installed? */
function findExecutable() {
  return findOnPath('pi');
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
  return findOnPath('bash');
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
  if (opts.provider) args.push('--provider', String(opts.provider));
  if (opts.thinking) args.push('--thinking', String(opts.thinking));
  if (opts.tools) args.push('--tools', String(opts.tools));
  if (opts.excludeTools) args.push('--exclude-tools', String(opts.excludeTools));
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', String(opts.appendSystemPrompt));
  if (opts.noContextFiles) args.push('--no-context-files');

  // $VAR refs only — resolved at spawn, dropped when unset. We never read Pi's own credential files.
  // NOTE: a stored `pi /login` OAuth session takes priority over these, so an injected key can be
  // shadowed without any error.
  const env = {
    ANTHROPIC_API_KEY: '$ANTHROPIC_API_KEY',
    OPENAI_API_KEY: '$OPENAI_API_KEY',
  };

  return { command: 'pi', args, env, cwd, spawnMode: 'argv' };
}

// --- The file-store seam (discovery, watching, and the two identity hooks) ---
//
// Pi names its own session (a uuid in its header), so the id we launch under is not the id it records —
// the same problem Codex has, solved in the same place. backends/file-store.js owns the mechanics (#156);
// Pi declares only what is Pi's: the root, what a transcript is called, and how a filename names a session.
const store = createFileStore({
  root: sessionsRoot,
  matches: (name) => name.endsWith('.jsonl'),
  parseSession: parser.parseSession,
  // `<ISO>_<uuid>.jsonl`
  refSuffix: (sessionId) => `_${sessionId}.jsonl`,
});

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
  transcriptAccess: 'file',   // one JSONL per session
  // Shown on the backend's settings page. Pi is the only backend where injecting a key can appear to
  // work and quietly do nothing: a stored `pi /login` OAuth session takes PRIORITY over the env vars we
  // pass, with no error. A user chasing "why is it still on the old account" has no way to see that from
  // inside Switchboard, so say it where they configure it.
  caveat: 'If you have run `pi /login`, its stored OAuth account takes priority over any API key passed in — Pi will use the logged-in account, not the key.',
  configFields,
  buildLaunch,
  probe,
  findExecutable,

  // the dual-mode seam, file side (backends/file-store.js)
  discoverSessions: store.discoverSessions,
  parseSession: parser.parseSession,
  parseSessionIncremental: parser.parseSessionIncremental,
  PARSER_SCHEMA_VERSION: parser.PARSER_SCHEMA_VERSION,
  watchTargets: store.watchTargets,
  deriveState,
  matchLiveSession: store.matchLiveSession,
  liveRefFor: store.liveRefFor,
  liveState,

  sessionsRoot,
  setRoot,
};
