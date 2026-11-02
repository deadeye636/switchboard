// app/plugins-inventory.js — the plugins and apps the Plugins manager lists (#803, spec 40).
//
// One row per installed plugin, package or extension across backends, and one per app a backend reports.
// The core names no backend and reads no format: each descriptor answers through hooks in its own folder.
//
// PLUGINS, two roads, and the descriptor picks:
//   - `listPlugins({ projectPath })` — a backend that can say what is installed AND whether it is on answers
//     `{ ok, plugins: [{ name, scope, state, path, brings }] }` (Claude, Codex). `state` is that backend's
//     reading of its own settings, `brings` neutral words for what the plugin carries.
//   - `listPlugins: null` — the backend states no on/off. Its `listResources` rows of the plugin kinds are
//     shown instead: a directory row is read one level through the backend's own `expandResource` (one
//     entry per plugin), a row without a path is one entry, and the state is "not reported" — never a
//     guess (owner decision E6: read-only, from the descriptor).
//
// APPS: `listApps({ projectPath })` → `{ ok, apps: [{ name, state }] }`, optional. No backend implements it
// today, so the list is empty and the view says so (owner decision E3).
//
// One asker per CLI (`oneAskerPerCli`): a driver of a CLI and a template on a base read the same install,
// and listing them both would show every plugin twice. No IPC answer carries a backend id (reflex 5).
//
// COST: all of it is synchronous on the main process — each backend's listing (twice with a project) and
// a few stats per installed plugin. Acceptable for a list the user opens in Settings; not for a poll.
'use strict';

const crypto = require('crypto');
const path = require('path');

let ctx = null;

function init(context) {
  ctx = context;
}

// The listing kinds that are plugins in the manager's sense — core vocabulary, like 'skill' and 'command'.
const PLUGIN_KINDS = ['plugin', 'package', 'extension'];
const STATES = new Set(['enabled', 'disabled']);

/** A hook that threw: logged for whoever wonders where a backend's plugins went, never sent to a window. */
function debug(descriptor, hook, err) {
  try { ctx.log.debug(`[plugins] ${descriptor.id}.${hook} failed:`, (err && err.code) || 'error'); } catch {}
}

function backendById(id) {
  try { return ctx.backends.get(id) || null; } catch { return null; }
}

/** Ready, not a profile, one per CLI — the Agent Files rule, so the lists cannot name a CLI differently. */
function inventoryBackends() {
  try {
    if (!ctx.backends || typeof ctx.backends.list !== 'function') return [];
    const ready = (ctx.backends.list() || []).filter(b => b && !b.isProfile && b.status === 'ready');
    return typeof ctx.backends.oneAskerPerCli === 'function' ? ctx.backends.oneAskerPerCli(ready) : ready;
  } catch { return []; }
}

function rowId(parts) {
  return crypto.createHash('sha1').update(parts.map(p => String(p == null ? '' : p).toLowerCase()).join('\0')).digest('hex').slice(0, 16);
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** A descriptor's own answer, checked field by field: what crosses to a window is what was checked. */
function fromHook(descriptor, projectPath) {
  let answer = null;
  try { answer = descriptor.listPlugins({ projectPath: projectPath || null }); } catch (err) { debug(descriptor, 'listPlugins', err); return []; }
  if (!answer || answer.ok === false || !Array.isArray(answer.plugins)) return [];
  const out = [];
  for (const p of answer.plugins) {
    const name = p && str(p.name);
    if (!name) continue;
    out.push({
      kind: 'plugin',
      name,
      scope: p.scope === 'project' ? 'project' : 'global',
      state: STATES.has(p.state) ? p.state : 'not reported',
      path: str(p.path),
      brings: Array.isArray(p.brings) ? p.brings.filter(w => typeof w === 'string' && w) : [],
    });
  }
  return out;
}

/** The listing's plugin rows, for a backend that states no on/off. */
function fromListing(descriptor, projectPath) {
  if (typeof descriptor.listResources !== 'function') return [];
  const out = [];
  const seen = new Set();
  const add = (row) => {
    const key = [row.kind, row.scope, row.name, row.path || ''].join('\0').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  };
  // Both scopes, as the skill inventory asks: the global answer, then the project's own rows.
  for (const scopePath of projectPath ? [null, projectPath] : [null]) {
    let listed = null;
    try { listed = descriptor.listResources({ projectPath: scopePath }); } catch (err) { debug(descriptor, 'listResources', err); continue; }
    if (!listed || listed.ok === false || !Array.isArray(listed.resources)) continue;
    for (const entry of listed.resources) {
      if (!entry || !PLUGIN_KINDS.includes(entry.kind)) continue;
      const scope = entry.scope === 'project' ? 'project' : 'global';
      if (scopePath && scope !== 'project') continue;
      if (!entry.path) {
        const name = str(entry.name);
        if (name) add({ kind: entry.kind, name, scope, state: 'not reported', path: null, brings: [] });
        continue;
      }
      let expanded = null;
      if (typeof descriptor.expandResource === 'function') {
        try {
          expanded = descriptor.expandResource({ path: entry.path, source: entry.source, scope: entry.scope, projectPath: projectPath || null });
        } catch (err) {
          debug(descriptor, 'expandResource', err);
          expanded = null;
        }
      }
      // A directory the backend has no reading rule for (Pi's installed npm/git package directories) is
      // still something installed: it is shown as the one entry it is, rather than dropped without a trace.
      if (!expanded || expanded.ok === false || !Array.isArray(expanded.entries)) {
        const name = str(entry.name) || path.basename(entry.path);
        add({ kind: entry.kind, name, scope, state: 'not reported', path: str(entry.path), brings: [] });
        continue;
      }
      for (const child of expanded.entries) {
        const name = child && str(child.name);
        if (!name) continue;
        add({ kind: entry.kind, name, scope, state: 'not reported', path: str(child.path), brings: [] });
      }
    }
  }
  return out;
}

/**
 * Every installed plugin, package and extension for one project: `{ plugins: [{ id, kind, name,
 * backendLabel, scope, state, path, brings }] }`, sorted by name. A backend that throws is skipped and
 * the others still answer.
 */
function getPluginInventory({ projectPath = null } = {}) {
  const plugins = [];
  for (const b of inventoryBackends()) {
    const descriptor = backendById(b.id);
    if (!descriptor) continue;
    const label = descriptor.label || descriptor.id;
    const rows = typeof descriptor.listPlugins === 'function'
      ? fromHook(descriptor, projectPath)
      : fromListing(descriptor, projectPath);
    for (const r of rows) {
      plugins.push({ id: rowId([descriptor.id, r.kind, r.scope, r.name, r.path]), backendLabel: label, ...r });
    }
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name) || a.backendLabel.localeCompare(b.backendLabel));
  return { plugins };
}

/** Every app a backend reports: `{ apps: [{ id, name, backendLabel, state }] }`. Empty while none answers. */
function getAppInventory({ projectPath = null } = {}) {
  const apps = [];
  for (const b of inventoryBackends()) {
    const descriptor = backendById(b.id);
    if (!descriptor || typeof descriptor.listApps !== 'function') continue;
    let answer = null;
    try { answer = descriptor.listApps({ projectPath: projectPath || null }); } catch (err) { debug(descriptor, 'listApps', err); continue; }
    if (!answer || answer.ok === false || !Array.isArray(answer.apps)) continue;
    const label = descriptor.label || descriptor.id;
    for (const a of answer.apps) {
      const name = a && str(a.name);
      if (!name) continue;
      apps.push({ id: rowId([descriptor.id, 'app', name]), name, backendLabel: label, state: STATES.has(a.state) ? a.state : 'not reported' });
    }
  }
  apps.sort((a, b) => a.name.localeCompare(b.name) || a.backendLabel.localeCompare(b.backendLabel));
  return { apps };
}

/** Wire the IPC surface. main.js hands in ipcMain; this file never requires electron. */
function registerIpc(ipcMain) {
  const projectOf = (p) => (typeof p === 'string' && p ? p : null);
  ipcMain.handle('get-plugin-inventory', (_e, projectPath) => getPluginInventory({ projectPath: projectOf(projectPath) }));
  ipcMain.handle('get-app-inventory', (_e, projectPath) => getAppInventory({ projectPath: projectOf(projectPath) }));
}

module.exports = { init, registerIpc, getPluginInventory, getAppInventory, PLUGIN_KINDS };
