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
  watchPlansDirs();
}

// --- The plans list, kept live (#452) ---------------------------------------------------------------
//
// The open document already refreshed itself; the LIST never did. `loadPlans()` ran on a tab switch and
// nowhere else, so a plan an agent had just written did not appear, an existing row's timestamp was
// frozen, and the list is sorted by that timestamp — the ordering the user was looking at was a snapshot
// of whenever they last changed tabs.
//
// Only the plans directories are watched, and that is deliberate: they are flat and small. The other
// lists this file serves walk project trees that reach tens of thousands of files, where a recursive
// watch would cost more than the staleness it fixes.
const plansWatchers = [];
let plansChangeTimer = null;
const PLANS_DEBOUNCE_MS = 400;

function liveWindows() {
  const out = [];
  const main = ctx && typeof ctx.getMainWindow === 'function' ? ctx.getMainWindow() : null;
  if (main && !main.isDestroyed()) out.push(main);
  const others = ctx && typeof ctx.getDetachedWindows === 'function' ? ctx.getDetachedWindows() : [];
  for (const win of others || []) {
    if (win && !win.isDestroyed() && win !== main) out.push(win);
  }
  return out;
}

function announcePlansChanged() {
  if (plansChangeTimer) clearTimeout(plansChangeTimer);
  plansChangeTimer = setTimeout(() => {
    // The signature guard would otherwise skip the reindex on a write that did not move any mtime the
    // list had already seen — and the list about to be rebuilt is exactly the one asking for fresh rows.
    invalidateFtsSignature('plan');
    for (const win of liveWindows()) {
      try { win.webContents.send('plans-changed'); } catch { /* a window on its way out */ }
    }
  }, PLANS_DEBOUNCE_MS);
}

// What is currently watched, so a rebuild only happens when the set actually changed. The set is not
// fixed: a project can gain a plans directory (#454) long after the app started, and one can be removed.
let plansWatchedKey = null;

function watchPlansDirs() {
  const dirs = plansDirs();
  const key = [...dirs].sort().join('|');
  if (key === plansWatchedKey) return;
  stopWatchingPlansDirs();
  plansWatchedKey = key;
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      // A directory watch answers for a file appearing, being renamed and being removed — all three are
      // list changes and none of them touches a file this side already had open.
      plansWatchers.push(fs.watch(dir, () => announcePlansChanged()));
    } catch { /* a plans dir that cannot be watched is one whose list simply stays as stale as before */ }
  }
}

function stopWatchingPlansDirs() {
  while (plansWatchers.length) {
    try { plansWatchers.pop().close(); } catch { /* best effort */ }
  }
  if (plansChangeTimer) { clearTimeout(plansChangeTimer); plansChangeTimer = null; }
  plansWatchedKey = null;
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
// Every row in this tab carries a `kind`, because the type filter (#447) is built from them and a row
// with none would be filterable by nothing and reachable only by clearing the filter. An instruction
// file has no kind of its own — `memorySources` describes WHERE it is, not what it is — so it gets one
// here. `s.kind` on the source says dir-or-file, which is a different question.
const INSTRUCTION_KIND = 'instructions';

// A file can belong to SEVERAL backends, and the dedupe used to hide that. Codex and Pi both declare
// `AGENTS.md`; Claude and Pi both declare `CLAUDE.md`. Listing it twice would be wrong — it is one
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

// --- The type filter's chips (#447) ---
//
// Derived from the `kind` the rows already carry, never from a list — a list in the core would go stale
// the day a backend names a directory nothing had named before, and a list in the RENDERER is the
// per-backend table the rules forbid outright. A type with no rows produces no chip, so the bar shows
// what is actually there rather than what could be.
//
// The label is made from the id: hyphens become spaces, and it is pluralised, because a chip reads
// "Skills 79" and not "Skill 79". Three endings cover every kind in play and the rule degrades
// harmlessly for one it has not seen.
function typeLabel(kind) {
  const words = String(kind).replace(/-/g, ' ');
  const plural = /s$/i.test(words) ? words
    : /[^aeiou]y$/i.test(words) ? words.replace(/y$/i, 'ies')
      : words + 's';
  return plural.charAt(0).toUpperCase() + plural.slice(1);
}

// The bucket for a row whose kind nothing set. It is stamped ONTO the row rather than only counted,
// so the renderer compares against what it was given instead of keeping its own copy of this word.
const FALLBACK_KIND = 'other';

// One chip per backend that actually owns a row here. A file claimed by two backends counts for both,
// because filtering to Pi has to show the AGENTS.md Pi really reads.
function backendCounts(files, backendsList) {
  const labels = new Map(backendsList.map(b => [b.id, b.label || b.id]));
  const counts = new Map();
  for (const f of files) {
    for (const id of (f && f.backendIds) || []) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, label: labels.get(id) || id, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function typeCounts(files) {
  const counts = new Map();
  for (const f of files) {
    if (f && !f.kind) f.kind = FALLBACK_KIND;
    const kind = (f && f.kind) || FALLBACK_KIND;
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, label: typeLabel(id), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// --- Backend resource groups (#440) ---
//
// The customization directories a backend keeps — skills, rules, commands, agents — shown in this tab
// beside the instruction files it already lists. They arrive as GROUPS rather than as loose files,
// because a flat list of 500 skills is what this replaced: the directory is the row, its entries are
// what the row opens.
//
// One level is read here rather than on demand. The tab needs the count for its header and the search
// index needs the text, so a lazy load would have to run anyway before either could be right — and the
// walk is the same capped one the settings panel used to run on every open.

// What this TAB shows, which is narrower than what a backend lists. Two kinds are deliberately absent
// and both were visible mistakes before they were rules:
//
//   plan-store  the Plans tab already shows exactly these files, in a tab named for them.
//   plugin / package / theme / extension
//               a plugin is a directory, and a directory opened in a text editor is a dead end. They
//               stay in the Backends settings list, where "Open" hands them to the system.
//
// This is a property of the tab, not of any backend — it names kinds, which are the shared vocabulary,
// and no backend id appears here.
const TAB_KINDS = new Set([
  'skill', 'skill-bundle', 'rule', 'command', 'agent', 'prompt-template',
  'output-style', 'workflow', 'memory-store', 'memory', 'hook', 'resource',
]);

/** Is this listing entry a directory this backend can read into? */
function isExpandableDir(entry) {
  if (!entry || !entry.path) return false;
  try { if (!fs.statSync(entry.path).isDirectory()) return false; } catch { return false; }
  return true;
}

/** A resource entry in the shape the memory list renders. */
function resourceFile(entry, rootPath) {
  let stat = null;
  try { stat = fs.statSync(entry.path); } catch { return null; }
  const rel = path.relative(rootPath, entry.path);
  return {
    filename: entry.name || path.basename(entry.path),
    filePath: entry.path,
    modified: stat.mtime.toISOString(),
    size: stat.size,
    displayPath: rel && !rel.startsWith('..') ? rel : path.basename(entry.path),
    source: entry.source || null,
    kind: entry.kind || null,
  };
}

/**
 * The resource groups for one scope. `seen` is shared with the instruction files so a file that is both
 * (Claude's CLAUDE.md is listed by memorySources AND by listResources) appears once.
 */
function resourceGroups(projectPath, seen) {
  // `seen` is the same Map the instruction files filled, so a resource that is also an instruction file
  // adds its backend to that row rather than appearing twice.
  const groups = [];
  for (const b of memoryBackends()) {
    if (typeof b.listResources !== 'function' || typeof b.expandResource !== 'function') continue;
    let listed = null;
    try { listed = b.listResources({ projectPath: projectPath || null }); } catch { continue; }
    if (!listed || listed.ok === false || !Array.isArray(listed.resources)) continue;

    for (const entry of listed.resources) {
      const wantScope = projectPath ? 'project' : 'global';
      if ((entry.scope || 'global') !== wantScope) continue;
      if (!TAB_KINDS.has(entry.kind)) continue;
      if (!isExpandableDir(entry)) continue;

      let expanded = null;
      try { expanded = b.expandResource({ path: entry.path, source: entry.source, scope: entry.scope, projectPath: projectPath || null }); }
      catch { expanded = null; }
      if (!expanded || expanded.ok === false || !Array.isArray(expanded.entries) || !expanded.entries.length) continue;

      const files = [];
      for (const child of expanded.entries) {
        if (!child || !child.path) continue;
        if (claim(seen, child.path, b.id)) continue;
        // One level is what this reads, so a child that is itself a directory has nothing to open —
        // it would sit in the list and answer a click with "that is a directory".
        try { if (fs.statSync(child.path).isDirectory()) continue; } catch { continue; }
        const file = resourceFile(child, entry.path);
        if (!file) continue;
        file.backendIds = [b.id];
        seen.set(child.path, file);
        files.push(file);
      }
      if (!files.length) continue;

      groups.push({
        id: b.id + ':' + entry.path,
        backendId: b.id,
        backendLabel: b.label || b.id,
        label: entry.name || path.basename(entry.path),
        kind: entry.kind || 'resource',
        path: entry.path,
        truncated: !!expanded.truncated,
        files,
      });
    }
  }
  return groups;
}

// --- Plans ---

// Which project each plan belongs to (#449).
//
// The file cannot say: its name is generated and it carries no header. The SESSION that wrote it can —
// it records a reference to the plan, and it knows its project. So the answer is a lookup, not a guess.
//
// The backend that owns the plans store says how one of its files is referred to (`planRef`); the core
// never learns what that string means. A backend that declares no such hook gets no attribution, which
// is the honest answer for one whose plans nothing has ever recorded.
//
// DERIVED on the spot rather than stored: a plan whose session has been cleaned off disk has no answer
// here, and is then listed without a project rather than dropped.
function attributePlans(plans, refOf) {
  let attributions;
  try {
    attributions = ctx.db.getPlanRefAttributions();
  } catch (err) {
    // Loud on purpose. `ctx.db` is an enumerated surface built in main.js, so a reader missing from it
    // throws here — and a silent catch turned that into "no plan has a project", which looks exactly like
    // a machine whose sessions have all been cleaned up. It cost a full round of tests-green-click-dead.
    ctx.log.warn('[plans] no attribution available:', err && err.message);
    return;
  }
  let names;
  try { names = ctx.db.getProjectDisplayNames(); } catch { names = new Map(); }
  for (const plan of plans) {
    const ref = refOf.get(plan.filePath);
    const hit = ref ? attributions.get(ref) : null;
    if (!hit) continue;
    plan.projectPath = hit.projectPath;
    plan.sessionId = hit.sessionId;
    plan.shortName = projectShortName(hit.projectPath);
    plan.displayName = names.get(hit.projectPath) || '';
  }
}

// --- What a project already does with plans (#454) --------------------------------------------------
//
// The Plans list used to show one thing: the directory a backend declares as its own plans store. A
// project that keeps plan documents itself — `docs/plans/`, a spec tree, whatever the team settled on —
// was invisible, so the people most disciplined about planning got the least out of the tab.
//
// This finds those directories and lists them. It writes nothing, configures nothing and creates nothing:
// Switchboard does not produce plans, so recognising what a project does is the honest job, not insisting
// it does what we would have chosen.
//
// A plan found this way needs no attribution — it is IN the project, so the path is the answer. It also
// keeps the directory it came from, because a hand-written `docs/plans/` and a CLI's plan-mode output are
// not the same kind of document and a list that silently merged them would be a markdown browser.

/** The candidate directory names, from the settings — a list, so a project's own layout can be added. */
function planDirCandidates() {
  const fallback = ['.plans', 'docs/plans', 'plans', '.agent/plans'];
  try {
    const eff = ctx.effectiveSettings ? ctx.effectiveSettings(null) : null;
    const names = eff && eff.planDirNames;
    if (!Array.isArray(names)) return fallback;
    // A blank entry would resolve to the project root and put every markdown file in the repo on the list.
    const clean = names.map(n => String(n || '').trim()).filter(Boolean);
    return clean.length ? clean : fallback;
  } catch { return fallback; }
}

/**
 * Every project-local plan directory that exists, as `{ projectPath, dir, name }`.
 *
 * One `existsSync` per candidate per project over the register the app already keeps. A directory that is
 * not there costs a failed stat; a project with none costs nothing else.
 */
function projectPlanSources() {
  const out = [];
  const candidates = planDirCandidates();
  for (const projectPath of visibleProjectPaths()) {
    for (const name of candidates) {
      const dir = path.resolve(projectPath, name);
      // A candidate that escapes the project — `../elsewhere` in the setting — is not this project's
      // plans directory, whatever it holds.
      if (dir !== path.resolve(projectPath) && !dir.startsWith(path.resolve(projectPath) + path.sep)) continue;
      try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      } catch { continue; }
      out.push({ projectPath, dir, name });
    }
  }
  return out;
}

function getPlans() {
  const plans = [];
  const sigFiles = [];
  const bodies = new Map(); // filePath -> content (single read: title + FTS body)
  const refOf = new Map();  // filePath -> the reference its own backend knows it by
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
        plans.push({ filename: file, filePath, title, modified: stat.mtime.toISOString(), backendId: b.id });
        bodies.set(filePath, content);
        sigFiles.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
        if (typeof b.planRef === 'function') {
          try { const ref = b.planRef(filePath); if (ref) refOf.set(filePath, ref); } catch {}
        }
      } catch {}
    }
  }
  attributePlans(plans, refOf);

  // The project's own plan directories (#454), appended AFTER the attribution pass: these plans need
  // none — they live inside the project, so the path already answers the question.
  let displayNames = new Map();
  try { displayNames = ctx.db.getProjectDisplayNames(); } catch {}
  for (const source of projectPlanSources()) {
    let files = [];
    try { files = fs.readdirSync(source.dir).filter(f => f.endsWith('.md')); } catch { continue; }
    for (const file of files) {
      const filePath = path.join(source.dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        const firstLine = content.split('\n').find(l => l.trim());
        const title = firstLine && firstLine.startsWith('# ') ? firstLine.slice(2).trim() : file.replace(/\.md$/, '');
        plans.push({
          filename: file, filePath, title, modified: stat.mtime.toISOString(),
          projectPath: source.projectPath,
          shortName: projectShortName(source.projectPath),
          displayName: displayNames.get(source.projectPath) || '',
          // The directory is part of the row's identity, not decoration: it is what tells a project's own
          // plan from a CLI's, and the two are different kinds of document.
          sourceDir: source.name,
        });
        bodies.set(filePath, content);
        sigFiles.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {}
    }
  }

  plans.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  // The set of plan directories is not fixed — a project can gain one while the app runs — so the
  // watches are re-established from what was just collected. A no-op when nothing moved.
  watchPlansDirs();

  try {
    // The signature carries the ATTRIBUTION as well as the file, because the attribution is what the
    // indexed title is built from and it changes without any plan file being touched — a project renamed,
    // a session scanned for the first time. On mtime and size alone the index would be right on the day it
    // was written and wrong from then on.
    const attributedBy = new Map(plans.map(p => [p.filePath, p.displayName || p.shortName || '']));
    const sig = computeIndexSignature(sigFiles.map(f => ({ ...f, filePath: f.filePath + '\x00' + (attributedBy.get(f.filePath) || '') })));
    if (shouldReindex('plan', sig)) {
      ctx.db.deleteSearchType('plan');
      ctx.db.upsertSearchEntries(plans.map(p => ({
        // The project rides in the TITLE, not only in `folder`: the search worker's query filters on type
        // and matches the FTS text, and nothing there reads `folder` — so a project written into that
        // column alone would be a fact no query could reach. In the title it is searchable today, which
        // is how the memory index already names its scope.
        id: p.filePath, type: 'plan', folder: p.projectPath || null,
        title: (p.displayName || p.shortName)
          ? (p.displayName || p.shortName) + ' ' + p.title
          : p.title,
        body: bodies.get(p.filePath) || '',
      })));
    }
  } catch {}

  return { plans, hasStore };
}

// Every plans dir, resolved — the read/save guard for a plan path.
//
// Both kinds: what a backend declares as its own store, and what a project keeps itself (#454). A plan
// the list shows and the viewer then refuses to open would be worse than not listing it, so the guard has
// to cover exactly what `getPlans` collects — these two functions are one decision written twice, and
// they must not drift.
function plansDirs() {
  const dirs = [];
  for (const b of memoryBackends()) {
    try { const d = b.plansDir(); if (d) dirs.push(path.resolve(d)); } catch {}
  }
  for (const source of projectPlanSources()) dirs.push(source.dir);
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
  const globalSeen = new Map();
  for (const b of backendsList) {
    let sources = [];
    try { sources = b.memorySources({ projectPath: null, storeFolders: [] }) || []; } catch { sources = []; }
    for (const s of sources) collectSource(s, globalFiles, globalSeen, b.id);
  }
  const globalGroups = resourceGroups(null, globalSeen);

  // Work files (#448). Asked once for every project rather than once per project: `getWorkFiles` walks
  // the whole register and reindexes for search in the same pass, so a call inside the loop below would
  // walk every project's tree once per project.
  const workFilesByProject = new Map();
  try {
    for (const p of (getWorkFiles().projects || [])) workFilesByProject.set(p.projectPath, p);
  } catch {}

  // Per-project files: from the register (every backend's provenance), not one store directory.
  const projects = [];
  for (const projectPath of visible) {
    const storeFolders = storeFoldersFor(projectPath);
    const short = projectShortName(projectPath);
    const files = [];
    const seen = new Map();
    for (const b of backendsList) {
      let sources = [];
      try { sources = b.memorySources({ projectPath, storeFolders }) || []; } catch { sources = []; }
      for (const s of sources) collectSource(s, files, seen, b.id);
    }
    const groups = resourceGroups(projectPath, seen);
    const workFiles = workFilesByProject.get(projectPath);
    if (workFiles) groups.push(workFilesGroup(workFiles));
    if (files.length || groups.length) {
      const displayName = displayNames.get(projectPath) || '';
      projects.push({
        folder: storeFolders[0] || encodeProjectPath(projectPath),
        projectPath, shortName: short, displayName, files, groups,
      });
    }
  }

  // A project can now have groups and no loose files (#440), so the newest of EVERYTHING it holds
  // decides the order — `Math.max()` of nothing is -Infinity, which would sink such a project.
  const newestOf = (p) => {
    const times = [...p.files, ...p.groups.flatMap(g => g.files)].map(f => new Date(f.modified).getTime());
    return times.length ? Math.max(...times) : 0;
  };
  projects.sort((a, b) => newestOf(b) - newestOf(a));

  const everyFile = [
    ...globalFiles, ...globalGroups.flatMap(g => g.files),
    ...projects.flatMap(p => [...p.files, ...p.groups.flatMap(g => g.files)]),
  ];
  const result = {
    global: { files: globalFiles, groups: globalGroups },
    projects,
    types: typeCounts(everyFile),
    backends: backendCounts(everyFile, backendsList),
  };

  try {
    // Group files are indexed too (#440) — a skill the tab shows but search cannot find reads as a bug.
    //
    // Work files are the exception, and they are excluded HERE rather than left out of the list above:
    // they are in this payload since #448, but `getWorkFiles` has already indexed them under their own
    // type, with the rules they need — a `.jsonl` and anything past 64 KB is listed and not read. This
    // loop reads every entry whole and as UTF-8, so including them would mean pulling a project's entire
    // `.work-files/` tree into memory, indexing each file twice, and losing the whole memory index to
    // the first read that throws.
    const forMemoryIndex = (files) => files.filter(f => f.kind !== WORK_FILE_KIND);
    const allFiles = [
      ...forMemoryIndex(globalFiles).map(f => ({ ...f, label: 'Global' })),
      ...globalGroups.flatMap(g => forMemoryIndex(g.files).map(f => ({ ...f, label: 'Global' }))),
      ...projects.flatMap(p => forMemoryIndex([...p.files, ...p.groups.flatMap(g => g.files)])
        .map(f => ({ ...f, label: p.displayName || p.shortName }))),
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

// An instruction file the tab may open and save. Markdown, or one of the handful of agent-instruction
// files that carry no extension at all (#451 — Hermes reads `.cursorrules` beside `AGENTS.md`).
//
// The real protection is the containment check beside this one: a path has to sit under a backend's own
// memory root or a registered project. This narrowing is about not opening arbitrary file types in a
// markdown editor, so a NAMED file is as safe as a `.md` — and listing a file the viewer then answers
// with an empty editor is the worse failure.
const EXTENSIONLESS_INSTRUCTION_FILES = new Set(['.cursorrules']);

function isInstructionFile(resolved) {
  if (resolved.endsWith('.md')) return true;
  return EXTENSIONLESS_INSTRUCTION_FILES.has(path.basename(resolved));
}

function readMemory(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (!isInstructionFile(resolved)) return '';
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
    if (!isInstructionFile(resolved)) return { ok: false, error: 'not an instruction file' };
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

// The kind a work file carries into the Agent Files list, and the id of its chip in the type filter.
const WORK_FILE_KIND = 'work-file';

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

/**
 * One project's work files, shaped as a group in the Agent Files payload (#448).
 *
 * A group and not loose rows, for two reasons the tab it replaces already had: `.work-files/` is a
 * directory and reads as one, and the cap really bites (a project can hold tens of thousands of files).
 * The group header is the only place that cap is ever admitted to, as `shown/total`.
 *
 * `backendId` is null because no CLI owns `.work-files/` — the project does. Everything downstream that
 * draws a backend has to cope with that; naming one here would be the `|| 'claude'` the rules forbid.
 */
function workFilesGroup(proj) {
  return {
    id: 'work-files:' + proj.projectPath,
    backendId: null,
    backendLabel: null,
    label: '.work-files',
    kind: WORK_FILE_KIND,
    path: path.join(proj.projectPath, '.work-files'),
    total: proj.totalCount,
    // `displayPath` rather than the bare filename: work files nest, and two `notes.md` in different
    // subdirectories are told apart by nothing else. Same field the instruction rows use, so the row
    // builder needs no branch for it.
    files: proj.files.map(f => ({ ...f, displayPath: f.relativePath, kind: WORK_FILE_KIND, backendIds: [] })),
  };
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
  // No `get-work-files` handler: work files arrive with `get-memories` since #448, and a second way to
  // ask for them is a second answer that can disagree with the list the user is looking at.
  ipcMain.handle('read-work-file', (_e, filePath) => readWorkFile(filePath));
  ipcMain.handle('delete-work-file', (_e, filePath) => deleteWorkFile(filePath));
}

module.exports = {
  init,
  registerIpc,
  // exported for the tests: the label rule and the counting are pure
  _typeLabel: typeLabel, _typeCounts: typeCounts, _backendCounts: backendCounts,
  _isInstructionFile: isInstructionFile,
  // exported for main.js (save-file-for-panel invalidates the FTS signature) and for tests
  invalidateFtsSignature,
  getPlans, readPlan, savePlan, getMemories, readMemory, saveMemory,
  getWorkFiles, readWorkFile, deleteWorkFile,
  // The plans-directory watch (#452) — started by init, stopped by the ordered teardown.
  stopWatchingPlansDirs,
};
