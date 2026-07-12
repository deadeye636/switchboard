// backends/claude.js — the Claude Code backend descriptor (the default; status 'ready').
//
// A THIN ADAPTER (00 §4, 02-file-map): Claude's heavy parse/state/discovery logic already lives in
// the existing hot-path modules that the other forks rewrote, so we do NOT move them into a folder
// (pure merge pain). This descriptor just points at them:
//   - buildLaunch  reproduces the inline claude-arg logic (main.js:3052-3086) byte-identically.
//   - discoverSessions  = FILE mode over ~/.claude/projects (reuses enumerateSessionFiles).
//   - parseSession({kind:'file'})  delegates to read-session-file.js.
//   - deriveState  is null — Claude's busy/idle comes from the existing session-transitions folder
//     watch (detectSessionTransitions), not a per-event function.
//   - watchTargets  = the projects dir root(s).
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { readSessionFile, enumerateSessionFiles } = require('../read-session-file');

// Claude's session store root. Defaults to ~/.claude/projects; main.js overrides it with its own
// PROJECTS_DIR at init (and tests point it at a fixture) via setRoots().
let _roots = [path.join(os.homedir(), '.claude', 'projects')];

function setRoots(roots) {
  if (Array.isArray(roots) && roots.length) _roots = roots.slice();
}

// The per-CLI launch-option schema (00 §4a) — drives the generated Configure dialog (T-3.8) and the
// per-backend "Launch defaults" panel (T-2.6). Declarative only in Phase 1; buildLaunch below keeps
// today's exact two-field permission logic for byte-identical Claude behaviour.
// Claude's launch options — the schema the Settings "Launch defaults" panel and the Configure dialog
// are both generated from (§4a). These option ids are the ones the spawn path already speaks, so a
// stored default and a one-off override are the same vocabulary.
//
// `dangerously-skip` is a CHOICE of permissionMode here rather than a separate boolean: they are
// mutually exclusive in the CLI (`--dangerously-skip-permissions` wins over `--permission-mode`), and
// two controls for one decision is how you end up with a UI that can express "plan AND skip".
const configFields = [
  // The full set the CLI accepts (as offered by the old Sessions & CLI form), plus the skip flag as a
  // mutually-exclusive choice. 'default' = send no --permission-mode at all.
  { id: 'permissionMode', label: 'Permission mode', type: 'select',
    choices: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions', 'dangerously-skip'],
    choiceLabels: {
      'default': 'Default — ask each time',
      'acceptEdits': 'Accept Edits — auto file edits',
      'plan': 'Plan — read-only',
      'auto': 'Auto — auto-approve (preview)',
      'dontAsk': "Don't Ask — auto-deny unless allowed",
      'bypassPermissions': 'Bypass — skip all prompts',
      'dangerously-skip': 'Dangerous Skip — skip every safety prompt',
    },
    default: 'default' },
  { id: 'model', label: 'Model', type: 'text', default: '' },
  { id: 'worktree', label: 'Git worktree', type: 'toggle', default: false },
  { id: 'worktreeName', label: 'Worktree branch name', type: 'text', default: '' },
  { id: 'chrome', label: 'Chrome', type: 'toggle', default: false },
  { id: 'addDirs', label: 'Additional directories', type: 'text', default: '' },
  { id: 'preLaunchCmd', label: 'Pre-launch command', type: 'text', default: '' },
  { id: 'mcpEmulation', label: 'IDE emulation (MCP bridge)', type: 'toggle', default: true },
  { id: 'afkTimeoutSec', label: 'AskUserQuestion timeout (s)', type: 'number', default: '' },
];

// Build the Claude argv exactly as main.js:3052-3086 does today. Returns a clean argv array (the
// spawn path shell-quotes it via quoteArgvForShell); the `claude` binary + spawnMode:'shell' match
// today's path. MCP `--ide`, preLaunchCmd prefixing and env injection stay at the spawn site
// (they depend on the started MCP server + live settings) — this only owns the base arg logic.
function buildLaunch({ cwd, resume, sessionId, forkFrom, options } = {}) {
  const opts = options || {};
  const fork = forkFrom != null ? forkFrom : opts.forkFrom;
  const args = [];

  if (fork) {
    args.push('--resume', String(fork), '--fork-session');
  } else if (!resume) {
    args.push('--session-id', String(sessionId));
  } else {
    args.push('--resume', String(sessionId));
  }

  // The descriptor owns the translation (§4a). `permissionMode: 'dangerously-skip'` is the schema's way
  // of saying it; `dangerouslySkipPermissions: true` is the legacy shape the Configure dialog and older
  // stored sessions still send. Both mean the same flag, and neither combines with --permission-mode.
  const skip = opts.dangerouslySkipPermissions || opts.permissionMode === 'dangerously-skip';
  if (skip) {
    args.push('--dangerously-skip-permissions');
  } else if (opts.permissionMode && opts.permissionMode !== 'default') {
    args.push('--permission-mode', String(opts.permissionMode));
  }
  // `model` is declared in configFields (and settable as a per-backend launch default), so it must
  // actually reach the CLI — otherwise the user sets a model and nothing happens. Nothing sent one
  // before this, so an unset model keeps the argv byte-identical to the pre-refactor command.
  if (opts.model) {
    args.push('--model', String(opts.model));
  }
  if (opts.worktree) {
    args.push('--worktree');
    if (opts.worktreeName) args.push(String(opts.worktreeName));
  }
  if (opts.chrome) {
    args.push('--chrome');
  }
  if (opts.addDirs) {
    const dirs = String(opts.addDirs).split(',').map(d => d.trim()).filter(Boolean);
    for (const dir of dirs) args.push('--add-dir', dir);
  }
  if (opts.appendSystemPrompt) {
    args.push('--append-system-prompt', String(opts.appendSystemPrompt));
  }

  return { command: 'claude', args, env: {}, cwd, spawnMode: 'shell' };
}

// FILE-mode discovery over the Claude projects root(s). Yields the same session set as today's scan
// (top-level session .jsonl + subagent transcripts), as {kind:'file'} handles. The scanner (T-4.2)
// consumes these; project bucketing stays central (derive-project-path), so no projectPath here.
function discoverSessions() {
  const out = [];
  for (const root of _roots) {
    let folders;
    try {
      // Skip `.git` like every other scan site (workers/scan-projects.js, session-cache.js) so a
      // stray git dir under the projects root is never mistaken for a project folder.
      folders = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== '.git');
    } catch { continue; }
    for (const dirent of folders) {
      const folder = dirent.name;
      const folderPath = path.join(root, folder);
      for (const f of enumerateSessionFiles(folderPath)) {
        out.push({
          kind: 'file',
          path: f.filePath,
          sessionId: f.sessionId,
          parentSessionId: f.parentSessionId,
          folder,
          root,
        });
      }
    }
  }
  return out;
}

// Parse one file handle -> the normalised session row, delegating to read-session-file.js. The
// scanner supplies the decoded projectPath (central derive-project-path); pass it through opts.
function parseSession(handle, opts = {}) {
  if (!handle || handle.kind !== 'file') return null;
  const { projectPath, folder } = opts;
  return readSessionFile(handle.path, folder != null ? folder : handle.folder, projectPath, opts);
}

// STORE-level watch targets: Claude's projects root dir(s). The live watcher (T-4.8) watches these.
function watchTargets() {
  return _roots.map(p => ({ kind: 'dir', path: p }));
}

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  binary: 'claude',  // the executable name, for callers that build their own argv (the schedule runner)
  tier: 1,
  axis: null,        // default backend, no axis
  status: 'ready',
  monogram: 'C',
  colour: 'claude',
  configFields,
  buildLaunch,
  discoverSessions,
  parseSession,
  watchTargets,
  deriveState: null, // Claude state comes from session-transitions folder-watch, not a per-event fn
  setRoots,          // main.js/tests point this at the real/ fixture projects dir
  _roots: () => _roots.slice(),
};
