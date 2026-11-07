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
// The doors (#823 T2) read, save, create and delete BY THAT ID, never by a path: every call lists the views
// again and takes a row only by equality of its id, so an id that is no longer listed is refused. The work is
// `backend-resources.js`'s (its own re-listing, containment on real paths, `safe-write.js` with the baseline);
// `editable` / `deletable` / `creatable` on a row are the predicates the doors use, so nothing is offered that
// a door then refuses. A hook is listed and may be read, never saved or deleted; a plugin's file is never deleted.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const backendResources = require('./backend-resources');
const skills = require('./skills');
const { pathKey, samePath } = require('./path-containment');

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
        const reach = backendResources._reachable(descriptor, f.resources, f.filePath);
        const owner = {
          backendId: descriptor.id,
          cli,
          fromPlugin: !!f.entry.fromPlugin,
          reach,
          // A hook is a script: read-only whatever its extension, so an `.md` hook is never offered an Edit.
          door: !READ_ONLY_KINDS.includes(f.kind) && reach && backendResources._editableHere(descriptor, f.filePath),
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
        // One file two backends list under different kinds: if either calls it a hook, it is read-only for all.
        if (READ_ONLY_KINDS.includes(f.kind)) byKey.get(key).readOnly = true;
      }
    }
  }
  for (const r of byKey.values()) if (r.readOnly) for (const o of r.owners) o.door = false;
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
function flagsOf(r) {
  const fromPlugin = r.owners.some(o => o.fromPlugin);
  const editable = r.owners.some(o => o.door);
  return {
    editable,
    deletable: editable && backendResources.isDeletableKind(r.kind) && !fromPlugin,
    fromPlugin,
    creatable: r.owners.some(o => o.creatable),
  };
}

function getResourceInventory({ view, projectPath = null } = {}) {
  if (!Object.prototype.hasOwnProperty.call(RESOURCE_VIEWS, view)) return { ok: false, reason: 'Unknown view.' };
  const { rows, perCli } = collect(view, projectPath);
  const out = rows.map(r => {
    const clis = distinctClis(r.owners);
    return {
      id: r.id, name: r.name, kind: r.kind, scope: r.scope, sourceLabel: r.sourceLabel, originLabel: r.originLabel,
      cli: clis[0], clis, ...flagsOf(r),
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

// --- The doors (#823 T2) ---------------------------------------------------------------------------------

/** The project a backend call is made for: a row's own scope decides, as the listing it came from did. */
function scopedProject(row, projectPath) {
  return row.scope === 'project' ? projectPath : null;
}

/**
 * The listed row an id names, from a fresh listing of the named view (all three when none is named): `{ row }` or
 * `{ error }`. A project the
 * register does not hold is refused first (it would choose where a project scope resolves).
 */
function rowFor(id, projectPath, onlyView = null) {
  if (!skills.projectAllowed(projectPath)) return { error: 'That project is not on the list.' };
  if (typeof id !== 'string' || !id) return { error: 'That item is no longer listed.' };
  if (onlyView && !Object.prototype.hasOwnProperty.call(RESOURCE_VIEWS, onlyView)) return { error: 'Unknown view.' };
  for (const view of onlyView ? [onlyView] : Object.keys(RESOURCE_VIEWS)) {
    const row = collect(view, projectPath).rows.find(r => r.id === id);
    if (row) return { row };
  }
  return { error: 'That item is no longer listed.' };
}

/** The text of one item: `{ ok, content, mtimeMs, size }` or `{ ok: false, reason }`. A hook may be read. */
async function readResourceItem({ id, projectPath = null, view = null } = {}) {
  const found = rowFor(id, projectPath, view);
  if (found.error) return { ok: false, reason: found.error };
  const owner = found.row.owners.find(o => o.reach);
  if (!owner) return { ok: false, reason: 'This item cannot be opened here.' };
  return backendResources.readResource(owner.backendId, found.row.filePath, scopedProject(found.row, projectPath));
}

/**
 * Save one item: `{ ok, content }`, `{ ok: false, conflict: true, diskContent, reason }` when the file moved under
 * the editor, or `{ ok: false, reason }`. A baseline is required, as for a skill: the editor only saves what it read.
 */
async function saveResourceItem({ id, projectPath = null, content, baseline = null, view = null } = {}) {
  if (typeof content !== 'string') return { ok: false, reason: 'Nothing to save.' };
  if (typeof baseline !== 'string') return { ok: false, reason: 'Open the item again before saving it.' };
  const found = rowFor(id, projectPath, view);
  if (found.error) return { ok: false, reason: found.error };
  const owner = found.row.owners.find(o => o.door);
  if (!owner) return { ok: false, reason: 'This item cannot be edited here.' };
  return backendResources.writeResource(owner.backendId, found.row.filePath, content, scopedProject(found.row, projectPath), baseline);
}

/** Delete one item: `{ ok }` or `{ ok: false, reason }`. Never a hook, never a plugin's file, only a kind with a lifecycle. */
async function deleteResourceItem({ id, projectPath = null, view = null } = {}) {
  const found = rowFor(id, projectPath, view);
  if (found.error) return { ok: false, reason: found.error };
  const { row } = found;
  const flags = flagsOf(row);
  if (flags.fromPlugin) return { ok: false, reason: 'This item was installed with something else, such as a plugin; remove it there.' };
  if (!flags.deletable) return { ok: false, reason: 'Switchboard does not delete this item.' };
  const owner = row.owners.find(o => o.door);
  return backendResources.deleteResource(owner.backendId, row.filePath, scopedProject(row, projectPath));
}

/**
 * Every place a new item of the view may go: a listed directory of a kind the backend's scaffold claims, under a
 * source it names, that exists. `[{ id, label, scope, kind, backendId, dir }]`; the window gets `id`, `label`,
 * `scope` and `kind`: no path field and no backend id (the label does show the folder, the user's own).
 */
function collectPlaces(view, projectPath) {
  const kinds = RESOURCE_VIEWS[view].filter(k => !READ_ONLY_KINDS.includes(k));
  const places = [];
  for (const b of inventoryBackends()) {
    const d = backendById(b.id);
    // `expandResource` too: an item the inventory cannot list could be created but never opened.
    if (!d || typeof d.listResources !== 'function' || typeof d.expandResource !== 'function') continue;
    for (const scope of projectPath ? ['project', 'global'] : ['global']) {
      let listed = null;
      try { listed = d.listResources({ projectPath: scope === 'project' ? projectPath : null }); } catch { continue; }
      if (!listed || listed.ok === false || !Array.isArray(listed.resources)) continue;
      for (const kind of kinds) {
        const scaffold = scaffoldFor(d, kind);
        if (!scaffold || !Array.isArray(scaffold.sources)) continue;
        for (const entry of listed.resources) {
          if (!entry || entry.kind !== kind || !entry.path) continue;
          if ((entry.scope || 'global') !== scope || !scaffold.sources.includes(entry.source)) continue;
          try { if (!fs.statSync(entry.path).isDirectory()) continue; } catch { continue; }
          if (places.some(p => p.backendId === d.id && p.kind === kind && samePath(p.dir, entry.path))) continue;
          places.push({
            id: crypto.createHash('sha1').update(`${d.id}\0${kind}\0${scope}\0${entry.path}`).digest('hex').slice(0, 16),
            label: `${d.label || d.id} · ${scope} — ${entry.path}`,
            scope, kind, backendId: d.id, dir: entry.path,
          });
        }
      }
    }
  }
  return places;
}

/** The places for the window: `{ ok, places: [{ id, label, scope, kind }] }`. */
function getResourcePlaces({ view, projectPath = null } = {}) {
  if (!Object.prototype.hasOwnProperty.call(RESOURCE_VIEWS, view)) return { ok: false, reason: 'Unknown view.' };
  if (!skills.projectAllowed(projectPath)) return { ok: false, reason: 'That project is not on the list.' };
  return { ok: true, places: collectPlaces(view, projectPath).map(({ id, label, scope, kind }) => ({ id, label, scope, kind })) };
}

/** Create one item from its backend's scaffold: `{ ok, id }` (the new row's id, null if not listed) or `{ ok: false, reason }`. */
async function createResourceItem({ view, placeId, name, projectPath = null } = {}) {
  if (!Object.prototype.hasOwnProperty.call(RESOURCE_VIEWS, view)) return { ok: false, reason: 'Unknown view.' };
  if (!skills.projectAllowed(projectPath)) return { ok: false, reason: 'That project is not on the list.' };
  const place = collectPlaces(view, projectPath).find(p => p.id === placeId);
  if (!place) return { ok: false, reason: 'That folder is no longer offered for a new item.' };
  const created = await backendResources.createResource(place.backendId, {
    kind: place.kind, name: typeof name === 'string' ? name.trim() : '', parentDir: place.dir,
    projectPath: place.scope === 'project' ? projectPath : null,
  });
  if (!created || !created.ok) return { ok: false, reason: (created && created.reason) || 'The item could not be created.' };
  const row = collect(view, projectPath).rows.find(r => samePath(r.filePath, created.path));
  return { ok: true, id: row ? row.id : null };
}

/** Wire the IPC surface. main.js hands in ipcMain; this file never requires electron. */
function registerIpc(ipcMain) {
  const idOf = (id) => (typeof id === 'string' ? id : '');
  const projectOf = (p) => (typeof p === 'string' && p ? p : null);
  const viewOf = (v) => (typeof v === 'string' ? v : '');
  ipcMain.handle('get-resource-inventory', (_e, view, projectPath) => getResourceInventory({
    view: viewOf(view), projectPath: projectOf(projectPath),
  }));
  const optView = (v) => (typeof v === 'string' && v ? v : null);
  ipcMain.handle('read-resource-item', (_e, id, projectPath, view) => readResourceItem({
    id: idOf(id), projectPath: projectOf(projectPath), view: optView(view),
  }));
  ipcMain.handle('save-resource-item', (_e, id, projectPath, content, baseline, view) => saveResourceItem({
    id: idOf(id), projectPath: projectOf(projectPath), content, baseline: typeof baseline === 'string' ? baseline : null,
    view: optView(view),
  }));
  ipcMain.handle('delete-resource-item', (_e, id, projectPath, view) => deleteResourceItem({
    id: idOf(id), projectPath: projectOf(projectPath), view: optView(view),
  }));
  ipcMain.handle('get-resource-places', (_e, view, projectPath) => getResourcePlaces({ view: viewOf(view), projectPath: projectOf(projectPath) }));
  ipcMain.handle('create-resource-item', (_e, view, placeId, name, projectPath) => createResourceItem({
    view: viewOf(view), placeId: idOf(placeId), name: typeof name === 'string' ? name : '', projectPath: projectOf(projectPath),
  }));
}

module.exports = {
  init, registerIpc, getResourceInventory, RESOURCE_VIEWS, _collect: collect,
  readResourceItem, saveResourceItem, deleteResourceItem, getResourcePlaces, createResourceItem,
};
