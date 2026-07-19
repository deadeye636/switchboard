// projects.js — project management, in one place and out of main.js (#170).
//
// A project is a directory the user works in. Switchboard has to know which ones exist, which of them
// to show, which are trusted, and how to forget one. All of that lived in main.js — and main.js cannot
// be tested: nothing requires it, so nothing can exercise it. Both of the bugs that shipped green on
// 2026-07-13 (#151, #155) lived in exactly that blind spot, and were caught by reading, not by running.
//
// So this module keeps no Electron reference of its own: everything it touches is injected through
// init(), and a plain `node --test` process can load it. main.js wires it up and stops owning the logic.
//
// The context is an explicit ALLOW-LIST, the way session-cache.js does it: a function that is missing
// here is `undefined` at runtime, not "inherited from somewhere". test/projects-wiring.test.js checks
// that main.js actually passes everything this file reads.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { encodeProjectPath } = require('../session/encode-project-path');
const { deriveProjectPath } = require('../session/derive-project-path');
const registry = require('./project-registry');
// Global-only setting defaults (#239). Requiring app/settings.js here is safe: it pulls in no Electron
// and no db at load — both arrive through its own ctx.
const { GLOBAL_ONLY_DEFAULTS } = require('../app/settings');
// No `require` of a backend-specific module here (#211): per-project trust, meta, config and transcript
// paths are all declared capabilities the core reaches through `ctx.backends`, so the Projects admin does
// not know that Claude — or any one backend — exists.

let ctx = null;

/**
 * @param {object} context
 *   PROJECTS_DIR       Claude's store root (~/.claude/projects)
 *   activeSessions     Map of live sessions — a project with one is never auto-hidden
 *   log                electron-log
 *   showOpenDialog     () => Promise<{canceled, filePaths}>  — the only Electron surface, injected
 *   db                 { getSetting, setSetting, deleteSetting, deleteCachedFolder, deleteSearchFolder,
 *                        getProjectMeta, setProjectAutoHidden, resetProjectAutoHide, getAutoHiddenProjects,
 *                        renameProjectRefs, deleteProjectRefs, setFolderMeta, toggleProjectFavorite }
 *   cache              { refreshFolder, buildProjectsFromCache, buildProjectsAdmin, shouldAutoHide,
 *                        claudeStoreScope, notifyRendererProjectsChanged }
 */
function init(context) {
  ctx = context;
}

// --- helpers ---

/**
 * Put a project ON THE LIST (#167) — because the user did something explicit: added it by hand, or
 * started a session in it. Both modes: manual mode means "nobody but me writes to the list", not "I
 * cannot start a session anywhere".
 *
 * It buries any tombstone and comes back VISIBLE, and it restarts the auto-hide grace timer so a
 * just-added stale project is not immediately hidden again on the next pass (#57).
 */
function ensureProjectAdded(projectPath) {
  if (!projectPath) return;
  try {
    ctx.db.setProjectState(projectPath, registry.registrationState(new Date().toISOString()));
  } catch (err) {
    ctx.log.warn('[registry] register failed: ' + err.message);
  }
}

// --- #57: auto-hide stale projects ---
// One pass over all known projects: any non-hidden project with no running session whose effective
// activity (max of newest session activity and autoHideResetAt) is older than `autoHideDays` gets the
// autoHidden flag. Runs on app start and on the throttled refresh.
//
// The pass RELEASES as well as hides (#184). An auto-hide is the machine's decision, and the one thing
// that separates it from a hide is that the machine takes it back by itself — that is what the two
// columns are for. It never did: the sweep only ever set the flag, and nothing but an unhide by hand or
// a remap cleared it. A project that went quiet long enough was gone for good, however much work went
// into it afterwards. A hide the USER made is still theirs alone; activity does not undo it.
let lastAutoHideAt = 0;
const AUTO_HIDE_THROTTLE_MS = 10000;

// Give back every project the auto-hide is currently holding. A hide the user made is a different
// column and is not touched. Silent when there is nothing to give back, so it costs nothing on the
// pass that runs whenever the projects refresh.
function releaseAllAutoHidden() {
  try {
    const held = ctx.db.getAutoHiddenProjects();
    if (!held || held.size === 0) return;
    for (const projectPath of held) {
      try { ctx.db.setProjectAutoHidden(projectPath, 0); } catch { /* best effort */ }
    }
    ctx.cache.notifyRendererProjectsChanged();
  } catch (err) {
    ctx.log.warn('[auto-hide] release failed: ' + (err && err.message));
  }
}

function applyAutoHide(force) {
  try {
    const global = ctx.db.getSetting('global') || {};
    // The default lives once, in app/settings.js (#239) — not as a fourth literal here.
    const days = Number(global.autoHideDays ?? GLOBAL_ONLY_DEFAULTS.autoHideDays) || 0;
    if (!(days > 0)) {
      // The feature is off. Nothing may STAY auto-hidden by a machine that is no longer running —
      // switching it off has to give back every project it took (#184).
      releaseAllAutoHidden();
      return;
    }

    const now = Date.now();
    if (!force && now - lastAutoHideAt < AUTO_HIDE_THROTTLE_MS) return;
    lastAutoHideAt = now;

    // A project with a live (non-exited) session is active — never auto-hide it.
    const runningPaths = new Set();
    for (const [, session] of ctx.activeSessions) {
      if (session.exited) continue;
      if (session.projectPath) runningPaths.add(session.projectPath);
    }

    let changed = false;
    // buildProjectsAdmin returns every project (hidden included) with lastActivity.
    for (const row of ctx.cache.buildProjectsAdmin()) {
      if (!row.registered) continue;                    // not on the list — nothing to hide
      if (row.hidden) continue;                         // hidden by hand: not the machine's to undo
      const meta = ctx.db.getProjectMeta(row.projectPath);
      const activityMs = row.lastActivity ? new Date(row.lastActivity).getTime() : 0;
      const resetMs = meta && meta.autoHideResetAt ? new Date(meta.autoHideResetAt).getTime() : 0;
      const eff = Math.max(activityMs, resetMs);
      // A project with a live (non-exited) session is active by definition, whatever its timestamps say.
      const stale = !runningPaths.has(row.projectPath) && ctx.cache.shouldAutoHide(eff, now, days);

      if (stale && !row.autoHidden) {
        // ONLY the flag. It used to also push the path onto `hiddenProjects` — the same list a manual
        // hide wrote to — so the two became one state, and an auto-hidden project could never come back
        // by itself, which is the one thing that separates it from a hide (#167).
        try { ctx.db.setProjectAutoHidden(row.projectPath, 1); } catch { /* best effort */ }
        changed = true;
      } else if (!stale && row.autoHidden) {
        // Back within the window — work happened here again. The flag goes, and nothing else: stamping
        // the reset timer as well would hand the project a fresh grace period it did not earn, and it
        // would not age out again on its own (#184).
        try { ctx.db.setProjectAutoHidden(row.projectPath, 0); } catch { /* best effort */ }
        changed = true;
      }
    }

    if (changed) ctx.cache.notifyRendererProjectsChanged();
  } catch (err) {
    ctx.log.error('[auto-hide] applyAutoHide failed:', err && err.message);
  }
}

/**
 * Does any ~/.claude/projects/<folder> still resolve to this project? Legacy folder encodings mean
 * there can be several, so scan rather than test the encoded name.
 */
function projectHasSessionsOnDisk(projectPath) {
  const encoded = encodeProjectPath(projectPath);
  try {
    return fs.readdirSync(ctx.PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .some(d => d.name === encoded || deriveProjectPath(path.join(ctx.PROJECTS_DIR, d.name)) === projectPath);
  } catch {
    return false;
  }
}

/**
 * Index EVERY store folder that belongs to this project — not just the one its path encodes to.
 *
 * Claude's folder-name encoding has changed over time, so one project can own several store folders
 * (session-cache.js merges them into one sidebar group for exactly that reason). While the project was
 * removed each of those folders had its mtime memo stamped up to date on the way past, so refreshing only
 * the canonical name would leave the others skipped by the reconcile gate — their sessions gone from the
 * cache, their files on disk, and nothing to bring them back until something happens to touch them.
 */
function refreshProjectFolders(projectPath) {
  const folders = new Set([encodeProjectPath(projectPath)]);
  try {
    for (const [folder, meta] of ctx.db.getAllFolderMeta()) {
      if (meta && meta.projectPath === projectPath) folders.add(folder);
    }
  } catch { /* the canonical folder alone is better than nothing */ }
  for (const folder of folders) {
    try { ctx.cache.refreshFolder(folder); } catch { /* the reconcile sweep will get it */ }
  }
}

/** Windows spells the same directory two ways, and a missed tombstone means a resurrected project. */
function samePathKey(p) {
  // Normalise separators too (backslash -> forward slash), not just the trailing one and case: on Windows
  // the same directory gets spelled with either separator by different backends/launches, and without
  // collapsing them the register keeps BOTH as separate projects — the same cwd then shows two (or three)
  // times in the sidebar (#8). This matches normPath (derive-project-path.js), the one canonical form.
  const t = String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return process.platform === 'win32' ? t.toLowerCase() : t;
}

/**
 * Is there ANY session left in this project — from any backend?
 *
 * `projectHasSessionsOnDisk` only ever looked in Claude's store, and the prune below is what wipes a
 * project's tags, handoffs and favourites. So clearing just the Claude history of a project that also has
 * Codex or Pi sessions counted as "nothing left" and threw all of that away, while the other backends'
 * sessions carried on being listed. The cache is the honest answer here: a hard delete removes the rows of
 * the backends the user picked and no others, so a row that is still there is a session that is still there.
 */
function projectHasSessionsLeft(projectPath) {
  try {
    if ((ctx.db.getCachedByProjectPath(projectPath) || []).length) return true;
  } catch { /* fall through to the store */ }
  return projectHasSessionsOnDisk(projectPath);
}

/**
 * After a hard delete, forget the project entirely (#55). Only when nothing is left to restore — no
 * sessions on disk and no backend still tracking it in its own config. A plain "hide" keeps all of this,
 * because unhiding has to bring the project back intact.
 *
 * Called at the end of the two hard-delete handlers rather than from the renderer: the "Remove" dialog
 * runs them in sequence, so whichever finishes last finds the project truly gone and does the pruning.
 */
function pruneProjectIfGone(projectPath) {
  if (!projectPath) return false;
  if (projectHasSessionsLeft(projectPath) || projectKnownToAnyBackend(projectPath)) return false;

  // The project_meta row goes, and the register row IS that row (#167) — so the entry, the hide flags and
  // the tombstone go with it. There is nothing left to guard: no sessions anywhere, no config entry.
  try { ctx.db.deleteProjectRefs(projectPath); } catch (err) {
    ctx.log.warn('[prune] project refs delete failed: ' + err.message);
  }
  ctx.log.info('[prune] forgot project (no sessions, no config entry): ' + projectPath);
  return true;
}

// --- the operations (one per IPC handler) ---

async function browseFolder() {
  const result = await ctx.showOpenDialog();
  if (!result || result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

/**
 * Put a project on the list (#167).
 *
 * This used to create `~/.claude/projects/<encoded>/` and write a FAKE transcript into it — a session
 * that never happened, saying "New project" — because a project the app could not derive from a
 * transcript could not exist. It exists now because it is on the list, so the forgery is gone.
 */
function addProject(projectPath) {
  try {
    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    ensureProjectAdded(projectPath);

    // If the store already holds sessions for it (a project that was removed, or one Claude has been used
    // in outside Switchboard), index them NOW — all of them, from every folder that belongs to it — so
    // they are there before the renderer paints. "Re-adding brings all its sessions back" is a promise.
    refreshProjectFolders(projectPath);
    ctx.cache.notifyRendererProjectsChanged();

    return { ok: true, folder: encodeProjectPath(projectPath), projectPath };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * HIDE: on the list, not shown. Reversible, and new sessions do NOT bring it back — that is the whole
 * point of saying "hide". Its sessions keep being indexed, so unhiding shows them at once.
 */
function hideProject(projectPath) {
  try {
    if (!projectPath) return { error: 'No project path' };

    // Hiding is a property OF A LISTED PROJECT. Setting it on one that is not on the list writes a flag
    // nothing shows and nothing can clear — and the day discovery registers that project, it arrives
    // already hidden, for a reason nobody can see. That is the silent swallow this whole issue exists to
    // kill, so refuse instead: there is nothing to hide.
    const state = ctx.db.getProjectMeta(projectPath);
    if (!state || !state.registered) return { error: 'This project is not on the list, so there is nothing to hide' };

    ctx.db.setProjectState(projectPath, { hidden: 1 });
    ctx.cache.notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * REMOVE: off the list, cached rows purged — and a tombstone, or it would not stick.
 *
 * The sessions that put the project on the list stay on disk. Without a memory of WHEN it was removed,
 * the very next scan would find them and register it straight back, so removing would be a no-op in auto
 * mode — which is exactly why the old code turned "remove" into a permanent hide instead. Only a session
 * NEWER than the tombstone brings the project back.
 */
function removeProject(projectPath) {
  try {
    if (!projectPath) return { error: 'No project path' };
    ctx.db.setProjectState(projectPath, registry.removalState(new Date().toISOString()));

    // Purge the cached rows — THIS PROJECT'S, from EVERY backend, row by row.
    //
    // Two things this deliberately is not. It is not folder-scoped: a store folder is keyed on the cwd a
    // session started from, so since #157 it can hold rows of OTHER projects, and clearing by folder
    // would drop those while their transcripts sat on disk. And it is not Claude-only: "remove from
    // Switchboard" that leaves a project's Codex and Pi sessions in the cache, the search index and the
    // stats has not removed it — the sidebar row goes and every other view keeps it.
    //
    // No session FILE is touched. Deleting the history is a separate act (deleteProjectSessions).
    let rows = [];
    try { rows = ctx.db.getCachedByProjectPath(projectPath) || []; } catch { rows = []; }
    for (const r of rows) {
      try { ctx.db.deleteCachedSession(r.sessionId); } catch { /* best effort */ }
      try { ctx.db.deleteSearchSession(r.sessionId); } catch { /* best effort */ }
    }
    ctx.db.deleteSetting('project:' + projectPath);

    ctx.cache.notifyRendererProjectsChanged();
    return { ok: true, cleared: rows.length };
  } catch (err) {
    return { error: err.message };
  }
}

/** The projects that are on the list but not shown, flagged with whether auto-hide did it. */
function getHiddenProjects() {
  const out = [];
  for (const [projectPath, state] of ctx.db.getProjectStates()) {
    if (!state.registered) continue;
    if (!state.hidden && !state.autoHidden) continue;
    out.push({ path: projectPath, autoHidden: !!state.autoHidden });
  }
  return out;
}

/**
 * Show it again — whether it was hidden by hand or by staleness. Both flags go, and the auto-hide grace
 * timer restarts, or a stale project would be hidden again on the very next pass (#57).
 */
function unhideProject(projectPath) {
  try {
    if (!projectPath) return { error: 'No project path' };
    // An unhide of a project that is somehow not on the list puts it on it: the user is asking to see it.
    ctx.db.setProjectState(projectPath, { hidden: 0, registered: 1 });
    try { ctx.db.resetProjectAutoHide(projectPath); } catch { /* best effort */ }

    refreshProjectFolders(projectPath);
    ctx.cache.notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Toggle automatic project discovery — that is, WHO MAY WRITE TO THE LIST (#167).
 *
 * auto:   discovery registers a project it finds a session in, in any backend's store. The user may
 *         still add one by hand.
 * manual: only the user does. Nothing that turns up in a store on its own gets on the list.
 *
 * Flipping the switch no longer has to snapshot anything: the list is already the list. It used to
 * freeze the currently-visible projects into an allowlist, because manual mode was a FILTER over a
 * derivation and without that snapshot the sidebar would have gone blank.
 */
function setProjectAutoAdd(enabled) {
  try {
    const global = ctx.db.getSetting('global') || {};
    global.projectAutoAdd = !!enabled;
    ctx.db.setSetting('global', global);
    ctx.cache.notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Discovery: put the projects the scan found on the list — and sweep the tombstones that guard nothing.
 *
 * Called from `get-projects`, after the scans and before the list is built, so what a scan just found is
 * on the list by the time the sidebar paints it. It is the ONLY place discovery writes to the register,
 * and it is deliberately backend-blind: a Codex or Pi session in an unknown path registers its project
 * exactly like a Claude one. The old code could only ever discover Claude projects, because the list was
 * read out of Claude's store.
 */
function syncRegistry() {
  try {
    const global = ctx.db.getSetting('global') || {};
    const autoAdd = global.projectAutoAdd !== false;
    const states = ctx.db.getProjectStates();

    // The newest session per project, across every backend. The tombstone is compared against it, so it
    // has to include the projects the CACHE cannot speak for: a removed project is not indexed, and if
    // discovery only looked at cached rows, a brand-new session in it would never be noticed and
    // "removed" would quietly mean "banned for good". The scan reports what it saw in the stores.
    //
    // ONE pass over the cached rows, not `buildProjectsAdmin()` — that also readdirs the store and stats
    // every project path, and this runs on every sidebar render.
    const newest = new Map();
    for (const [projectPath, at] of ctx.cache.getStoreProjectPaths()) newest.set(projectPath, at || null);
    for (const row of ctx.db.getAllCached()) {
      if (!row.projectPath) continue;
      const at = row.modified || null;
      const known = newest.get(row.projectPath);
      if (!newest.has(row.projectPath) || (at && (!known || at > known))) {
        newest.set(row.projectPath, at || known || null);
      }
    }

    // The same directory can be spelled two ways on Windows, and a state looked up under the wrong
    // spelling is a state that is not there — which for a tombstone means the project resurrects itself.
    const byKey = new Map();
    for (const [p, s] of states) byKey.set(samePathKey(p), s);

    const now = new Date().toISOString();
    let changed = false;

    for (const [projectPath, sessionAt] of newest) {
      const state = states.get(projectPath) || byKey.get(samePathKey(projectPath));
      if (!registry.shouldRegister(state, { source: 'scan', autoAdd, sessionAt })) continue;
      // Registering does NOT unhide: `registrationState` is for an explicit act by the user. Discovery
      // only puts it on the list, and a project the user hid stays hidden while its sessions pile up.
      ctx.db.setProjectState(projectPath, { registered: 1, registeredAt: now, removedAt: null });
      changed = true;

      // Index it NOW — every folder of it. While it was removed the scan skipped those folders, and
      // stamped each one's mtime memo as up to date on the way past, so the next reconcile would skip
      // them too: the project would sit in the sidebar empty, its sessions on disk, nothing to bring
      // them in.
      if (state && state.removedAt) refreshProjectFolders(projectPath);
    }

    // The sweep. A tombstone whose sessions are all gone guards nothing — a genuinely new session at that
    // path SHOULD register the project again — so it is only in the way. The grace period is the safety
    // belt: an unmounted network drive looks exactly like a deleted one.
    //
    // "Has sessions" must be asked of the STORES, not of the cache. A removed project is not indexed, so
    // the cache is empty for it BY CONSTRUCTION — believing the cache would sweep every tombstone on the
    // next pass and resurrect the project off the transcripts still on disk. So: the cache, plus what the
    // scan actually saw in the backend stores, plus Claude's store on disk.
    const seen = new Set([...newest.keys()].map(samePathKey));
    const nowMs = Date.now();
    for (const [projectPath, removedAt] of ctx.db.getProjectTombstones()) {
      const hasSessions = seen.has(samePathKey(projectPath)) || projectHasSessionsOnDisk(projectPath);
      if (!registry.shouldDropTombstone({ removedAt }, { hasSessions, now: nowMs })) continue;
      ctx.db.setProjectState(projectPath, { removedAt: null });
      ctx.log.info('[registry] tombstone swept (no sessions left anywhere): ' + projectPath);
    }

    if (changed) ctx.cache.notifyRendererProjectsChanged();
  } catch (err) {
    ctx.log.warn('[registry] sync failed: ' + (err && err.message));
  }
}

/**
 * Move a project's sessions to a new path — ALL of them, not just Claude's (#171).
 *
 * A remap used to rewrite `~/.claude/projects/**` and stop there, which split a mixed project in two:
 * Claude's history followed the rename and Codex' stayed behind as a phantom at the old path. And a
 * project with only Codex sessions could not be remapped at all — the handler looked for them in
 * Claude's store and reported "No session data found".
 *
 * Each backend declares how to rewrite its own transcript (`rewriteProjectPath`). One that cannot —
 * Hermes keeps its cwd in a database we may only read (#2914) — is reported, not silently skipped.
 *
 * @returns {{moved: object, cannotMove: string[]}} sessions rewritten per backend, and the backends
 *          whose sessions had to stay behind.
 */
function rewriteSessionPaths(oldPath, newPath) {
  const moved = {};
  const cannotMove = [];

  // The rows are the map of where a project's sessions actually live — every backend, every file.
  let rows = [];
  try { rows = ctx.db.getCachedByProjectPath(oldPath) || []; } catch { rows = []; }

  const byBackend = new Map();
  for (const row of rows) {
    // getCachedByProjectPath COALESCEs a legacy NULL backendId to the pre-multi-LLM default already, so
    // the id is always set here — the core does not re-guess it.
    const id = row.backendId;
    if (!byBackend.has(id)) byBackend.set(id, []);
    byBackend.get(id).push(row);
  }

  for (const [backendId, backendRows] of byBackend) {
    const backend = ctx.backends.get(backendId);
    // A template runs its base backend's binary and writes into its store, so it rewrites like the base.
    const rewrite = backend && typeof backend.rewriteProjectPath === 'function'
      ? backend.rewriteProjectPath
      : null;

    if (!rewrite) {
      // Hermes: its cwd is a column in a database we may not write. Say so.
      cannotMove.push(backend ? (backend.label || backendId) : backendId);
      continue;
    }

    let count = 0;
    for (const row of backendRows) {
      // Where this row's transcript lives is the backend's own answer (#211): a file backend hands back
      // the filePath stored on the row (v11 — a date-bucketed Codex rollout has nothing to reconstruct
      // from), Claude reconstructs from folder + session id over its own roots (subagents included). The
      // core no longer knows how any one backend spells a path.
      const file = backend.transcriptPathFor(row);
      if (!file) continue;
      try { if (rewrite(file, oldPath, newPath)) count++; } catch (err) {
        ctx.log.warn(`[remap] ${backendId}: ${file}: ${err.message}`);
      }
    }
    if (count) moved[backendId] = count;
  }

  return { moved, cannotMove };
}

function remapProject(oldPath, newPath) {
  try {
    const stat = fs.statSync(newPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Every backend's sessions, not only Claude's. A project with no Claude sessions at all is a normal
    // project and must be remappable — it used to be refused outright.
    const { moved, cannotMove } = rewriteSessionPaths(oldPath, newPath);
    const folder = encodeProjectPath(oldPath);

    // Nothing to move AND nothing that had to stay behind AND no session on disk = there is no project
    // here. projectHasSessionsOnDisk is the honest store-side check (it already owns the PROJECTS_DIR
    // scan); the core does not re-derive a Claude store path inline for this.
    if (!Object.keys(moved).length && !cannotMove.length && !projectHasSessionsOnDisk(oldPath)) {
      return { error: 'No session data found for this project' };
    }

    // Re-point the folder→projectPath cache before refreshing. folderProjectPath() short-circuits
    // derivation while the previously-derived directory still exists — and after a remap the OLD
    // directory usually does. Without this the folder keeps resolving to oldPath, the rewritten cwd is
    // ignored, and the project vanishes from the sidebar once the rest of its state has moved to
    // newPath. A zero mtime marks the folder stale so the refresh below fully re-indexes it.
    ctx.db.setFolderMeta(folder, newPath, 0);
    ctx.cache.refreshFolder(folder);

    // Carry Switchboard's own per-project state across (#55): favorite + auto-hide (project_meta), tags,
    // handoffs, and the `project:<path>` blob that holds the display name, permission mode, worktree
    // prefs and AFK timeout. Without this a remap silently dropped all of it and left the old path
    // behind as a phantom.
    try { ctx.db.renameProjectRefs(oldPath, newPath); } catch (err) {
      ctx.log.warn('[remap] project refs move failed: ' + err.message);
    }
    // The register moves with the project (#167). `renameProjectRefs` above already carries the
    // project_meta row over, hide flag and all — a hide the user made themselves is about the PROJECT,
    // and the project is what just moved. What must not survive is a TOMBSTONE sitting on the new path:
    // the user is plainly putting a project there, and a stale removal would make it vanish on the next
    // scan with no control anywhere that says why.
    try {
      ctx.db.setProjectState(newPath, { registered: 1, registeredAt: new Date().toISOString(), removedAt: null });
    } catch (err) {
      ctx.log.warn('[remap] register move failed: ' + err.message);
    }

    // A remapped project must not be auto-hidden out from under the rename (#171).
    //
    // Between the rewrite and the next scan the project at the NEW path is momentarily empty — its
    // sessions have not been re-attributed yet. Auto-hide reads "no activity, ever", and no activity is
    // stale BY DEFINITION (`shouldAutoHide(0, …)` is true). It hides the project — and the scan SKIPS a
    // hidden project, so the sessions never arrive and the rename stays broken. Observed in the running
    // app: after a remap the project sat there with only its Codex row, at the old path, for good.
    //
    // Adding or unhiding a project already restarts this grace timer (#57). A remap is the same kind of
    // act: the user just touched this project.
    try {
      // Clearing the auto-hide is now exactly one call: the flag IS the state (#167). It used to also
      // have to pull the path out of `hiddenProjects` — the same list a manual hide wrote to — while
      // taking care not to undo a hide the user had made themselves. The two are separate columns now,
      // so that whole dance is gone: a manual hide rides along with the project, the machine's does not.
      ctx.db.resetProjectAutoHide(newPath);
    } catch (err) {
      ctx.log.warn('[remap] auto-hide reset failed: ' + err.message);
    }

    // Move each backend's own per-project CONFIG entry to the new path so it survives the remap — Claude's
    // ~/.claude.json row carries trust + MCP + cost together (#211). This runs BEFORE the trust loop below
    // on purpose: moving Claude's whole entry takes its trust with it, so the trust loop then finds nothing
    // at oldPath for Claude and does not move it a second time. Non-fatal: the cwd rewrite already succeeded.
    for (const backend of listBackendsWithMeta()) {
      try {
        const res = backend.projectMeta.rename(oldPath, newPath);
        if (res && res.error) ctx.log.warn(`[remap] ${backend.id} config move failed: ${res.error}`);
      } catch (err) {
        ctx.log.warn(`[remap] ${backend.id} config move threw: ${err.message}`);
      }
    }

    // ...and every backend's per-project trust with it, so a renamed project does not have to be trusted
    // all over again (#171). A backend whose config move above already carried its trust (Claude) reads as
    // untrusted at oldPath now, so this is a no-op for it — no id special-case needed.
    for (const backend of listBackendsWithTrust()) {
      try {
        const was = backend.projectTrust.get(oldPath);
        if (was === true) {
          backend.projectTrust.set(newPath, true);
          backend.projectTrust.set(oldPath, false);
        }
      } catch (err) {
        ctx.log.warn(`[remap] ${backend.id} trust move failed: ${err.message}`);
      }
    }

    ctx.cache.notifyRendererProjectsChanged();
    // The renderer tells the user what actually moved — and what could not (Hermes' store is read-only
    // to us, so its sessions keep the old path and would re-form a project there).
    return { ok: true, moved, cannotMove };
  } catch (err) {
    return { error: err.message };
  }
}

/** Every enabled backend that has a per-project trust gate at all (Claude, Codex — not Pi, not Hermes). */
function listBackendsWithTrust() {
  try {
    return ctx.backends.launchable().filter(b => b.projectTrust && typeof b.projectTrust.get === 'function');
  } catch {
    return [];
  }
}

/**
 * Every enabled backend that keeps its OWN per-project config/meta store (#211) — Claude's ~/.claude.json
 * projects table (trust, MCP, cost). A backend with none declares no `projectMeta`, and the Projects admin
 * contributes no columns for it rather than borrowing Claude's. The core names no backend to find them.
 */
function listBackendsWithMeta() {
  try {
    return ctx.backends.launchable().filter(b => b.projectMeta && typeof b.projectMeta.getMany === 'function');
  } catch {
    return [];
  }
}

/** Does any backend's own config still track this project (Claude's ~/.claude.json, another's config.toml)? */
function projectKnownToAnyBackend(projectPath) {
  try {
    for (const b of listBackendsWithMeta()) {
      if (typeof b.projectMeta.has === 'function' && b.projectMeta.has(projectPath)) return true;
    }
  } catch { /* fall through */ }
  return false;
}

/**
 * The projects that HAVE sessions and are not on the list (#183).
 *
 * Their sessions are indexed and searchable, and the sidebar paints none of them: the register decides
 * what is shown, and in manual mode discovery may not write to it. That is the correct behaviour and it
 * is also a silent one — nothing anywhere says "there is work here you cannot see", so a session you were
 * in an hour ago is simply not in the list and there is nothing to click. This is what the sidebar's
 * notice counts, and what the project manager can filter down to.
 *
 * The list is exactly what AUTO-ADD would have taken, tombstone included: a project the user REMOVED is
 * not offered back until a session newer than the removal turns up — the same rule, asked of the same
 * function, so the offer can never contradict what the register would do.
 */
function unlistedProjects() {
  try {
    const states = ctx.db.getProjectStates();
    const out = [];
    for (const row of ctx.cache.buildProjectsAdmin()) {
      if (row.registered) continue;
      if (!row.sessionCount) continue;                 // nothing to miss
      const state = states.get(row.projectPath) || null;
      if (!registry.shouldRegister(state, { source: 'scan', autoAdd: true, sessionAt: row.lastActivity })) continue;
      out.push({
        projectPath: row.projectPath,
        sessionCount: row.sessionCount,
        lastActivity: row.lastActivity || null,
      });
    }
    out.sort((a, b) => new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0));
    return { ok: true, projects: out, sessionCount: out.reduce((n, p) => n + (p.sessionCount || 0), 0) };
  } catch (err) {
    ctx.log.warn('[projects] unlistedProjects failed: ' + (err && err.message));
    return { ok: false, projects: [], sessionCount: 0 };
  }
}

/**
 * Aggregated per-project admin view (#32): cache-derived rows (all projects incl. hidden) layered with
 * per-backend trust state + each backend's declared per-project meta (via projectMeta), plus any project
 * that only exists in a backend's own config store (so it can still be managed). Names no backend (#211).
 *
 * Returns ONLY aggregated, display-ready fields — never the raw secret-bearing config.
 */
function getProjectsAdmin() {
  try {
    const global = ctx.db.getSetting('global') || {};
    const autoAdd = global.projectAutoAdd !== false;

    const rows = ctx.cache.buildProjectsAdmin();

    // The backends that keep a per-project TRUST gate, and those that keep a per-project CONFIG/META store.
    // Both are declared capabilities (#171/#211); this file names no backend and reads no backend's format.
    const trustBackends = listBackendsWithTrust();
    const metaBackends = listBackendsWithMeta();

    // Fold in projects that exist ONLY in a backend's own config (trust/meta but no Switchboard cache) —
    // e.g. Claude's ~/.claude.json knows a project we have never scanned. Each such backend declares its
    // known project paths; add any not already represented, keyed by the one canonical path form (#8).
    const byKey = new Map();
    for (const r of rows) byKey.set(samePathKey(r.projectPath), r);
    for (const b of metaBackends) {
      let known = [];
      try { known = b.projectMeta.knownProjects() || []; } catch { known = []; }
      for (const projectPath of known) {
        if (byKey.has(samePathKey(projectPath))) continue;
        const r = {
          projectPath,
          folder: encodeProjectPath(projectPath),
          displayName: '',
          sessionCount: 0,
          lastActivity: null,
          missing: !fs.existsSync(projectPath),
          // A project known only to a backend's config: it has trust and a cost history, and it is NOT on
          // the list — which is what the "Listed" toggle is for. Badged `config-only` in the admin.
          hidden: false,
          registered: false,
          favorite: false,
          configOnly: true,
        };
        rows.push(r);
        byKey.set(samePathKey(projectPath), r);
      }
    }

    // Which backends actually have sessions in each project (#171). `session_cache.backendId` is the
    // authoritative provenance, so this is a GROUP BY, not a new concept — and it is what makes the
    // manager stop showing a Claude-and-Codex project as if it were a Claude one.
    let backendsByPath = new Map();
    try { backendsByPath = ctx.db.getBackendsByProjectPath() || new Map(); } catch { /* leave it empty */ }

    // Ask each trust/meta backend ONCE, for every project at a time. `projectTrust.get` /
    // `projectMeta.getMany` open and parse that backend's config file, so asking per row meant re-reading
    // a config once per project just to draw one table. Which backend that is, is not this file's business.
    const allPaths = rows.map(r => r.projectPath);
    const trustOf = new Map();
    for (const b of trustBackends) {
      if (typeof b.projectTrust.getMany !== 'function') continue;
      try { trustOf.set(b.id, b.projectTrust.getMany(allPaths)); } catch { /* fall back to per-row */ }
    }
    const metaOf = new Map();
    for (const b of metaBackends) {
      try { metaOf.set(b.id, b.projectMeta.getMany(allPaths)); } catch { /* leave it empty */ }
    }

    for (const r of rows) {
      // Per backend: { claude: true, codex: null, ... }. null = never asked / no gate.
      r.trust = {};
      for (const b of trustBackends) {
        const batch = trustOf.get(b.id);
        try {
          r.trust[b.id] = batch ? (batch.has(r.projectPath) ? batch.get(r.projectPath) : null)
            : b.projectTrust.get(r.projectPath);
        } catch { r.trust[b.id] = null; }
      }

      r.backends = backendsByPath.get(r.projectPath) || [];

      // Per backend: display-ready meta columns { claude: [{ id, label, value, title }], ... }. A backend
      // that declares no projectMeta contributes nothing — no columns, not Claude's blanks (#211).
      r.meta = {};
      for (const b of metaBackends) {
        const batch = metaOf.get(b.id);
        r.meta[b.id] = (batch && batch.get(r.projectPath)) || [];
      }

      // Kept under its old name for the renderer's column: it now means "on the register", which is what
      // the allowlist was always trying to be — except that it could only ever subtract (#167).
      r.inAllowlist = !!r.registered;
    }

    // What the renderer needs to draw the controls: which backends can be trusted, and which keep a
    // config/meta store (for the columns and the Remove-dialog "delete config entry" switch).
    const trustable = trustBackends.map(b => ({ id: b.id, label: b.label || b.id }));
    const metaBackendsOut = metaBackends.map(b => ({
      id: b.id, label: b.label || b.id, removeLabel: (b.projectMeta && b.projectMeta.removeLabel) || null,
    }));
    return { ok: true, autoAdd, trustable, metaBackends: metaBackendsOut, projects: rows };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Trust a project — FOR A BACKEND (#171).
 *
 * It used to write Claude's `hasTrustDialogAccepted` and nothing else, while the column said "Trusted"
 * as if it spoke for all of them. Codex has its own gate ("Do you trust this directory?") in its own
 * config, and it kept asking. Now the backend that owns the answer writes it.
 *
 * An old two-argument call (no backendId) resolves to the first backend that has a trust gate, not a
 * hardcoded id. Setting trust to true is a security decision — the renderer gates it behind a confirm.
 */
function setProjectTrust(projectPath, backendId, trusted) {
  // Tolerate the old two-argument shape (projectPath, trusted): it predates per-backend trust, when there
  // was only one gate. Resolve it to the first backend that HAS a trust gate rather than to a hardcoded id.
  if (typeof backendId === 'boolean') {
    trusted = backendId;
    backendId = (listBackendsWithTrust()[0] || {}).id || '';
  }

  const backend = ctx.backends.get(backendId);
  if (!backend || !backend.projectTrust || typeof backend.projectTrust.set !== 'function') {
    return { ok: false, error: `${backend ? (backend.label || backend.id) : backendId} has no project trust setting.` };
  }

  const result = backend.projectTrust.set(projectPath, trusted);
  if (result && result.ok) ctx.cache.notifyRendererProjectsChanged();
  return result;
}

/**
 * Which backends a project has sessions from, and whether each one's history can be deleted at all.
 * The renderer builds the Remove dialog from this — a switch that cannot do anything is not offered.
 */
function deletableBackends(projectPath) {
  let rows = [];
  try { rows = ctx.db.getCachedByProjectPath(projectPath) || []; } catch { rows = []; }

  const counts = new Map();
  for (const r of rows) {
    // getCachedByProjectPath COALESCEs a legacy NULL backendId already — the id is always set here.
    const id = r.backendId;
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  const out = [];
  for (const [id, sessions] of counts) {
    const backend = ctx.backends.get(id);
    const deletable = !!(backend && typeof backend.deleteSessions === 'function');
    out.push({
      id,
      label: backend ? (backend.label || id) : id,
      sessions,
      deletable,
      // A backend that cannot hand over its history says WHY itself — the reason belongs to the backend,
      // not to a sentence here that happened to describe Hermes and was then shown for everything else.
      reason: deletable ? null : ((backend && backend.deleteBlockedReason) || 'Switchboard cannot delete its history'),
    });
  }
  return out;
}

/**
 * Hard-delete a project's session history — FOR THE BACKENDS THE USER PICKED (#171).
 *
 * It used to mean `~/.claude/projects/<folder>` and nothing else. A project's Codex rollouts and Pi
 * transcripts survived it untouched; the user simply stopped seeing them, because the project was hidden
 * in the same breath, and they came back the day it was unhidden.
 *
 * Each backend hands over its own: Claude removes the folders that resolve to this project (its store is
 * organised BY project, and a legacy encoding can leave several), the file backends remove the
 * transcripts named on their rows. Hermes cannot, and is not offered.
 *
 * @param {string} projectPath
 * @param {string[]} [backendIds]  which backends to clear. Omitted = every backend that has rows in this
 *                                 project (the renderer always sends the picked set).
 */
function deleteProjectSessions(projectPath, backendIds) {
  try {
    if (!projectPath) return { error: 'No project path' };

    let rows = [];
    try { rows = ctx.db.getCachedByProjectPath(projectPath) || []; } catch { rows = []; }

    // The renderer always sends the picked backends (the Remove dialog builds them from deletableBackends).
    // If omitted (an older caller), clear every backend that actually has rows here — not a hardcoded id.
    const wanted = Array.isArray(backendIds) && backendIds.length
      ? backendIds
      : [...new Set(rows.map(r => r.backendId))];

    const deleted = {};
    const refused = [];
    let removed = 0;

    for (const backendId of wanted) {
      const backend = ctx.backends.get(backendId);
      if (!backend || typeof backend.deleteSessions !== 'function') {
        refused.push(backend ? (backend.label || backendId) : backendId);
        continue;
      }

      const mine = rows.filter(r => r.backendId === backendId);
      const files = mine
        .map(r => backend.transcriptPathFor(r))
        .filter(Boolean);

      let res;
      try {
        res = backend.deleteSessions(files, { projectPath, projectsDir: ctx.PROJECTS_DIR });
      } catch (err) {
        ctx.log.warn(`[delete] ${backendId}: ${err.message}`);
        continue;
      }
      if (!res || !res.removed) continue;

      deleted[backendId] = res.removed;
      removed += res.removed;

      // The rows go with the files, ROW BY ROW. Clearing them by folder would repeat the mistake the
      // folder delete itself was: a store folder is keyed on the cwd a session started from, so since
      // #157 it can hold rows belonging to other projects — and they would disappear from the cache
      // while their transcripts sat untouched on disk, which no rescan would necessarily put back.
      for (const r of mine) {
        try { ctx.db.deleteCachedSession(r.sessionId); } catch { /* best effort */ }
        try { ctx.db.deleteSearchSession(r.sessionId); } catch { /* best effort */ }
      }
    }

    pruneProjectIfGone(projectPath);
    ctx.cache.notifyRendererProjectsChanged();
    return { ok: true, removed, deleted, refused };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Hard-delete the project's entry from a backend's own config store (Claude's ~/.claude.json row: trust,
 * MCP, allowedTools, cost). The backend does the atomic write; the core just names no backend (#211).
 * `backendId` omitted picks the first backend that keeps such a store, for an older renderer.
 */
function removeProjectConfig(projectPath, backendId) {
  const metaBackends = listBackendsWithMeta();
  const backend = backendId ? metaBackends.find(b => b.id === backendId) : metaBackends[0];
  if (!backend || typeof backend.projectMeta.remove !== 'function') {
    return { error: 'No backend keeps a per-project config entry.' };
  }
  const result = backend.projectMeta.remove(projectPath);
  if (result && result.ok) {
    pruneProjectIfGone(projectPath);
    ctx.cache.notifyRendererProjectsChanged();
  }
  return result;
}

function toggleFavorite(projectPath) {
  const favorited = ctx.db.toggleProjectFavorite(projectPath);
  return { favorited };
}

/** Wire the IPC surface. main.js hands in ipcMain; this file never requires electron. */
function registerIpc(ipcMain) {
  ipcMain.handle('browse-folder', () => browseFolder());
  ipcMain.handle('add-project', (_e, projectPath) => addProject(projectPath));
  // Hide and remove are different things now (#167): hide keeps the project on the list and unseen;
  // remove takes it off, purges its cached rows and leaves a tombstone.
  ipcMain.handle('hide-project', (_e, projectPath) => hideProject(projectPath));
  ipcMain.handle('remove-project', (_e, projectPath) => removeProject(projectPath));
  ipcMain.handle('get-hidden-projects', () => getHiddenProjects());
  ipcMain.handle('unhide-project', (_e, projectPath) => unhideProject(projectPath));
  ipcMain.handle('set-project-auto-add', (_e, enabled) => setProjectAutoAdd(enabled));
  ipcMain.handle('remap-project', (_e, oldPath, newPath) => remapProject(oldPath, newPath));
  ipcMain.handle('get-projects-admin', () => getProjectsAdmin());
  ipcMain.handle('get-unlisted-projects', () => unlistedProjects());
  ipcMain.handle('set-project-trust', (_e, projectPath, backendId, trusted) => setProjectTrust(projectPath, backendId, trusted));
  ipcMain.handle('delete-project-sessions', (_e, projectPath, backendIds) => deleteProjectSessions(projectPath, backendIds));
  ipcMain.handle('project-deletable-backends', (_e, projectPath) => deletableBackends(projectPath));
  ipcMain.handle('remove-project-config', (_e, projectPath, backendId) => removeProjectConfig(projectPath, backendId));
  ipcMain.handle('toggle-project-favorite', (_e, projectPath) => toggleFavorite(projectPath));
}

module.exports = {
  init,
  registerIpc,
  // operations (exported for tests, and for main.js where it calls them directly)
  browseFolder, addProject, hideProject, removeProject, getHiddenProjects, unhideProject, setProjectAutoAdd,
  remapProject, getProjectsAdmin, unlistedProjects, setProjectTrust, deleteProjectSessions, deletableBackends,
  removeProjectConfig, toggleFavorite,
  // helpers main.js still calls on other paths (a spawn adds the project; the app start hides stale ones)
  ensureProjectAdded, applyAutoHide, syncRegistry,
  projectHasSessionsOnDisk, pruneProjectIfGone,
  AUTO_HIDE_THROTTLE_MS,
  _resetAutoHideThrottle: () => { lastAutoHideAt = 0; },
};
