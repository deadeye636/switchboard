// Session and project metadata — what the USER decided about a session or a project (#217 step 8).
//
// Everything here is a user's own annotation, not something derived from a transcript: a renamed session,
// a star, an archive flag, a favourited project, and the register (#167) — one row per project, where the
// ROW IS THE LIST the sidebar builds from, instead of the list being re-derived from the folders on disk.
// Auto-hide (#57) lives here too: it writes the same project_meta row.
//
// It reads settings for one thing only: getProjectDisplayNames pulls the display name out of each
// `project:<path>` blob, which is a settings row, not a project_meta column. That is why this module
// imports settings-store — a real dependency, small and one-directional.
//
// `stmts` is exported for project-refs.js: renaming a project moves its project_meta row inside the same
// transaction that moves its tags, handoffs and settings blob.
'use strict';

const { db } = require('./connection');
const { runWithBusyRetry } = require('./sqlite-busy-retry');
const settingsStore = require('./settings-store');

const stmts = {
  get: db.prepare('SELECT * FROM session_meta WHERE sessionId = ?'),
  getAll: db.prepare('SELECT * FROM session_meta'),
  upsertName: db.prepare(`
    INSERT INTO session_meta (sessionId, name) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET name = excluded.name
  `),
  upsertStar: db.prepare(`
    INSERT INTO session_meta (sessionId, starred) VALUES (?, 1)
    ON CONFLICT(sessionId) DO UPDATE SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END
  `),
  upsertArchived: db.prepare(`
    INSERT INTO session_meta (sessionId, archived) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET archived = excluded.archived
  `),
  // Project favorites (toggle on the real projectPath, analog to upsertStar)
  projectFavoriteToggle: db.prepare(`
    INSERT INTO project_meta (projectPath, favorited) VALUES (?, 1)
    ON CONFLICT(projectPath) DO UPDATE SET favorited = CASE WHEN favorited = 1 THEN 0 ELSE 1 END
  `),
  projectMetaGet: db.prepare('SELECT * FROM project_meta WHERE projectPath = ?'),
  projectMetaGetAll: db.prepare('SELECT projectPath FROM project_meta WHERE favorited = 1'),
  // Project path lifecycle (#55): remap moves these rows, hard delete removes them.
  projectMetaDelete: db.prepare('DELETE FROM project_meta WHERE projectPath = ?'),
  projectMetaRename: db.prepare('UPDATE project_meta SET projectPath = ? WHERE projectPath = ?'),
  // Auto-hide (#57): mark/clear the automatic-hide flag and (re)start the grace timer.
  projectMetaSetAutoHidden: db.prepare(`
    INSERT INTO project_meta (projectPath, autoHidden) VALUES (?, ?)
    ON CONFLICT(projectPath) DO UPDATE SET autoHidden = excluded.autoHidden
  `),
  projectMetaResetAutoHide: db.prepare(`
    INSERT INTO project_meta (projectPath, autoHidden, autoHideResetAt) VALUES (?, 0, ?)
    ON CONFLICT(projectPath) DO UPDATE SET autoHidden = 0, autoHideResetAt = excluded.autoHideResetAt
  `),
  projectMetaAutoHidden: db.prepare('SELECT projectPath FROM project_meta WHERE autoHidden = 1'),
  // The register (#167). One row per project, and the row IS the list — `projectMetaAll` is what the
  // sidebar builds from, instead of deriving the list from the transcripts on disk.
  projectMetaAll: db.prepare('SELECT * FROM project_meta'),
  projectMetaTombstones: db.prepare('SELECT projectPath, removedAt FROM project_meta WHERE removedAt IS NOT NULL'),
};


function getMeta(sessionId) {
  return stmts.get.get(sessionId) || null;
}

function getAllMeta() {
  const rows = stmts.getAll.all();
  const map = new Map();
  for (const row of rows) map.set(row.sessionId, row);
  return map;
}

function setName(sessionId, name) {
  runWithBusyRetry(() => stmts.upsertName.run(sessionId, name));
}

function toggleStar(sessionId) {
  runWithBusyRetry(() => stmts.upsertStar.run(sessionId));
  const row = stmts.get.get(sessionId);
  return row.starred;
}

function setArchived(sessionId, archived) {
  runWithBusyRetry(() => stmts.upsertArchived.run(sessionId, archived ? 1 : 0));
}

function toggleProjectFavorite(projectPath) {
  runWithBusyRetry(() => stmts.projectFavoriteToggle.run(projectPath));
  const row = stmts.projectMetaGet.get(projectPath);
  return row ? row.favorited : 0;
}

// Set of projectPaths currently favorited — consumed by buildProjectsFromCache.
function getFavoritedProjects() {
  const set = new Set();
  for (const row of stmts.projectMetaGetAll.all()) set.add(row.projectPath);
  return set;
}

// --- Auto-hide meta (#57) ---
// Raw project_meta row (or null) — used by applyAutoHide to read autoHideResetAt.
function getProjectMeta(projectPath) {
  return stmts.projectMetaGet.get(projectPath) || null;
}

// Mark/clear the automatic-hide flag for a project (distinguishes auto from manual hide).
function setProjectAutoHidden(projectPath, autoHidden) {
  runWithBusyRetry(() => stmts.projectMetaSetAutoHidden.run(projectPath, autoHidden ? 1 : 0));
}

// Reset the auto-hide grace timer to now and clear the auto-hidden flag. Called on
// unhide and on add/re-add so a just-restored stale project isn't re-hidden immediately.
function resetProjectAutoHide(projectPath) {
  runWithBusyRetry(() => stmts.projectMetaResetAutoHide.run(projectPath, new Date().toISOString()));
}

// Set of projectPaths whose current hide was set automatically — consumed by the
// hidden-projects UI to show an "auto" badge.
function getAutoHiddenProjects() {
  const set = new Set();
  for (const row of stmts.projectMetaAutoHidden.all()) set.add(row.projectPath);
  return set;
}

// --- The register (#167) ---

// The columns a caller may patch. An allow-list, because the patch is built from a plain object and
// this is the one place a typo would silently write nothing — or, worse, something else.
const PROJECT_STATE_COLUMNS = ['registered', 'registeredAt', 'hidden', 'autoHidden', 'autoHideResetAt', 'removedAt'];

/**
 * Write part of a project's state. Only the keys given are touched — "not mentioned" is not "set to
 * null", or registering a project would wipe its favourite.
 */
function setProjectState(projectPath, patch) {
  if (!projectPath || !patch) return;
  const keys = Object.keys(patch).filter(k => PROJECT_STATE_COLUMNS.includes(k));
  if (!keys.length) return;

  const cols = ['projectPath', ...keys];
  const sql = `INSERT INTO project_meta (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    + ` ON CONFLICT(projectPath) DO UPDATE SET ${keys.map(k => `${k} = excluded.${k}`).join(', ')}`;
  const values = [projectPath, ...keys.map(k => {
    const v = patch[k];
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  })];
  runWithBusyRetry(() => db.prepare(sql).run(...values));
}

/** Every project the app knows about: projectPath -> its row. THIS IS THE LIST. */
function getProjectStates() {
  const map = new Map();
  for (const row of stmts.projectMetaAll.all()) map.set(row.projectPath, row);
  return map;
}

/** projectPath -> removedAt, for the tombstone sweep. */
function getProjectTombstones() {
  const map = new Map();
  for (const row of stmts.projectMetaTombstones.all()) map.set(row.projectPath, row.removedAt);
  return map;
}

// Map projectPath -> custom displayName (only non-empty), from the per-project
// settings blobs (`project:<path>`). Consumed wherever a project name is rendered.
function getProjectDisplayNames() {
  const map = new Map();
  for (const row of settingsStore.stmts.settingsByPrefix.all('project:%')) {
    let val;
    try { val = JSON.parse(row.value); } catch { val = null; }
    const name = val && typeof val.displayName === 'string' ? val.displayName.trim() : '';
    if (name) map.set(row.key.slice('project:'.length), name);
  }
  return map;
}

module.exports = {
  getMeta, getAllMeta, setName, toggleStar, setArchived,
  toggleProjectFavorite, getFavoritedProjects, getProjectDisplayNames,
  getProjectMeta, setProjectAutoHidden, resetProjectAutoHide, getAutoHiddenProjects,
  setProjectState, getProjectStates, getProjectTombstones,
  // For project-refs.js's cross-domain transactions only — see the header.
  stmts,
};
