// app/resource-inventory.js — the neutral inventory of agents, commands and rules (#823, spec 44).
//
// One row per FILE across backends, for the three Plugins views that replace the Agent Files tab's groups.
// The core names no backend and reads no format: each descriptor answers through `listResources` and
// `expandResource`, the same seam the skill inventory (`skills.js`) and the Plugins manager use, and the
// `kind` words are the shared vocabulary of the listing (`RESOURCE_VIEWS` below is the one table that says
// which kind belongs to which view).
//
// A BACKEND THAT HAS NO SUCH KIND DECLINES, and the view says so: `declines` holds one sentence per CLI that
// reports no row, no listed source and no scaffold for the view's kinds ("<CLI> keeps no agents here").
//
// One asker per CLI (`oneAskerPerCli`): a driver of a CLI and a template on a base read the same files.
// A driver folds into its owner for the `cli` / `clis` stamps (`cliOwnerOf`), as in #824. No path and no
// backend id FIELD leave this module: a row is named by an opaque id, the sha of its `pathKey`. The owner CLI's
// id travels only as the opaque `cli.key` of the #824 stamps (spec 40), which a window uses to filter and never
// to decide anything.
//
// The door that reads, writes, creates and deletes by id is the next step (spec 44); this module only
// lists, and decides `editable` / `deletable` / `creatable` with the same predicates that door will use, so
// nothing is offered that the door would then refuse.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const backendResources = require('./backend-resources');
const { pathKey } = require('./path-containment');

let ctx = null;

function init(context) {
  ctx = context;
}

/**
 * Which listing kinds each view shows (spec 44, "Kind mapping"). Kinds are the core's shared vocabulary, never
 * a backend id. Hooks are scripts: listed read-only (`READ_ONLY_KINDS`, whatever the extension) and never deleted.
 */
const RESOURCE_VIEWS = {
  agents: ['agent'],
  commands: ['command', 'prompt-template', 'workflow', 'skill-bundle'],
  rules: ['rule', 'hook'],
};

/** Kinds the app lists but never writes or deletes, whatever a descriptor's `resourceEditing` says. */
const READ_ONLY_KINDS = ['hook'];

function backendById(id) {
  try { return ctx.backends.get(id) || null; } catch { return null; }
}

/** Ready, not a profile, one per CLI — the rule of `skills.js` and `plugins-inventory.js`. */
function inventoryBackends() {
  try {
    if (!ctx.backends || typeof ctx.backends.list !== 'function') return [];
    const ready = (ctx.backends.list() || []).filter(b => b && !b.isProfile && b.status === 'ready');
    return typeof ctx.backends.oneAskerPerCli === 'function' ? ctx.backends.oneAskerPerCli(ready) : ready;
  } catch { return []; }
}

/** The CLI a descriptor belongs to: `{ key, label }` of its owner (a driver counts as its CLI). */
function cliOf(descriptor) {
  let owner = descriptor;
  try {
    if (typeof ctx.backends.cliOwnerOf === 'function') owner = ctx.backends.cliOwnerOf(descriptor) || descriptor;
  } catch { owner = descriptor; }
  return { key: owner.id, label: owner.label || owner.id };
}

/** A stable id for one file, decided here so the renderer never builds one from a path. */
function resourceId(filePath) {
  return crypto.createHash('sha1').update(pathKey(filePath)).digest('hex').slice(0, 16);
}

function scaffoldFor(descriptor, kind) {
  const declared = Array.isArray(descriptor.resourceScaffolds) ? descriptor.resourceScaffolds : [];
  return declared.find(s => s && s.kind === kind && typeof s.template === 'function') || null;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** A hook that threw: logged for whoever wonders where a backend's rows went, never sent to a window. */
function debug(descriptor, hook, err) {
  try { ctx.log.debug(`[resources] ${descriptor.id}.${hook} failed:`, (err && err.code) || 'error'); } catch { /* quiet */ }
}

/**
 * The entries one backend reports for the view's kinds in one scope: `{ entry, child }` pairs, where `child`
 * is a file the backend's own expander named under a listed directory (or the listed file itself).
 */
function backendFiles(descriptor, kinds, projectPath, scope, facts) {
  if (typeof descriptor.listResources !== 'function') return [];
  let listed = null;
  try { listed = descriptor.listResources({ projectPath: scope === 'project' ? projectPath : null }); }
  catch (err) { debug(descriptor, 'listResources', err); return []; }
  if (!listed || listed.ok === false || !Array.isArray(listed.resources)) return [];
  const resources = listed.resources;

  const out = [];
  for (const entry of resources) {
    if (!entry || !kinds.includes(entry.kind)) continue;
    if ((entry.scope || 'global') !== scope) continue;
    if (!entry.path) { facts.listed = true; continue; }
    let expanded = null;
    if (typeof descriptor.expandResource === 'function') {
      try {
        expanded = descriptor.expandResource({ path: entry.path, source: entry.source, scope: entry.scope, projectPath: projectPath || null });
      } catch (err) { debug(descriptor, 'expandResource', err); expanded = null; }
    }
    // An expander that answers a promise is not read here (the inventory is synchronous): that is a failure,
    // and it must not count as a listed source, or the CLI could never decline.
    if (expanded && typeof expanded.then === 'function') {
      debug(descriptor, 'expandResource', { code: 'async' });
      continue;
    }
    facts.listed = true;
    if (expanded && expanded.ok !== false && Array.isArray(expanded.entries)) {
      for (const child of expanded.entries) {
        if (!child || !child.path || !child.name) continue;
        const kind = child.kind || entry.kind;
        if (!kinds.includes(kind)) continue;
        out.push({ entry, kind, name: child.name, filePath: child.path, resources });
      }
    } else if (isFile(entry.path)) {
      out.push({ entry, kind: entry.kind, name: entry.name || path.basename(entry.path), filePath: entry.path, resources });
    }
  }
  return out;
}

/**
 * Every file of one view for one project, one row per real path, with its owners kept beside it. Not for the
 * renderer: that one gets `getResourceInventory`. The owners are what the door of the next step needs.
 */
function collect(view, projectPath) {
  const kinds = RESOURCE_VIEWS[view];
  const byKey = new Map();
  const perCli = [];
  for (const b of inventoryBackends()) {
    const descriptor = backendById(b.id);
    if (!descriptor) continue;
    const cli = cliOf(descriptor);
    const facts = { cli, listed: false, rows: 0, scaffold: kinds.some(k => scaffoldFor(descriptor, k)) };
    perCli.push(facts);
    for (const scope of projectPath ? ['global', 'project'] : ['global']) {
      for (const f of backendFiles(descriptor, kinds, projectPath, scope, facts)) {
        facts.rows += 1;
        const owner = {
          backendId: descriptor.id,
          cli,
          fromPlugin: !!f.entry.fromPlugin,
          // A hook is a script: read-only whatever its extension, so an `.md` hook is never offered an Edit.
          door: !READ_ONLY_KINDS.includes(f.kind)
            && backendResources._editableHere(descriptor, f.filePath)
            && backendResources._reachable(descriptor, f.resources, f.filePath),
          creatable: !!scaffoldFor(descriptor, f.kind),
        };
        const key = pathKey(f.filePath);
        const kept = byKey.get(key);
        if (!kept) {
          byKey.set(key, {
            id: resourceId(f.filePath), name: f.name, kind: f.kind, scope, filePath: f.filePath,
            originLabel: f.entry.originLabel || null,
            sourceLabel: `${descriptor.label || descriptor.id} · ${f.entry.originLabel || scope}`,
            owners: [owner],
          });
        } else if (!kept.owners.some(o => o.cli.key === owner.cli.key && o.backendId === owner.backendId)) {
          kept.owners.push(owner);
        }
      }
    }
  }
  const rows = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.sourceLabel.localeCompare(b.sourceLabel));
  return { rows, perCli };
}

function distinctClis(owners) {
  const out = [];
  for (const o of owners) if (!out.some(c => c.key === o.cli.key)) out.push(o.cli);
  return out;
}

/**
 * The neutral inventory of one view: `{ ok, rows, declines }`.
 * A row is `{ id, name, kind, scope, sourceLabel, originLabel, cli, clis, editable, deletable, fromPlugin,
 * creatable }`. `deletable` follows the skills rule (spec 40 E16): the kind has a lifecycle, a backend's door
 * admits Edit, and nothing a plugin installed — a second CLI listing the same folder unmarked does not open it.
 */
function getResourceInventory({ view, projectPath = null } = {}) {
  if (!Object.prototype.hasOwnProperty.call(RESOURCE_VIEWS, view)) return { ok: false, reason: 'Unknown view.' };
  const { rows, perCli } = collect(view, projectPath);
  const out = rows.map(r => {
    const clis = distinctClis(r.owners);
    const fromPlugin = r.owners.some(o => o.fromPlugin);
    const editable = r.owners.some(o => o.door);
    return {
      id: r.id, name: r.name, kind: r.kind, scope: r.scope, sourceLabel: r.sourceLabel, originLabel: r.originLabel,
      cli: clis[0], clis, editable,
      deletable: editable && backendResources.isDeletableKind(r.kind) && !fromPlugin,
      fromPlugin,
      creatable: r.owners.some(o => o.creatable),
    };
  });
  const declines = [];
  for (const f of perCli) {
    if (f.rows || f.listed || f.scaffold) continue;
    if (declines.some(d => d.cli.key === f.cli.key)) continue;
    declines.push({ cli: f.cli, sentence: `${f.cli.label} keeps no ${view} here.` });
  }
  return { ok: true, rows: out, declines };
}

/** Wire the IPC surface. main.js hands in ipcMain; this file never requires electron. */
function registerIpc(ipcMain) {
  ipcMain.handle('get-resource-inventory', (_e, view, projectPath) => getResourceInventory({
    view: typeof view === 'string' ? view : '',
    projectPath: typeof projectPath === 'string' && projectPath ? projectPath : null,
  }));
}

module.exports = { init, registerIpc, getResourceInventory, RESOURCE_VIEWS, _collect: collect };
