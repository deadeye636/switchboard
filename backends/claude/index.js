// backends/claude/index.js — the Claude Code backend descriptor (the default; status 'ready').
//
// A THIN ADAPTER (00 §4, 02-file-map): Claude's heavy parse/state/discovery logic still lives in the
// hot-path modules at the repo root — read-session-file.js and friends — because the CORE imports them
// directly (session-cache.js does not go through this descriptor the way it goes through Codex's or Pi's).
// That is the real asymmetry, and a folder does not fix it; moving the readers in here before the core is
// routed through the descriptor would only hide it. This descriptor just points at them:
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
const { readSessionFile, enumerateSessionFiles, PARSER_SCHEMA_VERSION: readerVersion } = require('../../read-session-file');

// Claude's session store root. Defaults to ~/.claude/projects; main.js overrides it with its own
// PROJECTS_DIR at init (and tests point it at a fixture) via setRoots().
let _roots = [path.join(os.homedir(), '.claude', 'projects')];

function setRoots(roots) {
  if (Array.isArray(roots) && roots.length) _roots = roots.slice();
}

// Claude can fork a session (`--resume <id> --fork-session`). The sidebar's Fork button is gated on
// this: a backend that cannot fork must not OFFER it, because "cannot fork" degrades silently into
// "launch an unrelated empty session" — which is what Codex and Hermes did until the final review.
const supportsFork = true;

// Claude's launch options — the schema the Settings "Launch defaults" panel and the generated Configure
// dialog are both built from (§4a). These option ids are the ones the spawn path already speaks, so a
// stored default and a one-off override share one vocabulary.
//
// `dangerously-skip` is a CHOICE of permissionMode rather than a separate boolean: the two are mutually
// exclusive in the CLI (the skip flag wins), and two controls for one decision is how you end up with a
// UI that can express "plan AND skip".
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
  // `requires`: this option only means anything while another one is on. Declared, so the generated UI
  // and the contract test both know it — an option that silently does nothing on its own is exactly the
  // kind of dead control #160 exists to prevent.
  { id: 'worktreeName', label: 'Worktree branch name', type: 'text', default: '', requires: 'worktree' },
  { id: 'chrome', label: 'Chrome', type: 'toggle', default: false },
  { id: 'addDirs', label: 'Additional directories', type: 'text', default: '' },
  // `appliesAt: 'spawn'`: NOT part of the argv this function builds. main.js applies these at the spawn
  // site — mcpEmulation starts the MCP bridge and appends `--ide`, and afkTimeoutSec becomes an env var.
  // They are still this backend's options and still cascade like any other; they just do not land in
  // `args`. Say so, rather than let a test discover it.
  //
  // `preLaunchCmd` used to be here too. It never belonged to Claude: it is a raw shell prefix and has
  // nothing to do with which CLI follows it. The registry adds it to EVERY backend now
  // (backends/index.js, UNIVERSAL_FIELDS).
  { id: 'mcpEmulation', label: 'IDE emulation (MCP bridge)', type: 'toggle', default: true, appliesAt: 'spawn' },
  { id: 'afkTimeoutSec', label: 'AskUserQuestion timeout (s)', type: 'number', default: '', appliesAt: 'spawn' },
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

// Per-project TRUST, and how to move a transcript to a new project path (#171). Both are the backend's
// own business — Claude keeps trust in ~/.claude.json and writes `cwd` on every line; Codex keeps trust
// in its config.toml and writes cwd once, in its header. A backend that has neither declares neither,
// and the project manager stops pretending it speaks for everyone.
const claudeConfig = require('../../claude-config');
const { rewriteTranscript, claudeLine } = require('../rewrite-cwd');

const projectTrust = {
  get: (projectPath) => {
    try {
      const map = claudeConfig.getProjectTrustMap();
      const norm = claudeConfig.normalizeClaudePath(projectPath);
      return map.has(norm) ? map.get(norm) : null;
    } catch { return null; }
  },
  // Many projects at once — the Projects admin asks for every row it renders, and `get` reads and parses
  // the config file each time it is called. The normalisation stays in here: only this backend knows how
  // its own config spells a path.
  getMany: (projectPaths) => {
    const out = new Map();
    let map;
    try { map = claudeConfig.getProjectTrustMap(); } catch { return out; }
    for (const p of projectPaths) {
      const norm = claudeConfig.normalizeClaudePath(p);
      out.set(p, map.has(norm) ? map.get(norm) : null);
    }
    return out;
  },
  set: (projectPath, trusted) => claudeConfig.setProjectTrust(projectPath, trusted),
};

/** Rewrite this session's transcript so it belongs to `newPath`. Returns whether it changed anything. */
function rewriteProjectPath(filePath, oldPath, newPath) {
  return rewriteTranscript(filePath, oldPath, newPath, claudeLine);
}

/**
 * Hand over this project's transcripts — THE FILES ON THE ROWS, not the folder they happen to sit in.
 *
 * This used to remove every store folder that resolved to the project, and that was safe only while a
 * folder and a project were the same thing. Since #157 they are not: a session is attributed to the tree
 * it works in, so a folder created from one cwd can hold sessions that now belong to somewhere else. A
 * recursive folder delete took those with it — sessions of a DIFFERENT project, that the Remove dialog
 * had never counted and never offered. It also removed the transcripts of Axis-A templates, whose rows
 * are not Claude's and therefore survived, leaving rows pointing at files that no longer existed.
 *
 * So: delete exactly the transcripts the caller names (they come from this project's cached rows), plus
 * what belongs to each of them — the `.meta.json` sidecar and, for a parent session, its `subagents/`
 * directory. A folder left with nothing in it is then removed as the empty shell it is.
 */
function deleteSessions(filePaths, { projectsDir } = {}) {
  if (!projectsDir || !Array.isArray(filePaths) || !filePaths.length) return { removed: 0, failed: [] };
  const root = path.resolve(projectsDir) + path.sep;

  let removed = 0;
  const failed = [];
  const touched = new Set();

  for (const file of filePaths) {
    if (!file) continue;
    const resolved = path.resolve(file);
    if (!resolved.startsWith(root)) continue;   // never step outside the store
    // A subagent's file is listed on its own row, so it may already be gone with its parent. Only a file
    // that was really there counts as removed — the dialog reports this number.
    const existed = fs.existsSync(resolved);
    try {
      fs.rmSync(resolved, { force: true });
      fs.rmSync(resolved.replace(/\.jsonl$/, '.meta.json'), { force: true });
      fs.rmSync(resolved.replace(/\.jsonl$/, ''), { recursive: true, force: true });  // subagents/, if any
      if (existed) removed++;
      touched.add(path.dirname(resolved));
    } catch {
      failed.push(file);
    }
  }

  for (let dir of touched) {
    // Up from the transcript, dropping every directory that is now empty. `root` carries a trailing
    // separator, so the store folder itself never satisfies this and is never removed.
    while (path.resolve(dir).startsWith(root)) {
      let entries;
      try { entries = fs.readdirSync(dir); } catch { break; }
      if (entries.length) break;
      try { fs.rmdirSync(dir); } catch { break; }
      dir = path.dirname(dir);
    }
  }

  return { removed, failed };
}

module.exports = {
  id: 'claude',
  supportsFork,
  projectTrust,
  rewriteProjectPath,
  deleteSessions,
  // Claude's parser lives in read-session-file.js (it predates the backend registry); its version rides
  // on the descriptor like every other backend's, so the scan's staleness gate (#152) is one rule for
  // all of them and not a special case for the default backend.
  PARSER_SCHEMA_VERSION: readerVersion,
  // How another agent can READ this session's transcript (the 'new session reads the old one' handoff
  // route). 'file' = it is a file on disk, hand over the path. 'export' = it lives in a store with no
  // file (Hermes), so Switchboard writes it out first. Declare it; do not let the code guess.
  transcriptAccess: 'file',
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
