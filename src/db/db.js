// Switchboard's database — FAÇADE in progress (#217).
//
// This file is being split into modules named after what they hold. The name stays and so does every
// export: `require('../db/db')` keeps working and no caller outside `src/db/` changes.
//
// `./connection` is required FIRST and that is load-bearing, not style: it resolves DATA_DIR and opens the
// database at module load, which is exactly what this file used to do on its own first lines. main.js
// (~L75) sets SWITCHBOARD_DATA_DIR before requiring db.js, and that ordering must keep working.
const { db, DB_PATH, closeDb } = require('./connection');
const { runWithBusyRetry } = require('./sqlite-busy-retry');
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



// --- FTS5 full-text search (external-content table) ---
//
// Body is capped at FTS_BODY_MAX_CHARS before being stored. This bounds the
// content table size independently of raw transcript length, while keeping
// enough text for useful snippet() previews.
const FTS_BODY_MAX_CHARS = 32768; // 32 768 JS characters (UTF-16 code units); surrogate-pair split at the boundary is negligible for ASCII transcripts

// Query length cap + MATCH building shared with the search worker — rationale
// lives in search-query-util.js (#79).
const { buildFtsMatch } = require('./search-query-util');

// search_content holds the plaintext the fts5 index reads columns from.
// It is the single authoritative copy: title is full-length; body is
// truncated to FTS_BODY_MAX_CHARS. Keeping this separate from search_map
// (which stores only id/type/folder) lets us JOIN on rowid cheaply.
db.exec(`
  CREATE TABLE IF NOT EXISTS search_content (
    rowid INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    body  TEXT NOT NULL DEFAULT ''
  )
`);

// search_fts is an external-content fts5 table: it stores only the trigram
// index, not a copy of title/body. snippet()/highlight() work by reading
// the corresponding row from search_content at query time (zero extra copy).
// This eliminates the ~14x amplification of the old plain fts5 table.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title, body,
    content='search_content',
    tokenize='trigram case_sensitive 0'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS search_map (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    folder TEXT
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_search_map_type_id ON search_map(type, id)');

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
  // Session cache statements
  cacheCount: db.prepare('SELECT COUNT(*) as cnt FROM session_cache'),
  cacheGetAll: db.prepare('SELECT * FROM session_cache'),
  // backendId / filePath (multi-LLM, v10 + v11) are COALESCEd on update, never overwritten with NULL:
  // the scanner passes NULL when it cannot tell (no launch overlay, Claude root), and a NULL must not
  // downgrade a row that already carries an Axis-A profile id — the row is the authoritative
  // provenance (§5.7) and the overlay is only the bridge until it is written. A NULL on INSERT means
  // "plain Claude"; the row getters below normalise it to 'claude'.
  cacheUpsert: db.prepare(`
    INSERT INTO session_cache (
      sessionId, folder, projectPath, summary, firstPrompt, created, modified,
      messageCount, userMessageCount, inputTokens, outputTokens, cacheCreationTokens,
      cacheReadTokens, largestUserPromptWords, startedAt, lastEntryAt, activeMinutes,
      slug, aiTitle,
      parentSessionId, agentId, subagentType, description,
      backendId, filePath,
      changeMarker, estimatedCostUsd, actualCostUsd, costStatus, lineageParentId,
      parserVersion
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET
      folder = excluded.folder, projectPath = excluded.projectPath,
      summary = excluded.summary, firstPrompt = excluded.firstPrompt,
      created = excluded.created, modified = excluded.modified,
      messageCount = excluded.messageCount,
      userMessageCount = excluded.userMessageCount,
      inputTokens = excluded.inputTokens,
      outputTokens = excluded.outputTokens,
      cacheCreationTokens = excluded.cacheCreationTokens,
      cacheReadTokens = excluded.cacheReadTokens,
      largestUserPromptWords = excluded.largestUserPromptWords,
      startedAt = excluded.startedAt,
      lastEntryAt = excluded.lastEntryAt,
      activeMinutes = excluded.activeMinutes,
      slug = excluded.slug,
      aiTitle = excluded.aiTitle,
      parentSessionId = excluded.parentSessionId,
      agentId = excluded.agentId,
      subagentType = excluded.subagentType,
      description = excluded.description,
      backendId = COALESCE(excluded.backendId, session_cache.backendId),
      filePath = COALESCE(excluded.filePath, session_cache.filePath),
      changeMarker = excluded.changeMarker,
      estimatedCostUsd = COALESCE(excluded.estimatedCostUsd, session_cache.estimatedCostUsd),
      actualCostUsd = COALESCE(excluded.actualCostUsd, session_cache.actualCostUsd),
      costStatus = COALESCE(excluded.costStatus, session_cache.costStatus),
      lineageParentId = COALESCE(excluded.lineageParentId, session_cache.lineageParentId),
      parserVersion = excluded.parserVersion
  `),
  cacheGetByParent: db.prepare('SELECT * FROM session_cache WHERE parentSessionId = ? ORDER BY created ASC'),
  cacheGetByFolder: db.prepare('SELECT sessionId, modified, parentSessionId, agentId, backendId, filePath, changeMarker, parserVersion FROM session_cache WHERE folder = ?'),
  cacheGetFolder: db.prepare('SELECT folder FROM session_cache WHERE sessionId = ?'),
  cacheGetSession: db.prepare('SELECT * FROM session_cache WHERE sessionId = ?'),
  cacheDeleteSession: db.prepare('DELETE FROM session_cache WHERE sessionId = ?'),
  cacheDeleteFolder: db.prepare('DELETE FROM session_cache WHERE folder = ?'),
  // Session metrics statements (per-(session,date,model) token/tool/message counts)
  metricsDeleteBySession: db.prepare('DELETE FROM session_metrics WHERE sessionId = ?'),
  metricsDeleteByFolder: db.prepare('DELETE FROM session_metrics WHERE sessionId IN (SELECT sessionId FROM session_cache WHERE folder = ?)'),
  // One row per (date, hour, model) bucket. A parser emits each bucket ONCE (they all aggregate into a
  // Map first), so a plain INSERT is the contract — `INSERT OR REPLACE` would quietly paper over a
  // parser that double-counts, and an upsert that SUMS would have to COALESCE the two cost columns,
  // turning "reported no cost" (NULL) into "cost nothing" (0). Both are lies we would never see.
  metricsInsert: db.prepare(`
    INSERT INTO session_metrics
      (sessionId, date, hour, model, messageCount, toolCallCount, inputTokens, outputTokens,
       cacheReadTokens, cacheCreationTokens, estimatedCostUsd, actualCostUsd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  // Cache meta statements
  metaGet: db.prepare('SELECT * FROM cache_meta WHERE folder = ?'),
  metaGetAll: db.prepare('SELECT * FROM cache_meta'),
  metaUpsert: db.prepare(`
    INSERT INTO cache_meta (folder, projectPath, indexMtimeMs)
    VALUES (?, ?, ?)
    ON CONFLICT(folder) DO UPDATE SET
      projectPath = excluded.projectPath, indexMtimeMs = excluded.indexMtimeMs
  `),
  metaDelete: db.prepare('DELETE FROM cache_meta WHERE folder = ?'),
  // FTS search statements
  // External-content protocol: search_content is the authoritative column store;
  // search_fts holds only the trigram index and reads columns from search_content
  // at query time. Delete/insert must keep both tables in sync.
  searchDeleteContentBySession: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND id = ?)'),
  searchDeleteBySession: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND id = ?)'),
  searchMapDeleteBySession: db.prepare('DELETE FROM search_map WHERE type = \'session\' AND id = ?'),
  searchDeleteContentByFolder: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND folder = ?)'),
  searchDeleteByFolder: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND folder = ?)'),
  searchMapDeleteByFolder: db.prepare('DELETE FROM search_map WHERE type = \'session\' AND folder = ?'),
  searchDeleteContentByType: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)'),
  searchDeleteByType: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)'),
  searchMapDeleteByType: db.prepare('DELETE FROM search_map WHERE type = ?'),
  // Insert: search_content row first (external-content protocol requires the
  // content row to exist before the fts5 shadow row is written).
  searchInsertContent: db.prepare('INSERT OR REPLACE INTO search_content(rowid, title, body) VALUES (?, ?, ?)'),
  searchInsertFts: db.prepare('INSERT OR REPLACE INTO search_fts(rowid, title, body) VALUES (?, ?, ?)'),
  searchInsertMap: db.prepare('INSERT OR REPLACE INTO search_map(id, type, folder) VALUES (?, ?, ?)'),
  searchMapLookup: db.prepare('SELECT rowid FROM search_map WHERE id = ? AND type = ?'),
  searchMapCountByType: db.prepare('SELECT COUNT(*) as cnt FROM search_map WHERE type = ?'),
  // Title update: patches search_content (the authoritative column store) and
  // immediately removes the old fts5 shadow row via the 'delete' command then
  // reinserts it with the new title. See updateSearchTitle() for the full
  // two-step delete + reinsert protocol — the index is NOT lazily rebuilt.
  searchUpdateTitle: db.prepare('UPDATE search_content SET title = ? WHERE rowid = (SELECT rowid FROM search_map WHERE id = ? AND type = ?)'),
  searchDeleteContentByRowid: db.prepare('DELETE FROM search_content WHERE rowid = ?'),
  searchDeleteByRowid: db.prepare('DELETE FROM search_fts WHERE rowid = ?'),
  searchMapDeleteByRowid: db.prepare('DELETE FROM search_map WHERE rowid = ?'),
  searchContentGet: db.prepare('SELECT title, body FROM search_content WHERE rowid = ?'),
  // fts5 external-content delete command: removes the shadow row by its old
  // column values. Used before reinserting with updated title.
  searchFtsDeleteRow: db.prepare("INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', ?, ?, ?)"),
  searchFtsInsertRow: db.prepare('INSERT INTO search_fts(rowid, title, body) VALUES(?, ?, ?)'),
  // Settings statements
  searchQuery: db.prepare(`
    SELECT search_map.id, snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM search_fts
    JOIN search_map ON search_fts.rowid = search_map.rowid
    WHERE search_map.type = ? AND search_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),
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

// --- Bookmarks + session tags ---

// --- Project path lifecycle (#55) ---
// Everything Switchboard keys by projectPath: project_meta (favorite, auto-hide),
// project_tags, project_handoffs, and the `project:<path>` settings blob (display
// name, permission mode, worktree prefs, AFK timeout).
//
// A remap moves the project to a new path; a hard delete removes it for good.
// Neither used to touch any of this, so a remap silently dropped the project's
// favorite/tags/settings and left the old path behind as a phantom.

// Move every reference from oldPath to newPath. Where the destination already
// carries data of its own, the destination wins and the source row is dropped —
// remapping onto a folder that is already a known project must never clobber it.
const renameProjectRefsTx = db.transaction((oldPath, newPath) => {
  const destMeta = stmts.projectMetaGet.get(newPath);
  if (destMeta) stmts.projectMetaDelete.run(oldPath);
  else stmts.projectMetaRename.run(newPath, oldPath);

  // Tags merge: a tag the destination already has keeps its own colour.
  tagsStore.stmts.projectTagsMerge.run(newPath, oldPath);
  tagsStore.stmts.projectTagDeleteAll.run(oldPath);

  // Handoffs are a list, so they simply accrue to the destination.
  tasksStore.stmts.projectHandoffsRename.run(newPath, oldPath);

  const destSettings = settingsStore.stmts.settingsGet.get('project:' + newPath);
  if (destSettings) settingsStore.stmts.settingsDelete.run('project:' + oldPath);
  else settingsStore.stmts.settingsRename.run('project:' + newPath, 'project:' + oldPath);
});

function renameProjectRefs(oldPath, newPath) {
  if (!oldPath || !newPath || oldPath === newPath) return;
  runWithBusyRetry(() => renameProjectRefsTx(oldPath, newPath));
}

// Drop every trace of a project. Only for a hard delete — a plain "hide" must
// keep this data so unhiding restores the project intact.
const deleteProjectRefsTx = db.transaction((projectPath) => {
  stmts.projectMetaDelete.run(projectPath);
  tagsStore.stmts.projectTagDeleteAll.run(projectPath);
  tasksStore.stmts.projectHandoffsDeleteAll.run(projectPath);
  settingsStore.stmts.settingsDelete.run('project:' + projectPath);
});

function deleteProjectRefs(projectPath) {
  if (!projectPath) return;
  runWithBusyRetry(() => deleteProjectRefsTx(projectPath));
}

// --- Session cache functions ---

// --- backend scoping (multi-LLM T-4.2) ---
//
// A folder key no longer belongs to ONE backend. A Codex session's folder is the SAME
// encodeProjectPath(cwd) key as the Claude session in that cwd (project grouping is central and
// cwd-keyed, §5.9) — so `~/.claude/projects/<folder>` and a Codex rollout can share a row bucket.
// Every folder-wide read/delete on the scan path must therefore be scoped to the backend being
// refreshed, or a Claude sweep would delete the Codex rows sitting in "its" folder (and vice versa).
//
// scope:
//   null / undefined  -> all rows (unchanged legacy behaviour: project removal wipes everything)
//   { except: [ids] } -> everything NOT owned by those backends (the Claude-store sweep: Claude plus
//                        every Axis-A profile, which shares Claude's store, minus the Axis-B stores)
//   { only:   [ids] } -> only those backends (a single backend's own sweep)
//
// A NULL backendId counts as 'claude' (the v10 DEFAULT, and what the scanner writes when it cannot
// tell — see cacheUpsert).
function backendScopeClause(scope, col = 'backendId') {
  if (!scope) return { sql: '', params: [] };
  const isOnly = Array.isArray(scope.only);
  const ids = isOnly ? scope.only : (Array.isArray(scope.except) ? scope.except : null);
  if (!ids) return { sql: '', params: [] };
  if (ids.length === 0) return isOnly ? { sql: ' AND 0', params: [] } : { sql: '', params: [] };

  const q = ids.map(() => '?').join(', ');
  // A NULL backendId IS 'claude' (the v10 DEFAULT, and what the scanner writes when it has nothing
  // to say). Handled as an explicit OR rather than COALESCE(backendId,'claude') so the comparison
  // stays on the bare column and idx_session_cache_backend remains usable.
  const inSide = isOnly ? `${col} IN (${q})` : `${col} NOT IN (${q})`;
  const claudeListed = ids.includes('claude');
  const nullSide = isOnly
    ? (claudeListed ? `${col} IS NULL` : null)   // only:[claude,…] must also match the NULL rows
    : (claudeListed ? null : `${col} IS NULL`);  // except:[axis-B…] must keep them
  return {
    sql: nullSide ? ` AND (${nullSide} OR ${inSide})` : ` AND ${inSide}`,
    params: ids.slice(),
  };
}

// The scope list is dynamic (built-in Axis-B backends + user profiles), so these statements cannot be
// prepared up front. Memoize by SQL text — the set of distinct shapes is tiny (one per scope size).
const _scopedStmts = new Map();
function prepScoped(sql) {
  let s = _scopedStmts.get(sql);
  if (!s) { s = db.prepare(sql); _scopedStmts.set(sql, s); }
  return s;
}

// A NULL backendId (legacy row, or a row the scanner could not attribute) reads as 'claude'.
function normalizeCacheRow(row) {
  if (row && row.backendId == null) row.backendId = 'claude';
  return row;
}
function normalizeCacheRows(rows) {
  for (const r of rows) if (r.backendId == null) r.backendId = 'claude';
  return rows;
}

function isCachePopulated() {
  return stmts.cacheCount.get().cnt > 0;
}

function getAllCached() {
  return normalizeCacheRows(stmts.cacheGetAll.all());
}

const upsertCachedSessionsBatch = db.transaction((sessions) => {
  for (const s of sessions) {
    stmts.cacheUpsert.run(
      s.sessionId, s.folder, s.projectPath, s.summary,
      s.firstPrompt, s.created, s.modified, s.messageCount || 0,
      s.userMessageCount || 0, s.inputTokens || 0, s.outputTokens || 0,
      s.cacheCreationTokens || 0, s.cacheReadTokens || 0,
      s.largestUserPromptWords || 0, s.startedAt || null, s.lastEntryAt || null,
      s.activeMinutes || 0,
      s.slug || null, s.aiTitle || null,
      s.parentSessionId || null, s.agentId || null,
      s.subagentType || null, s.description || null,
      // NULL = "unknown" (see cacheUpsert): keeps an already-recorded backendId instead of
      // downgrading it to 'claude' when the launch overlay has since been evicted.
      s.backendId || null, s.filePath || null,
      // v12 — db-store change marker + Hermes cost/lineage. All NULL for a file backend.
      s.changeMarker || null,
      s.estimatedCostUsd == null ? null : Number(s.estimatedCostUsd),
      s.actualCostUsd == null ? null : Number(s.actualCostUsd),
      s.costStatus || null,
      s.lineageParentId || null,
      // v14 (#152) — which parser wrote this row. The scan compares it to the parser that would read
      // it now, so a bumped parser re-reads its own sessions instead of leaving stale metrics behind.
      s.parserVersion == null ? null : Number(s.parserVersion)
    );
  }
});

// Replace all metric rows for a session in one transaction: delete-by-session
// then insert the fresh per-(date,model) rows. Called whenever a session is read
// in full (cold-start rebuild + NEW-file branch of the incremental refresh).
const replaceSessionMetricsBatch = db.transaction((sessionId, rows) => {
  stmts.metricsDeleteBySession.run(sessionId);
  for (const r of rows || []) {
    stmts.metricsInsert.run(
      sessionId, r.date,
      // -1 = "this backend cannot say when within the day". Kept out of the hour grid rather than
      // guessed at; it still counts in every per-day chart.
      Number.isInteger(r.hour) && r.hour >= 0 && r.hour <= 23 ? r.hour : -1,
      r.model || '',
      r.messageCount | 0, r.toolCallCount | 0,
      r.inputTokens | 0, r.outputTokens | 0,
      r.cacheReadTokens | 0, r.cacheCreationTokens | 0,
      // NULL, not 0: only Hermes reports money, and "no figure" must never render as "free".
      r.estimatedCostUsd == null ? null : Number(r.estimatedCostUsd),
      r.actualCostUsd == null ? null : Number(r.actualCostUsd)
    );
  }
});

function replaceSessionMetrics(sessionId, rows) {
  replaceSessionMetricsBatch(sessionId, rows);
}

function getCachedByParent(parentSessionId) {
  return normalizeCacheRows(stmts.cacheGetByParent.all(parentSessionId));
}

function upsertCachedSessions(sessions) {
  runWithBusyRetry(() => upsertCachedSessionsBatch(sessions));
}

// `scope` (optional, see backendScopeClause): restricts the rows to one backend's store. Omitted =
// every row in the folder, whatever produced it.
function getCachedByFolder(folder, scope) {
  if (!scope) return normalizeCacheRows(stmts.cacheGetByFolder.all(folder));
  const c = backendScopeClause(scope);
  const sql = 'SELECT sessionId, modified, parentSessionId, agentId, backendId, filePath, changeMarker, parserVersion'
    + ' FROM session_cache WHERE folder = ?' + c.sql;
  return normalizeCacheRows(prepScoped(sql).all(folder, ...c.params));
}

/**
 * Every cached session of a project, whatever backend wrote it — with the path to its transcript (#171).
 *
 * A remap has to move a project's sessions, and they do not all live in Claude's store: a project's
 * Codex rollouts sit in a date-bucketed tree, Pi's under a cwd-encoded folder. `filePath` is on the row
 * (v11) precisely because there is nothing to reconstruct it from.
 */
function getCachedByProjectPath(projectPath) {
  if (!projectPath) return [];
  // parentSessionId + agentId ride along because Claude's rows carry no `filePath`: their transcript is
  // reconstructed from folder + session id, and a SUBAGENT's file sits under the parent's directory.
  // Without these two columns every subagent transcript resolved to a path that does not exist, so the
  // remap skipped them and the delete missed them.
  return db.prepare(
    "SELECT sessionId, folder, projectPath, filePath, parentSessionId, agentId,"
    + " COALESCE(backendId, 'claude') AS backendId"
    + ' FROM session_cache WHERE projectPath = ?'
  ).all(projectPath);
}

/**
 * projectPath -> the backends that actually have sessions in it (#171). `backendId` is the authoritative
 * provenance, and NULL means Claude (rows written before the column existed, and every scheduled run).
 */
function getBackendsByProjectPath() {
  const map = new Map();
  const rows = db.prepare(
    "SELECT projectPath, COALESCE(backendId, 'claude') AS backendId, COUNT(*) AS n"
    + ' FROM session_cache WHERE projectPath IS NOT NULL'
    + ' GROUP BY projectPath, COALESCE(backendId, \'claude\') ORDER BY n DESC'
  ).all();
  for (const r of rows) {
    if (!map.has(r.projectPath)) map.set(r.projectPath, []);
    map.get(r.projectPath).push(r.backendId);
  }
  return map;
}

function getCachedFolder(sessionId) {
  const row = stmts.cacheGetFolder.get(sessionId);
  return row ? row.folder : null;
}

function getCachedSession(sessionId) {
  return normalizeCacheRow(stmts.cacheGetSession.get(sessionId) || null);
}

function deleteCachedSession(sessionId) {
  runWithBusyRetry(() => {
    stmts.metricsDeleteBySession.run(sessionId);
    stmts.cacheDeleteSession.run(sessionId);
  });
}

// `scope` (optional): only delete the rows of that backend store. Without it this stays the old
// wipe-the-whole-folder call (project removal / cold-start rebuild of a single-backend folder).
function deleteCachedFolder(folder, scope) {
  const c = backendScopeClause(scope);
  const metricsSql = 'DELETE FROM session_metrics WHERE sessionId IN'
    + ' (SELECT sessionId FROM session_cache WHERE folder = ?' + c.sql + ')';
  const cacheSql = 'DELETE FROM session_cache WHERE folder = ?' + c.sql;
  runWithBusyRetry(() => {
    // Delete metrics first — the metrics statement sub-selects on session_cache, so it must run
    // before the session_cache rows for this folder are gone.
    if (!scope) {
      stmts.metricsDeleteByFolder.run(folder);
      stmts.cacheDeleteFolder.run(folder);
    } else {
      prepScoped(metricsSql).run(folder, ...c.params);
      prepScoped(cacheSql).run(folder, ...c.params);
    }
    // cache_meta is Claude's per-folder index state (only the Claude scan writes it), so it is
    // dropped with the folder in both modes.
    stmts.metaDelete.run(folder);
  });
}

function getFolderMeta(folder) {
  // A late cache refresh can fire during shutdown after the DB is closed —
  // return null instead of throwing "connection is not open" (#90).
  if (!db.open) return null;
  return stmts.metaGet.get(folder) || null;
}

function getAllFolderMeta() {
  const rows = stmts.metaGetAll.all();
  const map = new Map();
  for (const row of rows) map.set(row.folder, row);
  return map;
}

function setFolderMeta(folder, projectPath, indexMtimeMs) {
  runWithBusyRetry(() => stmts.metaUpsert.run(folder, projectPath, indexMtimeMs));
}

// --- FTS search functions ---

const upsertSearchEntriesBatch = db.transaction((entries) => {
  for (const e of entries) {
    // Delete any existing FTS + content rows for this (id, type) pair before
    // inserting. search_map uses INSERT OR REPLACE which deletes the old row
    // and creates a new one with a new rowid, but the orphaned search_fts and
    // search_content rows keyed to the old rowid would never be cleaned up —
    // causing duplicate search results and unbounded table growth.
    const existing = stmts.searchMapLookup.get(e.id, e.type);
    if (existing) {
      stmts.searchDeleteByRowid.run(existing.rowid);
      stmts.searchDeleteContentByRowid.run(existing.rowid);
      stmts.searchMapDeleteByRowid.run(existing.rowid);
    }
    const result = stmts.searchInsertMap.run(e.id, e.type, e.folder || null);
    const rid = result.lastInsertRowid;
    const title = e.title || '';
    // Truncate body to FTS_BODY_MAX_CHARS: bounds search_content size and
    // keeps the fts5 index compact without sacrificing meaningful snippets
    // (the first 32 KB of a transcript covers the most-relevant content).
    const body = (e.body || '').slice(0, FTS_BODY_MAX_CHARS);
    // External-content protocol: search_content row must exist before the
    // fts5 shadow row so that fts5 can read columns for snippet() at insert.
    stmts.searchInsertContent.run(rid, title, body);
    stmts.searchInsertFts.run(rid, title, body);
  }
});

function deleteSearchSession(sessionId) {
  // External-content FTS5 protocol: delete from search_fts FIRST while
  // search_content rows still exist. SQLite reads search_content to locate the
  // trigram entries to remove from the shadow tables; if content is gone first,
  // those entries are never cleaned up and accumulate as ghost trigrams.
  // search_map is deleted last because the rowid sub-select in the two DELETE
  // stmts above still needs to resolve. Kept in runWithBusyRetry (HaydnG) for
  // SQLITE_BUSY resilience under concurrent writers.
  runWithBusyRetry(() => {
    stmts.searchDeleteBySession.run(sessionId);
    stmts.searchDeleteContentBySession.run(sessionId);
    stmts.searchMapDeleteBySession.run(sessionId);
  });
}

// `scope` (optional, multi-LLM): restrict the wipe to one backend's sessions. search_map has no
// backendId of its own, so the scope resolves through session_cache. The membership test is phrased
// so it does NOT depend on the caller's delete order: with { except: [...] } an entry survives only
// while a session_cache row explicitly owns it for an excluded backend — an orphaned entry (no cache
// row) is still cleaned up, exactly as the unscoped call would.
function deleteSearchFolder(folder, scope) {
  if (!scope) {
    // Same external-content FTS5 ordering: FTS delete before content delete.
    runWithBusyRetry(() => {
      stmts.searchDeleteByFolder.run(folder);
      stmts.searchDeleteContentByFolder.run(folder);
      stmts.searchMapDeleteByFolder.run(folder);
    });
    return;
  }

  // Both scope kinds resolve to the same shape: list the sessions of a SET of backends, then keep or
  // drop the search entries whose id is in that set.
  //   { only:   [a,b] } -> delete the entries OF a,b            -> id IN     (sessions of {a,b})
  //   { except: [a,b] } -> delete everything BUT a,b's entries  -> id NOT IN (sessions of {a,b})
  const ids = Array.isArray(scope.only) ? scope.only : scope.except;
  const op = Array.isArray(scope.only) ? 'IN' : 'NOT IN';
  const c = backendScopeClause({ only: ids }, 'sc.backendId');
  const sub = 'SELECT sc.sessionId FROM session_cache sc WHERE 1 = 1' + c.sql;
  const mapSel = "SELECT rowid FROM search_map WHERE type = 'session' AND folder = ?"
    + ` AND id ${op} (${sub})`;

  runWithBusyRetry(() => {
    prepScoped(`DELETE FROM search_fts WHERE rowid IN (${mapSel})`).run(folder, ...c.params);
    prepScoped(`DELETE FROM search_content WHERE rowid IN (${mapSel})`).run(folder, ...c.params);
    prepScoped(`DELETE FROM search_map WHERE rowid IN (${mapSel})`).run(folder, ...c.params);
  });
}

function deleteSearchType(type) {
  // Same external-content FTS5 ordering: FTS delete before content delete.
  runWithBusyRetry(() => {
    stmts.searchDeleteByType.run(type);
    stmts.searchDeleteContentByType.run(type);
    stmts.searchMapDeleteByType.run(type);
  });
}

function upsertSearchEntries(entries) {
  runWithBusyRetry(() => upsertSearchEntriesBatch(entries));
}

function updateSearchTitle(id, type, title) {
  // For an external-content fts5 table, updating search_content is the
  // authoritative change (snippet() reads columns from there). The fts5 index
  // is also patched: delete the old shadow row then re-insert with the new
  // title so trigram search on title reflects the rename immediately.
  try {
    runWithBusyRetry(() => {
      const mapRow = stmts.searchMapLookup.get(id, type);
      if (!mapRow) return;
      const rid = mapRow.rowid;
      const contentRow = stmts.searchContentGet.get(rid);
      if (!contentRow) return;
      // Update the content table first.
      stmts.searchUpdateTitle.run(title, id, type);
      // Patch the fts5 index: external-content delete + reinsert.
      // The 'delete' command removes the old shadow row without touching the
      // content table; the plain insert adds the updated shadow row.
      stmts.searchFtsDeleteRow.run(rid, contentRow.title, contentRow.body);
      stmts.searchFtsInsertRow.run(rid, title, contentRow.body);
    });
  } catch {}
}

function searchByType(type, query, limit = 50, titleOnly = false) {
  try {
    // Truncation + quoting + title: filter — see search-query-util.js for the
    // trigram-phrase rationale behind the length cap.
    return stmts.searchQuery.all(type, buildFtsMatch(query, titleOnly), limit);
  } catch {
    return [];
  }
}

function isSearchIndexPopulated() {
  const row = stmts.searchMapCountByType.get('session');
  return row.cnt > 0;
}

// --- Settings functions ---


module.exports = {
  getMeta, getAllMeta, setName, toggleStar, setArchived,
  toggleProjectFavorite, getFavoritedProjects, getProjectDisplayNames,
  getProjectMeta, setProjectAutoHidden, resetProjectAutoHide, getAutoHiddenProjects,
  setProjectState, getProjectStates, getProjectTombstones,
  renameProjectRefs, deleteProjectRefs,
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
  isCachePopulated, getAllCached, getCachedByFolder, getCachedByParent, getCachedByProjectPath, getBackendsByProjectPath, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
  replaceSessionMetrics,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
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
