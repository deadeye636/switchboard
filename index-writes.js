// The neutral index write sink + the shared scan-state, split out of session-cache.js (#199 step 4).
//
// This is the LEAF everything else in the scan/index layer depends on. It holds:
//   - the ONE backend-neutral write sink (`applyIndexResults`) every scan path funnels its writes
//     through, so the worker (#199 step 5) can post raw parsed rows and main does the common DB writes,
//   - `buildSearchEntry` (the FTS body of a session, identical for any backend's row),
//   - `claudeStoreScope` (the Claude/Axis-A store scope, shared with main.js's folder deletes),
//   - the cross-sweep scan-state (`storeProjectPaths` + `isRemovedProject`), and
//   - the two renderer-push helpers (`notifyRendererProjectsChanged`, `sendStatus`).
//
// It requires only `backends` (registry, for the scope) and `sessionBackends` (for markPersisted); it
// requires NONE of the other split modules, so nothing cycles back into it.

const backends = require('./backends');
const sessionBackends = require('./session-backends');

let getMainWindow, log;
let upsertCachedSessions, deleteCachedSession, replaceSessionMetrics;
let deleteSearchFolder, deleteSearchSession, upsertSearchEntries, deleteCachedFolder;
let getMeta, setName, getProjectMeta;

function init(ctx) {
  getMainWindow = ctx.getMainWindow;
  log = ctx.log;
  upsertCachedSessions = ctx.db.upsertCachedSessions;
  deleteCachedSession = ctx.db.deleteCachedSession;
  replaceSessionMetrics = ctx.db.replaceSessionMetrics;
  deleteSearchFolder = ctx.db.deleteSearchFolder;
  deleteSearchSession = ctx.db.deleteSearchSession;
  upsertSearchEntries = ctx.db.upsertSearchEntries;
  deleteCachedFolder = ctx.db.deleteCachedFolder;
  getMeta = ctx.db.getMeta;
  setName = ctx.db.setName;
  getProjectMeta = ctx.db.getProjectMeta;
}

// --- backend provenance + scoping (multi-LLM T-4.2) ---
//
// The cache is no longer Claude-only, but the FOLDER key is still shared: a session groups into a
// project by its cwd (§5.9), and the folder key is encodeProjectPath(cwd) whatever produced it. So a
// Codex rollout in D:\Projekte\demo lands in the SAME folder bucket as the Claude session there.
//
// Consequence: every folder-wide read/delete must be scoped to the store being refreshed, or the
// Claude sweep would delete the Codex rows in "its" folder (they have no file under ~/.claude/projects,
// so the vanished-file reconcile would sweep them away) — and the Codex sweep would do the same in
// reverse. Two disjoint scopes:
//   CLAUDE store  = claude + every Axis-A profile (a profile shares Claude's binary AND its store)
//   Axis-B stores = codex (later gemini/hermes/pi) — each has its own root
// Expressed as { except: [axis-B ids] } so a newly-created Axis-A profile is automatically inside
// Claude's scope without the scanner needing the profile list.

let _foreignIds = null;
function foreignBackendIds() {
  if (_foreignIds) return _foreignIds;
  try {
    // Axis-B backends own their session store. `planned` ones never have rows, but listing them is
    // harmless and keeps the scope stable when a phase flips one to `ready`.
    _foreignIds = backends.list().filter(b => b.axis === 'B').map(b => b.id);
  } catch {
    _foreignIds = ['codex'];
  }
  return _foreignIds;
}

/** The scope of the Claude/Axis-A store: everything that is NOT an Axis-B backend's own row. */
function claudeStoreScope() {
  return { except: foreignBackendIds() };
}

/** After the row is written the overlay entry may finally be FIFO-evicted (§5.7). */
function markPersisted(sessionId) {
  try { sessionBackends.markPersisted(sessionId); } catch {}
}

// Title precedence: user rename (session_meta.name) > JSONL custom-title (Claude
// /title) > JSONL ai-title. AI titles must NEVER promote to session_meta.name or
// they'd overwrite the user's UI rename on the next index pass.
function sessionName(s) {
  return getMeta(s.sessionId)?.name || s.customTitle || s.aiTitle || '';
}

// The search-index row for a session (external-content FTS body = its text).
function buildSearchEntry(s) {
  const name = sessionName(s);
  return {
    id: s.sessionId, type: 'session', folder: s.folder,
    title: (name ? name + ' ' : '') + s.summary, body: s.textContent,
  };
}

/**
 * What the STORES hold, for projects the cache cannot speak for: projectPath -> the newest session seen.
 *
 * A REMOVED project is deliberately not indexed, so its rows are gone while its transcripts are not. Two
 * things then depend on this map, and both would be wrong without it (#167):
 *
 *   - The tombstone sweep may only forget a removal once no session for that path is left ANYWHERE. Ask
 *     the cache and it says "none" by construction — the sweep would drop the tombstone, and the next
 *     scan would resurrect the project off the very transcripts the removal was meant to forget.
 *   - A NEW session in a removed project has to bring it back. That is the entire difference between
 *     "removed" and "banned". Ask the cache and it never even hears about it.
 */
const storeProjectPaths = new Map();
function noteStoreProject(projectPath, at) {
  if (!projectPath) return;
  const prev = storeProjectPaths.get(projectPath) || null;
  storeProjectPaths.set(projectPath, at && (!prev || at > prev) ? at : prev);
}
function getStoreProjectPaths() {
  return storeProjectPaths;
}

/** The newest `modified` in a batch of parsed sessions — what a removed project is judged by. */
function newestSessionAt(sessions) {
  let newest = null;
  for (const s of sessions || []) {
    const at = s.lastEntryAt || s.modified || null;
    if (at && (!newest || at > newest)) newest = at;
  }
  return newest;
}

/**
 * Don't index this project back in — it was REMOVED (#167).
 *
 * A hidden project is still ON the list and only unseen, so its sessions go on being indexed; a REMOVED
 * project is off the list and its rows were purged — re-indexing them would put it back into search and
 * undo half the removal. A single-row lookup by primary key, called per session in the scan loop.
 */
function isRemovedProject(projectPath) {
  try {
    const m = getProjectMeta(projectPath);
    return !!(m && m.removedAt && !m.registered);
  } catch {
    return false;
  }
}

/**
 * The ONE backend-neutral write sink (#199 step 4). Every scan path — Claude store-indexer, the generic
 * backend-scan, the cold-scan worker handler, and (step 5) the worker message handler — runs its
 * per-backend `prepare()` (the only place a backend id is branched on) and then calls THIS. It knows no
 * backend id: the rows arrive already stamped with their own `backendId`, and it scopes every FTS/cache
 * delete through each row's own backendId so a Claude sweep can never take a Codex row with it.
 *
 * Inputs:
 *   sessions      — already-prepared rows (backendId set on each). Upserted, marked-persisted, named,
 *                   metric'd and (re)indexed for FTS.
 *   wipeFolders   — [{folder, scope}] folder-scoped wipes: deleteSearchFolder BEFORE deleteCachedFolder
 *                   (the scoped FTS delete resolves backendId through session_cache rows — so the rows
 *                   must still be there when it runs — ordering matters).
 *   deleteIds     — per-session-id deletes (cache + search), for a reconcile that keys on id/file.
 *   metricsMode   — 'always'      (Claude): replaceSessionMetrics unconditionally, clearing on empty too;
 *                   'if-nonempty' (Axis-B, #154): only when the parser actually emitted per-day metrics.
 *
 * Per session it does: buildSearchEntry (a DB read — fine on main, identical for a Hermes/Codex row),
 * upsert, markPersisted (#155 — every write path marked after upsert; do NOT drop it), setName when a
 * customTitle is present (COMMON: Axis-B promotes it too — §5.7 / :862), replaceSessionMetrics per
 * metricsMode, and the FTS delete+reinsert. Search entries are BUILT before setName runs — matching
 * refreshFolder/refreshFile/refreshBackendSessions, whose entries were captured pre-setName in the
 * parse loop; the FTS body is byte-identical whether setName lands before or after, because the search
 * title precedence (name > customTitle) already folds a just-set customTitle back to the same string.
 */
function applyIndexResults({ sessions = [], wipeFolders = [], deleteIds = [], metricsMode = 'always' } = {}) {
  // Folder-scoped wipes first: search before cache (the scoped FTS delete reads session_cache to
  // resolve backendId, so the rows must still be present). Runs even for an emptied folder.
  for (const wf of wipeFolders) {
    if (!wf) continue;
    deleteSearchFolder(wf.folder, wf.scope);
    deleteCachedFolder(wf.folder, wf.scope);
  }

  if (sessions.length) {
    // Build the search rows BEFORE any setName below (see the doc comment) so the FTS title reflects
    // the same name the scattered paths captured in their parse loops.
    const entries = sessions.map(buildSearchEntry);

    upsertCachedSessions(sessions);
    for (const s of sessions) {
      // The row now carries the authoritative backendId, so the overlay entry may be evicted (§5.7).
      markPersisted(s.sessionId);
      if (metricsMode === 'always') {
        // Claude: the sole write point for an incremental refresh — clears the table on empty too.
        replaceSessionMetrics(s.sessionId, s.dailyMetrics);
      } else if (Array.isArray(s.dailyMetrics) && s.dailyMetrics.length) {
        // Axis-B (#154): a parser that emits per-day metrics gets them stored; one that emits none
        // must not clobber a backend whose metrics live elsewhere.
        replaceSessionMetrics(s.sessionId, s.dailyMetrics);
      }
    }
    // FTS is delete + full-document reinsert (external-content protocol — see db.js).
    for (const s of sessions) deleteSearchSession(s.sessionId);
    upsertSearchEntries(entries);
    // Only JSONL custom-title (a genuine user title) promotes to the DB name column. AI titles must
    // not — see sessionName() for the precedence rationale.
    for (const s of sessions) {
      if (s.customTitle) setName(s.sessionId, s.customTitle);
    }
  }

  // Per-id reconcile deletes: a cached row whose source is gone. Its own row + search entry.
  for (const id of deleteIds) {
    deleteCachedSession(id);
    deleteSearchSession(id);
  }
}

function notifyRendererProjectsChanged() {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('projects-changed');
  }
}

function sendStatus(text, type) {
  if (text) log.info(`[status] (${type || 'info'}) ${text}`);
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send('status-update', text, type || 'info');
  }
}

module.exports = {
  init,
  applyIndexResults,
  buildSearchEntry,
  claudeStoreScope,
  markPersisted,
  noteStoreProject,
  getStoreProjectPaths,
  newestSessionAt,
  isRemovedProject,
  notifyRendererProjectsChanged,
  sendStatus,
};
