// app/handoffs.js — where a handoff packet lives (#468).
//
// A handoff used to be a row in `project_handoffs`, keyed by project path. Nothing outside this app could
// reach it: not an editor, not version control, not the agent that is supposed to read it, and not the
// same user on their other machine. Meanwhile the handoff skills several CLIs already run write markdown
// straight into the project, and none of that was visible here.
//
// So a handoff is a FILE in the project now, the way a plan is (#450, #454), and this module is the whole
// of that: where they are read from, where a new one is written, what a file has to look like to be one,
// and getting the old rows out of the database before the table goes.
//
// Two settings and they are not the same question:
//
//   `handoffDirNames`  every directory a handoff may be READ from. A list, because the point is to
//                      recognise what a project already does — including what a skill wrote there before
//                      Switchboard knew about any of this.
//   `handoffDir`       the one directory a new packet is WRITTEN to. Deliberately its own setting rather
//                      than "the first entry of the read list": reordering a list must not silently move
//                      where future packets land.
//
// Both are in the settings cascade, so a project says its own answer without every other project
// inheriting it, and both are relative to the project root — a path that escapes it is refused. Unlike
// plans there is no CLI to configure and no refusal of one to diagnose: Switchboard writes the handoff
// itself.
//
// Like every src/app/* module it keeps no Electron reference and never top-level-requires db.js — both
// arrive through ctx, which is what lets `node --test` load it.
'use strict';

const fs = require('fs');
const path = require('path');

const projectRegistry = require('../projects/project-registry');
const { projectShortName } = require('../session/derive-project-path');
const { readableError } = require('./readable-error');
const { writeTextFile } = require('./safe-write');
const { ignoreWarning } = require('./vcs-ignore');
const { isAtOrInside, isInside } = require('./path-containment');

let ctx = null;

/**
 * @param {object} context
 *   backends           the registry — the only source of a backend's own handoff directory
 *   db                 { getProjectStates, getProjectDisplayNames, readLegacyHandoffs,
 *                        deleteLegacyHandoff, dropLegacyHandoffTable }
 *   log                electron-log
 *   effectiveSettings  the settings cascade, by project
 *   dialog             Electron's dialog, for picking another folder when a write is refused
 *   getMainWindow      the window a picker is modal to
 */
function init(context) {
  ctx = context;
  migrateLegacyHandoffs();
}

// --- Where they live -------------------------------------------------------------------------------

// The directories a handoff may be read from when the settings say nothing. `prompts/` is deliberately
// absent although the handoff skills write there first: in many repositories that directory is prompt
// assets, and scanning it would offer files that are not handoffs at all. A project that does keep them
// there adds it to its own list.
//
// No backend's own folder is in here either. Where a CLI keeps things is a declared capability, so a
// backend with a handoff directory answers `handoffDirs({ projectPath })` and this module reads both —
// which is how `.claude/handoffs`, where Claude's own handoff skills write, is covered without the core
// ever spelling it.
const DEFAULT_DIR_NAMES = ['.handoffs', 'docs/handoffs', 'handoffs', '.agent/handoffs'];
const DEFAULT_WRITE_DIR = '.handoffs';

/** The candidate directory names, from the settings — a list, so a project's own layout can be added. */
function handoffDirCandidates(projectPath) {
  try {
    const eff = ctx.effectiveSettings ? ctx.effectiveSettings(projectPath || null) : null;
    const names = eff && eff.handoffDirNames;
    if (!Array.isArray(names)) return DEFAULT_DIR_NAMES;
    // A blank entry would resolve to the project root and put every markdown file in the repo on the list.
    const clean = names.map(n => String(n || '').trim()).filter(Boolean);
    return clean.length ? clean : DEFAULT_DIR_NAMES;
  } catch { return DEFAULT_DIR_NAMES; }
}

/** The directory a NEW packet goes into. One name, from the cascade. */
function handoffWriteDirName(projectPath) {
  try {
    const eff = ctx.effectiveSettings ? ctx.effectiveSettings(projectPath || null) : null;
    const value = (eff && typeof eff.handoffDir === 'string') ? eff.handoffDir.trim() : '';
    return value || DEFAULT_WRITE_DIR;
  } catch { return DEFAULT_WRITE_DIR; }
}

/**
 * Is `dir` inside `projectPath`? A candidate that escapes it is not that project's handoff directory.
 *
 * The real path of both sides, not the spelled one (#474): a directory that is a junction is spelled
 * inside the project while its contents are somewhere else, and this guards paths the app writes into and
 * deletes from. `path-containment.js` is the one implementation, shared with the plans convention.
 */
function insideProject(dir, projectPath) {
  return isAtOrInside(dir, projectPath);
}

/** The backends that declare a handoff directory of their own. Profiles forward a base's and only duplicate. */
function handoffBackends() {
  try {
    return ctx.backends.list().filter(b => !b.isProfile && typeof b.handoffDirs === 'function');
  } catch { return []; }
}

/** The projects the register says are visible — the same rule the sidebar and the other tabs use. */
function visibleProjectPaths() {
  const set = new Set();
  try {
    for (const [projectPath, state] of ctx.db.getProjectStates()) {
      if (projectRegistry.isVisible(state)) set.add(projectPath);
    }
  } catch { /* an empty set would blank every list — better to show than to vanish */ }
  return set;
}

/**
 * Every handoff directory that exists, as `{ projectPath, dir, name }`.
 *
 * Discovery only: nothing is created here. The write target is created on demand by `saveHandoff`, and
 * only when someone actually saves — a directory that appears because the app started would be this
 * module deciding a project keeps handoffs before it does.
 */
function handoffSources(onlyProject = null) {
  const out = [];
  const seen = new Set();
  const add = (projectPath, dir, name) => {
    if (!insideProject(dir, projectPath)) return;
    if (seen.has(dir)) return;
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    } catch { return; }
    seen.add(dir);
    out.push({ projectPath, dir, name });
  };

  const projects = onlyProject ? [path.resolve(onlyProject)] : [...visibleProjectPaths()];
  for (const projectPath of projects) {
    for (const name of handoffDirCandidates(projectPath)) {
      add(projectPath, path.resolve(projectPath, name), name);
    }
    // …and whatever each backend says it keeps for this project. Asked per project, because a handoff
    // directory is inside the work it belongs to and there is no global one to ask about.
    for (const backend of handoffBackends()) {
      let dirs = [];
      try { dirs = backend.handoffDirs({ projectPath }) || []; } catch { dirs = []; }
      for (const dir of dirs) {
        const resolved = path.resolve(dir);
        add(projectPath, resolved, path.relative(projectPath, resolved).split(path.sep).join('/') || '.');
      }
    }
  }
  return out;
}

/**
 * Every directory a handoff path may be under — the read/save/delete guard.
 *
 * The write target counts even when it does not exist yet: the first save creates it, and a guard that
 * only knew about directories already on disk would refuse the write that makes one.
 */
function handoffDirs(onlyProject = null) {
  const dirs = handoffSources(onlyProject).map(s => s.dir);
  const projects = onlyProject ? [path.resolve(onlyProject)] : [...visibleProjectPaths()];
  for (const projectPath of projects) {
    const dir = path.resolve(projectPath, handoffWriteDirName(projectPath));
    if (insideProject(dir, projectPath) && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

function isAllowedHandoffPath(filePath, onlyProject = null) {
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().endsWith('.md')) return null;
  const ok = handoffDirs(onlyProject).some(d => isInside(resolved, d));
  return ok ? resolved : null;
}

// --- What a handoff file looks like ----------------------------------------------------------------
//
// The first heading is the title, and a header block under it carries what the row used to hold: when the
// packet was written, and which CLI wrote it. Both are optional — a file a skill wrote without knowing any
// of this is still a handoff, and then the filesystem answers the date and nothing answers the backend.
//
// Nothing may depend on the FILENAME, for the reason the plans convention spells out at length: a name is
// something a tool generates and later renames, and state that lives in a name is state that vanishes.

const HEADER_PREFIX = '> ';

/** The `key: value` pairs of the header block, if there is one. */
function parseHeader(lines) {
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith(HEADER_PREFIX.trim())) break;
    const body = trimmed.replace(/^>\s*/, '');
    for (const part of body.split('·')) {
      const match = part.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/);
      if (match) out[match[1].toLowerCase()] = match[2];
    }
  }
  return out;
}

/** One handoff row, read from its file. */
function readHandoffFile(filePath, source, displayNames) {
  let stat = null;
  let content = '';
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    content = fs.readFileSync(filePath, 'utf8');
  } catch { return null; }

  const lines = content.split('\n');
  const firstIndex = lines.findIndex(l => l.trim());
  const firstLine = firstIndex >= 0 ? lines[firstIndex].trim() : '';
  const filename = path.basename(filePath);
  const title = firstLine.startsWith('# ') ? firstLine.slice(2).trim() : filename.replace(/\.md$/i, '');
  const header = parseHeader(firstIndex >= 0 ? lines.slice(firstIndex + 1) : []);

  // NULL when the file does not say, and deliberately NOT the mtime (#577). This used to fall back to
  // `stat.mtime`, which made one field carry two different clocks — and while the list was ordered by it,
  // a packet with a header sorted by when the work was handed over and one without it by when the file was
  // last written, in the same list. The order is `modified` now, so this field means only what the header
  // said and answers null when there was none, the same way `backendId` does.
  const created = header.created && !Number.isNaN(Date.parse(header.created))
    ? new Date(header.created).toISOString()
    : null;

  return {
    filePath,
    filename,
    title,
    // What the resume picker puts on the row. It was a column; it is the heading now, so the two lists
    // cannot disagree about what a packet is called.
    label: title,
    content,
    createdAt: created,
    modified: stat.mtime.toISOString(),
    // NULL for a handoff whose file does not say — the same "unknown, not Claude" the column meant (#148).
    backendId: header.backend || null,
    projectPath: source.projectPath,
    shortName: projectShortName(source.projectPath),
    displayName: (displayNames && displayNames.get(source.projectPath)) || '',
    // Which directory it came from. A packet in `.handoffs` and one a skill left in `docs/handoffs` are
    // both handoffs, and a list that hid the difference would be a markdown browser.
    sourceDir: source.name,
  };
}

/**
 * The handoffs of one project, or of every visible project when none is named.
 *
 * Newest first BY MTIME — the same value every surface puts on the row, and the same one `handoffGroups`
 * orders the Agent Files rows by (#577).
 *
 * It used to be the `created:` header, on the argument that editing a packet does not make it a newer
 * handoff. That holds for a packet written once and a handoff is not written once: it is a running log
 * appended to per session, with the header untouched since the first write. So the packet worked on today
 * sank below one created last week and never opened again, under a row showing today's date. The header
 * is still written, still parsed and still returned; it just does not decide the order.
 */
function getHandoffs(projectPath = null) {
  let displayNames = new Map();
  try { displayNames = ctx.db.getProjectDisplayNames(); } catch {}

  const handoffs = [];
  const seen = new Set();
  for (const source of handoffSources(projectPath)) {
    let files = [];
    try { files = fs.readdirSync(source.dir).filter(f => f.toLowerCase().endsWith('.md')); } catch { continue; }
    for (const file of files) {
      const filePath = path.join(source.dir, file);
      const key = filePath.toLowerCase();
      if (seen.has(key)) continue;    // one directory reached through two spellings is still one file
      seen.add(key);
      const row = readHandoffFile(filePath, source, displayNames);
      if (row) handoffs.push(row);
    }
  }
  handoffs.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  return handoffs;
}

// --- Writing one -----------------------------------------------------------------------------------

/** `<date>-<slug>.md`. The name carries nothing, so anything unusable falls back rather than failing. */
function handoffFilename(label, createdAt, existing) {
  const date = (() => {
    const parsed = new Date(createdAt);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  })();
  const stamp = date.toISOString().slice(0, 10);
  const slug = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'handoff';
  const taken = new Set((existing || []).map(n => n.toLowerCase()));
  let candidate = `${stamp}-${slug}.md`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) candidate = `${stamp}-${slug}-${n++}.md`;
  return candidate;
}

/** The file's text: the heading, the header block, then the packet as the agent wrote it. */
function handoffFileText(label, content, createdAt, backendId) {
  const heading = String(label || '').trim() || 'Handoff';
  const bits = [`created: ${createdAt}`];
  if (backendId) bits.push(`backend: ${backendId}`);
  const body = String(content == null ? '' : content).replace(/^﻿/, '').trimStart();
  return `# ${heading}\n\n> ${bits.join(' · ')}\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}

/**
 * Save a packet as a file in its project.
 *
 * `dir` is how the caller says "somewhere else" after a refused write — the dialog that comes back from a
 * failure offers it, because this is the moment right after an expensive session and losing the packet to
 * a read-only folder is the failure worth spending a branch on. It is still held to the containment rule:
 * a directory outside the project is not this project's handoff directory, whoever picked it.
 */
/**
 * What the write core refused, in words for the dialog that asked.
 *
 * Only the thrown half goes through the translator: an errno's own message names the file's full path and
 * the renderer puts the answer on screen (#444). A refusal this module worded is already for a reader.
 */
function writeFailure(result) {
  if (result.code === 'failed') return readableError(result.cause, 'Could not write the handoff.', ctx.log);
  return result.error || 'Could not write the handoff.';
}

function saveHandoff({ projectPath, label, content, backendId, dir } = {}) {
  if (!projectPath) return { ok: false, error: 'A handoff belongs to a project, and this session has none.' };
  if (!content) return { ok: false, error: 'There is nothing to save.' };
  const root = path.resolve(projectPath);
  const target = dir ? path.resolve(dir) : path.resolve(root, handoffWriteDirName(projectPath));
  if (!insideProject(target, root)) {
    return { ok: false, error: 'A handoff directory has to be inside its project.' };
  }

  const createdAt = new Date().toISOString();
  try {
    fs.mkdirSync(target, { recursive: true });
    let existing = [];
    try { existing = fs.readdirSync(target); } catch { existing = []; }
    const filePath = path.join(target, handoffFilename(label, createdAt, existing));
    // The same write core as every other save (#441). `mustExist: false` because this file is new by
    // construction — the name is picked around what is already there.
    const result = writeTextFile(filePath, handoffFileText(label, content, createdAt, backendId), {
      mustExist: false,
    });
    if (!result.ok) return { ok: false, error: writeFailure(result) };
    // A packet quotes paths, machine names and whatever the session was looking at. If the directory it
    // just landed in is going to be committed, that is worth one sentence at the moment it happens —
    // the same warning the plans convention gives, from the same helper (#468).
    const note = ignoreWarning(
      root, path.relative(root, target).split(path.sep).join('/') || '.',
      'A handoff packet quotes paths and machine names, so consider adding it to .gitignore.',
    );
    return { ok: true, filePath, dir: target, note };
  } catch (err) {
    ctx.log.error('Error saving handoff:', err && err.message);
    return { ok: false, error: readableError(err, 'Could not write the handoff.', ctx.log) };
  }
}

function readHandoff(filePath) {
  const resolved = isAllowedHandoffPath(filePath);
  if (!resolved) return { content: '', filePath: '' };
  try {
    return { content: fs.readFileSync(resolved, 'utf8'), filePath: resolved };
  } catch (err) {
    ctx.log.error('Error reading handoff:', err && err.message);
    return { content: '', filePath: '' };
  }
}

/** Delete a handoff. A file this time, so the caller asks first — the renderer does. */
function deleteHandoff(filePath) {
  const resolved = isAllowedHandoffPath(filePath);
  if (!resolved) return { ok: false, error: 'That file is not in a handoff directory.' };
  try {
    fs.unlinkSync(resolved);
    return { ok: true };
  } catch (err) {
    ctx.log.error('Error deleting handoff:', err && err.message);
    return { ok: false, error: readableError(err, 'Could not delete that handoff.', ctx.log) };
  }
}

/** Pick another directory for a packet whose write was refused. Inside the project, or it is refused too. */
async function chooseHandoffDir(projectPath) {
  if (!ctx.dialog || !projectPath) return { ok: false };
  let answer = null;
  try {
    answer = await ctx.dialog.showOpenDialog(ctx.getMainWindow ? ctx.getMainWindow() : null, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: projectPath,
      title: 'Where should this handoff go?',
    });
  } catch { return { ok: false }; }
  if (!answer || answer.canceled || !answer.filePaths || !answer.filePaths[0]) return { ok: false };
  const dir = path.resolve(answer.filePaths[0]);
  if (!insideProject(dir, path.resolve(projectPath))) {
    return { ok: false, error: 'A handoff directory has to be inside its project.' };
  }
  return { ok: true, dir };
}

// --- The Agent Files group (#468) -------------------------------------------------------------------

// The kind a handoff carries into the Agent Files list, and the id of its chip in the type filter.
const HANDOFF_KIND = 'handoff';

/**
 * One project's handoffs, shaped as groups in the Agent Files payload.
 *
 * One group per DIRECTORY rather than one per project: a packet the app wrote into `.handoffs` and one a
 * skill left in `docs/handoffs` are told apart by nothing else, and the tab's rows carry a path relative
 * to their group.
 *
 * `backendId` is null because no CLI owns a handoff directory — the project does. Naming one here would
 * be the `|| 'claude'` the rules forbid, and a packet can be written by any backend anyway (#148).
 *
 * Newest first by mtime, which is what `getHandoffs` orders by as well since #577 — one directory read
 * through two surfaces must not come back in two orders.
 */
function handoffGroups(projectPath) {
  const groups = [];
  for (const source of handoffSources(projectPath)) {
    if (source.projectPath !== path.resolve(projectPath)) continue;
    let files = [];
    try { files = fs.readdirSync(source.dir).filter(f => f.toLowerCase().endsWith('.md')); } catch { continue; }
    if (!files.length) continue;
    const rows = [];
    for (const file of files) {
      const filePath = path.join(source.dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        rows.push({
          filename: file,
          filePath,
          displayPath: file,
          modified: stat.mtime.toISOString(),
          size: stat.size,
          kind: HANDOFF_KIND,
          backendIds: [],
          // The tab offers a delete for a row that says it has one (#441's vocabulary). A packet has a
          // lifecycle of its own — it is written here and thrown away here — so it does.
          deletable: true,
        });
      } catch {}
    }
    if (!rows.length) continue;
    rows.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    groups.push({
      id: 'handoffs:' + source.dir,
      backendId: null,
      backendLabel: null,
      label: source.name,
      kind: HANDOFF_KIND,
      path: source.dir,
      files: rows,
    });
  }
  return groups;
}

// --- Leaving the database (#468) --------------------------------------------------------------------

/**
 * Get the old rows out, then drop the table.
 *
 * Runs at startup, once — after the first successful pass there is no table left to read. The order is
 * the whole point: a row becomes a file BEFORE anything is dropped, and one that could not be written
 * keeps the drop from happening. A project whose directory is gone is exactly that case; the row waits
 * for the folder to come back rather than being discarded, and the table lingers unused until it does.
 */
function migrateLegacyHandoffs() {
  let rows = [];
  try { rows = ctx.db.readLegacyHandoffs ? (ctx.db.readLegacyHandoffs() || []) : []; } catch { rows = []; }
  if (!rows.length) {
    try { if (ctx.db.dropLegacyHandoffTable) ctx.db.dropLegacyHandoffTable(); } catch {}
    return { migrated: 0, kept: 0 };
  }

  let migrated = 0;
  let kept = 0;
  const stuck = new Set();
  for (const row of rows) {
    const projectPath = row && row.projectPath;
    if (!projectPath) { kept++; continue; }
    try {
      if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        kept++;
        stuck.add(projectPath);
        continue;
      }
    } catch { kept++; stuck.add(projectPath); continue; }

    const target = path.resolve(projectPath, handoffWriteDirName(projectPath));
    if (!insideProject(target, path.resolve(projectPath))) { kept++; stuck.add(projectPath); continue; }
    try {
      fs.mkdirSync(target, { recursive: true });
      let existing = [];
      try { existing = fs.readdirSync(target); } catch { existing = []; }
      const createdAt = row.createdAt || new Date().toISOString();
      const filePath = path.join(target, handoffFilename(row.label || 'Handoff', createdAt, existing));
      const result = writeTextFile(
        filePath,
        handoffFileText(row.label || 'Handoff', row.content, createdAt, row.backendId),
        { mustExist: false },
      );
      if (!result.ok) { kept++; continue; }
      // The row goes as soon as its file is there. Deleting per row rather than dropping the table per
      // batch is what keeps a single stuck row from re-exporting every other packet on the next start.
      // Write first, forget second: the other order loses the packet when the write fails.
      try {
        if (ctx.db.deleteLegacyHandoff) ctx.db.deleteLegacyHandoff(row.id);
      } catch (err) {
        ctx.log.warn('[handoffs] a packet was written but its row could not be dropped:', err && err.message);
      }
      migrated++;
    } catch (err) {
      ctx.log.warn('[handoffs] a saved packet could not be written to its project:', err && err.code);
      kept++;
      stuck.add(projectPath);
    }
  }

  if (kept === 0) {
    try {
      if (ctx.db.dropLegacyHandoffTable) ctx.db.dropLegacyHandoffTable();
      ctx.log.info(`[handoffs] moved ${migrated} saved handoff(s) into their projects; the old table is gone`);
    } catch (err) {
      ctx.log.warn('[handoffs] the old handoff table could not be dropped:', err && err.message);
    }
  } else {
    // Named, not just counted: a project directory that is gone is something the user can put back, and
    // they cannot do that from a number.
    ctx.log.warn(`[handoffs] ${kept} saved handoff(s) have no reachable project directory — they stay in `
      + `the database until it is back: ${[...stuck].join(', ')}`);
  }
  return { migrated, kept };
}

/** Wire the IPC surface. main.js hands in ipcMain; this file never requires electron. */
function registerIpc(ipcMain) {
  ipcMain.handle('list-handoffs', (_e, projectPath) => (projectPath ? getHandoffs(projectPath) : []));
  ipcMain.handle('save-handoff', (_e, payload) => saveHandoff(payload || {}));
  ipcMain.handle('read-handoff', (_e, filePath) => readHandoff(filePath));
  ipcMain.handle('delete-handoff', (_e, filePath) => deleteHandoff(filePath));
  ipcMain.handle('choose-handoff-dir', (_e, projectPath) => chooseHandoffDir(projectPath));
}

module.exports = {
  init,
  registerIpc,
  getHandoffs,
  saveHandoff,
  readHandoff,
  deleteHandoff,
  handoffGroups,
  HANDOFF_KIND,
  // exported for the tests: the file format and the naming are pure
  _parseHeader: parseHeader,
  _handoffFilename: handoffFilename,
  _handoffFileText: handoffFileText,
  _migrateLegacyHandoffs: migrateLegacyHandoffs,
};
