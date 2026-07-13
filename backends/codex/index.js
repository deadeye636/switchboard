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

const parser = require('./parser');
const trust = require('./trust');
const { createFileStore, findOnPath } = require('../file-store');
const { rewriteTranscript, codexLine } = require('../rewrite-cwd');
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
// Codex' own launch options — taken from its real `--help` (#160).
//
// Deliberately NOT here: `-C/--cd` (we own the working directory), `--print`-style non-interactive
// subcommands, and `--dangerously-bypass-approvals-and-sandbox`, whose own help calls it "EXTREMELY
// DANGEROUS… intended solely for environments that are externally sandboxed". `sandbox:
// danger-full-access` already lets a user turn the sandbox off deliberately; a one-click toggle that
// removes approvals AND the sandbox at once is a different thing, and Switchboard is not that place.
const configFields = [
  { id: 'model', label: 'Model', type: 'text', default: '',
    description: 'Model the agent should use. Empty = Codex\' own default.' },
  { id: 'approvalMode', label: 'Approval', type: 'select',
    choices: ['untrusted', 'on-failure', 'on-request', 'never'], default: 'on-request',
    description: 'When Codex asks before running a command.' },
  { id: 'sandbox', label: 'Sandbox', type: 'select',
    choices: ['read-only', 'workspace-write', 'danger-full-access'], default: 'workspace-write',
    description: 'What model-generated commands may touch.' },
  { id: 'profile', label: 'Codex config profile', type: 'text', default: '',
    description: 'Codex\' OWN profile: layers $CODEX_HOME/<name>.config.toml over its base config. Not a Switchboard template.' },
  { id: 'search', label: 'Web search', type: 'toggle', default: false,
    description: 'Give the model Codex\' native web-search tool (no per-call approval).' },
  { id: 'oss', label: 'Local (open-source) provider', type: 'toggle', default: false,
    description: 'Run against a local model instead of the hosted one.' },
  { id: 'localProvider', label: 'Local provider', type: 'select',
    choices: ['', 'lmstudio', 'ollama'], choiceLabels: { '': 'Codex decides' }, default: '',
    description: 'Which local runtime to use. Only applies with the local provider above.' },
  { id: 'addDirs', label: 'Additional directories', type: 'text', default: '',
    description: 'Comma-separated extra directories Codex may write to, alongside the project.' },
  { id: 'configOverrides', label: 'Config overrides', type: 'text', default: '',
    description: 'Codex `-c key=value` overrides, comma-separated (e.g. reasoning.effort=high). Dotted paths address nested values.' },
];

/**
 * Build the Codex launch. Returns CLEAN ARGV (spawnMode 'argv') — the recon warns Codex is happiest
 * with execFile-style argv and Windows shell quoting mangles it.
 *   new:    `codex`                      (interactive TUI; -C/--cd sets the root)
 *   resume: `codex resume <sessionId>`   (binary-bound, §5.11 — no cross-binary resume)
 */
/** A comma-separated text field -> a list. Empty entries are dropped, not passed as empty flags. */
function splitList(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function buildLaunch({ cwd, resume, sessionId, options } = {}) {
  const opts = options || {};
  const args = [];

  if (resume && sessionId) {
    args.push('resume', String(sessionId));
  }

  if (opts.model) args.push('-m', String(opts.model));
  if (opts.approvalMode) args.push('-a', String(opts.approvalMode));
  if (opts.sandbox) args.push('-s', String(opts.sandbox));
  if (opts.profile) args.push('--profile', String(opts.profile));
  if (opts.search) args.push('--search');
  if (opts.oss) args.push('--oss');
  if (opts.localProvider) args.push('--local-provider', String(opts.localProvider));
  // Repeatable flags: one occurrence per value. Splitting on the comma is what makes a single text box
  // able to express a list — the same shape Claude's `addDirs` already uses.
  for (const dir of splitList(opts.addDirs)) args.push('--add-dir', dir);
  for (const kv of splitList(opts.configOverrides)) args.push('-c', kv);

  // Auth as $VAR refs only — resolved at spawn by env-refs, dropped if unset. Never read auth.json.
  const env = {
    OPENAI_API_KEY: '$OPENAI_API_KEY',
    CODEX_API_KEY: '$CODEX_API_KEY',
  };

  return { command: 'codex', args, env, cwd, spawnMode: 'argv' };
}

/** Is codex actually installed? (npm ships it as a .cmd shim on Windows — that counts.) */
function findExecutable() {
  return findOnPath('codex');
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

// --- The file-store seam (discovery, watching, and the two identity hooks) ---
//
// Codex has no `--session-id`: it names its rollout with an id IT generates, so the id we launched under
// is not the id Codex records. Pairing the two, watching the date-bucketed tree, and enumerating it are
// not Codex problems — they are FILE-STORE problems, and backends/file-store.js owns them (#156). What is
// Codex' own: where the store is, what a rollout is called, and how a filename names a session.
const store = createFileStore({
  root: sessionsRoot,
  matches: (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
  parseSession: parser.parseSession,
  // `rollout-<ISO>-<uuid>.jsonl`
  refSuffix: (sessionId) => `-${sessionId}.jsonl`,
});

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
  transcriptAccess: 'file',   // rollout JSONL on disk
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
  deriveStateFromFileTail,
  matchLiveSession: store.matchLiveSession,
  liveRefFor: store.liveRefFor,
  liveState,

  // Codex has its OWN trust gate — "Do you trust this directory?" on a fresh cwd — and it remembers the
  // answer in its config.toml, not in Claude's config (#171). Ticking "Trusted" in the project manager
  // used to write Claude's file and nothing else, so the column said trusted and Codex asked anyway.
  projectTrust: { get: trust.get, set: trust.set },

  // Codex writes its cwd ONCE, in the session_meta header. A remap that only rewrote Claude's
  // transcripts left Codex' sessions behind at the old path, as a phantom project.
  rewriteProjectPath: (filePath, oldPath, newPath) =>
    rewriteTranscript(filePath, oldPath, newPath, codexLine),

  setHome,
  sessionsRoot,
};
