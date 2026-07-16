// Switchboard's database — FAÇADE (#217).
//
// This was 1997 lines. It is now a façade over modules named after what they hold, re-exporting the SAME
// names with function identity preserved: `require('../db/db')` keeps working and no caller outside
// `src/db/` changed. Nothing here has behaviour of its own — the only code is the three lines below, and
// each of them is an ordering constraint.
//
//   connection.js     — DATA_DIR, the one handle, the pragmas, closeDb. The single writer.
//   schema.js         — every CREATE TABLE/INDEX: the shape a FRESH database is born with.
//   migrations.js     — the one ordered, append-only array. Its LENGTH is the schema version.
//   meta-store.js     — what the USER decided: renames, stars, archive, favourites, auto-hide, register.
//   session-store.js  — what the SCANNER derived: the session cache, metrics, folder bookkeeping.
//   search-store.js   — the FTS5 index, its backing tables and every query against them.
//   tags-store.js     — bookmarks, session tags, project tags, tag defs.
//   tasks-store.js    — tasks and project handoffs.
//   settings-store.js — settings blobs and saved variables.
//   project-refs.js   — a project's whole footprint, moved or dropped ATOMICALLY across four of the above.
//   stats-store.js    — the Stats screen's aggregates (SQL in stats-queries.js).
//
// `./connection` is required FIRST and that is load-bearing, not style: it resolves DATA_DIR and opens the
// database at module load, which is exactly what this file used to do on its own first lines. main.js
// (~L75) sets SWITCHBOARD_DATA_DIR before requiring db.js, and that ordering must keep working.
//
// NOTHING LOADS THIS FILE IN A TEST — better-sqlite3 is built against Electron's ABI, so `npm test` says
// nothing about whether the wiring below is right. It was checked by running the real thing against a
// copy of a real database, and against an empty one, and diffing the export surface, the schema version,
// the table list and thirty-odd reads. Do the same before trusting a change here.
const { db, DB_PATH, closeDb } = require('./connection');
const { runMigrations } = require('./migrations');
const { applySchema } = require('./schema');

// Create the tables a fresh database needs, then bring an existing one up to date. Order matters: the
// migrations assume the tables exist.
applySchema(db);
// …then bring an existing database up to date. searchFtsRecreated is a snapshot of what THIS run did:
// a migration that dropped search_fts sets it, and main.js reads it to trigger a full repopulate. It has
// always been re-exported as a VALUE captured here, not a getter — keep it that way.
const { searchFtsRecreated } = runMigrations(db);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// THE STORES LOAD HERE, BELOW THE SCHEMA, AND THAT IS NOT STYLE.
//
// Each store prepares its statements at ITS module load, and `db.prepare` needs the table to exist. Put
// one of these requires up with the others and a FRESH database dies on the first launch with
// `SqliteError: no such table: settings` — while every existing install stays perfectly happy, because
// its tables have been there for months. That is a bug you ship, not one you hit.
//
// So: schema, then migrations, then stores. A new store module goes at the bottom of this list.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
const statsStore = require('./stats-store');
const settingsStore = require('./settings-store');
const tasksStore = require('./tasks-store');
const tagsStore = require('./tags-store');
const metaStore = require('./meta-store');
const projectRefs = require('./project-refs');
const sessionStore = require('./session-store');
const searchStore = require('./search-store');

module.exports = {
  // --- session + project metadata, the register, auto-hide (meta-store.js) ---
  getMeta: metaStore.getMeta,
  getAllMeta: metaStore.getAllMeta,
  setName: metaStore.setName,
  toggleStar: metaStore.toggleStar,
  setArchived: metaStore.setArchived,
  toggleProjectFavorite: metaStore.toggleProjectFavorite,
  getFavoritedProjects: metaStore.getFavoritedProjects,
  getProjectDisplayNames: metaStore.getProjectDisplayNames,
  getProjectMeta: metaStore.getProjectMeta,
  setProjectAutoHidden: metaStore.setProjectAutoHidden,
  resetProjectAutoHide: metaStore.resetProjectAutoHide,
  getAutoHiddenProjects: metaStore.getAutoHiddenProjects,
  setProjectState: metaStore.setProjectState,
  getProjectStates: metaStore.getProjectStates,
  getProjectTombstones: metaStore.getProjectTombstones,
  // --- a project's whole footprint, moved or dropped atomically (project-refs.js) ---
  renameProjectRefs: projectRefs.renameProjectRefs,
  deleteProjectRefs: projectRefs.deleteProjectRefs,
  // --- bookmarks + tags + tag defs (tags-store.js) ---
  toggleBookmark: tagsStore.toggleBookmark,
  removeBookmark: tagsStore.removeBookmark,
  listBookmarks: tagsStore.listBookmarks,
  // --- tasks + handoffs (tasks-store.js) ---
  createTask: tasksStore.createTask,
  listTasks: tasksStore.listTasks,
  getTask: tasksStore.getTask,
  updateTask: tasksStore.updateTask,
  removeTask: tasksStore.removeTask,
  openTaskCountsBySession: tasksStore.openTaskCountsBySession,
  openTaskCountsByProject: tasksStore.openTaskCountsByProject,
  saveProjectHandoff: tasksStore.saveProjectHandoff,
  listProjectHandoffs: tasksStore.listProjectHandoffs,
  deleteProjectHandoff: tasksStore.deleteProjectHandoff,
  getSessionTags: tagsStore.getSessionTags,
  setSessionTags: tagsStore.setSessionTags,
  listAllTags: tagsStore.listAllTags,
  getAllSessionTags: tagsStore.getAllSessionTags,
  getProjectTags: tagsStore.getProjectTags,
  setProjectTags: tagsStore.setProjectTags,
  listAllProjectTags: tagsStore.listAllProjectTags,
  getAllProjectTags: tagsStore.getAllProjectTags,
  listTagDefs: tagsStore.listTagDefs,
  createTagDef: tagsStore.createTagDef,
  renameTagDef: tagsStore.renameTagDef,
  setTagDefColor: tagsStore.setTagDefColor,
  setTagDefFlags: tagsStore.setTagDefFlags,
  deleteTagDef: tagsStore.deleteTagDef,
  // --- the indexed session cache, metrics and folder bookkeeping (session-store.js) ---
  isCachePopulated: sessionStore.isCachePopulated,
  getAllCached: sessionStore.getAllCached,
  getCachedByFolder: sessionStore.getCachedByFolder,
  getCachedByParent: sessionStore.getCachedByParent,
  getCachedByProjectPath: sessionStore.getCachedByProjectPath,
  getBackendsByProjectPath: sessionStore.getBackendsByProjectPath,
  getCachedFolder: sessionStore.getCachedFolder,
  getCachedSession: sessionStore.getCachedSession,
  upsertCachedSessions: sessionStore.upsertCachedSessions,
  deleteCachedSession: sessionStore.deleteCachedSession,
  deleteCachedFolder: sessionStore.deleteCachedFolder,
  replaceSessionMetrics: sessionStore.replaceSessionMetrics,
  getFolderMeta: sessionStore.getFolderMeta,
  getAllFolderMeta: sessionStore.getAllFolderMeta,
  setFolderMeta: sessionStore.setFolderMeta,
  // --- full-text search (search-store.js) ---
  upsertSearchEntries: searchStore.upsertSearchEntries,
  updateSearchTitle: searchStore.updateSearchTitle,
  deleteSearchSession: searchStore.deleteSearchSession,
  deleteSearchFolder: searchStore.deleteSearchFolder,
  deleteSearchType: searchStore.deleteSearchType,
  searchByType: searchStore.searchByType,
  isSearchIndexPopulated: searchStore.isSearchIndexPopulated,
  // A snapshot of what THIS run's migrations did — a value, not a getter, exactly as it always was.
  searchFtsRecreated,
  // --- settings + saved variables (settings-store.js) ---
  getSetting: settingsStore.getSetting,
  setSetting: settingsStore.setSetting,
  deleteSetting: settingsStore.deleteSetting,
  listSettings: settingsStore.listSettings,
  listSavedVariables: settingsStore.listSavedVariables,
  listAllSavedVariables: settingsStore.listAllSavedVariables,
  getSavedVariable: settingsStore.getSavedVariable,
  saveSavedVariable: settingsStore.saveSavedVariable,
  deleteSavedVariable: settingsStore.deleteSavedVariable,
  touchSavedVariable: settingsStore.touchSavedVariable,
  // --- the stats aggregates (stats-store.js) ---
  getDailyActivity: statsStore.getDailyActivity,
  getDailyMetrics: statsStore.getDailyMetrics,
  getDailyModelTokens: statsStore.getDailyModelTokens,
  getModelUsage: statsStore.getModelUsage,
  getTotalCounts: statsStore.getTotalCounts,
  getDailyBackendTokens: statsStore.getDailyBackendTokens,
  getDailyCost: statsStore.getDailyCost,
  getHourlyActivity: statsStore.getHourlyActivity,
  closeDb,
  // Exported so main.js can pass the resolved path to the search-query worker
  // without re-deriving the SWITCHBOARD_DATA_DIR logic in a second place.
  DB_PATH,
};
