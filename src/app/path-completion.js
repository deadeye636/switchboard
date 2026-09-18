// app/path-completion.js — what an `@` in a session's input completes to (#643, A3).
//
// The input of a session with no terminal (`src/renderer/session/conversation-view.js`) offers the project's
// files after an `@`, the way a CLI's own prompt does. Two answers, and the prefix decides which:
//
//   * with a `/` in it (`src/rend`), the entries of the directory it names that start with the last part —
//     one `readdir`, the way a shell completes;
//   * without one (`conv`), files and directories anywhere in the project whose NAME contains it, from a
//     bounded walk. That is what makes `@conversation` find `src/renderer/session/conversation-view.js`.
//
// It names no backend and reads no store: the question is about the project's own files. What it will not do:
//
//   * leave the project. The directory a prefix names is asked about with `isAtOrInside` on REAL paths
//     (CLAUDE.md reflex 13), BEFORE it is read — `@../` and a junction pointing out answer nothing. The walk
//     never descends into a link at all, so it cannot leave through one either.
//   * touch an `.asar`: a prefix with such a segment is refused before its path is resolved, and the walk
//     skips the name (`build-dirs.js` says why — statting one holds it open for the life of the process). It
//     does not walk into generated output, a fetched dependency or a VCS store either, and it offers hidden
//     entries only when the typed part starts with a dot.
//   * block the main process. Every read is asynchronous, the walk yields between directories and checks
//     its budget per entry, and it stops at WALK_MAX_ENTRIES entries or WALK_MAX_MS. A walk that finished is
//     kept for WALK_CACHE_MS, so typing a name costs one walk rather than one per keystroke; one that was
//     cut short is kept only briefly, because it may be missing what the next keystroke asks for.
'use strict';

const fs = require('fs');
const path = require('path');
const { isAtOrInside } = require('./path-containment');
const { isBuildDir, isAsarArchive } = require('./build-dirs');

const LIMIT = 50;
const WALK_MAX_ENTRIES = 20000;
const WALK_MAX_MS = 400;
const WALK_CACHE_MS = 10000;
const PARTIAL_WALK_CACHE_MS = 1500;

// root -> { at, keep, entries: [{ rel, dir }] }. A handful of projects at most; the oldest goes first.
const walks = new Map();

function hidden(name) { return name.startsWith('.'); }

async function listDir(dirAbs) {
  try { return await fs.promises.readdir(dirAbs, { withFileTypes: true }); } catch { return []; }
}

// A link is offered as what it points at, so `@inlink` reads as a directory when it is one. Asked with
// `stat`, which follows it; a link that goes nowhere is a plain entry.
async function isDirEntry(dirAbs, d) {
  if (d.isDirectory()) return true;
  if (!d.isSymbolicLink()) return false;
  try { return (await fs.promises.stat(path.join(dirAbs, d.name))).isDirectory(); } catch { return false; }
}

// A walk still running for a project, shared by every keystroke that asks meanwhile — otherwise each one
// before the first walk finished would start its own.
const running = new Map();

function walk(root, now) {
  const cached = walks.get(root);
  if (cached && now - cached.at < cached.keep) return Promise.resolve(cached.entries);
  if (running.has(root)) return running.get(root);
  const p = walkOnce(root, now).finally(() => running.delete(root));
  running.set(root, p);
  return p;
}

async function walkOnce(root, now) {
  const entries = [];
  const started = Date.now();
  const queue = [''];
  let cut = false;
  outer:
  while (queue.length) {
    const rel = queue.shift();
    const dirAbs = path.join(root, rel);
    for (const d of await listDir(dirAbs)) {
      if (entries.length >= WALK_MAX_ENTRIES || Date.now() - started >= WALK_MAX_MS) { cut = true; break outer; }
      if (isAsarArchive(d.name)) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      // A link is named as what it points at, and never followed: the walk cannot leave through one.
      const dir = await isDirEntry(dirAbs, d);
      if (dir && (isBuildDir(d.name) || hidden(d.name))) continue;
      if (!dir && hidden(d.name)) continue;
      entries.push({ rel: childRel, dir });
      if (d.isDirectory()) queue.push(childRel);
    }
    await new Promise((r) => setImmediate(r));   // let the rest of the main process run between directories
  }
  if (walks.size > 8) walks.delete(walks.keys().next().value);
  walks.set(root, { at: now, keep: cut ? PARTIAL_WALK_CACHE_MS : WALK_CACHE_MS, entries });
  return entries;
}

const byDirThenName = (a, b) => (a.dir === b.dir ? a.value.localeCompare(b.value) : a.dir ? -1 : 1);

async function listing(dirAbs, dirRel, base) {
  const baseLower = base.toLowerCase();
  const out = [];
  for (const d of await listDir(dirAbs)) {
    if (isAsarArchive(d.name)) continue;
    if (hidden(d.name) && !base.startsWith('.')) continue;
    if (!d.name.toLowerCase().startsWith(baseLower)) continue;
    const dir = await isDirEntry(dirAbs, d);
    out.push({ value: dirRel + d.name + (dir ? '/' : ''), dir });
  }
  return out.sort(byDirThenName);
}

/**
 * The completions for one `@` prefix, relative to `root` and spelled with `/`: `[{ value, dir }]`, a
 * directory's value ending in `/`. `root` is the session's project; nothing outside it is ever named.
 */
async function completePaths(root, prefix, { limit = LIMIT, now = Date.now() } = {}) {
  if (!root || typeof root !== 'string') return [];
  const typed = String(prefix == null ? '' : prefix).replace(/\\/g, '/');
  if (typed.startsWith('/') || /^[A-Za-z]:/.test(typed)) return [];   // only relative to the project
  const slash = typed.lastIndexOf('/');
  const base = slash >= 0 ? typed.slice(slash + 1) : typed;

  if (slash >= 0) {
    const dirRel = typed.slice(0, slash + 1);
    if (dirRel.split('/').some(isAsarArchive)) return [];   // before anything resolves the path
    const dirAbs = path.resolve(root, dirRel);
    if (!isAtOrInside(dirAbs, root)) return [];
    return (await listing(dirAbs, dirRel, base)).slice(0, limit);
  }

  // No directory named: the project's top level first, then anything whose name contains what was typed.
  const top = await listing(root, '', base);
  if (!base) return top.slice(0, limit);
  const baseLower = base.toLowerCase();
  const seen = new Set(top.map(t => t.value));
  const found = [];
  for (const e of await walk(root, now)) {
    const name = e.rel.slice(e.rel.lastIndexOf('/') + 1).toLowerCase();
    if (!name.includes(baseLower)) continue;
    const value = e.rel + (e.dir ? '/' : '');
    if (seen.has(value)) continue;
    found.push({ value, dir: e.dir, starts: name.startsWith(baseLower) });
  }
  found.sort((a, b) => (a.starts !== b.starts ? (a.starts ? -1 : 1) : a.value.length - b.value.length || a.value.localeCompare(b.value)));
  return [...top, ...found.map(({ value, dir }) => ({ value, dir }))].slice(0, limit);
}

module.exports = { completePaths, LIMIT, WALK_MAX_ENTRIES, WALK_MAX_MS, WALK_CACHE_MS };
