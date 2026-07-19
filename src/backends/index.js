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

// Options that belong to SWITCHBOARD, not to any one CLI — so they are added here, once, instead of
// being copied into four descriptors and drifting.
//
// `preLaunchCmd` was Claude's, which was never a decision: it is a raw shell prefix (`nvm use 20 &&`,
// `aws-vault exec profile --`) and has nothing to do with Claude. It was gated on the claude binary
// because only Claude spawns through a SHELL — the Axis-B backends use argv mode (no shell to prefix,
// because Windows shell quoting mangles their arguments). The fix is not to make the option Claude's
// forever; it is to spawn through the shell when, and only when, someone actually sets one. main.js does
// that, and the argv path stays the default for everyone who does not.
const UNIVERSAL_FIELDS = [
  {
    id: 'preLaunchCmd',
    label: 'Pre-launch command',
    type: 'text',
    default: '',
    // Applied by main.js at the spawn site: it PREFIXES the command line, so it is not part of the argv
    // this backend's buildLaunch returns.
    appliesAt: 'spawn',
    description: 'Runs in the shell immediately before the CLI, on the same line — e.g. `nvm use 20 &&` or '
      + '`aws-vault exec profile --`. Setting one makes the session start through a shell instead of '
      + 'spawning the binary directly.',
  },
];

/** A descriptor as the app sees it: its own options, plus the ones Switchboard adds to every backend. */
function withUniversalFields(descriptor) {
  const own = Array.isArray(descriptor.configFields) ? descriptor.configFields : [];
  const missing = UNIVERSAL_FIELDS.filter(u => !own.some(f => f.id === u.id));
  if (!missing.length) return descriptor;
  return { ...descriptor, configFields: [...own, ...missing] };
}

// Register (or replace) a descriptor. Later phases swap a `planned` dummy for the real `ready` one.
function register(descriptor) {
  if (!descriptor || typeof descriptor.id !== 'string' || descriptor.id === '') {
    throw new Error('backend descriptor needs a non-empty string id');
  }
  registry.set(descriptor.id, withUniversalFields(descriptor));
  return descriptor;
}

// Is a backend user-activated? `backendEnabled.<id>` (global-only, §5.8). Default: only `claude` for
// built-ins; a template is enabled on creation. `planned` can never be enabled.
//
// Claude is NOT exempt (#162). It never was here — `id === 'claude'` is only the default when nothing is
// stored — but the UI pretended otherwise, and the model was not ready for the truth. It is now.
//
// A TEMPLATE follows its base backend: disabling a backend disables the templates that run on it, because
// a template runs that backend's binary and there is nothing left to launch. Deliberate and uniform: a
// DeepSeek template runs the *claude* binary, so disabling Claude stops it too.
function isEnabled(descriptor, enabledMap, seen) {
  if (descriptor.status === 'planned') return false;

  if (descriptor.isProfile) {
    const base = registry.get(descriptor.baseId || 'claude');
    // Guard against a cycle even though a template's base must be a built-in — a future change that
    // allowed a template on a template must not spin here.
    const chain = seen || new Set();
    if (base && !chain.has(base.id)) {
      chain.add(descriptor.id);
      if (!isEnabled(base, enabledMap, chain)) return false;
    }
  }

  const stored = enabledMap ? enabledMap[descriptor.id] : undefined;
  if (stored !== undefined) return !!stored;
  return descriptor.isProfile ? true : descriptor.id === 'claude';
}

// A user profile (Axis-A) IS a backend — the same shape as a built-in (10-phase-1 key decision: no
// parallel profile/backend abstractions). It has NO own launch: buildLaunch delegates to Claude and
// merely merges the profile's env bundle over it (00 §4 "Axis-A composition"). The bundle's `$VAR`
// refs are resolved at spawn by the caller (main.js), never here and never on disk.
function profileToDescriptor(p) {
  // The BASE backend this template runs on (#161). It used to be `registry.get('claude')`, always — a
  // template could not say what it ran on, and the editor never said either.
  const baseId = p.backendId || 'claude';
  const base = registry.get(baseId);

  // A template whose base is gone (unregistered, or a `planned` dummy) must not throw on launch — the
  // old code dereferenced `claude.buildLaunch` unguarded. It stays visible in Settings, says what is
  // wrong, and simply cannot be started.
  const usable = !!base && base.status === 'ready';

  return {
    id: p.id,
    label: p.name,
    tier: 1,
    // 'A' is the historical name for "runs another backend's binary". It is no longer Claude-specific:
    // the axis says the template has no store of its own, not which binary it borrows.
    axis: 'A',
    status: usable ? 'ready' : 'planned',
    isProfile: true,
    baseId,
    baseLabel: base ? base.label : baseId,
    icon: p.icon || null,
    monogram: null,           // renderer derives the glyph from icon/id
    colour: p.icon || 'default',
    // The template's own option values — the TOP layer of the cascade (default → global → project →
    // template). Only what it explicitly set; the rest falls through to the base backend's own defaults.
    templateOptions: p.options || {},
    templateEnv: p.env || {},
    caveat: usable ? base.caveat : `Its backend (${baseId}) is not available, so this template cannot start.`,
    // Same binary -> same launch options. The template's own values live in `backendDefaults.<templateId>`
    // and cascade over the base backend's (see dialogs.js `storedDefaultsFor`).
    configFields: usable ? base.configFields : [],
    PARSER_SCHEMA_VERSION: base ? base.PARSER_SCHEMA_VERSION : undefined,
    supportsFork: base ? base.supportsFork : false,
    supportsSubagents: base ? base.supportsSubagents === true : false,   // #230
    transcriptAccess: base ? base.transcriptAccess : undefined,
    // A template's sessions are written by the base binary, into the base's store, in the base's format —
    // so the base is also the one that can move them and delete them. Without these two the project
    // manager treated every template like Hermes: the remap left its sessions behind at the old path, and
    // the Remove dialog offered no switch for them and blamed a read-only database that does not exist.
    // Absent on a base that declares neither (Hermes), which is the honest answer, not a silent no-op.
    ...(base && typeof base.rewriteProjectPath === 'function' ? { rewriteProjectPath: base.rewriteProjectPath } : {}),
    ...(base && typeof base.deleteSessions === 'function' ? { deleteSessions: base.deleteSessions } : {}),
    buildLaunch(ctx) {
      if (!usable) throw new Error(`Template '${p.name}' runs on '${baseId}', which is not available.`);
      const launch = base.buildLaunch(ctx);
      // The template's env bundle wins over the base's. That is the whole point of an Axis-A template:
      // same binary, different endpoint. `$VAR` refs are resolved at spawn (main.js), never here.
      return { ...launch, env: { ...(launch.env || {}), ...(p.env || {}) } };
    },
    // A template has NO store of its own: it shares its base's entirely. The scanner skips it for
    // exactly that reason (session-cache.js), and its sessions carry the template's id as provenance
    // through the launch overlay, not through the scan.
    discoverSessions: usable ? base.discoverSessions : () => [],
    parseSession: usable ? base.parseSession : () => null,
    watchTargets: usable ? base.watchTargets : () => [],
    deriveState: base ? base.deriveState : null,
    // A template's sessions are written by the base binary in the base's format, so lineage reads exactly
    // like the base's (#193). Without forwarding this the neutral sink would skip a template's rows and a
    // forked template session would silently lose its "continued from" — the parser used to stamp it
    // regardless of backendId, so this restores that for the descriptor era.
    resolveLineage: base ? base.resolveLineage : undefined,
    // A template's rows are the base's rows in the base's store, so the transcript path and the
    // per-project config/meta are the base's too (#211) — forward both, exactly like rewriteProjectPath
    // and resolveLineage. Without transcriptPathFor a template's remap/delete could not find its files.
    transcriptPathFor: base ? base.transcriptPathFor : undefined,
    // NOT projectMeta (#211): it is the base's ~/.claude.json projects table, keyed by PROJECT PATH, not by
    // backend — a template shares the base's config, it does not add a second entry. Forwarding it made a
    // Claude-based template a second "meta backend", so the Projects admin doubled Claude's Info column and
    // showed two identical Remove-config checkboxes. The base is always launchable when its template is, so
    // listBackendsWithMeta() covers the config through the base alone.
    // Plans + memory/instruction files are the base's too (#227): a template writes into the base's store
    // and works in the same project tree, so it exposes the base's plans dir and instruction files.
    plansDir: base ? base.plansDir : () => null,
    memorySources: base ? base.memorySources : () => [],
    // A template's binary IS the base's, writing into the base's store — so the CLI-home isolation is the
    // base's too (#241). Without forwarding it, a template launched from an isolated instance would write
    // into the user's real store while its base backend wrote into the demo one.
    cliHomeEnv: base && typeof base.cliHomeEnv === 'function' ? base.cliHomeEnv : () => null,
    probe: base && typeof base.probe === 'function' ? base.probe : undefined,
    liveRefFor: base ? base.liveRefFor : undefined,
    liveState: base ? base.liveState : undefined,
    matchLiveSession: base ? base.matchLiveSession : undefined,
    sessionBucketPath: base ? base.sessionBucketPath : undefined,
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
// The target a plain "new session" launches. It must be one that can ACTUALLY launch (#162): this used
// to fall back to a hardcoded 'claude' even when Claude was disabled, handing every caller a target the
// spawn gate would then refuse. With Claude disableable, that fallback is a dead end, not a safety net.
//
// Order: the user's stored choice, then Claude (still the default backend when it is available), then
// whatever else is launchable — a Codex-only user has a working default without ever setting one. If
// NOTHING is launchable, return null and let the caller say so; inventing a target here would only move
// the error somewhere less explainable.
function getDefaultLaunchTarget() {
  const g = _getGlobalSettings() || {};
  const all = list();
  const launchable = (id) => {
    const d = all.find(b => b.id === id);
    return !!(d && d.status === 'ready' && d.enabled);
  };

  const id = g.defaultLaunchTarget;
  if (typeof id === 'string' && id && launchable(id)) return id;
  if (launchable('claude')) return 'claude';

  const first = all.find(b => b.status === 'ready' && b.enabled);
  return first ? first.id : null;
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

// --- planned Axis-B dummy factory (00 §5.8): a "Coming soon" backend, never spawned/scanned. A guard
// (T-3.6) blocks `planned` (or disabled) ids from the spawn + scan paths. Kept — and exported — because
// the app's shape must survive an unbuilt backend, and the tests exercise that guard against one. No
// built-in is planned any more: agy (Google's Antigravity CLI) became a real `ready` descriptor in #192
// (backends/agy), so the seed registers it like every other binary.
function plannedDummy({ id, label, monogram, colour }) {
  return {
    id, label, tier: 1, axis: 'B', status: 'planned', monogram, colour,
    configFields: [],
    buildLaunch() { throw new Error(`backend '${id}' is planned (not built yet) — cannot launch`); },
    discoverSessions() { return []; },
    parseSession() { return null; },
    watchTargets() { return []; },
    deriveState: null, // uniform with claude.js: null = "state derived elsewhere / not applicable"
    transcriptPathFor: (row) => (row && row.filePath) || null, // #211: uniform hook, even for a stub
    plansDir: () => null,        // #227
    memorySources: () => [],     // #227
    supportsSubagents: false,    // #230
  };
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
  // Antigravity (agy) is the next Axis-B binary and Codex' closest sibling, so it sits right under Codex
  // in the Settings > Backends list (which renders built-ins in registration order). A real `ready`
  // file-mode descriptor whose transcript happens to be a SQLite DB (#192, backends/agy).
  register(require('./agy'));
  register(require('./hermes'));   // Phase 5 — the first non-file (SQLite) backend
  register(require('./pi'));       // Phase 6 — file mode again, the payoff of the abstraction
}

_seedDefaults();

module.exports = {
  init, register, get, has, list, backendCoreEnv,
  getDefaultLaunchTarget, isEnabled, isLaunchable, launchable, profileToDescriptor,
  _resetForTests, _seedDefaults, plannedDummy,
};
