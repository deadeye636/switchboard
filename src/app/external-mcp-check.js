'use strict';
// The static check of a project's external MCP server entries (#789 slice D, spec 36).
//
// Entries in, neutral facts out: does the command resolve, is every `${VAR}` set, which backends take the entry.
// Nothing is started, nothing is requested, and no VALUE leaves this module: the reply carries variable NAMES,
// states, booleans, reason codes and the resolved command path (the user's own machine, O-D7). The settings card
// draws it; #790 reuses it for "is the server present".
//
// It says what the LAUNCH would say. The rules are the launch's own, not copies: `references` / `expand`
// (`src/shared/env-expand.js`), `entryAppliesTo` (`src/app/mcp-inject.js`), the descriptor's `externalMcpTakes`,
// and the skip rule of `externalServersSource` — an entry with an unset variable (no default) in its command,
// args, env values, cwd, url or header values is not injected, on every backend. `test/external-mcp-check-agreement.test.js`
// runs the real source and the real composer against this module.
//
// Environment (D-D7, E3): the app's environment plus the global `backendEnv.<id>` bundle of each backend, layered
// as spawn's `quietSessionEnv` layers them. Project and template variables and secrets that only spawn resolves
// are not considered, so a reply carries `envGap: true` where the answer rests on that gap.
//
// Electron-free and db-free. The world arrives through `init` (`backends`, `getSetting`, `isForeignNetworkFile`,
// `log`) or through the `context` of `checkEntries`, so `node --test` loads it.

const nodePath = require('node:path');
const { expand, references, lookupVar } = require('../shared/env-expand');
const { validateExternalMcpServers } = require('../shared/external-mcp-validate');
const { entryAppliesTo } = require('./mcp-inject');
const { resolveCommands } = require('./path-resolve');
const { readableError } = require('./readable-error');
const { isEnvRef, refVarName } = require('../backends/env-refs');

const FAILED = 'The check could not run.';
const MAX_ENTRIES = 64;
const MAX_STRING = 4096;
const MAX_ITEMS = 256;

// The closed set of codes a reply can carry. The card maps each to a sentence (T5).
const REASONS = Object.freeze({
  // command.state 'unknown' carries one of these (the resolver's, plus the caller's `unset-variable`)
  command: Object.freeze(['network', 'unreadable', 'timeout', 'relative-path-entry', 'unexpanded-path-entry', 'no-cwd', 'empty-name', 'unset-variable', 'path-overridden']),
  commandStates: Object.freeze(['found', 'missing', 'unknown', 'not-applicable']),
  takes: Object.freeze(['entry-disabled', 'backend-filter', 'unset-variable', 'transport', 'cwd', 'no-channel']),
  variableStates: Object.freeze(['app', 'backend-env', 'declared-unresolved', 'default', 'unset']),
  variableFields: Object.freeze(['command', 'args', 'env', 'cwd', 'url', 'headers']),
});

const FILTER_REASON = { disabled: 'entry-disabled', 'backend-filter': 'backend-filter' };

let ctx = { backends: null, getSetting: null, isForeignNetworkFile: null, log: null };

function init(deps = {}) {
  ctx = {
    backends: deps.backends || null,
    getSetting: typeof deps.getSetting === 'function' ? deps.getSetting : null,
    isForeignNetworkFile: typeof deps.isForeignNetworkFile === 'function' ? deps.isForeignNetworkFile : null,
    log: deps.log || null,
  };
}

const isWin = (context) => (context.platform || process.platform) === 'win32';

// A plain-object copy of the app environment, the way spawn copies it: `{ ...process.env }`.
function copyEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * One backend's own layer of the global `backendEnv`, resolved the way `resolveEnvRefs` resolves it: a whole-value
 * `$VAR` / `${VAR}` takes the app's value when that is a non-empty string and is DROPPED otherwise; a literal
 * (the empty string included) is kept. -> { values: {KEY: value}, unresolved: Set<KEY> }
 */
function backendLayer(bundle, appEnv, win) {
  const values = {};
  const unresolved = new Set();
  if (!bundle || typeof bundle !== 'object') return { values, unresolved };
  for (const [key, raw] of Object.entries(bundle)) {
    if (isEnvRef(raw)) {
      const got = lookupVar(appEnv, refVarName(raw), win);
      if (typeof got === 'string' && got !== '') values[key] = got;
      else unresolved.add(key);
    } else {
      values[key] = typeof raw === 'string' ? raw : String(raw);
    }
  }
  return { values, unresolved };
}

/**
 * The environment `${VAR}` expands against for one backend: the app's, then the backend's layer. Lookup is by
 * the exact name first and, on win32, case-insensitively after it, as `expand` does it at launch (#794).
 */
function layeredEnv(appEnv, layer) {
  // Exactly spawn's `{ ...process.env, ...layer }`: keys that differ only in case stay two keys, and `expand`
  // takes the exact spelling before a folded one.
  return { ...appEnv, ...layer.values };
}

const hasValue = (env, name, hasDefault, win) => {
  const v = lookupVar(env, name, win);
  return v !== undefined && (!hasDefault || v !== '');
};

// The fields of an entry that are expanded at launch, as [field, string] pairs. Env KEYS and header names are not.
function expandedFields(entry) {
  const out = [];
  if (entry.transport === 'stdio') {
    out.push(['command', entry.command]);
    for (const a of entry.args || []) out.push(['args', a]);
    for (const v of Object.values(entry.env || {})) out.push(['env', v]);
    if (entry.cwd !== undefined) out.push(['cwd', entry.cwd]);
  } else {
    out.push(['url', entry.url]);
    for (const v of Object.values(entry.headers || {})) out.push(['headers', v]);
  }
  return out;
}

// Every name with no default that `env` lacks, over all expanded fields — the launch's own `expand` pass.
function missingIn(entry, env, win) {
  const missing = new Set();
  for (const [, text] of expandedFields(entry)) expand(text, env, missing, { foldCase: win });
  return missing;
}

function variablesOf(entry, appEnv, layers, win) {
  const seen = new Set();
  const out = [];
  for (const [field, text] of expandedFields(entry)) {
    for (const { name, hasDefault } of references(text)) {
      const key = `${field}\0${name}\0${hasDefault}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let state;
      let backendIds;
      if (hasValue(appEnv, name, hasDefault, win)) state = 'app';
      else {
        const ids = layers.filter((l) => hasValue(l.env, name, hasDefault, win)).map((l) => l.id);
        if (ids.length) { state = 'backend-env'; backendIds = ids; }
        // A default is what the launch uses when nothing else sets the variable, so it outranks a dropped reference.
        else if (hasDefault) state = 'default';
        else state = layers.some((l) => l.layer.unresolved.has(name)) ? 'declared-unresolved' : 'unset';
      }
      const row = { name, field, hasDefault, state };
      if (backendIds) row.backendIds = backendIds;
      out.push(row);
    }
  }
  return out;
}

const SEPARATED = /[\\/]|^[A-Za-z]:/;

function takesRows(entry, checked, expandedCwd, win) {
  return checked.map(({ id, label, backend, env }) => {
    const row = (takes, reason) => ({ id, label, takes, reason });
    const applies = entryAppliesTo(entry, backend);
    if (!applies.applies) return row(false, FILTER_REASON[applies.reason] || 'backend-filter');
    const caps = backend.externalMcpTakes;
    if (!caps) return row(false, 'no-channel');
    if (missingIn(entry, env, win).size) return row(false, 'unset-variable');
    if (!Array.isArray(caps.transports) || !caps.transports.includes(entry.transport)) return row(false, 'transport');
    if (entry.transport === 'stdio' && expandedCwd(env) !== '' && caps.cwd !== true) return row(false, 'cwd');
    return row(true, null);
  });
}

// Plain data, no prototype tricks, bounded: the window's entries are untrusted input.
function withinLimits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const okString = (s) => typeof s === 'string' && s.length <= MAX_STRING;
  for (const v of Object.values(raw)) {
    if (typeof v === 'string') { if (!okString(v)) return false; continue; }
    if (Array.isArray(v)) {
      if (v.length > MAX_ITEMS || !v.every(okString)) return false;
      continue;
    }
    if (v && typeof v === 'object') {
      const e = Object.entries(v);
      if (e.length > MAX_ITEMS || !e.every(([k, x]) => okString(k) && okString(x))) return false;
    }
  }
  return true;
}

/**
 * Check entries against an environment and a set of backends.
 *
 * context: { projectPath, env, backendEnv, backends, isForeignNetworkPath, fs, now, platform, budgetMs, cacheMs }
 *   backends  — descriptors to give a verdict for (the caller picks them: enabled, ready, no template)
 *   backendEnv — the global blob's `backendEnv`: { <backendId>: { KEY: value } }
 * -> [{ index, rejected: true } | { index, name, enabled, transport, command, variables, takes, envGap }]
 */
async function checkEntries(entries, context = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const win = isWin(context);
  const appEnv = copyEnv(context.env);
  const backendEnv = context.backendEnv && typeof context.backendEnv === 'object' ? context.backendEnv : {};
  const projectPath = typeof context.projectPath === 'string' && context.projectPath && context.projectPath.length <= MAX_STRING
    ? context.projectPath : null;

  // Take the window's list apart: oversized entries are rejected before the validator sees them.
  const usable = list.map((raw) => (withinLimits(raw) ? raw : null));
  const toValidate = usable.map((raw) => raw || {});
  const valid = validateExternalMcpServers(toValidate);
  const rejectedAt = new Set(valid.rejected.map((r) => r.index));
  usable.forEach((raw, i) => { if (!raw) rejectedAt.add(i); });
  const indices = [];
  list.forEach((_, i) => { if (!rejectedAt.has(i)) indices.push(i); });
  // A validator that dropped an entry for a reason of its own keeps the zip honest: counts must match.
  const servers = valid.servers.length === indices.length ? valid.servers : [];

  const checked = (Array.isArray(context.backends) ? context.backends : []).map((backend) => {
    const layer = backendLayer(backendEnv[backend.id], appEnv, win);
    return { id: backend.id, label: String(backend.label || backend.id), backend, layer, env: layeredEnv(appEnv, layer) };
  });

  // The command fact is one answer per entry: the app's environment, then (for a variable it lacks) the first
  // backend that carries it.
  const commandEnv = { ...appEnv };
  for (const c of checked) for (const [k, v] of Object.entries(c.env)) if (commandEnv[k] === undefined) commandEnv[k] = v;

  const pathMod = win ? nodePath.win32 : nodePath.posix;
  const isPathKey = (k) => (win ? k.toUpperCase() === 'PATH' : k === 'PATH');
  // The server's command is looked up with the SESSION's PATH at launch: a backend variable or the entry's own
  // env may replace the app's. A miss on the app's PATH is then no evidence of absence (D-D5). Only a PATH that
  // reaches a launch counts: the entry's own, or a resolved one of a backend that would take the entry (a
  // `$REF` the app cannot fill is dropped at launch and overrides nothing).
  const overridesPath = (entry, takes) => Object.keys(entry.env || {}).some(isPathKey)
    || checked.some((c) => takes.some((t) => t.id === c.id && t.takes === true) && Object.keys(c.layer.values).some(isPathKey));

  const plans = servers.map((entry) => {
    const plan = { entry, command: { state: 'not-applicable' }, name: null, group: null };
    if (entry.transport !== 'stdio') return plan;
    const missing = new Set();
    const command = expand(entry.command, commandEnv, missing, { foldCase: win });
    if (missing.size) { plan.command = { state: 'unknown', reason: 'unset-variable' }; return plan; }
    let cwd = entry.cwd !== undefined ? expand(entry.cwd, commandEnv, missing, { foldCase: win }) : '';
    if (missing.size) cwd = '';
    plan.name = command;
    // A bare name walks PATH (the launch's directory is irrelevant); a path is relative to the entry's own cwd.
    // A relative cwd is relative to the project, as at launch; the resolver still applies the network guard.
    if (cwd && !pathMod.isAbsolute(cwd) && projectPath) cwd = pathMod.resolve(projectPath, cwd);
    plan.group = SEPARATED.test(command) && cwd ? cwd : projectPath;
    return plan;
  });

  const groups = new Map();
  for (const p of plans) {
    if (p.name === null) continue;
    const key = p.group === null ? '\0' : p.group;
    if (!groups.has(key)) groups.set(key, { cwd: p.group, names: new Set() });
    groups.get(key).names.add(p.name);
  }
  const answers = new Map();
  for (const [key, g] of groups) {
    answers.set(key, await resolveCommands([...g.names], {
      env: appEnv, cwd: g.cwd || undefined, isForeignNetworkPath: context.isForeignNetworkPath,
      fs: context.fs, now: context.now, platform: context.platform, budgetMs: context.budgetMs,
      concurrency: context.concurrency, cacheMs: context.cacheMs,
    }));
  }

  const byIndex = new Map();
  plans.forEach((plan, k) => {
    const { entry } = plan;
    const expandedCwd = (env) => (entry.cwd !== undefined ? expand(entry.cwd, env, new Set(), { foldCase: win }) : '');
    const takes = takesRows(entry, checked, expandedCwd, win);
    if (plan.name !== null) {
      const a = answers.get(plan.group === null ? '\0' : plan.group).get(plan.name);
      // Only a bare name is looked up on PATH; a command given as a path is not, so another PATH changes nothing.
      const command = a.state === 'missing' && !SEPARATED.test(plan.name) && overridesPath(entry, takes)
        ? { state: 'unknown', reason: 'path-overridden' }
        : { state: a.state };
      if (a.reason && !command.reason) command.reason = a.reason;
      if (a.resolved) command.resolved = a.resolved;
      if (a.ext) command.ext = a.ext;
      if (typeof a.executable === 'boolean') command.executable = a.executable;
      plan.command = command;
    }
    const variables = variablesOf(entry, appEnv, checked.map((c) => ({ id: c.id, env: c.env, layer: c.layer })), win);
    byIndex.set(indices[k], {
      index: indices[k],
      name: entry.name,
      enabled: entry.enabled !== false,
      transport: entry.transport,
      command: plan.command,
      variables,
      takes,
      envGap: variables.some((v) => v.state !== 'app' && v.state !== 'default'),
    });
  });

  return list.map((_, i) => byIndex.get(i) || { index: i, rejected: true });
}

// The backends a verdict is given for: the ones the settings card offers as choices (enabled, not a template),
// and ready. A template is not asked: it runs its base's binary and inherits the base's declaration.
function checkableBackends(list) {
  return (Array.isArray(list) ? list : []).filter((b) => b && b.enabled && !b.isProfile && b.status === 'ready' && typeof b.id === 'string');
}

async function check(request) {
  try {
    const req = request && typeof request === 'object' ? request : {};
    const entries = req.entries;
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) {
      if (ctx.log && ctx.log.debug) ctx.log.debug('[external-mcp-check] refused: the entry list is not an array within the cap');
      return { ok: false, reason: FAILED };
    }
    const global = (ctx.getSetting && ctx.getSetting('global')) || {};
    const isForeign = ctx.isForeignNetworkFile;
    const results = await checkEntries(entries, {
      projectPath: req.projectPath,
      env: process.env,
      backendEnv: global.backendEnv,
      backends: checkableBackends(ctx.backends ? ctx.backends.list() : []),
      isForeignNetworkPath: isForeign ? (p) => isForeign(p) : undefined,
    });
    return { ok: true, results };
  } catch (err) {
    // The raw text goes to the log; the reply is a sentence that names nothing.
    readableError(err, FAILED, ctx.log || undefined);
    if (ctx.log && ctx.log.warn) ctx.log.warn('[external-mcp-check] the check threw; see the debug line above');
    return { ok: false, reason: FAILED };
  }
}

function registerIpc(ipc) {
  ipc.handle('external-mcp-check', (_event, request) => check(request));
}

module.exports = { init, registerIpc, checkEntries, checkableBackends, REASONS, FAILED };
