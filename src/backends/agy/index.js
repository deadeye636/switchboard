// backends/agy/index.js — the Antigravity CLI (`agy`) backend descriptor (Axis B: own binary, own store).
//
// agy is Google's successor to the retired Gemini CLI — a single Go binary at %LOCALAPPDATA%\agy\bin\
// agy.exe (a REAL .exe on PATH, not a .cmd shim). It signs in with a Google account and imports an
// existing ~/.gemini config on first run, which is why its data lives UNDER ~/.gemini, not ~/.agy.
//
// Store: ~/.gemini/antigravity-cli/conversations/<conversation-id>.db — one SQLite DB per conversation.
// So this is a FILE-mode backend (one transcript file per session) and composes backends/file-store.js
// for discovery/watching/identity, exactly like Codex and Pi — but the file's CONTENT is a database, so
// the parser reads it with the shared dual SQLite driver, the way Hermes reads its store.
//
// Recon: docs/backend-formats.md "agy (Antigravity CLI)" + `agy --help` / `agy models` on a real
// install (v1.1.1). Everything the parser does is documented there.
'use strict';

const os = require('os');
const path = require('path');

const parser = require('./parser');
const { createFileStore, findOnPath } = require('../file-store');
const { deleteTranscripts } = require('../delete-sessions');
const { deriveState, deriveStateFromDb } = require('./state');

// The store root. agy documents no env override (it imports ~/.gemini and writes there), so the path is
// fixed; `setRoot()` exists only so a test can point it at a fixture dir. Resolved lazily — the root can
// move under a test between calls.
let _root = null;

function conversationsRoot() {
  if (_root) return _root;
  // SWITCHBOARD_STORE_AGY isolates our scan (demo/sandbox — scripts/demo-start.js); it names the
  // conversations dir directly (agy has no CLI env for it).
  return process.env.SWITCHBOARD_STORE_AGY
    || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
}

function setRoot(dir) {
  _root = dir || null;
}

// agy's own launch options — taken from its real `agy --help` (v1.1.1). The model choices are exactly
// what `agy models` lists (they are also the display strings the store records), so `--model` is fed a
// value the CLI itself printed.
//
// Deliberately NOT here: `--dangerously-skip-permissions` — its own help calls it "Auto-approve all tool
// permission requests without prompting". This is the same stance Switchboard takes on Codex'
// `--dangerously-bypass-approvals-and-sandbox`: a one-click toggle that removes every permission prompt
// is a different thing from configuring a sandbox mode, and Switchboard is not the place to offer it.
// Also left out: `--project`/`--new-project`/`--agent` (agy's own project/agent selection, orthogonal to
// how Switchboard groups a cwd), and `--print`/`--prompt`/`-i` (non-interactive — we run the TUI).
const MODEL_CHOICES = [
  '',
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.1 Pro (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
];

const configFields = [
  { id: 'model', label: 'Model', type: 'select',
    choices: MODEL_CHOICES, choiceLabels: { '': 'agy\'s own default' }, default: '',
    description: 'Model the agent should use — the list `agy models` prints. Empty = agy\'s own default.' },
  { id: 'mode', label: 'Execution mode', type: 'select',
    choices: ['', 'accept-edits', 'plan'], choiceLabels: { '': 'agy\'s default' }, default: '',
    description: 'accept-edits auto-applies file edits; plan makes it plan without acting. Empty = agy\'s default.' },
  { id: 'sandbox', label: 'Sandbox', type: 'toggle', default: false,
    description: 'Run with terminal restrictions enabled (agy\'s `--sandbox`).' },
  { id: 'addDirs', label: 'Additional directories', type: 'text', default: '',
    description: 'Comma-separated extra directories to add to the workspace, alongside the project.' },
];

/** A comma-separated text field -> a list. Empty entries are dropped, not passed as empty flags. */
function splitList(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Build the agy launch. Returns CLEAN ARGV (spawnMode 'argv') — agy is a real .exe, so it spawns
 * directly (no .cmd shim, no shell), and shell quoting would only mangle its arguments.
 *   new:    `agy`                          (interactive TUI)
 *   resume: `agy --conversation <id>`      (binary-bound, §5.11 — no cross-binary resume)
 *
 * Fork is NOT supported (supportsFork: false): agy has no fork flag, and `forkFrom` is ignored so the
 * Fork button never launches an unrelated session in its place.
 */
function buildLaunch({ cwd, resume, sessionId, options } = {}) {
  const opts = options || {};
  const args = [];

  if (resume && sessionId) {
    args.push('--conversation', String(sessionId));
  }

  if (opts.model) args.push('--model', String(opts.model));
  if (opts.mode) args.push('--mode', String(opts.mode));
  if (opts.sandbox) args.push('--sandbox');
  for (const dir of splitList(opts.addDirs)) args.push('--add-dir', dir);

  // agy authenticates itself from its own Google sign-in (imported ~/.gemini). We inject nothing and
  // never read its credential files — the same stance as Hermes.
  return { command: 'agy', args, env: {}, cwd, spawnMode: 'argv' };
}

/** Is agy actually installed? On Windows it is a real `agy.exe` on PATH (not a .cmd shim). */
function findExecutable() {
  return findOnPath('agy');
}

/**
 * { ok, reason }. Without this, an enabled-but-not-installed agy is offered in the picker and the launch
 * drops a raw `'agy' is not recognized...` into the tab — the failure D15 exists to prevent.
 */
function probe() {
  const exe = findExecutable();
  if (!exe) {
    return {
      ok: false,
      reason: 'The agy executable was not found. Install the Antigravity CLI and add agy to PATH.',
    };
  }
  return { ok: true, exe };
}

// --- the file-store seam (discovery, watching, and the two identity hooks) ---
//
// agy names its own conversation (the `.db` basename), so the id we launch under is not the id it
// records — the same problem Codex and Pi have, solved in the same place (#156). agy declares only what
// is its own: where the store is, what a transcript file is called, and how a filename names a session.
const store = createFileStore({
  root: conversationsRoot,
  matches: (name) => name.endsWith('.db'),
  parseSession: parser.parseSession,
  // `<conversation-id>.db`
  refSuffix: (sessionId) => `${sessionId}.db`,
});

/** Busy/idle for a live session, read from the conversation DB `matchLiveSession` returned. */
function liveState(ref, ctx = {}) {
  return deriveStateFromDb(ref, Date.now(), ctx);
}

module.exports = {
  id: 'agy',
  label: 'Antigravity CLI',
  description: "Google's terminal coding agent.",   // shown in the Backends settings list (#212)
  tier: 1,
  axis: 'B',
  status: 'ready',
  monogram: 'Ag',
  colour: 'agy',
  // No confirmed fork flag — declaring false HIDES the Fork button for agy's sessions rather than
  // launching an unrelated empty session when it is pressed.
  supportsFork: false,
  // Lineage (#193): agy's `.db` has a `parent_references` table, but it is an unschema'd protobuf blob and
  // no forked/parent agy conversation was available to reverse-engineer what it points at. Declares none
  // until the reference is verified against a real forked trajectory (honest gap).
  resolveLineage: () => null,
  // agy keeps sessions in per-conversation SQLite DBs — row.filePath if the row has one, else null (#211).
  transcriptPathFor: (row) => (row && row.filePath) || null,
  // agy keeps no plans store (#227).
  plansDir: () => null,
  // agy's per-project instruction file is GEMINI.md (#227) — it used to be guessed under Claude's branch.
  memorySources: (scope) => {
    if (!scope || !scope.projectPath) return [];
    const short = require('../../session/derive-project-path').projectShortName(scope.projectPath);
    return [{ kind: 'file', path: path.join(scope.projectPath, 'GEMINI.md'), displayPath: short + '/', source: 'project' }];
  },
  // The `.db` is a binary SQLite/protobuf file, NOT a text transcript — so it EXPORTS its messages (like
  // Hermes) rather than being read as JSONL. It is still discovered as a file (the file store scans,
  // watches and reconciles it), but the viewer and the handoff read it through `readMessages`, never the
  // raw path. Leaving it as 'file' let read-session-jsonl hand the binary blob to the JSONL reader and
  // the handoff to a fresh agent.
  transcriptAccess: 'export',
  configFields,
  buildLaunch,
  probe,
  findExecutable,

  // No `usage` capability (#191). agy's quota is per-MODEL with no clean local file (unlike Codex's
  // token_count), so a real usage bar would need a network fetch — a follow-up. It ships `ready` without
  // one, like Hermes and Pi.

  // The transcript viewer + handoff read the conversation through here (transcriptAccess: 'export'), not
  // off the binary `.db`. `readMessages` takes the file path, so the sessionId is resolved to its `.db`
  // via the file store's own suffix match (the same map resume uses).
  readMessages: (sessionId, opts) => {
    const ref = store.liveRefFor(sessionId);
    return ref ? parser.readMessages(ref, opts) : [];
  },

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

  // agy's transcripts are files, so "Delete this project's sessions" can hand them over; the guard keeps
  // a delete inside the store it belongs to. No `rewriteProjectPath`: the cwd is embedded in a protobuf
  // blob (a length-delimited `file://` URI), and rewriting it to a different-length path in place would
  // corrupt the DB — so agy declares none, the honest answer (like Hermes), and the project manager shows
  // that rather than offering a remap that cannot work.
  deleteSessions: (filePaths) => deleteTranscripts(filePaths, conversationsRoot()),

  conversationsRoot,
  setRoot,
};
