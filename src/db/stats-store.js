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

// Returns [{date: 'YYYY-MM-DD', messageCount, sessionCount}, ...] sorted ASC.
// Aggregates ALL rows in session_cache (parent sessions + subagents) so the
// heatmap reflects real usage regardless of whether Claude rotated the parent
// JSONL files.
function getDailyActivity() {
  return db.prepare(`
    SELECT
      substr(modified, 1, 10) AS date,
      SUM(messageCount)       AS messageCount,
      COUNT(*)                AS sessionCount
    FROM session_cache
    WHERE modified IS NOT NULL
      AND length(modified) >= 10
    GROUP BY date
    ORDER BY date ASC
  `).all();
}

// --- Session metrics aggregates (for the stats screen) ---
//
// The SQL itself lives in stats-queries.js — Electron-free, so it can be run against a real SQLite in a
// unit test instead of being checked against a JS re-implementation of itself. Everything here is the
// plumbing: prepare, memoize, reshape.
//
// Every aggregate takes an optional backend filter ('all' / falsy = the whole corpus).
//
// THE FILTER IS A LIST, not one id (#168). "Codex" means "everything that ran the Codex binary": the
// backend itself, plus every template on it — a session launched from a template records the TEMPLATE's
// id as its provenance (§5.7), because that is what the user chose. main.js expands the id
// (`backendFilterIds`) and stats-queries.js emits one `?` per id. This function used to flatten the whole
// thing back with `String(backendId)`, binding the literal `"codex,test-1"` against a column that holds
// neither — so the moment ONE template ran on a backend, filtering by that backend reported zero
// sessions and the Stats page came back blank. Claude only escaped it because no template ran on Claude.
const statsQueries = require('./stats-queries');

// Statements are memoized on first use (the stats screen may never be opened) instead of being re-parsed
// on every call. What to run, what to bind and what to cache it under is decided by `statsQueries.plan()`
// — a pure function, in a module a test can load. Nothing about the filter is decided here any more: this
// file cannot be loaded in a test, and a decision made where nothing can check it is where #168 hid.
const _statsStmts = new Map();
function runStats(name, backendId) {
  const { sql, params, cacheKey } = statsQueries.plan(name, backendId);
  let stmt = _statsStmts.get(cacheKey);
  if (!stmt) {
    stmt = db.prepare(sql);
    _statsStmts.set(cacheKey, stmt);
  }
  return stmt.all(...params);
}

// One row per day, summed across all models and hours. Powers the heatmap + daily bars.
function getDailyMetrics(backendId) {
  return runStats('dailyMetrics', backendId);
}

// [{date, tokensByModel: {model: tokens}}] sorted by date.
function getDailyModelTokens(backendId) {
  const byDate = new Map();
  for (const r of runStats('dailyModelTokens', backendId)) {
    let entry = byDate.get(r.date);
    if (!entry) {
      entry = { date: r.date, tokensByModel: {} };
      byDate.set(r.date, entry);
    }
    entry.tokensByModel[r.model] = r.tokens;
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// {model: {inputTokens, outputTokens}} across all time.
function getModelUsage(backendId) {
  const out = {};
  for (const r of runStats('modelUsage', backendId)) {
    out[r.model] = { inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  }
  return out;
}

// [{date, tokensByBackend: {backendId: tokens}}] sorted by date — the stacked daily bars.
function getDailyBackendTokens(backendId) {
  const byDate = new Map();
  for (const r of runStats('dailyBackendTokens', backendId)) {
    let entry = byDate.get(r.date);
    if (!entry) {
      entry = { date: r.date, tokensByBackend: {} };
      byDate.set(r.date, entry);
    }
    entry.tokensByBackend[r.backendId] = r.tokens;
  }
  return Array.from(byDate.values());
}

// [{date, estimatedCostUsd, actualCostUsd}] — cost over time. The two figures stay separate: an
// estimate is not a bill.
function getDailyCost(backendId) {
  return runStats('dailyCost', backendId);
}

// [{weekday 0-6 (Sun..Sat), hour 0-23, messageCount, tokens}] — the activity grid.
function getHourlyActivity(backendId) {
  return runStats('hourlyActivity', backendId);
}

// {totalSessions, totalMessages, totalToolCalls, totalTokens}.
function getTotalCounts(backendId) {
  const metrics = runStats('totals', backendId)[0] || {};
  const sessions = runStats('totalSessions', backendId)[0] || {};
  return {
    totalSessions: sessions.cnt || 0,
    totalMessages: metrics.totalMessages || 0,
    totalToolCalls: metrics.totalToolCalls || 0,
    totalTokens: metrics.totalTokens || 0,
  };
}

module.exports = {
  getDailyActivity,
  getDailyMetrics,
  getDailyModelTokens,
  getModelUsage,
  getDailyBackendTokens,
  getDailyCost,
  getHourlyActivity,
  getTotalCounts,
};
