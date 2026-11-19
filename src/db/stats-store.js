// The stats aggregates — everything the Stats screen reads, and nothing else (#217 step 4).
//
// This block came out of db.js first because it was already the least entangled: it never touched the
// shared prepared-statement object, only `db` and `stats-queries.js`.
//
// The SQL itself stays in stats-queries.js on purpose — that module is Electron-free, so its decisions can
// be tested. Everything here is the plumbing: prepare, memoize, reshape. Nothing about a filter is decided
// in this file, because this file cannot be loaded by a test, and a decision made where nothing can check
// it is exactly where #168 hid.
'use strict';

const { db } = require('./connection');

const statsQueries = require('./stats-queries');

// --- The redesigned page (#877): one payload call per filter change, facets lazily ---
//
// What to run and what to bind is decided by `statsQueries.payloadPlan` (testable). The project list in a filter arrives
// ALREADY folded to the owner project plus its worktrees by the caller: nothing here consults the worktree knowledge,
// which is not guaranteed to be loaded when a stats query runs.
//
// The statement cache is keyed on the SQL text (its shape changes with the number of ids and paths). The project list can
// be long, so the map is cleared when it grows large rather than kept for every list ever seen.
const _payloadStmts = new Map();
function runSpec(spec) {
  let stmt = _payloadStmts.get(spec.sql);
  if (!stmt) {
    if (_payloadStmts.size >= 200) _payloadStmts.clear();
    stmt = db.prepare(spec.sql);
    _payloadStmts.set(spec.sql, stmt);
  }
  return stmt.all(...spec.params);
}

// {keyFigures, periodCounts, series, projects, models, backends, sessions, heatmap, grid, sidebar}: raw rows per block.
function getStatsPayload(request) {
  const out = {};
  for (const [name, spec] of Object.entries(statsQueries.payloadPlan(request))) out[name] = runSpec(spec);
  // The #809 roll-up for the table's lines only; it needs their ids, so it runs after them (not part of the plan).
  // Skipped when no spawn record names one of those sessions (or their subagents) as its caller: then it cannot return a row.
  const ids = out.sessions.map(r => r.sessionId);
  const gate = statsQueries.rollupGate(ids);
  out.rollup = gate && runSpec(gate)[0].any ? runSpec(statsQueries.sessionsRollup(request.filter, ids)) : [];
  return out;
}

// {models: [model], backends: [backendId]} still having rows under the other filters.
function getStatsFacets(filter) {
  return {
    models: runSpec(statsQueries.facetModels(filter)).map(r => r.model),
    backends: runSpec(statsQueries.facetBackends(filter)).map(r => r.backendId),
  };
}

// This machine's figures since a usage window started (#883): see statsQueries.usageWindowFigures.
function getUsageWindowFigures(backend, fromDate, fromHour, toDate, toHour) {
  return runSpec(statsQueries.usageWindowFigures(backend, fromDate, fromHour, toDate, toHour));
}

// The first day with metrics ('YYYY-MM-DD'), or null on an empty database: where the "all" range starts.
let _firstDateStmt = null;
function getStatsFirstDate() {
  if (!_firstDateStmt) _firstDateStmt = db.prepare('SELECT MIN(date) AS date FROM session_metrics');
  const row = _firstDateStmt.get();
  return row && row.date ? row.date : null;
}

// Every distinct project path the cache holds (idx_session_cache_projectPath, no scan): what the caller folds into
// owner projects for the project choices and the project filter's worktree members.
let _projectPathsStmt = null;
function getStatsProjectPaths() {
  if (!_projectPathsStmt) {
    _projectPathsStmt = db.prepare('SELECT DISTINCT projectPath FROM session_cache WHERE projectPath IS NOT NULL');
  }
  return _projectPathsStmt.all().map(r => r.projectPath);
}

module.exports = {
  getStatsFirstDate,
  getStatsProjectPaths,
  getStatsPayload,
  getStatsFacets,
  getUsageWindowFigures,
};
