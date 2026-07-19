// backends/claude/index.js — the Claude Code backend descriptor (the default; status 'ready').
//
// A THIN ADAPTER (00 §4, 02-file-map): Claude's heavy parse/state/discovery logic lives in the format
// modules alongside this descriptor — session-reader.js (was read-session-file.js) and folder-reader.js.
// Since #188 the CORE reads Claude's sessions THROUGH this descriptor (session-cache.js pulls the raw
// readers off the module.exports below, the way it goes through Codex's or Pi's), so the readers moved
// in here and this descriptor re-exports them:
//   - buildLaunch  reproduces the inline claude-arg logic (main.js:3052-3086) byte-identically.
//   - discoverSessions  = FILE mode over ~/.claude/projects (reuses enumerateSessionFiles).
//   - parseSession({kind:'file'})  delegates to session-reader.js; parseSessionIncremental wraps its
//     incremental reader for the watcher hot path.
//   - deriveState  is null — Claude's busy/idle comes from the existing session-transitions folder
//     watch (detectSessionTransitions), not a per-event function.
//   - watchTargets  = the projects dir root(s).
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { readSessionFile, readSessionFileIncremental, enumerateSessionFiles, resolveJsonlPath, subagentSessionId, readSubagentMeta, PARSER_SCHEMA_VERSION: readerVersion } = require('./session-reader');
// The per-spawn hook settings that tie a /clear to its terminal (#223).
const liveBinding = require('./live-binding');
const { readFolderSessions } = require('./folder-reader');
const { encodeProjectPath } = require('../../session/encode-project-path');
const { projectShortName } = require('../../session/derive-project-path');

// Claude's home directory (~/.claude, or the isolated demo/sandbox home) is the PARENT of its projects
// store root — always. Deriving it from _roots[0] keeps plans + global memory isolated by the same
// SWITCHBOARD_STORE_CLAUDE override that isolates the session scan, with no second env var (#227).
function claudeHome() {
  return path.dirname(_roots[0]);
}

// Claude's session store root. Defaults to ~/.claude/projects; main.js overrides it with its own
// PROJECTS_DIR at init (and tests point it at a fixture) via setRoots().
let _roots = [path.join(os.homedir(), '.claude', 'projects')];

function setRoots(roots) {
  if (Array.isArray(roots) && roots.length) _roots = roots.slice();
}

// Where the CLI ITSELF writes (#241). SWITCHBOARD_STORE_CLAUDE isolates where Switchboard LOOKS; it does
// not move the CLI's own store, so a session launched from an isolated (demo/sandbox) instance still
// landed in the user's real ~/.claude and the isolated app never saw it. Claude resolves everything it
// owns from CLAUDE_CONFIG_DIR — including `<dir>/projects` — so pointing it at claudeHome() puts the
// transcript exactly where we are scanning.
//
// Returns null unless the scan is actually isolated: a normal launch must NOT carry a CLAUDE_CONFIG_DIR
// nobody asked for, or the app would start dictating the CLI's home to every user.
// Derived from the env var itself, not from _roots: the two agree in the app (main.js seeds the roots
// from exactly this variable), but reading it here means the answer cannot depend on whether setRoots()
// has run yet — a hook that silently hands back the REAL home would look like isolation and not be one.
function cliHomeEnv() {
  const store = process.env.SWITCHBOARD_STORE_CLAUDE;
  if (!store) return null;
  return { CLAUDE_CONFIG_DIR: path.dirname(store) };
}

// Claude can fork a session (`--resume <id> --fork-session`). The sidebar's Fork button is gated on
// this: a backend that cannot fork must not OFFER it, because "cannot fork" degrades silently into
// "launch an unrelated empty session" — which is what Codex and Hermes did until the final review.
const supportsFork = true;
// Claude spawns Task-tool subagents that write <parent>/subagents/agent-<id>.jsonl (#230). It is the only
// backend with the concept today; declared so the core/renderer/settings ask rather than assume Claude.
const supportsSubagents = true;

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

// Incremental variant of parseSession — the SAME contract codex/pi expose (backends/*/parser.js):
// returns `{ row, parseState }`, where `parseState` is the opaque, serializable resume state to hand
// back as `prev` on the next call (null → full first read). Claude's own reader speaks `{session, next}`
// (or `null`); this wrapper normalises that shape so a generic consumer sees one contract across every
// backend. The Claude hot path calls `readSessionFileIncremental` raw (session-cache.js), so its
// `{session,next}` shape is unchanged — only this descriptor-level wrapper maps it.
function parseSessionIncremental(handle, opts = {}, prev = null) {
  if (!handle || handle.kind !== 'file') return { row: null, parseState: null };
  const { projectPath, folder } = opts;
  const parentSessionId = opts.parentSessionId != null ? opts.parentSessionId : handle.parentSessionId;
  const res = readSessionFileIncremental(handle.path, folder != null ? folder : handle.folder, projectPath, { parentSessionId }, prev);
  if (!res) return { row: null, parseState: null };
  return { row: res.session, parseState: res.next };
}

// STORE-level watch targets: Claude's projects root dir(s). The live watcher (T-4.8) watches these.
function watchTargets() {
  return _roots.map(p => ({ kind: 'dir', path: p }));
}

// Per-project TRUST, and how to move a transcript to a new project path (#171). Both are the backend's
// own business — Claude keeps trust in ~/.claude.json and writes `cwd` on every line; Codex keeps trust
// in its config.toml and writes cwd once, in its header. A backend that has neither declares neither,
// and the project manager stops pretending it speaks for everyone.
const claudeConfig = require('./config');
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

// Per-project META and CONFIG ownership (#211). Claude keeps a projects table in ~/.claude.json —
// trust, MCP servers, allowed tools, last cost, tokens — and the Projects admin used to read it
// directly, as if it were the app's own store. It is Claude's, so Claude declares it; a backend with no
// such store declares no `projectMeta`, and the admin shows no columns for it rather than Claude's.
const projectMeta = {
  // Display-ready columns per project: Map<projectPath, Array<{ id, label, value, title? }>>. The
  // renderer draws label/value pairs and names no backend. An unknown project gets [].
  getMany: (projectPaths) => {
    const out = new Map();
    let meta;
    try { meta = claudeConfig.getProjectClaudeMeta(); } catch { meta = new Map(); }
    for (const p of projectPaths) {
      const m = meta.get(claudeConfig.normalizeClaudePath(p));
      if (!m) { out.set(p, []); continue; }
      // `value` is display-ready and self-contained (carries its own unit) so a neutral renderer can join
      // them into one info cell without knowing what any column means.
      const cols = [];
      if (m.mcpServersCount) cols.push({ id: 'mcp', label: 'MCP servers', value: m.mcpServersCount + ' MCP', title: 'MCP servers configured' });
      if (m.allowedToolsCount) cols.push({ id: 'tools', label: 'Allowed tools', value: m.allowedToolsCount + ' tools', title: 'Allowed tools' });
      if (typeof m.lastCost === 'number') cols.push({ id: 'cost', label: 'Last cost', value: '$' + m.lastCost.toFixed(2), title: 'Last session cost' });
      out.set(p, cols);
    }
    return out;
  },
  // Every project path Claude's config knows — the config-only fold-in and the prune gate ask this.
  knownProjects: () => {
    try {
      const cfg = claudeConfig.readClaudeConfig();
      if (!cfg || !cfg.projects || typeof cfg.projects !== 'object') return [];
      return Object.keys(cfg.projects).map((k) => claudeConfig.normalizeClaudePath(k));
    } catch { return []; }
  },
  has: (projectPath) => {
    try {
      const cfg = claudeConfig.readClaudeConfig();
      if (!cfg || !cfg.projects || typeof cfg.projects !== 'object') return false;
      const norm = claudeConfig.normalizeClaudePath(projectPath);
      return Object.keys(cfg.projects).some((k) => claudeConfig.normalizeClaudePath(k) === norm);
    } catch { return false; }
  },
  // Move / drop this project's WHOLE ~/.claude.json entry (trust + meta together).
  rename: (oldPath, newPath) => claudeConfig.renameProjectEntry(oldPath, newPath),
  remove: (projectPath) => claudeConfig.removeProjectEntry(projectPath),
  removeLabel: 'Delete entry in ~/.claude.json (trust, MCP, cost)',
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
  cliHomeEnv,
  supportsFork,
  supportsSubagents,
  // Lineage (#193): a forked Claude session names its origin (`forkedFrom`) in the head — the only
  // cross-session link Claude records on disk. A /clear records NO back-ref, so its (single-session) link
  // is written live by session-transitions, not here. Same-session compaction is not a lineage row.
  resolveLineage: (row) => (row && row.forkedFrom ? { lineageParentId: row.forkedFrom, lineageKind: 'fork' } : null),
  projectTrust,
  projectMeta,
  rewriteProjectPath,
  deleteSessions,
  // Where this row's transcript lives when the row carries no `filePath` (#211). Claude reconstructs it
  // from folder + session id over its own store roots, so the Projects admin no longer passes PROJECTS_DIR
  // in. A file backend just hands back row.filePath; Claude is the one that reconstructs, so it owns this.
  transcriptPathFor: (row) => {
    if (!row) return null;
    if (row.filePath) return row.filePath;
    return resolveJsonlPath(_roots[0], row);
  },
  // --- The subagent seam (#235) ---------------------------------------------------------------
  // #230 declared THAT Claude has subagents; these three say HOW they are found, named and described,
  // so the core stops walking `<folder>/<parent>/subagents/` and stops minting `sub:<parent>:<agent>`
  // itself. A backend that declares supportsSubagents: false implements none of them and is never
  // asked. Everything Claude-shaped about a subagent now lives in this folder.
  //
  // The core owns the spawn/complete STATE MACHINE (mtime stability, bootstrap quiet, reopen, GC —
  // session-transitions.js); this hook only reports what exists right now.
  // `opts.folderPath` is the session's directory in this backend's store, passed because the caller
  // already resolved it; a backend that keeps no such directory ignores it.
  //
  // `null` and `[]` MEAN DIFFERENT THINGS and the core acts on the difference: `null` = "nothing to
  // watch here yet" (Claude: the subagents directory does not exist), `[]` = "watched, currently
  // empty". Only the second one starts the bootstrap bookkeeping, which is what makes the NEXT file
  // to appear a real spawn instead of a silently-recorded leftover (#122).
  listSubagents: (parentSessionId, opts) => {
    const base = (opts && opts.folderPath) || (_roots[0] ? path.join(_roots[0], (opts && opts.folder) || '') : null);
    if (!base || !parentSessionId) return null;
    const dir = path.join(base, parentSessionId, 'subagents');
    let files;
    try { files = fs.readdirSync(dir); } catch { return null; }   // not spawned yet — normal, not an error
    const out = [];
    for (const file of files) {
      const m = file.match(/^agent-(.+)\.jsonl$/);
      if (!m) continue;
      let stat;
      try { stat = fs.statSync(path.join(dir, file)); } catch { continue; }
      out.push({ agentId: m[1], mtimeMs: stat.mtimeMs });
    }
    return out;
  },
  // Claude writes `<transcript>.meta.json` beside the agent file. The core needs the type and the
  // description for the spawn event and knows neither the sidecar nor its name.
  subagentMeta: (parentSessionId, agentId, opts) => {
    const base = (opts && opts.folderPath) || (_roots[0] ? path.join(_roots[0], (opts && opts.folder) || '') : null);
    if (!base || !parentSessionId || !agentId) return null;
    const file = path.join(base, parentSessionId, 'subagents', `agent-${agentId}.jsonl`);
    const meta = readSubagentMeta(file);
    return meta ? { subagentType: meta.agentType || null, description: meta.description || null } : null;
  },
  // The row id a subagent is cached under. `sub:<parent>:<agent>` is CLAUDE's shape — the core used to
  // concatenate it by hand, which silently made it the universal one.
  subagentSessionId,
  // --- Live re-identification (#223) -----------------------------------------------------------
  // A backend that can tell us, mid-flight, that a running terminal moved to a NEW session id declares
  // this hook; one that cannot simply does not, and the core keeps its conservative rule. It is NOT
  // "detect /clear": Codex's `/new` is the same shape and would implement it differently.
  //
  // The core hands the terminal's tag and the URL its ingest listens on; the backend answers with what
  // its launch needs (extra argv, and anything to clean up afterwards). Claude writes a per-spawn
  // settings file registering a SessionEnd:clear hook — see live-binding.js for what was measured.
  supportsLiveRebinding: true,
  buildLiveBinding: ({ dir, tag, url, log } = {}) => {
    const file = liveBinding.writeBindingSettings({ dir, tag, url, log });
    if (!file) return null;
    return { args: ['--settings', file], cleanup: file };
  },
  releaseLiveBinding: (cleanup, log) => liveBinding.removeBindingSettings(cleanup, log),
  // Where Claude keeps its plan documents (#227) — the Plans tab reads every launchable backend's plansDir
  // and shows nothing for a backend that has none. ~/.claude/plans, or the isolated home under a demo run.
  plansDir: () => path.join(claudeHome(), 'plans'),
  // The memory / instruction files Claude exposes for one scope (#227). Global = its home-level files; a
  // project = its store-side .md files (per store folder — legacy encodings mean several, plus the
  // canonical encoded name so a not-yet-indexed project still resolves) and the project-root CLAUDE.md +
  // .claude dirs. Each source is display-ready; the neutral Plans/Memory module scans/stats them and never
  // hardcodes ~/.claude itself.
  memorySources: (scope) => {
    scope = scope || {};
    if (!scope.projectPath) {
      return [{ kind: 'dir', path: claudeHome(), displayPath: '~/.claude', source: 'claude-home' }];
    }
    const projectPath = scope.projectPath;
    const short = projectShortName(projectPath);
    const out = [];
    const folders = new Set(scope.storeFolders || []);
    folders.add(encodeProjectPath(projectPath));
    for (const folder of folders) {
      const fp = path.join(_roots[0], folder);
      out.push({ kind: 'dir', path: fp, displayPath: '~/.claude', source: 'claude-home' });
      out.push({ kind: 'dir', path: path.join(fp, 'memory'), displayPath: '~/.claude', source: 'claude-home' });
    }
    out.push({ kind: 'file', path: path.join(projectPath, 'CLAUDE.md'), displayPath: short + '/', source: 'project' });
    out.push({ kind: 'dir', path: path.join(projectPath, '.claude'), displayPath: short + '/.claude/', source: 'project' });
    out.push({ kind: 'dir', path: path.join(projectPath, '.claude', 'commands'), displayPath: short + '/.claude/commands/', source: 'project' });
    return out;
  },
  // Claude's parser lives in session-reader.js (it predates the backend registry); its version rides
  // on the descriptor like every other backend's, so the scan's staleness gate (#152) is one rule for
  // all of them and not a special case for the default backend.
  PARSER_SCHEMA_VERSION: readerVersion,
  // How another agent can READ this session's transcript (the 'new session reads the old one' handoff
  // route). 'file' = it is a file on disk, hand over the path. 'export' = it lives in a store with no
  // file (Hermes), so Switchboard writes it out first. Declare it; do not let the code guess.
  transcriptAccess: 'file',
  label: 'Claude Code',
  // The one-line blurb the Backends settings list shows under the label (#212). It lived in
  // backends-panel.js as a map keyed by backend id — five id literals in a file that must name no
  // backend, and the only thing a new backend still had to add to the RENDERER to look finished.
  //
  // It used to read "Anthropic — the default backend, always available", and both halves had stopped
  // being true: Claude can be switched off (#162), and the default launch target is whichever backend
  // the user picked. Say what the CLI IS, like every sibling does; what it is TO THIS INSTALL is the
  // list's job, and the list already shows it (the toggle, the "default" pill).
  description: "Anthropic's terminal coding agent.",
  binary: 'claude',  // the executable name, for callers that build their own argv (the schedule runner)
  tier: 1,
  axis: null,        // default backend, no axis
  status: 'ready',
  monogram: 'C',
  colour: 'claude',
  // Which environment-variable family this CLI reads its endpoint from (#212), or nothing if it has
  // none. An Axis-A template pointed at a third-party endpoint (DeepSeek, GLM, OpenRouter) works by
  // setting ANTHROPIC_* variables, so the profile editor offers its Endpoint fields only on a base that
  // reads them: on a Codex template they would be two boxes writing variables Codex never looks at —
  // a control that lies. The editor used to decide this with `baseId === 'claude'`; it now asks the
  // descriptor, so a future Anthropic-compatible CLI opts in by declaring the same family.
  endpointEnv: 'anthropic',
  // Which artwork the renderer draws (#212). backend-icons.js keys its ART map the same way it keys
  // COLOURS and MONOGRAMS, so declaring the slug is all it takes — the launch popover used to carry
  // Anthropic's logo as a raw SVG string emitted only when the id read `claude`. A backend that names
  // no icon simply gets the monogram badge, which is still the norm.
  icon: 'anthropic',
  configFields,
  buildLaunch,
  discoverSessions,
  parseSession,
  parseSessionIncremental,
  // Raw readers the core pulls off the descriptor (session-cache.js drives Claude's dedicated scan
  // through these instead of importing the format modules directly — #188).
  readSessionFile,
  readSessionFileIncremental,
  enumerateSessionFiles,
  resolveJsonlPath,
  // subagentSessionId + the subagent hooks are declared with the rest of the subagent seam above (#235).
  readFolderSessions,
  watchTargets,
  deriveState: null, // Claude state comes from session-transitions folder-watch, not a per-event fn
  setRoots,          // main.js/tests point this at the real/ fixture projects dir
  _roots: () => _roots.slice(),
  // Usage capability (#191). `live: true` — the figure is fetched from the API on every poll, so the bar
  // shows it without an "as of" caveat. Only the declaration crosses IPC; `fetch` stays in main.
  usage: {
    live: true,
    fetch: () => require('./usage').fetchUsage(),
  },
  // Integrations capability (#212). Extras that belong to THIS backend but are NOT launch options: they
  // reach no argv and no env, so they are not configFields — yet they are not generic app settings
  // either. The attention hook patches Claude's OWN ~/.claude/settings.json and applies to every Claude
  // session, including ones Switchboard never started. It is Claude's, so Claude declares it; a backend
  // that has no such extras declares nothing and its gear page shows no Integrations section.
  //
  // Like `usage`, only the DECLARATION crosses IPC — backends-panel.js renders whatever is here and
  // names no backend. `description` is descriptor-authored markup (the <code> tag is ours, not user
  // input) and is interpolated raw on purpose.
  //
  // Each field is a plain GLOBAL setting keyed by `id`, not a backendDefaults option — settings-panel.js
  // owns the save path and finds the control by `domId`. That is a string shared across two files with
  // nothing but `test/backend-integrations.test.js` tying the ends together; do not rename one alone.
  integrations: {
    title: 'Integrations',
    fields: [
      {
        id: 'attentionHooks',
        domId: 'sv-attention-hooks',
        type: 'toggle',
        label: 'Claude Code hooks for attention',
        description: 'More reliable attention detection than the terminal check alone. Catches permission and tool prompts the terminal heuristic can miss. Adds a reversible hook to <code>~/.claude/settings.json</code>; turning this off removes it again.',
      },
    ],
  },
};
