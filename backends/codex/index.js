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

module.exports = {
  id: 'codex',
  label: 'Codex',
  tier: 1,
  axis: 'B',
  status: 'ready',
  monogram: 'Cx',
  colour: 'codex',
  configFields,
  buildLaunch,
  discoverSessions,
  parseSession: parser.parseSession,
  parseSessionIncremental: parser.parseSessionIncremental,
  PARSER_SCHEMA_VERSION: parser.PARSER_SCHEMA_VERSION,
  watchTargets,
  deriveState,
  deriveStateFromFileTail,
  setHome,
  sessionsRoot,
};
