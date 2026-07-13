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
  if (projectHasSessionsOnDisk(projectPath) || projectIsInClaudeConfig(projectPath)) return false;

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

function remapProject(oldPath, newPath) {
  try {
    const stat = fs.statSync(newPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Find the folder key for the old project path
    const folder = encodeProjectPath(oldPath);
    const folderPath = path.join(ctx.PROJECTS_DIR, folder);
    if (!fs.existsSync(folderPath)) return { error: 'No session data found for this project' };

    // Rewrite cwd in all session JSONL files so CLI --resume also works
    const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      const filePath = path.join(folderPath, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const updated = content.split('\n').map(line => {
        if (!line) return line;
        try {
          const parsed = JSON.parse(line);
          if (parsed.cwd === oldPath) {
            parsed.cwd = newPath;
            return JSON.stringify(parsed);
          }
        } catch { /* a truncated line — leave it alone */ }
        return line;
      }).join('\n');
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, updated);
      fs.renameSync(tmp, filePath);
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

    // Move the project's ~/.claude.json entry (trust/MCP/cost) to the new path so it survives the
    // remap. Non-fatal: the session cwd rewrite above already succeeded.
    try {
      const moved = claudeConfig.renameProjectEntry(oldPath, newPath);
      if (moved && moved.error) ctx.log.warn('[remap] ~/.claude.json move failed: ' + moved.error);
    } catch (err) {
      ctx.log.warn('[remap] ~/.claude.json move threw: ' + err.message);
    }

    ctx.cache.notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
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

    for (const r of rows) {
      const norm = claudeConfig.normalizeClaudePath(r.projectPath);
      r.trusted = trustMap.has(norm) ? trustMap.get(norm) : null;
      const m = metaMap.get(norm) || {};
      r.mcpServersCount = m.mcpServersCount || 0;
      r.allowedToolsCount = m.allowedToolsCount || 0;
      r.lastCost = m.lastCost != null ? m.lastCost : null;
      r.inputTokens = m.inputTokens != null ? m.inputTokens : null;
      r.outputTokens = m.outputTokens != null ? m.outputTokens : null;
      // In manual mode, whether the project is on the explicit allowlist.
      r.inAllowlist = allowed ? allowed.has(r.projectPath) : true;
    }

    return { ok: true, autoAdd, projects: rows };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Atomic RMW on ~/.claude.json, only the `hasTrustDialogAccepted` field. Setting it to true is a
 * security decision (the renderer gates it behind a warning confirm).
 */
function setProjectTrust(projectPath, trusted) {
  const result = claudeConfig.setProjectTrust(projectPath, trusted);
  if (result.ok) ctx.cache.notifyRendererProjectsChanged();
  return result;
}

/**
 * Hard-delete a project's on-disk session history: every ~/.claude/projects/<folder> that resolves to
 * this projectPath (legacy encodings can leave several), plus its DB cache + search index. Session
 * .jsonl files are gone afterwards. Guards each target to stay strictly inside PROJECTS_DIR.
 */
function deleteProjectSessions(projectPath) {
  try {
    if (!projectPath) return { error: 'No project path' };
    const encoded = encodeProjectPath(projectPath);
    let removed = 0;
    const dirs = fs.readdirSync(ctx.PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git');
    for (const d of dirs) {
      const folderPath = path.join(ctx.PROJECTS_DIR, d.name);
      const pp = deriveProjectPath(folderPath);
      if (pp !== projectPath && d.name !== encoded) continue;
      // Safety: never remove anything outside PROJECTS_DIR.
      const resolved = path.resolve(folderPath);
      if (!resolved.startsWith(path.resolve(ctx.PROJECTS_DIR) + path.sep)) continue;
      fs.rmSync(resolved, { recursive: true, force: true });
      // Scoped: only Claude's transcripts were deleted above. Another backend's rows for this project
      // must stay — their session files still exist, so wiping the rows would just resurrect them.
      try { ctx.db.deleteCachedFolder(d.name, ctx.cache.claudeStoreScope()); } catch { /* best effort */ }
      try { ctx.db.deleteSearchFolder(d.name, ctx.cache.claudeStoreScope()); } catch { /* best effort */ }
      removed++;
    }
    pruneProjectIfGone(projectPath);
    ctx.cache.notifyRendererProjectsChanged();
    return { ok: true, removed };
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
  ipcMain.handle('set-project-trust', (_e, projectPath, trusted) => setProjectTrust(projectPath, trusted));
  ipcMain.handle('delete-project-sessions', (_e, projectPath) => deleteProjectSessions(projectPath));
  ipcMain.handle('remove-project-config', (_e, projectPath) => removeProjectConfig(projectPath));
  ipcMain.handle('toggle-project-favorite', (_e, projectPath) => toggleFavorite(projectPath));
}

module.exports = {
  init,
  registerIpc,
  // operations (exported for tests, and for main.js where it calls them directly)
  browseFolder, addProject, removeProject, getHiddenProjects, unhideProject, setProjectAutoAdd,
  remapProject, getProjectsAdmin, setProjectTrust, deleteProjectSessions, removeProjectConfig,
  toggleFavorite,
  // helpers main.js still calls on other paths (a spawn adds the project; the app start hides stale ones)
  ensureProjectAdded, applyAutoHide,
  projectHasSessionsOnDisk, projectIsInClaudeConfig, pruneProjectIfGone,
  AUTO_HIDE_THROTTLE_MS,
  _resetAutoHideThrottle: () => { lastAutoHideAt = 0; },
};
