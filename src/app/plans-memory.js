// Plans, Memory and Work-Files tabs — out of main.js (#227).
//
// These three tabs used to be pinned to Claude's home: PLANS_DIR = ~/.claude/plans, and the Memory tab
// enumerated its projects out of ~/.claude/projects — Claude's store — so a project that only ever ran
// Codex or Pi never appeared, and a backend that keeps its plans or instruction files somewhere else had
// no way to show them. The app runs several coding CLIs; these tabs behaved as though it ran one.
//
// So WHERE a backend keeps its plans and its memory/instruction files is now DECLARED on the descriptor
// (plansDir + memorySources), the way discovery/watching/the launch menu already are, and the project
// list behind Memory/Work-Files comes from the INDEXED projects (the register, fed by every backend's
// provenance) instead of one backend's store directory. This module names no backend and hardcodes no
// per-backend path — `test/backend-path-neutrality.test.js` is the guard that keeps it that way.
//
// Like every src/app/* module it keeps no Electron reference and never top-level-requires db.js: both
// come in through ctx, which is what lets `node --test` load it (see test/main-modules-no-db.test.js).
'use strict';

const fs = require('fs');
const path = require('path');
const projectRegistry = require('../projects/project-registry');
const { encodeProjectPath } = require('../session/encode-project-path');
const { projectShortName } = require('../session/derive-project-path');

let ctx = null;

/**
 * @param {object} context
 *   backends        the registry (the ONLY source of plans dirs and memory sources)
 *   activeSessions  Map of live sessions — their project dirs are always readable
 *   log             electron-log
 *   db              { getProjectStates, getProjectDisplayNames, getAllFolderMeta,
 *                     deleteSearchType, upsertSearchEntries }
 */
function init(context) {
  ctx = context;
}

// The backends whose plans + instruction files this tab surfaces: every installed (ready) backend, not
// only the launchable ones — a project's CLAUDE.md / AGENTS.md is on disk whether or not its backend is
// enabled, and the tab has always shown those files unconditionally. Profiles are skipped (they forward a
// base's dirs, which would only duplicate — dedupe by path handles the rest).
function memoryBackends() {
  try { return ctx.backends.list().filter(b => !b.isProfile && b.status === 'ready'); }
  catch { return []; }
}

// The projects the register says are visible — every backend's, not one store's (#227). This is the same
// rule the sidebar uses, so a tab can no longer show a project the sidebar hides, or hide one it shows.
function visibleProjectPaths() {
  const set = new Set();
  try {
    for (const [projectPath, state] of ctx.db.getProjectStates()) {
      if (projectRegistry.isVisible(state)) set.add(projectPath);
    }
  } catch { /* an empty set would blank every view — better to show than to vanish */ }
  return set;
}

// The store folders attributed to one project (a backend can own several — Claude's folder encoding has
// changed over time). A backend's memorySources uses these to find its store-side files for the project.
function storeFoldersFor(projectPath) {
  const folders = [];
  try {
    for (const [folder, meta] of ctx.db.getAllFolderMeta()) {
      if (meta && meta.projectPath === projectPath) folders.push(folder);
    }
  } catch { /* the backend adds its own canonical encoded name anyway */ }
  return folders;
}

// ---------------------------------------------------------------------------
// FTS dirty-flag: skip a full reindex when the file set has not changed. Each tab computes a cheap
// signature (sorted filePath + mtimeMs + size) and compares it to the last-indexed one; equal means the
// expensive deleteSearchType + upsertSearchEntries block (and the per-file reads it does) is skipped.
// The result payload returned to the UI is built unconditionally — only the FTS side-effect is gated.
// save-plan / save-memory / delete-work-file clear the stored signature so the next open reindexes even
// when a sub-second write left the mtime unchanged. save-file-for-panel (main.js) calls invalidate too.
// ---------------------------------------------------------------------------

/** @type {Map<string, string>} type -> last-indexed signature */
const _ftsIndexSignature = new Map();

function computeIndexSignature(files) {
  const sorted = [...files].sort((a, b) => a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0);
  return sorted.map(f => `${f.filePath}\x00${f.mtimeMs}\x00${f.size}`).join('\n');
}

function shouldReindex(type, sig) {
  if (_ftsIndexSignature.get(type) === sig) return false;
  _ftsIndexSignature.set(type, sig);
  return true;
}

function invalidateFtsSignature(type) {
  _ftsIndexSignature.delete(type);
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
function collectSource(s, out, seen) {
  if (!s || !s.path) return;
  if (s.kind === 'dir') {
    for (const f of scanMdFiles(s.path)) {
      if (seen.has(f.filePath)) continue;
      out.push({ ...f, displayPath: s.displayPath, source: s.source });
      seen.add(f.filePath);
    }
  } else if (s.kind === 'file') {
    try {
      if (!fs.existsSync(s.path)) return;
      const stat = fs.statSync(s.path);
      if (stat.size > 0 && !seen.has(s.path)) {
        out.push({
          filename: path.basename(s.path), filePath: s.path,
          modified: stat.mtime.toISOString(), size: stat.size,
          displayPath: s.displayPath, source: s.source,
        });
        seen.add(s.path);
      }
    } catch {}
  }
}

// --- Plans ---

function getPlans() {
  const plans = [];
  const sigFiles = [];
  const bodies = new Map(); // filePath -> content (single read: title + FTS body)
  let hasStore = false;
  for (const b of memoryBackends()) {
    let dir = null;
    try { dir = b.plansDir(); } catch { dir = null; }
    if (!dir) continue;
    hasStore = true;
    let files = [];
    try { files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.md')) : []; } catch { files = []; }
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const firstLine = content.split('\n').find(l => l.trim());
        const title = firstLine && firstLine.startsWith('# ') ? firstLine.slice(2).trim() : file.replace(/\.md$/, '');
        plans.push({ filename: file, filePath, title, modified: stat.mtime.toISOString() });
        bodies.set(filePath, content);
        sigFiles.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {}
    }
  }
  plans.sort((a, b) => new Date(b.modified) - new Date(a.modified));

  try {
    const sig = computeIndexSignature(sigFiles);
    if (shouldReindex('plan', sig)) {
      ctx.db.deleteSearchType('plan');
      ctx.db.upsertSearchEntries(plans.map(p => ({
        id: p.filePath, type: 'plan', folder: null, title: p.title, body: bodies.get(p.filePath) || '',
      })));
    }
  } catch {}

  return { plans, hasStore };
}

// Every declared plans dir, resolved — the read/save guard for a plan path.
function plansDirs() {
  const dirs = [];
  for (const b of memoryBackends()) {
    try { const d = b.plansDir(); if (d) dirs.push(path.resolve(d)); } catch {}
  }
  return dirs;
}

function readPlan(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return { content: '', filePath: '' };
    const ok = plansDirs().some(d => resolved === d || resolved.startsWith(d + path.sep));
    if (!ok) return { content: '', filePath: '' };
    return { content: fs.readFileSync(resolved, 'utf8'), filePath: resolved };
  } catch (err) {
    ctx.log.error('Error reading plan:', err && err.message);
    return { content: '', filePath: '' };
  }
}

function savePlan(filePath, content) {
  try {
    const resolved = path.resolve(filePath);
    const ok = plansDirs().some(d => resolved.startsWith(d + path.sep));
    if (!ok) return { ok: false, error: 'path outside a plans directory' };
    fs.writeFileSync(resolved, content, 'utf8');
    invalidateFtsSignature('plan');
    return { ok: true };
  } catch (err) {
    ctx.log.error('Error saving plan:', err && err.message);
    return { ok: false, error: err.message };
  }
}

// --- Memory ---

function getMemories() {
  const visible = visibleProjectPaths();
  const displayNames = ctx.db.getProjectDisplayNames();
  const backendsList = memoryBackends();

  // Global files: the union of every backend's home-level instruction files (Claude's ~/.claude).
  const globalFiles = [];
  const globalSeen = new Set();
  for (const b of backendsList) {
    let sources = [];
    try { sources = b.memorySources({ projectPath: null, storeFolders: [] }) || []; } catch { sources = []; }
    for (const s of sources) collectSource(s, globalFiles, globalSeen);
  }

  // Per-project files: from the register (every backend's provenance), not one store directory.
  const projects = [];
  for (const projectPath of visible) {
    const storeFolders = storeFoldersFor(projectPath);
    const short = projectShortName(projectPath);
    const files = [];
    const seen = new Set();
    for (const b of backendsList) {
      let sources = [];
      try { sources = b.memorySources({ projectPath, storeFolders }) || []; } catch { sources = []; }
      for (const s of sources) collectSource(s, files, seen);
    }
    if (files.length) {
      const displayName = displayNames.get(projectPath) || '';
      projects.push({
        folder: storeFolders[0] || encodeProjectPath(projectPath),
        projectPath, shortName: short, displayName, files,
      });
    }
  }

  projects.sort((a, b) => {
    const aMax = Math.max(...a.files.map(f => new Date(f.modified).getTime()));
    const bMax = Math.max(...b.files.map(f => new Date(f.modified).getTime()));
    return bMax - aMax;
  });

  const result = { global: { files: globalFiles }, projects };

  try {
    const allFiles = [
      ...globalFiles.map(f => ({ ...f, label: 'Global' })),
      ...projects.flatMap(p => p.files.map(f => ({ ...f, label: p.displayName || p.shortName }))),
    ];
    const sig = computeIndexSignature(allFiles.map(f => ({
      filePath: f.filePath, mtimeMs: new Date(f.modified).getTime(), size: f.size || 0,
    })));
    if (shouldReindex('memory', sig)) {
      ctx.db.deleteSearchType('memory');
      ctx.db.upsertSearchEntries(allFiles.map(f => ({
        id: f.filePath, type: 'memory', folder: null,
        title: f.label + ' ' + f.filename, body: fs.readFileSync(f.filePath, 'utf8'),
      })));
    }
  } catch {}

  return result;
}

// The roots a memory file may live under: every backend's home-level memory dirs (Claude's ~/.claude) and
// every registered project root — plus any active session's project dir. The Memory tab surfaces files for
// EVERY visible project, not just ones with a live session, so the allowlist has to cover the register.
function allowedMemoryRoots() {
  const roots = new Set();
  for (const b of memoryBackends()) {
    try {
      for (const s of (b.memorySources({ projectPath: null, storeFolders: [] }) || [])) {
        if (s && s.path) roots.add(path.resolve(s.path));
      }
    } catch {}
  }
  try {
    for (const [projectPath, state] of ctx.db.getProjectStates()) {
      if (state && state.registered) roots.add(path.resolve(projectPath));
    }
  } catch {}
  return roots;
}

function isAllowedMemoryPath(resolved) {
  for (const r of allowedMemoryRoots()) {
    if (resolved === r || resolved.startsWith(r + path.sep)) return true;
  }
  for (const [, session] of ctx.activeSessions) {
    if (session.projectPath && resolved.startsWith(path.resolve(session.projectPath) + path.sep)) return true;
  }
  return false;
}

function readMemory(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return '';
    if (!isAllowedMemoryPath(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    ctx.log.error('Error reading memory file:', err && err.message);
    return '';
  }
}

function saveMemory(filePath, content) {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
    if (!isAllowedMemoryPath(resolved)) return { ok: false, error: 'path not allowed' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'file does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    invalidateFtsSignature('memory');
    return { ok: true };
  } catch (err) {
    ctx.log.error('Error saving memory file:', err && err.message);
    return { ok: false, error: err.message };
  }
}

// --- Work-Files ---
// <projectPath>/.work-files/ is project-relative, so it was already backend-neutral — the only Claude-ism
// was deciding which projects to walk (out of Claude's store). That now comes from the register too.
const WORK_FILES_CAP = 200;

function walkWorkFiles(dir, baseDir, results) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkWorkFiles(fullPath, baseDir, results);
    } else if (e.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        results.push({
          filename: e.name, filePath: fullPath, relativePath: path.relative(baseDir, fullPath),
          modified: stat.mtime.toISOString(), size: stat.size,
        });
      } catch {}
    }
  }
}

function getWorkFiles() {
  const visible = visibleProjectPaths();
  const displayNames = ctx.db.getProjectDisplayNames();
  const projects = [];

  for (const projectPath of visible) {
    const workFilesDir = path.join(projectPath, '.work-files');
    if (!fs.existsSync(workFilesDir)) continue;
    const short = projectShortName(projectPath);
    const allFiles = [];
    walkWorkFiles(workFilesDir, workFilesDir, allFiles);
    allFiles.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    const totalCount = allFiles.length;
    const files = allFiles.slice(0, WORK_FILES_CAP);
    if (files.length > 0) {
      const displayName = displayNames.get(projectPath) || '';
      projects.push({ projectPath, shortName: short, displayName, files, totalCount });
    }
  }

  projects.sort((a, b) => {
    const aMax = a.files.length > 0 ? new Date(a.files[0].modified).getTime() : 0;
    const bMax = b.files.length > 0 ? new Date(b.files[0].modified).getTime() : 0;
    return bMax - aMax;
  });

  try {
    const allFiles = projects.flatMap(proj => proj.files.map(f => ({ ...f, proj })));
    const sig = computeIndexSignature(allFiles.map(f => ({ filePath: f.filePath, mtimeMs: new Date(f.modified).getTime(), size: f.size })));
    if (shouldReindex('work-file', sig)) {
      ctx.db.deleteSearchType('work-file');
      const TEXT_MAX = 64 * 1024;
      ctx.db.upsertSearchEntries(allFiles.map(f => {
        let body = '';
        if (!f.relativePath.endsWith('.jsonl') && f.size <= TEXT_MAX) {
          try { body = fs.readFileSync(f.filePath, 'utf8'); } catch {}
        }
        return { id: f.filePath, type: 'work-file', folder: null, title: (f.proj.displayName || f.proj.shortName) + ' ' + f.relativePath, body };
      }));
    }
  } catch {}

  return { projects };
}

// A work-file path is allowed only inside the .work-files dir of a REGISTERED project (or a live session's
// dir) — otherwise a compromised renderer could read/delete arbitrary .work-files dirs anywhere (#77).
function isAllowedWorkFilePath(resolved) {
  const m = resolved.match(/[\\/]\.work-files[\\/]/);
  if (!m) return false;
  const projectRoot = path.resolve(resolved.slice(0, m.index));
  try {
    for (const [projectPath, state] of ctx.db.getProjectStates()) {
      if (state && state.registered && path.resolve(projectPath) === projectRoot) return true;
    }
  } catch {}
  for (const [, session] of ctx.activeSessions) {
    if (session.projectPath && path.resolve(session.projectPath) === projectRoot) return true;
  }
  return false;
}

function readWorkFile(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (!isAllowedWorkFilePath(resolved)) return '[access denied]';
    if (!fs.existsSync(resolved)) return '';
    const stat = fs.statSync(resolved);
    if (stat.size > 2 * 1024 * 1024) return '[file too large to display]';
    const buf = fs.readFileSync(resolved);
    if (buf.includes(0)) return '[binary file]';
    return buf.toString('utf8');
  } catch (err) {
    ctx.log.error('Error reading work file:', err && err.message);
    return '';
  }
}

function deleteWorkFile(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (!isAllowedWorkFilePath(resolved)) return { ok: false, error: 'access denied' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'not found' };
    fs.unlinkSync(resolved);
    invalidateFtsSignature('work-file');
    return { ok: true };
  } catch (err) {
    ctx.log.error('Error deleting work file:', err && err.message);
    return { ok: false, error: err.message };
  }
}

/** Wire the IPC surface. main.js hands in ipcMain; this file never requires electron. */
function registerIpc(ipcMain) {
  ipcMain.handle('get-plans', () => getPlans());
  ipcMain.handle('read-plan', (_e, filePath) => readPlan(filePath));
  ipcMain.handle('save-plan', (_e, filePath, content) => savePlan(filePath, content));
  ipcMain.handle('get-memories', () => getMemories());
  ipcMain.handle('read-memory', (_e, filePath) => readMemory(filePath));
  ipcMain.handle('save-memory', (_e, filePath, content) => saveMemory(filePath, content));
  ipcMain.handle('get-work-files', () => getWorkFiles());
  ipcMain.handle('read-work-file', (_e, filePath) => readWorkFile(filePath));
  ipcMain.handle('delete-work-file', (_e, filePath) => deleteWorkFile(filePath));
}

module.exports = {
  init,
  registerIpc,
  // exported for main.js (save-file-for-panel invalidates the FTS signature) and for tests
  invalidateFtsSignature,
  getPlans, readPlan, savePlan, getMemories, readMemory, saveMemory,
  getWorkFiles, readWorkFile, deleteWorkFile,
};
