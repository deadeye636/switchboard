// The session cache — the indexed copy of every session, and the folder bookkeeping behind it
// (#217 step 10).
//
// This is the DERIVED half of the database: what the scanner read out of the transcripts, as opposed to
// what the user decided (meta-store.js). session_cache is one row per session, session_metrics is the
// per-(session,date,model) breakdown the Stats screen sums, and cache_meta records what each folder
// looked like the last time it was indexed.
//
// SINGLE WRITER (#199): one parser (the worker), one writer (main). The worker parses off-thread and
// posts rows back; every write below runs on the main thread. That is why there is no SQLITE_BUSY to
// handle here, and why nothing in this module may be called from a worker.
//
// BACKEND SCOPING IS NOT COSMETIC. A project bucket is keyed on cwd, so it is SHARED between backends:
// an unscoped folder delete takes another backend's rows with it. backendScopeClause builds the filter and
// prepScoped memoizes the resulting statement — the shape depends on the scope, so it cannot be a single
// prepared statement. test/scoped-folder-deletes.test.js guards the callers.
'use strict';

const { db } = require('./connection');
const { runWithBusyRetry } = require('./sqlite-busy-retry');

const stmts = {
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
};

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

module.exports = {
  isCachePopulated, getAllCached, getCachedByFolder, getCachedByParent, getCachedByProjectPath,
  getBackendsByProjectPath, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
  replaceSessionMetrics,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
};
