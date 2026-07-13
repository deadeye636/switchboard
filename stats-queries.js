// stats-queries.js — the SQL behind the Stats page (#159).
//
// These live outside db.js for one reason: db.js requires Electron (userData path) and opens the real
// database, so it cannot be loaded from a unit test. The queries themselves are the part most worth
// testing — they are what the entire page believes — and here they can be run against a throwaway
// in-memory SQLite with the real schema, instead of being "verified" against a JS re-implementation of
// themselves, which is what the old db-session-metrics tests did.
//
// Every query takes an optional backendId:
//
//   `session_metrics` deliberately carries NO backendId column. `sessionId` IS `session_cache`'s primary
//   key, and that table already holds the authoritative provenance (indexed). A copy here could drift
//   from the original; a JOIN cannot.
//
//   The join is INNER on purpose: a metrics row whose session is gone is an orphan (deleting a session
//   deletes its metrics), and an orphan must not be counted into a chart of sessions that no longer
//   exist.
//
//   backendId NULL means Claude — a row indexed before backends existed carries no id, and folding it
//   into 'claude' is what stops a Claude filter from hiding a user's own history.
'use strict';

const BACKEND_JOIN = 'JOIN session_cache sc ON sc.sessionId = m.sessionId';
const BACKEND_EXPR = "COALESCE(sc.backendId, 'claude')";

/**
 * The filter is a LIST of provenance ids, not one id.
 *
 * The Stats page filters by BACKEND — "Codex", not "my Codex template". But a session launched from a
 * template records the TEMPLATE's id as its provenance (§5.7), because that is what the user chose. So
 * "Codex" has to mean "everything that ran the Codex binary": the backend, plus every template on it.
 * The caller (main.js) expands the id; the query just takes the list.
 */
function idList(backend) {
  if (!backend) return null;
  const ids = (Array.isArray(backend) ? backend : [backend]).filter(Boolean).map(String);
  return ids.length ? ids : null;
}

/** Compose a metrics query with an optional backend predicate. -> { sql, params } */
function compose(select, { backend, extra = '', groupBy = '', orderBy = '' } = {}) {
  const where = [];
  const params = [];
  const ids = idList(backend);
  if (ids) {
    where.push(`${BACKEND_EXPR} IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }
  if (extra) where.push(`(${extra})`);
  const sql = [
    select,
    'FROM session_metrics m',
    ids ? BACKEND_JOIN : '',
    where.length ? 'WHERE ' + where.join(' AND ') : '',
    groupBy ? 'GROUP BY ' + groupBy : '',
    orderBy ? 'ORDER BY ' + orderBy : '',
  ].filter(Boolean).join('\n');
  return { sql, params };
}

/** One row per day, summed across every model and hour. The heatmap + the daily bars. */
function dailyMetrics(backend) {
  return compose(
    `SELECT m.date AS date,
            SUM(m.messageCount)                 AS messageCount,
            SUM(m.toolCallCount)                AS toolCallCount,
            SUM(m.inputTokens + m.outputTokens) AS tokens,
            COUNT(DISTINCT m.sessionId)         AS sessionCount`,
    { backend, groupBy: 'm.date', orderBy: 'm.date ASC' }
  );
}

/** Tokens per (day, model). The '' model bucket is synthetic/model-less and carries no tokens anyway. */
function dailyModelTokens(backend) {
  return compose(
    'SELECT m.date AS date, m.model AS model, SUM(m.inputTokens + m.outputTokens) AS tokens',
    { backend, extra: "m.model != ''", groupBy: 'm.date, m.model' }
  );
}

/** Tokens per model, all time. */
function modelUsage(backend) {
  return compose(
    `SELECT m.model AS model,
            SUM(m.inputTokens)  AS inputTokens,
            SUM(m.outputTokens) AS outputTokens`,
    { backend, extra: "m.model != ''", groupBy: 'm.model' }
  );
}

/**
 * Tokens per (day, backend) — the stacked bars. ALWAYS joined: the backend IS the dimension here, so
 * there is no unfiltered variant of this query, only a narrower one.
 */
function dailyBackendTokens(backend) {
  const params = [];
  let where = '';
  const ids = idList(backend);
  if (ids) {
    where = `WHERE ${BACKEND_EXPR} IN (${ids.map(() => '?').join(', ')})`;
    params.push(...ids);
  }
  // GROUP BY the EXPRESSION, not the output alias. `GROUP BY backendId` looks like it groups on the
  // COALESCE above, but SQLite resolves that name to the underlying `sc.backendId` column — so a legacy
  // row with a NULL backendId formed its own group, was relabelled 'claude' on the way out, and became
  // a SECOND 'claude' row for the same day that the caller then silently overwrote. A Claude user's
  // pre-multi-LLM history simply went missing from the chart.
  return {
    sql: `SELECT m.date AS date,
                 ${BACKEND_EXPR} AS backendId,
                 SUM(m.inputTokens + m.outputTokens) AS tokens
          FROM session_metrics m
          ${BACKEND_JOIN}
          ${where}
          GROUP BY m.date, ${BACKEND_EXPR}
          ORDER BY m.date ASC`,
    params,
  };
}

/**
 * Cost per day. The two figures stay SEPARATE — an estimate is not a bill, and the chart colours them
 * differently. Rows where nobody reported money are excluded rather than summed to zero: "free" is a
 * claim, and it is not the one the data makes.
 */
function dailyCost(backend) {
  return compose(
    `SELECT m.date AS date,
            SUM(m.estimatedCostUsd) AS estimatedCostUsd,
            SUM(m.actualCostUsd)    AS actualCostUsd`,
    {
      backend,
      extra: 'm.estimatedCostUsd IS NOT NULL OR m.actualCostUsd IS NOT NULL',
      groupBy: 'm.date',
      orderBy: 'm.date ASC',
    }
  );
}

/**
 * Messages per (weekday, hour) — the activity grid. `%w` is 0..6, Sunday first.
 *
 * Buckets whose backend could not say WHEN within the day (hour = -1) are excluded. Placing them at
 * midnight would invent a working habit nobody has.
 */
function hourlyActivity(backend) {
  return compose(
    `SELECT CAST(strftime('%w', m.date) AS INTEGER) AS weekday,
            m.hour AS hour,
            SUM(m.messageCount)                 AS messageCount,
            SUM(m.inputTokens + m.outputTokens) AS tokens`,
    { backend, extra: 'm.hour >= 0', groupBy: 'weekday, m.hour' }
  );
}

/** The metrics half of the summary tiles. The session COUNT comes from session_cache — see below. */
function totals(backend) {
  return compose(
    `SELECT SUM(m.messageCount)                 AS totalMessages,
            SUM(m.toolCallCount)                AS totalToolCalls,
            SUM(m.inputTokens + m.outputTokens) AS totalTokens`,
    { backend }
  );
}

/** Parent (human) sessions only — counting subagents here would inflate every user's session count. */
function totalSessions(backend) {
  const ids = idList(backend);
  if (!ids) {
    return { sql: 'SELECT COUNT(*) AS cnt FROM session_cache WHERE parentSessionId IS NULL', params: [] };
  }
  return {
    sql: 'SELECT COUNT(*) AS cnt FROM session_cache'
       + " WHERE parentSessionId IS NULL AND COALESCE(backendId, 'claude') IN "
       + `(${ids.map(() => '?').join(', ')})`,
    params: ids,
  };
}

/**
 * Everything db.js needs to run one of these: the SQL, the values to bind, and the key to cache the
 * prepared statement under.
 *
 * It lives HERE because db.js cannot be loaded in a test (better-sqlite3 is built for Electron's ABI), so
 * anything decided in db.js is decided where nothing can check it — and that is exactly where #168 hid.
 * The SQL layer was correct and tested; the plumbing above it flattened the id LIST into the string
 * `"codex,test-1"` and bound it against a column that holds neither, so filtering by a backend that had
 * even one template on it reported zero sessions and the Stats page came back blank.
 *
 * `cacheKey` carries the id COUNT, because that is what the SQL is shaped by — one `?` per id. Keyed on
 * "filtered or not", a statement prepared for two ids would be handed three, which is a different query.
 * The old bug hid that too: with the ids flattened to one string there was never more than one `?`.
 *
 * @param {string} name              a query in this module
 * @param {string|string[]|null} backend  a backend id, the LIST it expands to (backend + its templates),
 *                                        or null / 'all' for the whole corpus
 */
function plan(name, backend) {
  const query = module.exports[name];
  if (typeof query !== 'function') throw new Error(`unknown stats query: ${name}`);

  const raw = backend && backend !== 'all' ? backend : null;
  const ids = idList(raw) || [];
  const { sql, params } = query(ids.length ? ids : null);

  return { sql, params, cacheKey: `${name}:${ids.length}` };
}

module.exports = {
  dailyMetrics, dailyModelTokens, modelUsage, dailyBackendTokens,
  dailyCost, hourlyActivity, totals, totalSessions,
  idList, plan,
};
