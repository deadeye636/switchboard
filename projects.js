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

const { encodeProjectPath } = require('./encode-project-path');
const { deriveProjectPath } = require('./derive-project-path');
const { resolveJsonlPath } = require('./read-session-file');
const claudeConfig = require('./claude-config');

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
 * Add a projectPath to the `addedProjects` allowlist (used only when projectAutoAdd === false).
 * Idempotent; persists to the global settings blob.
 */
function ensureProjectAdded(projectPath) {
  if (!projectPath) return;
  // #57: adding / re-adding a project restarts its auto-hide grace timer so a just-added stale project
  // isn't immediately auto-hidden again on the next pass.
  try { ctx.db.resetProjectAutoHide(projectPath); } catch { /* best effort */ }
  const global = ctx.db.getSetting('global') || {};
  const added = Array.isArray(global.addedProjects) ? global.addedProjects : [];
  if (!added.includes(projectPath)) {
    added.push(projectPath);
    global.addedProjects = added;
    ctx.db.setSetting('global', global);
  }
}

// --- #57: auto-hide stale projects ---
// One pass over all known projects: any non-hidden project with no running session whose effective
// activity (max of newest session activity and autoHideResetAt) is older than `autoHideDays` gets added
// to hiddenProjects with the autoHidden flag set. Runs on app start and on the throttled refresh.
let lastAutoHideAt = 0;
const AUTO_HIDE_THROTTLE_MS = 10000;

function applyAutoHide(force) {
  try {
    const global = ctx.db.getSetting('global') || {};
    const days = Number(global.autoHideDays) || 0;
    if (!(days > 0)) return;

    const now = Date.now();
    if (!force && now - lastAutoHideAt < AUTO_HIDE_THROTTLE_MS) return;
    lastAutoHideAt = now;

    // A project with a live (non-exited) session is active — never auto-hide it.
    const runningPaths = new Set();
    for (const [, session] of ctx.activeSessions) {
      if (session.exited) continue;
      if (session.projectPath) runningPaths.add(session.projectPath);
    }

    const hidden = new Set(global.hiddenProjects || []);
    let changed = false;
    // buildProjectsAdmin returns every project (hidden included) with lastActivity.
    for (const row of ctx.cache.buildProjectsAdmin()) {
      if (hidden.has(row.projectPath)) continue;        // already hidden (manual or auto)
      if (runningPaths.has(row.projectPath)) continue;  // has a running session
      const meta = ctx.db.getProjectMeta(row.projectPath);
      const activityMs = row.lastActivity ? new Date(row.lastActivity).getTime() : 0;
      const resetMs = meta && meta.autoHideResetAt ? new Date(meta.autoHideResetAt).getTime() : 0;
      const eff = Math.max(activityMs, resetMs);
      if (ctx.cache.shouldAutoHide(eff, now, days)) {
        hidden.add(row.projectPath);
        try { ctx.db.setProjectAutoHidden(row.projectPath, 1); } catch { /* best effort */ }
        changed = true;
      }
    }

    if (changed) {
      global.hiddenProjects = [...hidden];
      ctx.db.setSetting('global', global);
      ctx.cache.notifyRendererProjectsChanged();
    }
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

function projectIsInClaudeConfig(projectPath) {
  try {
    const cfg = claudeConfig.readClaudeConfig();
    if (!cfg || !cfg.projects) return false;
    const norm = claudeConfig.normalizeClaudePath(projectPath);
    return Object.keys(cfg.projects).some(k => claudeConfig.normalizeClaudePath(k) === norm);
  } catch {
    return false;
  }
}

/**
 * After a hard delete, forget the project entirely (#55). Only when nothing is left to restore — no
 * sessions on disk and no ~/.claude.json entry. A plain "hide" keeps all of this, because unhiding has
 * to bring the project back intact.
 *
 * Called at the end of the two hard-delete handlers rather than from the renderer: the "Remove" dialog
 * runs them in sequence, so whichever finishes last finds the project truly gone and does the pruning.
 */
function pruneProjectIfGone(projectPath) {
  if (!projectPath) return false;
  if (projectHasSessionsLeft(projectPath) || projectIsInClaudeConfig(projectPath)) return false;

  try { ctx.db.deleteProjectRefs(projectPath); } catch (err) {
    ctx.log.warn('[prune] project refs delete failed: ' + err.message);
  }
  try {
    const global = ctx.db.getSetting('global') || {};
    let touched = false;
    for (const key of ['hiddenProjects', 'addedProjects']) {
      if (!Array.isArray(global[key]) || !global[key].includes(projectPath)) continue;
      global[key] = global[key].filter(p => p !== projectPath);
      touched = true;
    }
    if (touched) ctx.db.setSetting('global', global);
  } catch (err) {
    ctx.log.warn('[prune] global project lists cleanup failed: ' + err.message);
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

function addProject(projectPath) {
  try {
    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Unhide if previously hidden
    const global = ctx.db.getSetting('global') || {};
    if (global.hiddenProjects && global.hiddenProjects.includes(projectPath)) {
      global.hiddenProjects = global.hiddenProjects.filter(p => p !== projectPath);
      ctx.db.setSetting('global', global);
    }

    // Create the corresponding folder in ~/.claude/projects/ so it persists
    const folder = encodeProjectPath(projectPath);
    const folderPath = path.join(ctx.PROJECTS_DIR, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Seed a minimal .jsonl so deriveProjectPath can read the cwd
    if (!fs.readdirSync(folderPath).some(f => f.endsWith('.jsonl'))) {
      const seedId = crypto.randomUUID();
      const seedFile = path.join(folderPath, seedId + '.jsonl');
      const now = new Date().toISOString();
      const line = JSON.stringify({
        type: 'user', cwd: projectPath, sessionId: seedId, uuid: crypto.randomUUID(),
        timestamp: now, message: { role: 'user', content: 'New project' },
      });
      fs.writeFileSync(seedFile, line + '\n');
    }

    // Explicit add → allowlist, so it shows in manual project mode too.
    ensureProjectAdded(projectPath);

    // Index the new folder immediately so it is in the cache before the renderer paints.
    ctx.cache.refreshFolder(folder);
    ctx.cache.notifyRendererProjectsChanged();

    return { ok: true, folder, projectPath };
  } catch (err) {
    return { error: err.message };
  }
}

function removeProject(projectPath) {
  try {
    // Add to hidden projects list
    const global = ctx.db.getSetting('global') || {};
    const hidden = global.hiddenProjects || [];
    if (!hidden.includes(projectPath)) hidden.push(projectPath);
    global.hiddenProjects = hidden;
    // Also drop from the manual-mode allowlist so it stays gone in manual mode.
    if (Array.isArray(global.addedProjects)) {
      global.addedProjects = global.addedProjects.filter(p => p !== projectPath);
    }
    ctx.db.setSetting('global', global);

    // Clean up DB cache and search index for this folder. SCOPED to Claude's store: a project folder
    // key is derived from the cwd and is therefore shared with the other backends, but this action only
    // removes Claude's data — another backend's rows must survive (its session files are still on disk,
    // so an unscoped wipe would only make them reappear on the next scan anyway).
    const folder = encodeProjectPath(projectPath);
    const claudeScope = ctx.cache.claudeStoreScope();
    ctx.db.deleteCachedFolder(folder, claudeScope);
    ctx.db.deleteSearchFolder(folder, claudeScope);
    ctx.db.deleteSetting('project:' + projectPath);

    ctx.cache.notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/** The projectPaths the user has hidden, flagged with whether auto-hide did it (for the restore UI). */
function getHiddenProjects() {
  const global = ctx.db.getSetting('global') || {};
  const auto = ctx.db.getAutoHiddenProjects();
  return (global.hiddenProjects || []).map(p => ({ path: p, autoHidden: auto.has(p) }));
}

/**
 * Take a project off the hidden list and re-index its folder so it reappears. The on-disk
 * ~/.claude/projects folder still exists (removeProject only cleared the DB cache), so a refresh
 * repopulates it.
 */
function unhideProject(projectPath) {
  try {
    const global = ctx.db.getSetting('global') || {};
    global.hiddenProjects = (global.hiddenProjects || []).filter(p => p !== projectPath);
    ctx.db.setSetting('global', global);
    // #57: restart the grace timer + clear the auto flag so an unhidden stale project isn't re-hidden
    // on the next auto-hide pass.
    try { ctx.db.resetProjectAutoHide(projectPath); } catch { /* best effort */ }

    const folder = encodeProjectPath(projectPath);
    try { ctx.cache.refreshFolder(folder); } catch { /* the reconcile sweep will get it */ }
    ctx.cache.notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Toggle automatic project discovery. When turning OFF (manual mode), freeze the currently-visible
 * projects into the allowlist so nothing disappears; folders discovered afterwards won't appear unless
 * added explicitly. Turning ON again ignores the allowlist (everything is discovered as before).
 */
function setProjectAutoAdd(enabled) {
  try {
    const global = ctx.db.getSetting('global') || {};
    if (!enabled) {
      // Snapshot the current (auto-discovered) set before flipping the flag.
      const visible = ctx.cache.buildProjectsFromCache(false).map(p => p.projectPath);
      global.addedProjects = [...new Set(visible)];
    }
    global.projectAutoAdd = !!enabled;
    ctx.db.setSetting('global', global);
    ctx.cache.notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
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
    const id = row.backendId || 'claude';
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
      // `filePath` is stored for the backends that need it (v11) — there is nothing to reconstruct a
      // date-bucketed Codex rollout from. CLAUDE's rows carry none: its transcript's location follows
      // from the folder and the session id, and that is exactly what resolveJsonlPath knows (subagents
      // included). Skipping a row without a filePath is what left Claude behind on the first cut.
      const file = row.filePath || resolveJsonlPath(ctx.PROJECTS_DIR, row);
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
    const folderPath = path.join(ctx.PROJECTS_DIR, folder);

    if (!Object.keys(moved).length && !cannotMove.length && !fs.existsSync(folderPath)) {
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
    try {
      const global = ctx.db.getSetting('global') || {};
      let touched = false;
      for (const key of ['hiddenProjects', 'addedProjects']) {
        if (!Array.isArray(global[key]) || !global[key].includes(oldPath)) continue;
        // Rewrite in place, and never end up with the path listed twice.
        global[key] = [...new Set(global[key].map(p => (p === oldPath ? newPath : p)))];
        touched = true;
      }
      if (touched) ctx.db.setSetting('global', global);
    } catch (err) {
      ctx.log.warn('[remap] global project lists move failed: ' + err.message);
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
      const wasAutoHidden = ctx.db.getAutoHiddenProjects().has(newPath);
      ctx.db.resetProjectAutoHide(newPath);
      if (wasAutoHidden) {
        const g = ctx.db.getSetting('global') || {};
        if (Array.isArray(g.hiddenProjects) && g.hiddenProjects.includes(newPath)) {
          // It was hidden by the machine, not by the user — and the user is plainly moving a project
          // here. A hide the user made themselves rides along with the old path above, and stays.
          g.hiddenProjects = g.hiddenProjects.filter(p => p !== newPath);
          ctx.db.setSetting('global', g);
        }
      }
    } catch (err) {
      ctx.log.warn('[remap] auto-hide reset failed: ' + err.message);
    }

    // Move the project's ~/.claude.json entry (trust/MCP/cost) to the new path so it survives the
    // remap. Non-fatal: the session cwd rewrite above already succeeded.
    try {
      const res = claudeConfig.renameProjectEntry(oldPath, newPath);
      if (res && res.error) ctx.log.warn('[remap] ~/.claude.json move failed: ' + res.error);
    } catch (err) {
      ctx.log.warn('[remap] ~/.claude.json move threw: ' + err.message);
    }

    // ...and every OTHER backend's per-project trust with it, so a renamed project does not have to be
    // trusted all over again (#171).
    for (const backend of listBackendsWithTrust()) {
      if (backend.id === 'claude') continue;   // handled above, together with its MCP/cost entry
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
 * Aggregated per-project admin view (#32): cache-derived rows (all projects incl. hidden) layered with
 * trust state + read-only ~/.claude.json meta (MCP/allowedTools/cost/tokens), plus any project that only
 * exists in ~/.claude.json (so trust can still be managed).
 *
 * Returns ONLY aggregated fields — never the raw secret-bearing config.
 */
function getProjectsAdmin() {
  try {
    const global = ctx.db.getSetting('global') || {};
    const autoAdd = global.projectAutoAdd !== false;
    const allowed = Array.isArray(global.addedProjects) ? new Set(global.addedProjects) : null;

    // Parse ~/.claude.json once (~160 KB) and derive all three views from it, instead of each helper
    // re-reading + re-parsing the file.
    const cfg = claudeConfig.readClaudeConfig();
    const trustMap = claudeConfig.getProjectTrustMap(undefined, cfg);   // normalized -> bool
    const metaMap = claudeConfig.getProjectClaudeMeta(undefined, cfg);  // normalized -> {counts...}

    const rows = ctx.cache.buildProjectsAdmin();
    const byNorm = new Map();
    for (const r of rows) byNorm.set(claudeConfig.normalizeClaudePath(r.projectPath), r);

    // Fold in ~/.claude.json-only projects (have trust/meta but no Switchboard cache).
    const cfgKeys = cfg && cfg.projects ? Object.keys(cfg.projects) : [];
    for (const norm of trustMap.keys()) {
      if (byNorm.has(norm)) continue;
      const key = cfgKeys.find(k => claudeConfig.normalizeClaudePath(k) === norm) || null;
      const projectPath = key || norm;
      const r = {
        projectPath,
        folder: encodeProjectPath(projectPath),
        displayName: '',
        sessionCount: 0,
        lastActivity: null,
        missing: !fs.existsSync(projectPath),
        hidden: (global.hiddenProjects || []).includes(projectPath),
        favorite: false,
        configOnly: true,
      };
      rows.push(r);
      byNorm.set(norm, r);
    }

    // Which backends actually have sessions in each project (#171). `session_cache.backendId` is the
    // authoritative provenance, so this is a GROUP BY, not a new concept — and it is what makes the
    // manager stop showing a Claude-and-Codex project as if it were a Claude one.
    let backendsByPath = new Map();
    try { backendsByPath = ctx.db.getBackendsByProjectPath() || new Map(); } catch { /* leave it empty */ }

    // The backends that HAVE a per-project trust gate. Claude keeps it in ~/.claude.json, Codex in its
    // own config.toml; Pi and Hermes have none, and the UI says so rather than inventing one.
    const trustBackends = listBackendsWithTrust();

    // Ask each backend ONCE, for every project at a time. `projectTrust.get` opens and parses that
    // backend's config file on every call, so asking per row meant re-reading Codex' config.toml once per
    // project just to draw one table. A backend that has no batch answer is still asked the slow way —
    // and which backend that is, is not this file's business to know.
    const allPaths = rows.map(r => r.projectPath);
    const trustOf = new Map();
    for (const b of trustBackends) {
      if (typeof b.projectTrust.getMany !== 'function') continue;
      try { trustOf.set(b.id, b.projectTrust.getMany(allPaths)); } catch { /* fall back to per-row */ }
    }

    for (const r of rows) {
      const norm = claudeConfig.normalizeClaudePath(r.projectPath);
      // Kept for compatibility: `trusted` is CLAUDE's trust, and always was.
      r.trusted = trustMap.has(norm) ? trustMap.get(norm) : null;

      // ...and now the truth, per backend: { claude: true, codex: null, ... }. null = never asked.
      r.trust = {};
      for (const b of trustBackends) {
        const batch = trustOf.get(b.id);
        try {
          r.trust[b.id] = batch ? (batch.has(r.projectPath) ? batch.get(r.projectPath) : null)
            : b.projectTrust.get(r.projectPath);
        } catch { r.trust[b.id] = null; }
      }

      r.backends = backendsByPath.get(r.projectPath) || [];

      const m = metaMap.get(norm) || {};
      r.mcpServersCount = m.mcpServersCount || 0;
      r.allowedToolsCount = m.allowedToolsCount || 0;
      r.lastCost = m.lastCost != null ? m.lastCost : null;
      r.inputTokens = m.inputTokens != null ? m.inputTokens : null;
      r.outputTokens = m.outputTokens != null ? m.outputTokens : null;
      // In manual mode, whether the project is on the explicit allowlist.
      r.inAllowlist = allowed ? allowed.has(r.projectPath) : true;
    }

    // What the renderer needs to draw the trust controls: which backends can be trusted at all.
    const trustable = trustBackends.map(b => ({ id: b.id, label: b.label || b.id }));
    return { ok: true, autoAdd, trustable, projects: rows };
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
 * `backendId` defaults to claude, so an older renderer keeps working. Setting trust to true is a
 * security decision — the renderer gates it behind a warning confirm.
 */
function setProjectTrust(projectPath, backendId, trusted) {
  // Tolerate the old two-argument shape: (projectPath, trusted).
  if (typeof backendId === 'boolean') { trusted = backendId; backendId = 'claude'; }

  const backend = ctx.backends.get(backendId || 'claude');
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
    const id = r.backendId || 'claude';
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
 * @param {string[]} [backendIds]  which backends to clear. Omitted = Claude only, the old behaviour, so
 *                                 an older renderer keeps working.
 */
function deleteProjectSessions(projectPath, backendIds) {
  try {
    if (!projectPath) return { error: 'No project path' };
    const wanted = Array.isArray(backendIds) && backendIds.length ? backendIds : ['claude'];

    let rows = [];
    try { rows = ctx.db.getCachedByProjectPath(projectPath) || []; } catch { rows = []; }

    const deleted = {};
    const refused = [];
    let removed = 0;

    for (const backendId of wanted) {
      const backend = ctx.backends.get(backendId);
      if (!backend || typeof backend.deleteSessions !== 'function') {
        refused.push(backend ? (backend.label || backendId) : backendId);
        continue;
      }

      const mine = rows.filter(r => (r.backendId || 'claude') === backendId);
      const files = mine
        .map(r => r.filePath || resolveJsonlPath(ctx.PROJECTS_DIR, r))
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
 * Hard-delete the project's entry from ~/.claude.json (trust, MCP, allowedTools, cost). Atomic RMW with
 * a .bak; all other keys/secrets preserved.
 */
function removeProjectConfig(projectPath) {
  const result = claudeConfig.removeProjectEntry(projectPath);
  if (result.ok) {
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
  ipcMain.handle('remove-project', (_e, projectPath) => removeProject(projectPath));
  ipcMain.handle('get-hidden-projects', () => getHiddenProjects());
  ipcMain.handle('unhide-project', (_e, projectPath) => unhideProject(projectPath));
  ipcMain.handle('set-project-auto-add', (_e, enabled) => setProjectAutoAdd(enabled));
  ipcMain.handle('remap-project', (_e, oldPath, newPath) => remapProject(oldPath, newPath));
  ipcMain.handle('get-projects-admin', () => getProjectsAdmin());
  ipcMain.handle('set-project-trust', (_e, projectPath, backendId, trusted) => setProjectTrust(projectPath, backendId, trusted));
  ipcMain.handle('delete-project-sessions', (_e, projectPath, backendIds) => deleteProjectSessions(projectPath, backendIds));
  ipcMain.handle('project-deletable-backends', (_e, projectPath) => deletableBackends(projectPath));
  ipcMain.handle('remove-project-config', (_e, projectPath) => removeProjectConfig(projectPath));
  ipcMain.handle('toggle-project-favorite', (_e, projectPath) => toggleFavorite(projectPath));
}

module.exports = {
  init,
  registerIpc,
  // operations (exported for tests, and for main.js where it calls them directly)
  browseFolder, addProject, removeProject, getHiddenProjects, unhideProject, setProjectAutoAdd,
  remapProject, getProjectsAdmin, setProjectTrust, deleteProjectSessions, deletableBackends,
  removeProjectConfig, toggleFavorite,
  // helpers main.js still calls on other paths (a spawn adds the project; the app start hides stale ones)
  ensureProjectAdded, applyAutoHide,
  projectHasSessionsOnDisk, projectIsInClaudeConfig, pruneProjectIfGone,
  AUTO_HIDE_THROTTLE_MS,
  _resetAutoHideThrottle: () => { lastAutoHideAt = 0; },
};
