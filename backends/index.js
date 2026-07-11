// backends/index.js — the backend REGISTRY + the contract every layer talks to.
//
// A "backend" is a way to start and monitor a coding session (00-architecture §1). Claude Code is
// just the default backend. Each backend is a DESCRIPTOR (static capability data: id/label/tier/
// axis/status/monogram/colour/configFields) plus a set of HOOKS (functions the app calls):
//
//   buildLaunch({ cwd, resume, sessionId, forkFrom, options, profile }) -> { command, args, env, cwd?, spawnMode }
//   discoverSessions()   -> [handle]        handle = {kind:'file', path, ...} | {kind:'db', ref}
//   parseSession(handle) -> normalised session row (the shape session-cache expects, incl. cwd)
//   watchTargets()       -> [target]        STORE-level: {kind:'dir', path} | {kind:'db', path}
//   deriveState(events)  -> busy/idle/subagent  (may be null for backends that derive state elsewhere)
//
// Discovery is DUAL-MODE and first-class from Phase 1 (00 §4): file backends yield {kind:'file'}
// handles, a db backend (Hermes, Phase 5) yields {kind:'db'} handles — the scanner/watcher iterate
// handles/targets generically, so the SQLite source plugs in with no seam change.
//
// Phase 1 registers `claude` (ready, the real adapter) plus the not-yet-built Axis-B binaries as
// `planned` dummies so the registry shape is exercised against the full set. Phases 4–6 replace the
// codex/hermes/pi dummies with real `ready` descriptors; Gemini stays planned. Axis-A providers
// (DeepSeek/GLM/OpenRouter) are NOT registered here — they are presets (data) instantiated as user
// profiles in Phase 2, which `backends.list()` will then union in (T-2.1).
'use strict';

const registry = new Map();

// Register (or replace) a descriptor. Later phases swap a `planned` dummy for the real `ready` one.
function register(descriptor) {
  if (!descriptor || typeof descriptor.id !== 'string' || descriptor.id === '') {
    throw new Error('backend descriptor needs a non-empty string id');
  }
  registry.set(descriptor.id, descriptor);
  return descriptor;
}

function get(id) {
  return registry.get(id) || null;
}

function has(id) {
  return registry.has(id);
}

// Phase 1: built-in descriptors only. T-2.1 overrides this to return built-ins ∪ user profiles and
// to merge the `backendEnabled.<id>` flags — the single unified list every UI layer reads.
function list() {
  return Array.from(registry.values());
}

// The core terminal env shared by every backend spawn (00 §4 spawn pseudo:
// ptyEnv = {...cleanPtyEnv, ...backendCoreEnv(port), ...resolveEnv(launch.env)}). Mirrors the
// existing Claude injectors (main.js:3110-3117): iTerm identity (so Claude emits OSC 9) + the MCP
// IDE-bridge port when one was started for this session.
function backendCoreEnv({ mcpPort } = {}) {
  const env = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'iTerm.app',
    TERM_PROGRAM_VERSION: '3.6.6',
    FORCE_COLOR: '3',
    ITERM_SESSION_ID: '1',
  };
  if (mcpPort != null) env.CLAUDE_CODE_SSE_PORT = String(mcpPort);
  return env;
}

// --- planned Axis-B dummies (00 §5.8): shown in Settings as "Coming soon", never spawned/scanned.
// A guard (T-3.6) blocks `planned` (or disabled) ids from the spawn + scan paths. These carry no
// working hooks; Phases 4–6 replace codex/hermes/pi with real `ready` descriptors.
function plannedDummy({ id, label, monogram, colour }) {
  return {
    id, label, tier: 1, axis: 'B', status: 'planned', monogram, colour,
    configFields: [],
    buildLaunch() { throw new Error(`backend '${id}' is planned (not built yet) — cannot launch`); },
    discoverSessions() { return []; },
    parseSession() { return null; },
    watchTargets() { return []; },
    deriveState: null, // uniform with claude.js: null = "state derived elsewhere / not applicable"
  };
}

function registerPlannedDummies() {
  register(plannedDummy({ id: 'codex',  label: 'Codex',      monogram: 'Cx', colour: 'codex'  }));
  register(plannedDummy({ id: 'hermes', label: 'Hermes',     monogram: 'H',  colour: 'hermes' }));
  register(plannedDummy({ id: 'pi',     label: 'Pi',         monogram: 'Pi', colour: 'pi'     }));
  register(plannedDummy({ id: 'gemini', label: 'Gemini CLI', monogram: 'G',  colour: 'gemini' }));
}

// --- test hook: wipe + re-seed the registry deterministically.
function _resetForTests() {
  registry.clear();
}

// Seed the default registry: the real Claude adapter + the planned Axis-B dummies.
function _seedDefaults() {
  registry.clear();
  register(require('./claude'));
  registerPlannedDummies();
}

_seedDefaults();

module.exports = {
  register, get, has, list, backendCoreEnv,
  _resetForTests, _seedDefaults, plannedDummy,
};
