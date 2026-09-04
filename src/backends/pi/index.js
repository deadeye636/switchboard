// backends/pi/index.js — the Pi backend descriptor (Axis B: own binary, own store, own format).
//
// Recon on a REAL install: docs/plans/multi_llm/research/pi-format.md. Smoke-tested in a pty (T-6.0 = GO): the TUI
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
const { execFile, execFileSync } = require('child_process');

const parser = require('./parser');
const trust = require('./trust');
const liveBinding = require('./live-binding');
const turnQueue = require('./turn-queue');
const transcriptView = require('./transcript-view');
const resources = require('./resources');
const { createFileStore, findOnPath } = require('../file-store');
const { PROBE_STDIO, closeStdin, cliComplaint } = require('../cli-probe');
const { rewriteTranscript, piLine } = require('../rewrite-cwd');
const { deleteTranscripts } = require('../delete-sessions');
const { deriveState, deriveStateFromFileTail, deriveStateFromFileTailGated } = require('./state');
const { changelogSource } = require('./changelog');

// A Pi transcript's filename, from the module that also reads a session id out of one (#530). One pattern,
// not two that agree until somebody edits one of them — the rationale is over there with it.
const { PI_TRANSCRIPT_NAME } = turnQueue;


let _root = null;

/**
 * The sessions root. `PI_CODING_AGENT_SESSION_DIR` overrides it — read from OUR env, which is not the
 * user's shell env; a per-invocation `--session-dir` is undiscoverable and simply cannot be tracked.
 */
function sessionsRoot() {
  if (_root) return _root;
  // SWITCHBOARD_STORE_PI isolates our scan (demo/sandbox — scripts/demo-start.js); it names the
  // sessions dir directly, ahead of the CLI's own PI_CODING_AGENT_SESSION_DIR.
  return process.env.SWITCHBOARD_STORE_PI
    || process.env.PI_CODING_AGENT_SESSION_DIR
    || path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

function setRoot(dir) {
  _root = dir || null;
}

// Where the CLI ITSELF writes (#241/#406). Pi separates the sessions dir from the agent config dir, so
// an isolated launch gets both: sessions where Switchboard scans, and trust/config beside that store.
// Null unless isolated.
function cliHomeEnv() {
  const store = process.env.SWITCHBOARD_STORE_PI;
  if (!store) return null;
  return { PI_CODING_AGENT_SESSION_DIR: store, ...(trust.cliEnvForStore(store) || {}) };
}

// Pi's own launch options (§4a) — taken from its real `--help` (#160).
//
// Deliberately NOT here:
//   `--api-key` — it would put a raw key on the COMMAND LINE, where every process listing on the machine
//     can read it. Pi reads its key from the environment; a template's env bundle ($VAR, resolved at
//     spawn, never written to disk) is the route for that, and the only one we will offer.
//   `--mode json|rpc`, `--print` — non-interactive modes; we run Pi in a terminal.
//   `--session-dir`, `--no-session`, `--session*` — they move or suppress the session store we watch.
//   `--extension` — owned by buildLiveBinding for Switchboard's per-spawn extension; arbitrary extension
//     paths remain a future UI design, not a free text argv injection here.
const configFields = [
  { id: 'model', label: 'Model', type: 'text', default: '', modelDiscovery: true,
    description: 'Model pattern or id — supports "provider/id" and an optional ":<thinking>" suffix.' },
  { id: 'provider', label: 'Provider', type: 'text', default: '',
    description: 'Provider name. Empty = Pi\'s own default.' },
  { id: 'thinking', label: 'Thinking level', type: 'select',
    choices: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    choiceLabels: { '': 'Pi\'s default' },
    default: '',
    description: 'How hard the model thinks before answering.' },
  { id: 'name', label: 'Session name', type: 'text', default: '',
    description: 'Initial Pi session display name (`--name`).' },
  { id: 'models', label: 'Model cycle list', type: 'text', default: '',
    description: 'Comma-separated model patterns for Pi\'s Ctrl+P cycling (`--models`).' },
  { id: 'tools', label: 'Tools (allowlist)', type: 'text', default: '',
    description: 'Comma-separated tool names to enable. Empty = whatever Pi picks, which since 0.84.4 is its `defaultTools` setting when one is configured.' },
  { id: 'excludeTools', label: 'Tools (denylist)', type: 'text', default: '',
    description: 'Comma-separated tool names to disable. Applies to built-in, extension and custom tools.' },
  { id: 'noTools', label: 'Disable tools', type: 'toggle', default: false,
    description: 'Start Pi with all tools disabled by default (`--no-tools`).' },
  { id: 'noBuiltinTools', label: 'Disable built-in tools', type: 'toggle', default: false,
    description: 'Disable Pi\'s built-in tools but keep extension/custom tools enabled (`--no-builtin-tools`).' },
  { id: 'approval', label: 'Project trust for this run', type: 'select',
    choices: ['', 'approve', 'no-approve'],
    choiceLabels: { '': 'Use saved trust', approve: 'Trust this run', 'no-approve': 'Do not trust this run' },
    default: '',
    description: 'Override Pi project trust for this launch only.' },
  { id: 'offline', label: 'Offline startup', type: 'toggle', default: false,
    description: 'Disable Pi startup network operations (`--offline`).' },
  { id: 'appendSystemPrompt', label: 'Append to system prompt', type: 'text', default: '',
    description: 'Text (or a file path) appended to Pi\'s system prompt.' },
  // The slash form pairs a LIGHT theme with a DARK one (`solarized-light/solarized-dark`) — Pi reserves the
  // separator for exactly that and refuses a theme name containing it. `light/dark` reads like a keyword
  // and is not one; it happens to work because those are the names of two built-ins.
  { id: 'useTheme', label: 'Interactive theme', type: 'text', default: '',
    description: 'Pi theme for this run. One name, or `light-name/dark-name` to pair one of each. Empty = the theme Pi is configured with.' },
  { id: 'noContextFiles', label: 'Ignore AGENTS.md / CLAUDE.md', type: 'toggle', default: false,
    description: 'Do not load the project\'s context files for this session.' },
];

/** Is pi actually installed? */
function findExecutable() {
  return findOnPath('pi');
}

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

// How long the model probe may take before it is called a failure (#540). Measured on 0.84.4: 2.5-3.7 s
// across five runs. The same 20 s ceiling agy's carries, for the same reason — this runs on a user opening
// the model field, not on the scan path, and the answer is cached for ten minutes afterwards.
const MODEL_PROBE_TIMEOUT_MS = 20 * 1000;

let _modelCache = null; // { at, search, models }

function parseModelList(output) {
  const lines = String(output || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const models = [];
  for (const line of lines) {
    if (/^provider\s+model\s+/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const provider = parts[0];
    const model = parts[1];
    if (!provider || !model) continue;
    models.push({ id: `${provider}/${model}`, label: `${provider}/${model}` });
  }
  return models;
}

function piExecCommand() {
  const exe = findExecutable();
  if (!exe) return { command: 'pi', args: [] };
  if (process.platform === 'win32' && /\.cmd$/i.test(exe)) {
    const cli = path.join(path.dirname(exe), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    return { command: 'node', args: [cli] };
  }
  return { command: exe, args: [] };
}

function listModels({ search } = {}) {
  const q = String(search || '').trim();
  const now = Date.now();
  if (_modelCache && _modelCache.search === q && now - _modelCache.at < MODEL_CACHE_TTL_MS) {
    return Promise.resolve({ ok: true, models: _modelCache.models, cached: true });
  }
  return new Promise((resolve) => {
    const launch = piExecCommand();
    const args = [...launch.args, '--list-models'];
    if (q) args.push(q);
    // closeStdin, not a `stdio` option: execFile ignores that one (#532, backends/cli-probe.js).
    closeStdin(execFile(launch.command, args, { encoding: 'utf8', timeout: MODEL_PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // NOT `err.message`. execFile's message is "Command failed: <the whole argv>", which for Pi on
        // Windows is an absolute path into node_modules — in a message the user reads (#540, same defect
        // as agy's). What helps is that it took too long and why it might.
        const timedOut = !!(err.killed || err.code === 'ETIMEDOUT');
        resolve({
          ok: false,
          reason: timedOut
            ? `Pi did not answer within ${Math.round(MODEL_PROBE_TIMEOUT_MS / 1000)} seconds. Try again, or type the model id.`
            : (cliComplaint(stderr) || 'Could not list Pi models.'),
        });
        return;
      }
      const models = parseModelList(stdout);
      _modelCache = { at: Date.now(), search: q, models };
      resolve({ ok: true, models, cached: false });
    }));
  });
}

/** The version of the node ON PATH (`v22.22.0`), or null when there is none. */
function systemNodeVersion() {
  try {
    const out = execFileSync('node', ['--version'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: PROBE_STDIO });
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

// The toolchain probe, cached.
//
// `probe()` rides on `backends.list()`, which is on the SCAN path, and the registry's availability cache
// only holds for 15 seconds — so this shelled out to `node --version` SYNCHRONOUSLY on the main process
// every 15 seconds for the life of the app, blocking the UI for as long as the child took to answer
// (#155). A toolchain does not change under a running app; when it does (someone installs Node while
// Switchboard is open), five minutes is soon enough — and a restart is instant.
const TOOLCHAIN_TTL_MS = 5 * 60 * 1000;
let _toolchain = null;   // { at, nodeVersion, bash }

function toolchain() {
  const now = Date.now();
  if (_toolchain && now - _toolchain.at < TOOLCHAIN_TTL_MS) return _toolchain;
  _toolchain = { at: now, nodeVersion: systemNodeVersion(), bash: findBash() };
  return _toolchain;
}

/** Test hook: forget the cached toolchain, so a test can change PATH and probe again. */
function _resetToolchainCache() {
  _toolchain = null;
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
  const { nodeVersion, bash } = toolchain();
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

  if (!bash) {
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
  if (opts.name) args.push('--name', String(opts.name));
  if (opts.models) args.push('--models', String(opts.models));
  if (opts.tools) args.push('--tools', String(opts.tools));
  if (opts.excludeTools) args.push('--exclude-tools', String(opts.excludeTools));
  if (opts.noTools) args.push('--no-tools');
  if (opts.noBuiltinTools) args.push('--no-builtin-tools');
  if (opts.approval === 'approve') args.push('--approve');
  if (opts.approval === 'no-approve') args.push('--no-approve');
  if (opts.offline) args.push('--offline');
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', String(opts.appendSystemPrompt));
  if (opts.useTheme) args.push('--use-theme', String(opts.useTheme));
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
  // Pi's filename carries the session's start time — a birth estimate that costs no stat (#209). Unlike
  // Codex' it IS explicit UTC (the trailing Z), but file-store applies the same 24 h reject margin either
  // way and stats every survivor, so the precise birth is unchanged.
  birthHint: (name) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(name);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : null;
  },
});

// `ctx.lastOutputMs` = when this session's PTY last said anything (main.js). Used ONLY to keep a
// silent-but-running turn from being declared idle — never to declare one busy.
function liveState(ref, ctx = {}) {
  return deriveStateFromFileTailGated(ref, Date.now(), ctx);
}

module.exports = {
  id: 'pi',
  // Where this CLI publishes what changed (#528). The core knows none of these pages; it asks each
  // backend, and a backend without a public changelog simply declares nothing.
  changelogSource,
  cliHomeEnv,
  label: 'Pi',
  description: 'Terminal coding agent.',   // shown in the Backends settings list (#212)
  tier: 1,
  axis: 'B',
  status: 'ready',
  monogram: 'Pi',
  colour: 'pi',
  // MEASURED, not read off its keymap: Pi ignores ESC[5~/ESC[6~ at its prompt, and it runs on the
  // NORMAL buffer, so xterm holds the session history. The bare keys therefore page that history here.
  pageKeyTarget: 'viewport',
  // MEASURED in a real pty: Pi's composer inserts a newline on the kitty protocol's CSI 13;2u, so
  // Shift+Enter already worked here before #493 and keeps the sequence it was measured on.
  newlineKeySequence: '\x1b[13;2u',
  supportsFork: true,     // `pi --fork <id>`
  supportsSubagents: false,   // fork, yes; subagents, no (#230)
  supportsLiveRebinding: true,
  buildLiveBinding: ({ dir, tag, sessionUrl, log } = {}) => liveBinding.writeBindingExtension({ dir, tag, sessionUrl, log }),
  releaseLiveBinding: (file, log) => liveBinding.removeBindingExtension(file, log),
  // Lineage (#193): a FORKED Pi session records its origin in the header as `parentSession` — the full
  // path of the parent transcript. A hard link, like Claude's `forkedFrom` and Hermes' parent column.
  //
  // This said "records NO parent reference (verified against a real store)" for several issues, and the
  // survey behind that was not wrong so much as unlucky: only a fork carries the key, and there was no
  // forked session in the store that got looked at. One `pi --fork` transcript settles it, which is why
  // the claim is now backed by the id-bearing filename below rather than by a sentence.
  //
  // The path→id step lives HERE because the convention is Pi's: it names a transcript
  // `<ISO-timestamp>_<uuid>.jsonl`, so the parent's session id is its basename after the underscore. The
  // parser hands over the raw path and stays out of it (§5.9).
  //
  // The WHOLE filename must match that shape, not merely contain an underscore. A looser split answered
  // `backup_copy.jsonl` with the id `copy` — a wrong link, and a `fork` link is rendered as FACT, not as
  // a guess. So a name Pi did not write yields nothing: the sidebar showing no ancestor is right, and
  // showing the wrong one is not recoverable by the reader.
  resolveLineage: (row) => {
    const ref = row && row.lineageParentRef;
    if (!ref) return null;
    const m = PI_TRANSCRIPT_NAME.exec(path.basename(String(ref)));
    return m ? { lineageParentId: m[1], lineageKind: 'fork' } : null;
  },
  // A file backend's transcript IS the file on the row (#211) — nothing to reconstruct.
  transcriptPathFor: (row) => (row && row.filePath) || null,
  // Does this session still owe a turn (#530)? The answer is pushed by the per-spawn binding extension and
  // remembered in ./turn-queue.js — read that file for why it is not the RPC the issue named, and for what
  // a null answer means. Both halves are declared here so the seam is one backend's business end to end.
  readTurnQueue: (transcriptPath, sinceMs) => turnQueue.readTurnQueue(transcriptPath, sinceMs),
  noteTurnQueue: (sessionId, state) => turnQueue.noteTurnQueue(sessionId, state),
  // Pi keeps no plans store (#227).
  plansDir: () => null,
  // Pi reads AGENTS.md AND CLAUDE.md as its context files (the `noContextFiles` toggle turns both off),
  // so both are its per-project instruction files (#227). get-memories dedupes by path, so declaring
  // CLAUDE.md here does not double it with Claude's own.
  memorySources: (scope) => {
    if (!scope || !scope.projectPath) return [];
    const short = require('../../session/derive-project-path').projectShortName(scope.projectPath);
    return ['AGENTS.md', 'CLAUDE.md'].map(name => ({
      kind: 'file', path: path.join(scope.projectPath, name), displayPath: short + '/', source: 'project',
    }));
  },
  transcriptAccess: 'file',   // one JSONL per session
  normalizeTranscriptEntries: transcriptView.normalizeTranscriptEntries,
  // Shown on the backend's settings page. Pi is the only backend where injecting a key can appear to
  // work and quietly do nothing: a stored `pi /login` OAuth session takes PRIORITY over the env vars we
  // pass, with no error. A user chasing "why is it still on the old account" has no way to see that from
  // inside Switchboard, so say it where they configure it.
  caveat: 'If you have run `pi /login`, its stored OAuth account takes priority over any API key passed in — Pi will use the logged-in account, not the key.',
  // The capability matrix's answers for Pi (#439) — declared, not derived from hook presence; see
  // `src/backends/capabilities.js` for why, and for the catalog these ids come from.
  capabilities: {
    fork: { state: 'limited', note: 'only after its first reply — Pi names its own sessions' },
    deleteSessions: 'yes',
    moveProject: 'yes',
    transcriptHandoff: 'yes',
    lineage: { state: 'limited', note: 'only a forked session names its parent' },
    modelList: 'yes',
    endpoint: 'no',
    projectTrust: 'yes',
    subagentSessions: 'no',
    liveOwners: { state: 'no', note: 'unmeasured for this CLI' },
    liveRebinding: 'yes',
    queuedTurn: { state: 'limited', note: 'its extension reports whether a prompt waits, but not how many' },
    quota: { state: 'no', note: 'reports no plan allowance' },
    resourceDiscovery: 'yes',
    resourceDepth: 'yes',
    resourceWrite: { state: 'limited', note: 'its skills and instructions, but not its TypeScript extensions' },
    skillInvoke: 'yes',
    planDirSetting: { state: 'no', note: 'writes no plan documents at all' },
    plans: { state: 'no', note: 'keeps no plans store' },
    projectConfig: 'no',
    viewportPaging: 'yes',
  },
  configFields,
  buildLaunch,
  probe,
  findExecutable,
  listModels,
  /**
   * How pi is asked to run one of its skills (#462). Measured in a running session: typing `/git` offers
   * `skill:git-commit`, and completing it puts `/skill:git-commit` in the prompt — the prefix is part of
   * the command, so a bare `/git-commit` is not the same thing.
   */
  skillInvocation: ({ name }) => (name ? '/skill:' + name : null),
  listResources: resources.listResources,
  expandResource: resources.expandResource,   // one level into a listed directory (#440)
  // Pi's skills can be plain markdown files; its extensions are `.ts`/`.js` and are not offered (#441).
  resourceEditing: { extensions: ['.md', '.markdown', '.json'] },
  // Pi reads a skill as a directory or as a bare markdown file; the directory is what is created, because
  // it is the shape that stays right when the skill grows (#441). Its TypeScript extensions are not
  // offered — creating something that RUNS is a different feature.
  resourceScaffolds: [
    { kind: 'skill', layout: 'dir', entryFile: 'SKILL.md', sources: ['skills-directory', 'shared-skills-directory'],
      template: (name) => `---
name: ${name}
description: 
---

` },
    { kind: 'prompt-template', layout: 'file', ext: '.md', sources: ['prompts-directory'],
      template: (name) => `# ${name}

` },
  ],
  _parseModelList: parseModelList,

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
  // The default, kept rather than measured (#512): nothing here has watched WHEN the transcript header
  // is written. Honest gap — the pre-#512 behaviour, which has not been observed to misfire for pi.
  recordAppearsAt: 'spawn',

  // Pi writes its cwd ONCE, on the header line — so a remap has to touch that one line, and Pi's
  // transcripts move with the project like everyone else's (#171).
  rewriteProjectPath: (filePath, oldPath, newPath) =>
    rewriteTranscript(filePath, oldPath, newPath, piLine),

  // ...and they are deleted with it. "Delete this project's sessions" used to clear Claude's store only,
  // so Pi's transcripts survived and came back the day the project was unhidden.
  deleteSessions: (filePaths) => deleteTranscripts(filePaths, sessionsRoot()),
  // Pi's project trust lives in its own `trust.json` (#406), separate from the sessions store.
  projectTrust: { get: trust.get, getMany: trust.getMany, set: trust.set },

  sessionsRoot,
  setRoot,
  _resetToolchainCache,
};
