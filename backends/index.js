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

// Injected by main.js (T-2.1) so the registry can merge user state without importing electron:
//   getGlobalSettings() -> the global settings blob (holds backendEnabled.<id> + defaultLaunchTarget)
//   profiles            -> the profiles module (user-created Axis-A backends)
// Left un-injected (unit tests), list() simply returns the built-ins with default enabled flags.
let _getGlobalSettings = () => ({});
let _profiles = null;

function init({ getGlobalSettings, profiles } = {}) {
  if (typeof getGlobalSettings === 'function') _getGlobalSettings = getGlobalSettings;
  if (profiles) _profiles = profiles;
}

// Register (or replace) a descriptor. Later phases swap a `planned` dummy for the real `ready` one.
function register(descriptor) {
  if (!descriptor || typeof descriptor.id !== 'string' || descriptor.id === '') {
    throw new Error('backend descriptor needs a non-empty string id');
  }
  registry.set(descriptor.id, descriptor);
  return descriptor;
}

// Is a backend user-activated? `backendEnabled.<id>` (global-only, §5.8). Default: only `claude` for
// built-ins; a user profile is enabled on creation. `planned` can never be enabled.
function isEnabled(descriptor, enabledMap) {
  if (descriptor.status === 'planned') return false;
  const stored = enabledMap ? enabledMap[descriptor.id] : undefined;
  if (stored !== undefined) return !!stored;
  return descriptor.isProfile ? true : descriptor.id === 'claude';
}

// A user profile (Axis-A) IS a backend — the same shape as a built-in (10-phase-1 key decision: no
// parallel profile/backend abstractions). It has NO own launch: buildLaunch delegates to Claude and
// merely merges the profile's env bundle over it (00 §4 "Axis-A composition"). The bundle's `$VAR`
// refs are resolved at spawn by the caller (main.js), never here and never on disk.
function profileToDescriptor(p) {
  const claude = registry.get('claude');
  return {
    id: p.id,
    label: p.name,
    tier: 1,
    axis: 'A',
    status: 'ready',
    isProfile: true,
    icon: p.icon || null,
    monogram: null,           // renderer derives the glyph from icon/id
    colour: p.icon || 'default',
    configFields: claude ? claude.configFields : [],  // same binary -> same launch options
    buildLaunch(ctx) {
      const launch = claude.buildLaunch(ctx);
      return { ...launch, env: { ...(launch.env || {}), ...(p.env || {}) } };
    },
    // Axis-A shares Claude's store/format entirely.
    discoverSessions: claude ? claude.discoverSessions : () => [],
    parseSession: claude ? claude.parseSession : () => null,
    watchTargets: claude ? claude.watchTargets : () => [],
    deriveState: null,
  };
}

// Resolve a backend id -> descriptor. Looks through built-ins first, then user profiles, so
// `backends.get(sessionOptions.backendId)` works uniformly for both.
function get(id) {
  const builtin = registry.get(id);
  if (builtin) return builtin;
  if (_profiles) {
    const p = _profiles.get(id);
    if (p) return profileToDescriptor(p);
  }
  return null;
}

function has(id) {
  return get(id) != null;
}

// The single unified list every UI layer reads: built-ins ∪ user profiles, each carrying its merged
// `enabled` flag. Only `ready && enabled` entries may appear in launch surfaces / be scanned (§5.8);
// the callers apply that filter, this returns the full set (Settings needs the disabled/planned rows).
// Is the backend's binary actually there? A descriptor may declare a `probe()`; the answer rides on
// every list() so Settings can say "not installed" instead of letting the user enable a backend whose
// launch then dies with a raw shell error. Availability is NOT part of the §5.8 launch gate (a probe is
// a heuristic — a false negative must never make a working backend unusable); the spawn path checks it
// and refuses there, with the probe's own reason.
// Cached briefly: list() is on the scan path, and a probe walks PATH.
const PROBE_TTL_MS = 15000;
const _probeCache = new Map();   // id -> { at, result }

function availability(b) {
  if (typeof b.probe !== 'function') return { available: true, unavailableReason: null };
  const now = Date.now();
  const hit = _probeCache.get(b.id);
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.result;
  let result;
  try {
    const p = b.probe();
    result = (p && p.ok === false)
      ? { available: false, unavailableReason: p.reason || null }
      : { available: true, unavailableReason: null };
  } catch (err) {
    result = { available: false, unavailableReason: err?.message || String(err) };
  }
  _probeCache.set(b.id, { at: now, result });
  return result;
}

function list() {
  const g = _getGlobalSettings() || {};
  const enabledMap = g.backendEnabled || {};
  const out = [];
  for (const b of registry.values()) {
    out.push({ ...b, enabled: isEnabled(b, enabledMap), ...availability(b) });
  }
  if (_profiles) {
    for (const p of _profiles.list()) {
      const d = profileToDescriptor(p);
      out.push({ ...d, enabled: isEnabled(d, enabledMap), ...availability(d) });
    }
  }
  return out;
}

// May this backend be spawned/scanned at all? The §5.8 gate: `ready` (built) AND `enabled` (activated
// by the user). A `planned` binary or a disabled backend must never spawn and never have its roots
// scanned. Note: disable ≠ erase — a disabled backend's ALREADY-CACHED sessions stay visible; only
// launching and re-scanning stop.
function isLaunchable(id) {
  const d = list().find(b => b.id === id);
  return !!(d && d.status === 'ready' && d.enabled);
}

// Every backend that may currently be spawned or scanned.
function launchable() {
  return list().filter(b => b.status === 'ready' && b.enabled);
}

// The one backend/profile a plain new-session action launches (00 §4). Falls back to `claude` when
// unset or when the stored target no longer exists / isn't launchable.
function getDefaultLaunchTarget() {
  const g = _getGlobalSettings() || {};
  const id = g.defaultLaunchTarget;
  if (typeof id === 'string' && id) {
    const d = list().find(b => b.id === id);
    if (d && d.status === 'ready' && d.enabled) return id;
  }
  return 'claude';
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

// Axis-B binaries not built yet.
//
// `agy` = Google's Antigravity CLI. It REPLACES the Gemini CLI, which Google retired in June 2026
// (https://antigravity.google/docs/cli/install) — a single Go binary, installed to ~/.local/bin/agy or
// via `npm i -g @google/antigravity-cli`, which imports an existing ~/.gemini config on first run. The
// old `gemini` id is gone, not aliased: it was never built, so nothing can reference it.
function registerPlannedDummies() {
  register(plannedDummy({ id: 'agy', label: 'Antigravity CLI', monogram: 'Ag', colour: 'agy' }));
}

// --- test hook: wipe + re-seed the registry deterministically.
function _resetForTests() {
  registry.clear();
}

// Seed the default registry: the real adapters (Claude default + Codex, Phase 4) + the planned dummies.
// A `ready` backend still needs the user to ENABLE it (§5.8) — only `claude` is on out of the box.
function _seedDefaults() {
  registry.clear();
  register(require('./claude'));
  register(require('./codex'));
  register(require('./hermes'));   // Phase 5 — the first non-file (SQLite) backend
  register(require('./pi'));       // Phase 6 — file mode again, the payoff of the abstraction
  registerPlannedDummies();
}

_seedDefaults();

module.exports = {
  init, register, get, has, list, backendCoreEnv,
  getDefaultLaunchTarget, isEnabled, isLaunchable, launchable, profileToDescriptor,
  _resetForTests, _seedDefaults, plannedDummy,
};
