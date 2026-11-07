// app/instruction-files.js — the files that steer a CLI: instruction files, memory, settings files (#823, spec 44).
//
// Two halves, one reason to live together: both ask every backend's `memorySources` and `listResources`.
//
// 1. The scan helpers that used to sit in `plans-memory.js` (`memoryBackends`, `visibleProjectPaths`,
//    `storeFoldersFor`, `scanMdFiles`, `claim`, `collectSource`), moved here WITHOUT a change of behaviour so
//    the Agent Files tab and the Instructions inventory cannot answer differently while both exist. The tab keeps
//    requiring them from here until it goes (T11/T12).
// 2. The neutral INSTRUCTION INVENTORY (T5): one row per file for one scope (global, or one registered project) —
//    instruction files, the CLI's memory, its settings files, output styles and resources — with doors that read
//    and save a row BY ITS OPAQUE ID, never by a path. Every call lists again and takes a row only by equality of
//    its id, so an id that is no longer listed is refused. A write goes through `safe-write.js` with the editor's
//    baseline and `format-validate.js`. This module names no backend and reads no format.
//
// No create and no delete here: these files are ones the CLI reads or the user keeps; the app edits them, it
// does not make or remove them. Like every src/app/* module it keeps no Electron reference and never
// top-level-requires db.js (it arrives through ctx, via `plans-memory.init` or its own `init`).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { isInside, samePath, pathKey } = require('./path-containment');
const { readableError } = require('./readable-error');
const { writeTextFile } = require('./safe-write');
const { validateContent } = require('./format-validate');
const resourceInventory = require('./resource-inventory');
const skills = require('./skills');
const projectRegistry = require('../projects/project-registry');

let ctx = null;

/**
 * @param {object} context
 *   backends  the registry
 *   log       electron-log
 *   db        { getProjectStates, getAllFolderMeta }
 */
function init(context) {
  ctx = context;
}

// The backends whose plans + instruction files this tab surfaces: every installed (ready) backend, not
// only the launchable ones — a project's CLAUDE.md / AGENTS.md is on disk whether or not its backend is
// enabled, and the tab has always shown those files unconditionally. Profiles are skipped (they forward a
// base's dirs, which would only duplicate — dedupe by path handles the rest).
//
// And one entry per CLI (#683): a driver (`transcriptsOf`, the native GUI backends) forwards its owner's
// resources, so it showed up as a group of its own and claimed the owner's files under its own name — the
// same CLI twice, named the way the sidebar no longer names it. `oneAskerPerCli` keeps the owner and lets a
// driver answer only when its owner is not listed.
//
// The three that need the registry or the db take the ctx as an argument, defaulting to this module's own: the Agent
// Files tab asks with ITS ctx, so it works whether or not this module was initialised (T11/T12 remove the tab).
function memoryBackends(c = ctx) {
  try {
    const ready = c.backends.list().filter(b => !b.isProfile && b.status === 'ready');
    return typeof c.backends.oneAskerPerCli === 'function' ? c.backends.oneAskerPerCli(ready) : ready;
  } catch { return []; }
}

// The projects the register says are visible — every backend's, not one store's (#227). This is the same
// rule the sidebar uses, so a tab can no longer show a project the sidebar hides, or hide one it shows.
function visibleProjectPaths(c = ctx) {
  const set = new Set();
  try {
    for (const [projectPath, state] of c.db.getProjectStates()) {
      if (projectRegistry.isVisible(state)) set.add(projectPath);
    }
  } catch { /* an empty set would blank every view — better to show than to vanish */ }
  return set;
}

// The store folders attributed to one project (a backend can own several — Claude's folder encoding has
// changed over time). A backend's memorySources uses these to find its store-side files for the project.
function storeFoldersFor(projectPath, c = ctx) {
  const folders = [];
  try {
    for (const [folder, meta] of c.db.getAllFolderMeta()) {
      if (meta && meta.projectPath === projectPath) folders.push(folder);
    }
  } catch { /* the backend adds its own canonical encoded name anyway */ }
  return folders;
}

// --- shared scanning helpers ---

/** Scan a directory for .md files (non-recursive). Emptiness judged by stat.size (no content read). */
function scanMdFiles(dir) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const fp = path.join(dir, e.name);
        try {
          const stat = fs.statSync(fp);
          if (stat.size > 0) {
            results.push({ filename: e.name, filePath: fp, modified: stat.mtime.toISOString(), size: stat.size });
          }
        } catch {}
      }
    }
  } catch {}
  return results;
}

// Turn one declared memory Source into file entries, appended to `out` and deduped by path via `seen`.
// Every row in this tab carries a `kind`, because the type filter (#447) is built from them and a row
// with none would be filterable by nothing and reachable only by clearing the filter. An instruction
// file has no kind of its own — `memorySources` describes WHERE it is, not what it is — so it gets one
// here. `s.kind` on the source says dir-or-file, which is a different question.
const INSTRUCTION_KIND = 'instructions';

// A file can belong to SEVERAL backends, and the dedupe used to hide that. Codex and Pi both declare
// `AGENTS.md`; Claude and Pi both declare `CLAUDE.md` (Claude .claude/CLAUDE.md or AGENTS.md instead, in a project without one, #777, #785). Listing it twice would be wrong — it is one
// file — but so is attributing it to whichever backend happened to be asked first. So the second claim
// is recorded on the row that is already there, and a row carries a LIST of backends (#447 follow-up).
//
// `seen` is a Map now, path -> the row, because adding to a row means finding it again.
function claim(seen, filePath, backendId) {
  const row = seen.get(filePath);
  if (row && backendId && !row.backendIds.includes(backendId)) row.backendIds.push(backendId);
  return !!row;
}

function collectSource(s, out, seen, backendId) {
  if (!s || !s.path) return;
  if (s.kind === 'dir') {
    for (const f of scanMdFiles(s.path)) {
      if (claim(seen, f.filePath, backendId)) continue;
      const row = { ...f, displayPath: s.displayPath, source: s.source, kind: INSTRUCTION_KIND, backendIds: backendId ? [backendId] : [] };
      out.push(row);
      seen.set(f.filePath, row);
    }
  } else if (s.kind === 'file') {
    try {
      if (!fs.existsSync(s.path)) return;
      if (claim(seen, s.path, backendId)) return;
      const stat = fs.statSync(s.path);
      if (stat.size > 0) {
        const row = {
          filename: path.basename(s.path), filePath: s.path,
          modified: stat.mtime.toISOString(), size: stat.size,
          displayPath: s.displayPath, source: s.source, kind: INSTRUCTION_KIND,
          backendIds: backendId ? [backendId] : [],
        };
        out.push(row);
        seen.set(s.path, row);
      }
    } catch {}
  }
}

// --- The instruction inventory (#823 T5) -----------------------------------------------------------------

/**
 * What each listing kind is in this inventory: the row `kind`, and the section the window groups it under.
 * Kinds are the core's shared vocabulary (never a backend id). A listed `memory` entry is an instruction file
 * (CLAUDE.md, AGENTS.md, GEMINI.md, SOUL.md); a `memory-store` is a directory of notes the CLI keeps.
 */
const LISTING_KINDS = {
  memory: { kind: 'instructions', section: 'Instructions' },
  settings: { kind: 'settings', section: 'Settings files' },
  'memory-store': { kind: 'memory', section: 'Memory' },
  'output-style': { kind: 'output-style', section: 'Output styles' },
  resource: { kind: 'resource', section: 'Resources' },
};
const SECTION_ORDER = ['Instructions', 'Memory', 'Settings files', 'Output styles', 'Resources'];

/** What the editor may open and save, and how much of it (T5 c). `.cursorrules` is the one extensionless name. */
const EDITABLE_EXTENSIONS = new Set(['.md', '.markdown', '.json', '.toml', '.yaml', '.yml']);
const EXTENSIONLESS_FILES = new Set(['.cursorrules']);
const MAX_EDIT_BYTES = 1024 * 1024;

function editableName(filePath) {
  return EDITABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || EXTENSIONLESS_FILES.has(path.basename(filePath));
}

function fileId(filePath) {
  return crypto.createHash('sha1').update(pathKey(filePath)).digest('hex').slice(0, 16);
}

/** The size of a regular file, or -1 for anything else: the cap and the is-it-a-file question in one stat. */
function sizeOf(filePath) {
  try { const st = fs.statSync(filePath); return st.isFile() ? st.size : -1; } catch { return -1; }
}

/**
 * The rows of one scope with their owners kept beside them: `{ rows, perCli }`. `projectPath` null is the global
 * scope. Sources, in this order so a file is claimed by its real kind first: the listing kinds above, then
 * `memorySources` for the files they add (Claude's auto memory and `.claude/*.md`, Hermes' five names).
 * A file an agent, command or rule row already owns is not an instruction (`.claude/commands/*.md`).
 */
function collect(projectPath) {
  const shared = resourceInventory._shared;
  const scope = projectPath ? 'project' : 'global';
  const owned = new Set();
  for (const view of Object.keys(resourceInventory.RESOURCE_VIEWS)) {
    for (const r of resourceInventory._collect(view, projectPath).rows) owned.add(pathKey(r.filePath));
  }
  const byKey = new Map();
  const perCli = [];

  const add = (filePath, kindInfo, descriptor, cli, label) => {
    const key = pathKey(filePath);
    if (owned.has(key)) return false;
    const kept = byKey.get(key);
    const owner = { backendId: descriptor.id, cli };
    if (kept) {
      if (!kept.owners.some(o => o.cli.key === cli.key)) kept.owners.push(owner);
      return true;
    }
    byKey.set(key, {
      id: fileId(filePath), name: path.basename(filePath), kind: kindInfo.kind, section: kindInfo.section, scope, filePath,
      sourceLabel: label, owners: [owner],
    });
    return true;
  };

  const backends = shared.inventoryBackends();
  // Listing first: every CLI, so the kind a backend itself gives a file wins over the generic reading.
  const facts = new Map();
  for (const b of backends) {
    const descriptor = shared.backendById(b.id);
    if (!descriptor) continue;
    const cli = shared.cliOf(descriptor);
    const f = { cli, listed: false, rows: 0 };
    facts.set(b.id, f);
    perCli.push(f);
    const label = `${descriptor.label || descriptor.id} · ${scope}`;
    for (const hit of shared.backendFiles(descriptor, Object.keys(LISTING_KINDS), projectPath, scope, f)) {
      if (add(hit.filePath, LISTING_KINDS[hit.kind], descriptor, cli, label)) f.rows += 1;
    }
  }
  // Then what each backend declares as its instruction sources.
  const storeFolders = projectPath ? storeFoldersFor(projectPath) : [];
  for (const b of backends) {
    const descriptor = shared.backendById(b.id);
    const f = facts.get(b.id);
    if (!descriptor || !f || typeof descriptor.memorySources !== 'function') continue;
    let sources = [];
    try { sources = descriptor.memorySources({ projectPath: projectPath || null, storeFolders }) || []; } catch { sources = []; }
    const label = `${descriptor.label || descriptor.id} · ${scope}`;
    for (const s of sources) {
      const found = [];
      collectSource(s, found, new Map(), b.id);
      // A directory source OUTSIDE the project is the CLI's own store for it (Claude's auto memory); one
      // inside it, or at the home, holds instruction files. Decided by where it is, never by a backend id.
      let outside = false;
      if (projectPath && s.kind === 'dir') { try { outside = !isInside(s.path, projectPath); } catch { outside = false; } }
      const info = outside ? LISTING_KINDS['memory-store'] : LISTING_KINDS.memory;
      for (const row of found) if (add(row.filePath, info, descriptor, f.cli, label)) f.rows += 1;
    }
  }

  const rows = [...byKey.values()].sort((a, b) =>
    SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || a.name.localeCompare(b.name)
    || a.filePath.localeCompare(b.filePath));
  return { rows, perCli };
}

function distinctClis(owners) {
  const out = [];
  for (const o of owners) if (!out.some(c => c.key === o.cli.key)) out.push(o.cli);
  return out;
}

/** Which project a request names: `'global'` -> none; a path -> only a project the register holds. */
function scopeProject(scope) {
  if (scope === 'global' || scope == null || scope === '') return { projectPath: null };
  if (typeof scope !== 'string') return { error: 'Unknown scope.' };
  if (!skills.projectAllowed(scope)) return { error: 'That project is not on the list.' };
  return { projectPath: scope };
}

/**
 * The instruction inventory of one scope: `{ ok, rows, declines }`. A row is `{ id, name, kind, section, scope, ext,
 * cli, clis, sourceLabel, editable }`; no path and no backend id leave main. Every listed file is a row (agy's built-in
 * resources have no editor extension, and Agent Files showed them); `editable` is the predicate the save door uses: a
 * known text extension, a regular file, under the size cap. A row that is not editable may still be read if it is text.
 */
function getInstructionInventory({ scope } = {}) {
  const asked = scopeProject(scope);
  if (asked.error) return { ok: false, reason: asked.error };
  const { rows, perCli } = collect(asked.projectPath);
  const out = rows.map(r => {
    const clis = distinctClis(r.owners);
    const size = sizeOf(r.filePath);
    return {
      id: r.id, name: r.name, kind: r.kind, section: r.section, scope: r.scope, sourceLabel: r.sourceLabel,
      ext: path.extname(r.filePath).toLowerCase(), cli: clis[0], clis,
      editable: editableName(r.filePath) && size >= 0 && size <= MAX_EDIT_BYTES,
    };
  });
  const declines = [];
  for (const f of perCli) {
    if (f.rows || f.listed) continue;
    if (declines.some(d => d.cli.key === f.cli.key)) continue;
    declines.push({ cli: f.cli, sentence: `${f.cli.label} keeps no instructions here.` });
  }
  return { ok: true, rows: out, declines };
}

/** The listed row an id names, from a fresh listing of its scope: `{ row }` or `{ error }`. */
function rowFor(id, scope) {
  if (typeof id !== 'string' || !id) return { error: 'That file is no longer listed.' };
  const asked = scopeProject(scope);
  if (asked.error) return { error: asked.error };
  const row = collect(asked.projectPath).rows.find(r => r.id === id);
  return row ? { row } : { error: 'That file is no longer listed.' };
}

/** The text of one file: `{ ok, content, mtimeMs, size }` or `{ ok: false, reason }`. */
function readInstruction({ id, scope } = {}) {
  const found = rowFor(id, scope);
  if (found.error) return { ok: false, reason: found.error };
  const file = found.row.filePath;
  let st = null;
  try { st = fs.statSync(file); } catch { return { ok: false, reason: 'That file is no longer there.' }; }
  if (!st.isFile()) return { ok: false, reason: 'That is not a file.' };
  if (st.size > MAX_EDIT_BYTES) {
    return { ok: false, reason: `Too large to show here (${Math.round(st.size / 1024)} KB, limit ${MAX_EDIT_BYTES / 1024} KB).` };
  }
  let buf = null;
  try { buf = fs.readFileSync(file); } catch (err) { return { ok: false, reason: readableError(err, 'Could not read that file.', ctx && ctx.log) }; }
  if (buf.includes(0)) return { ok: false, reason: 'That file is not text.' };
  return { ok: true, content: buf.toString('utf8'), mtimeMs: st.mtimeMs, size: st.size };
}

/**
 * Save one file: `{ ok, content, mtimeMs, unchecked, tooLarge }`, `{ ok: false, conflict: true, diskContent, reason }`
 * when the file moved under the editor, or `{ ok: false, reason }`. A baseline is required: the editor only saves
 * what it read. The bytes are `safe-write.js`'s (baseline compare, atomic rename, the file's own EOL and BOM).
 */
function saveInstruction({ id, scope, content, baseline = null } = {}) {
  if (typeof content !== 'string') return { ok: false, reason: 'Nothing to save.' };
  if (typeof baseline !== 'string') return { ok: false, reason: 'Open the file again before saving it.' };
  if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_BYTES) return { ok: false, reason: 'That text is too large to save here.' };
  if (content.includes('\0')) return { ok: false, reason: 'That text contains a NUL byte and cannot be saved as a text file.' };
  const found = rowFor(id, scope);
  if (found.error) return { ok: false, reason: found.error };
  if (!editableName(found.row.filePath)) return { ok: false, reason: 'Switchboard does not edit this kind of file.' };
  const file = found.row.filePath;
  try {
    const result = writeTextFile(file, content, {
      expectPrevious: baseline, mustExist: true, validate: (text) => validateContent(file, text),
    });
    if (!result.ok) {
      if (result.code === 'stale') return { ok: false, conflict: true, diskContent: result.diskContent, reason: result.error, error: result.error };
      if (result.code === 'failed') {
        const reason = readableError(result.cause, 'That file could not be saved.', ctx && ctx.log);
        return { ok: false, reason, error: reason };
      }
      return { ok: false, reason: result.error, error: result.error };
    }
    const checked = result.verdict || {};
    return { ok: true, content: result.content, mtimeMs: result.mtimeMs, unchecked: !!checked.unchecked, tooLarge: !!checked.tooLarge };
  } catch (err) {
    return { ok: false, reason: readableError(err, 'That file could not be saved.', ctx && ctx.log) };
  }
}

/**
 * Which listed file a path is, if any: `{ id, scope, projectPath }` or null. Equality on the REAL path
 * (`samePath`), asked of the global inventory and, when a registered project is named, of that project's. For the
 * sidebar's Edit button and #822: a path the inventory does not list gets no button.
 */
function locateInstruction({ path: filePath, projectPath = null } = {}) {
  if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath)) return null;
  const scopes = [null];
  if (projectPath) {
    if (!skills.projectAllowed(projectPath)) return null;
    scopes.push(projectPath);
  }
  for (const p of scopes) {
    const row = collect(p).rows.find(r => samePath(r.filePath, filePath));
    if (row) return { id: row.id, scope: row.scope, projectPath: p };
  }
  return null;
}

/**
 * What applies to one session: the instruction, memory and settings files of the session's backend's owner CLI, in
 * the global scope and (a registered project) the project's. `{ ok, rows: [{ id, label, scope, section, path }],
 * declined }`. The path is for the read-only preview, the id for the Edit link; a CLI with none answers a sentence.
 */
function getSessionInstructions({ projectPath = null, backendId = '' } = {}) {
  const shared = resourceInventory._shared;
  const descriptor = typeof backendId === 'string' && backendId ? shared.backendById(backendId) : null;
  if (!descriptor) return { ok: true, rows: [], declined: 'The CLI of this session keeps no instruction files.' };
  const cli = shared.cliOf(descriptor);
  const scopes = [null];
  if (projectPath && skills.projectAllowed(projectPath)) scopes.push(projectPath);
  const rows = [];
  for (const p of scopes) {
    for (const r of collect(p).rows) {
      if (!SESSION_KINDS.has(r.kind) || !r.owners.some(o => o.cli.key === cli.key)) continue;
      rows.push({ id: r.id, label: r.name, scope: r.scope, section: r.section, path: r.filePath });
    }
  }
  return { ok: true, rows, declined: rows.length ? null : `${cli.label} keeps no instructions here.` };
}
const SESSION_KINDS = new Set(['instructions', 'memory', 'settings']);

/** The ids of the files of one scope whose text holds `query` (T4's matcher, bounded and memoised): `{ ok, ids }`. */
async function matchInstructionContent({ scope, query } = {}) {
  const asked = scopeProject(scope);
  if (asked.error) return { ok: false, reason: asked.error };
  const files = collect(asked.projectPath).rows.map(r => ({ id: r.id, filePath: r.filePath }));
  return { ok: true, ids: await resourceInventory._matchFiles(files, query) };
}

// --- Work files (T10, plan P6): `<project>/.work-files/**`, listed per registered project, named by id ---
//
// Agent Files was the only surface for these, with open and Delete; they move here unchanged in capability. Read-only
// (there never was a save), delete only a file the fresh listing holds. The walk, its exclusions and its cap are
// `plans-memory.js`'s, required lazily because that module requires this one.

/** The project's listed work files, with their paths kept in main: `{ projectPath, dir, files, total }` or `{ error }`. */
function workFilesOf(scope) {
  const asked = scopeProject(scope);
  if (asked.error) return { error: asked.error };
  if (!asked.projectPath) return { error: 'Work files belong to a project.' };
  const pm = require('./plans-memory');
  const dir = path.join(asked.projectPath, '.work-files');
  // The directory itself must be inside the project on REAL paths: a `.work-files` that is a link out lists nothing.
  if (!isInside(dir, asked.projectPath)) return { projectPath: asked.projectPath, dir, files: [], total: 0 };
  const all = [];
  pm.walkWorkFiles(dir, dir, all);
  all.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  // Each file must also be inside the real work-files directory: a link out of it is not a work file.
  const files = all.slice(0, pm.WORK_FILES_CAP).filter(f => isInside(f.filePath, dir))
    .map(f => ({ ...f, id: fileId(f.filePath) }));
  return { projectPath: asked.projectPath, dir, files, total: all.length };
}

/** The work files of one project: `{ ok, rows: [{ id, name, relativePath, modified, size }], total }`. No path leaves main. */
function getWorkFileList({ scope } = {}) {
  const found = workFilesOf(scope);
  if (found.error) return { ok: false, reason: found.error };
  return {
    ok: true, total: found.total,
    rows: found.files.map(f => ({ id: f.id, name: f.filename, relativePath: f.relativePath, modified: f.modified, size: f.size })),
  };
}

function workFileFor(id, scope) {
  const found = workFilesOf(scope);
  if (found.error) return { error: found.error };
  const file = typeof id === 'string' && id ? found.files.find(f => f.id === id) : null;
  return file ? { file } : { error: 'That file is no longer listed.' };
}

/** The text of one work file: `{ ok, content }` or `{ ok: false, reason }`. Same limits as before: 2 MB, text only. */
function readWorkFileById({ id, scope } = {}) {
  const found = workFileFor(id, scope);
  if (found.error) return { ok: false, reason: found.error };
  try {
    const st = fs.lstatSync(found.file.filePath);
    if (!st.isFile()) return { ok: false, reason: 'That is not a file.' };
    if (st.size > 2 * 1024 * 1024) return { ok: false, reason: 'That file is too large to show here.' };
    const buf = fs.readFileSync(found.file.filePath);
    if (buf.includes(0)) return { ok: false, reason: 'That file is not text.' };
    return { ok: true, content: buf.toString('utf8') };
  } catch (err) {
    return { ok: false, reason: readableError(err, 'Could not read that file.', ctx && ctx.log) };
  }
}

/** Delete one listed work file: `{ ok }` or `{ ok: false, reason }`. Never a directory, never an unlisted path. */
function deleteWorkFileById({ id, scope } = {}) {
  const found = workFileFor(id, scope);
  if (found.error) return { ok: false, reason: found.error };
  try {
    fs.unlinkSync(found.file.filePath);
    require('./plans-memory').invalidateFtsSignature('work-file');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: readableError(err, 'Could not delete that file.', ctx && ctx.log) };
  }
}

/** Wire the IPC surface. main.js hands in ipcMain; this file never requires electron. */
function registerIpc(ipcMain) {
  const scopeOf = (s) => (typeof s === 'string' && s ? s : 'global');
  ipcMain.handle('get-instruction-inventory', (_e, scope) => getInstructionInventory({ scope: scopeOf(scope) }));
  ipcMain.handle('read-instruction', (_e, id, scope) => readInstruction({ id: typeof id === 'string' ? id : '', scope: scopeOf(scope) }));
  ipcMain.handle('save-instruction', (_e, id, scope, content, baseline) => saveInstruction({
    id: typeof id === 'string' ? id : '', scope: scopeOf(scope), content, baseline: typeof baseline === 'string' ? baseline : null,
  }));
  ipcMain.handle('locate-instruction', (_e, filePath, projectPath) => locateInstruction({
    path: typeof filePath === 'string' ? filePath : '', projectPath: typeof projectPath === 'string' && projectPath ? projectPath : null,
  }));
  ipcMain.handle('get-session-instructions', (_e, projectPath, backendId) => getSessionInstructions({
    projectPath: typeof projectPath === 'string' && projectPath ? projectPath : null, backendId: typeof backendId === 'string' ? backendId : '',
  }));
  ipcMain.handle('match-instruction-content', (_e, scope, query) => matchInstructionContent({
    scope: scopeOf(scope), query: typeof query === 'string' ? query : '',
  }));
  ipcMain.handle('get-instruction-work-files', (_e, scope) => getWorkFileList({ scope: scopeOf(scope) }));
  ipcMain.handle('read-instruction-work-file', (_e, id, scope) => readWorkFileById({ id: typeof id === 'string' ? id : '', scope: scopeOf(scope) }));
  ipcMain.handle('delete-instruction-work-file', (_e, id, scope) => deleteWorkFileById({ id: typeof id === 'string' ? id : '', scope: scopeOf(scope) }));
}

module.exports = {
  init, registerIpc,
  // what plans-memory.js asks, unchanged
  memoryBackends, visibleProjectPaths, storeFoldersFor, scanMdFiles, claim, collectSource, INSTRUCTION_KIND,
  getInstructionInventory, readInstruction, saveInstruction, locateInstruction, matchInstructionContent, getSessionInstructions,
  getWorkFileList, readWorkFileById, deleteWorkFileById,
  _collect: collect, _workFilesOf: workFilesOf,
};
