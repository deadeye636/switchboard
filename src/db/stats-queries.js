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

/**
 * THE shared predicate (#877, spec 48 "Main-process side"): date range, backend id list, project path list, model.
 * Every query in this file builds its WHERE here, so no block can forget a dimension; a test narrows each query by
 * each field. A field that is absent, null or an empty list is NOT a filter ("no expansion" never means "no rows").
 *
 *   from, to   inclusive LOCAL day keys 'YYYY-MM-DD' (the caller owns the clock; this file never reads one)
 *   backend    the id list a backend expands to (backend + its templates), see idList
 *   projects   the project path list, ALREADY folded by the caller. The project filter means the owner project plus
 *              its worktrees, and that fold needs `setKnownWorktrees`, which is not guaranteed to be loaded when a
 *              stats query runs (T1). So SQL takes the member paths as bound parameters and decides nothing about
 *              worktrees. The fold is the caller's job (src/app/ stats module, plan step T4).
 *   model      exact match on session_metrics.model
 *
 * `without` drops fields (the facets leave out their own, the sidebar list leaves out the project). Needs
 * the `sc` join: the project and backend predicates read it.
 */
function buildPredicate(filter = {}, { without = [] } = {}) {
  const f = filter || {};
  const skip = new Set(without);
  const where = [];
  const params = [];
  if (!skip.has('range')) {
    if (f.from && f.to) { where.push('m.date BETWEEN ? AND ?'); params.push(f.from, f.to); }
    else if (f.from) { where.push('m.date >= ?'); params.push(f.from); }
    else if (f.to) { where.push('m.date <= ?'); params.push(f.to); }
  }
  const ids = skip.has('backend') ? null : idList(f.backend);
  if (ids) {
    where.push(`${BACKEND_EXPR} IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }
  const paths = skip.has('projects') ? null : idList(f.projects);
  if (paths) {
    where.push(`sc.projectPath IN (${paths.map(() => '?').join(', ')})`);
    params.push(...paths);
  }
  if (!skip.has('model') && f.model) { where.push('m.model = ?'); params.push(String(f.model)); }
  return { where, params };
}

/** Compose a metrics query with an optional backend predicate. -> { sql, params } */
function compose(select, { backend, extra = '', groupBy = '', orderBy = '' } = {}) {
  const pred = buildPredicate({ backend });
  const where = pred.where;
  const params = pred.params;
  const ids = idList(backend);
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

// ---- The redesigned page (#877, spec 48): one filter object, one payload ------------------------------------------
//
// These take a FILTER ({from, to, backend, projects, model}, see buildPredicate) and ALWAYS join session_cache: the
// project, backend, parent and cost-status columns all live there, and the INNER join keeps an orphan metrics row out
// of every block alike. The older queries above stay until the page that reads them is replaced.

const FROM_JOINED = `FROM session_metrics m\n${BACKEND_JOIN}`;
// A session is a distinct PARENT: a subagent's rows count under its parent, and a parent counts as soon as ANY of its
// rows (its own or a subagent's) matches the filter, so the tiles agree with the sessions table (spec 48).
const SESSION_KEY = 'COALESCE(sc.parentSessionId, m.sessionId)';
const PARENT_COUNT = `COUNT(DISTINCT ${SESSION_KEY})`;
// "Nobody reported money" is not zero: a row needs a figure, and a zero estimate without an actual is "no pricing".
const COST_OK = '(m.estimatedCostUsd IS NOT NULL OR m.actualCostUsd IS NOT NULL)'
  + ' AND NOT (m.estimatedCostUsd = 0 AND m.actualCostUsd IS NULL)';
// One figure per row: the settled number where there is one, else the estimate (the rule the old page applied).
const COST_VALUE = `SUM(CASE WHEN ${COST_OK} THEN COALESCE(m.actualCostUsd, m.estimatedCostUsd) END)`;
const TOKENS = 'SUM(m.inputTokens + m.outputTokens)';

/** SELECT ... FROM joined WHERE <shared predicate> [AND extra] <tail>. `lead` params bind before the WHERE ones (a ? in the column list). */
function selectFrom(columns, filter, { without, extra = [], tail = '', lead = [] } = {}) {
  const pred = buildPredicate(filter, { without });
  const where = pred.where.concat(extra);
  return {
    sql: `SELECT ${columns}\n${FROM_JOINED}${where.length ? '\nWHERE ' + where.join(' AND ') : ''}${tail ? '\n' + tail : ''}`,
    params: [...lead, ...pred.params],
  };
}

/**
 * Bucket kind for a range of `days`, so a chart never has more than about 100 bars: a day up to 90 days, a Monday-based
 * week up to about 13 months, a month beyond. The caller passes the answer to `series`.
 */
function bucketKindFor(days) {
  if (days <= 90) return 'day';
  if (days <= 400) return 'week';
  return 'month';
}
const BUCKET_EXPR = {
  day: 'm.date',
  // Monday = start of week: strftime %w is 0 (Sunday) .. 6, so (w + 6) % 7 days back is the Monday.
  week: "date(m.date, '-' || ((CAST(strftime('%w', m.date) AS INTEGER) + 6) % 7) || ' days')",
  month: 'substr(m.date, 1, 7)',
};
const MEASURE_EXPR = {
  tokens: TOKENS,
  cost: COST_VALUE,
  messages: 'SUM(m.messageCount)',
  sessions: PARENT_COUNT,
};
const SPLIT_EXPR = { none: "''", backend: BACKEND_EXPR, model: 'm.model', project: 'sc.projectPath' };

function pick(table, key, what) {
  if (!Object.prototype.hasOwnProperty.call(table, key)) throw new Error(`unknown stats ${what}: ${key}`);
  return table[key];
}

/**
 * The figures behind the key tiles, in ONE pass over [prevFrom, to]: `cur` is 1 for a row inside the range and 0 for the
 * previous period. Pass `prevFrom` null for no previous period (the "all" range): every row is then `cur` 1.
 * Grouped by backend and the session's costStatus (a `session_cache` column, one value per session) so the caller can
 * fold backends and decide what "settled" means. `estimatedCostUsd` is the estimate on rows WITHOUT an actual and
 * `actualCostUsd` the settled figures, so the two never overlap and their sum is the spend. It carries NO session or
 * day count: a parent counts under its subagents' rows too, and a subagent has its own backendId/costStatus, so a
 * parent can fall into several groups and a sum over groups would double-count it. Those counts are `periodCounts`.
 */
function keyFigures(filter, { prevFrom = null } = {}) {
  const f = { ...filter, from: prevFrom || filter.from };
  return selectFrom(
    `${BACKEND_EXPR} AS backendId, sc.costStatus AS costStatus,
       CASE WHEN m.date >= ? THEN 1 ELSE 0 END AS cur,
       SUM(m.messageCount) AS messages, SUM(m.toolCallCount) AS toolCalls,
       SUM(m.inputTokens) AS inputTokens, SUM(m.outputTokens) AS outputTokens,
       SUM(m.cacheReadTokens) AS cacheReadTokens, SUM(m.cacheCreationTokens) AS cacheCreationTokens,
       SUM(CASE WHEN ${COST_OK} AND m.actualCostUsd IS NULL THEN m.estimatedCostUsd END) AS estimatedCostUsd,
       SUM(CASE WHEN ${COST_OK} THEN m.actualCostUsd END) AS actualCostUsd`,
    f, { lead: [filter.from || ''], tail: 'GROUP BY 1, 2, 3' });
}

/**
 * The counts that cannot be summed over keyFigures' groups, per period (`cur` as in keyFigures), UNGROUPED: distinct
 * parent `sessions`, `costSessions` (parents with at least one priced row) and `activeDays` (days with a message).
 */
function periodCounts(filter, { prevFrom = null } = {}) {
  const f = { ...filter, from: prevFrom || filter.from };
  return selectFrom(
    `CASE WHEN m.date >= ? THEN 1 ELSE 0 END AS cur,
       ${PARENT_COUNT} AS sessions,
       COUNT(DISTINCT CASE WHEN ${COST_OK} THEN ${SESSION_KEY} END) AS costSessions,
       COUNT(DISTINCT CASE WHEN m.messageCount > 0 THEN m.date END) AS activeDays`,
    f, { lead: [filter.from || ''], tail: 'GROUP BY 1' });
}

/**
 * The main chart: rows `{bucket, key, value}` for one measure (tokens, cost, messages, sessions) split by none, backend,
 * model or project and bucketed by day, week or month (bucketKindFor). Raw keys: the top-8 fold, "Other" and the
 * backend/worktree fold belong to the caller. The cost measure leaves unpriced rows out, so a bucket with no figure is
 * absent rather than 0; a model split leaves the model-less bucket out.
 */
function series(filter, { measure = 'tokens', split = 'backend', bucket } = {}) {
  if (!bucket) throw new Error('series needs a bucket (bucketKindFor)');
  const extra = [];
  if (measure === 'cost') extra.push(`(${COST_OK})`);
  if (split === 'model') extra.push("m.model != ''");
  return selectFrom(
    `${pick(BUCKET_EXPR, bucket, 'bucket')} AS bucket, ${pick(SPLIT_EXPR, split, 'split')} AS key,
       ${pick(MEASURE_EXPR, measure, 'measure')} AS value`,
    filter, { extra, tail: 'GROUP BY 1, 2' });
}

/** Per raw projectPath (worktrees are separate rows here; the caller folds them into the owner). */
function projectsTable(filter) {
  return selectFrom(
    `sc.projectPath AS projectPath, ${PARENT_COUNT} AS sessions, SUM(m.messageCount) AS messages,
       ${TOKENS} AS tokens, ${COST_VALUE} AS cost`,
    filter, { tail: 'GROUP BY sc.projectPath' });
}

/** Per model, the model-less bucket left out. */
function modelsTable(filter) {
  return selectFrom(
    `m.model AS model, SUM(m.inputTokens) AS inputTokens, SUM(m.outputTokens) AS outputTokens,
       SUM(m.cacheReadTokens) AS cacheReadTokens, SUM(m.cacheCreationTokens) AS cacheCreationTokens,
       ${COST_VALUE} AS cost, ${PARENT_COUNT} AS sessions`,
    filter, { extra: ["m.model != ''"], tail: 'GROUP BY m.model' });
}

/** Per stored backend id and cost status: the same figures as the key row, for the caller to fold per CLI. */
function backendsTable(filter) {
  return selectFrom(
    `${BACKEND_EXPR} AS backendId, sc.costStatus AS costStatus, ${PARENT_COUNT} AS sessions,
       SUM(m.messageCount) AS messages, SUM(m.inputTokens) AS inputTokens, SUM(m.outputTokens) AS outputTokens,
       SUM(m.cacheReadTokens) AS cacheReadTokens, SUM(m.cacheCreationTokens) AS cacheCreationTokens,
       SUM(CASE WHEN ${COST_OK} AND m.actualCostUsd IS NULL THEN m.estimatedCostUsd END) AS estimatedCostUsd,
       SUM(CASE WHEN ${COST_OK} THEN m.actualCostUsd END) AS actualCostUsd`,
    filter, { tail: 'GROUP BY 1, 2' });
}

const SESSION_ORDER = { tokens: 'tokens', cost: 'cost', messages: 'messages' };

/**
 * The sessions table: one line per PARENT session (a subagent's rows add into its parent's line), top `limit` by the
 * measure (tokens, cost or messages; a session with no cost figure sorts last). `lastModel` is the session's latest
 * model over all its rows and its subagents', not narrowed to the range.
 */
function sessionsTable(filter, { by = 'tokens', limit = 50 } = {}) {
  const order = pick(SESSION_ORDER, by, 'sort measure');
  const n = Math.max(1, Math.min(500, Number(limit) | 0 || 50));
  const inner = selectFrom(
    `${SESSION_KEY} AS key, SUM(m.messageCount) AS messages,
       ${TOKENS} AS tokens, MAX(m.date) AS lastDate, ${COST_VALUE} AS cost`,
    filter, { tail: `GROUP BY 1 ORDER BY ${order} IS NULL, ${order} DESC, key LIMIT ${n}` });
  return {
    sql: `SELECT g.key AS sessionId, g.messages, g.tokens, g.cost, g.lastDate,
       s.aiTitle, s.projectPath, s.backendId, s.created,
       (SELECT m2.model FROM session_metrics m2
         WHERE m2.model != '' AND m2.sessionId IN
               (SELECT g.key UNION ALL SELECT c2.sessionId FROM session_cache c2 WHERE c2.parentSessionId = g.key)
         ORDER BY m2.date DESC, m2.hour DESC LIMIT 1) AS lastModel
FROM (${inner.sql}) g
LEFT JOIN session_cache s ON s.sessionId = g.key
ORDER BY g.${order} IS NULL, g.${order} DESC, g.key`,
    params: inner.params,
  };
}

/** Messages per day over the filter's window (the caller passes the 365-day window as from/to). */
function rhythmDays(filter) {
  return selectFrom('m.date AS date, SUM(m.messageCount) AS messages', filter, { tail: 'GROUP BY m.date' });
}

/** The 7 x 24 grid, Sunday = 0; buckets with no hour (-1) are left out, they would invent a habit. */
function rhythmGrid(filter) {
  return selectFrom(
    `CAST(strftime('%w', m.date) AS INTEGER) AS weekday, m.hour AS hour,
       SUM(m.messageCount) AS messages, ${TOKENS} AS tokens`,
    filter, { extra: ['m.hour >= 0'], tail: 'GROUP BY 1, 2' });
}

/**
 * The sidebar list: the top `limit` projects by tokens, each with a series of at most `points` buckets over
 * [filter.from, +`days`]. NOT narrowed by the project filter on purpose (the list is what you choose a project from);
 * every other field narrows it. Rows `{projectPath, bucket, tokens}`, bucket 0-based.
 */
function sidebarSeries(filter, { days, points = 30, limit = 50 } = {}) {
  if (!filter.from) throw new Error('sidebarSeries needs filter.from');
  if (!(Number(days) >= 1)) throw new Error('sidebarSeries needs the range length in days');
  const size = Math.max(1, Math.ceil(Number(days) / points));
  const pred = buildPredicate(filter, { without: ['projects'] });
  const base = pred.where.length ? pred.where.join(' AND ') + ' AND ' : '';
  return {
    sql: `WITH top AS (SELECT sc.projectPath AS projectPath ${FROM_JOINED}
                WHERE ${base}sc.projectPath IS NOT NULL
                GROUP BY sc.projectPath ORDER BY ${TOKENS} DESC LIMIT ${Math.max(1, Number(limit) | 0 || 50)})
SELECT sc.projectPath AS projectPath,
       CAST((julianday(m.date) - julianday(?)) / ? AS INTEGER) AS bucket, ${TOKENS} AS tokens
${FROM_JOINED}
WHERE ${base}sc.projectPath IN (SELECT projectPath FROM top)
GROUP BY sc.projectPath, bucket`,
    params: [...pred.params, filter.from, size, ...pred.params],
  };
}

/** Facets, read lazily when a dropdown opens: the choices that still have rows under the OTHER filters. */
function facetModels(filter) {
  return selectFrom('DISTINCT m.model AS model', filter, { without: ['model'], extra: ["m.model != ''"] });
}
function facetBackends(filter) {
  return selectFrom(`DISTINCT ${BACKEND_EXPR} AS backendId`, filter, { without: ['backend'] });
}

/**
 * Everything one page open runs, as named statements. `request`:
 *   filter     {from, to, backend, projects, model}
 *   prevFrom   first day of the previous period, or null (no comparison)
 *   series     {measure, split}  (the bucket is derived from the range)
 *   sessions   {by, limit}
 *   heatmap    {from, to}  the year window of the heatmap (the range does not narrow it)
 */
function payloadPlan(request) {
  const { filter, prevFrom = null } = request;
  const days = rangeDays(filter);
  return {
    keyFigures: keyFigures(filter, { prevFrom }),
    periodCounts: periodCounts(filter, { prevFrom }),
    series: series(filter, { ...request.series, bucket: bucketKindFor(days) }),
    projects: projectsTable(filter),
    models: modelsTable(filter),
    backends: backendsTable(filter),
    sessions: sessionsTable(filter, request.sessions),
    heatmap: rhythmDays({ ...filter, ...(request.heatmap || {}) }),
    grid: rhythmGrid(filter),
    sidebar: sidebarSeries(filter, { days }),
  };
}

/** Days in the resolved range [from, to], inclusive. The caller resolves "all" to the first metrics date; no guessing here. */
function rangeDays(filter) {
  const day = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  if (!filter || !day.test(filter.from || '') || !day.test(filter.to || '')) {
    throw new Error('payloadPlan needs a resolved range: filter.from and filter.to as YYYY-MM-DD');
  }
  const ms = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
  const days = Math.round((ms(filter.to) - ms(filter.from)) / 86400000) + 1;
  if (days < 1) throw new Error('payloadPlan: filter.to is before filter.from');
  return days;
}

/**
 * Everything db.js needs to run one of these: the SQL, the values to bind, and the key to cache the
 * prepared statement under.
 *
 * It lives HERE because db.js cannot be loaded in a test (it opens the app's own database when required), so
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
  // #877: the redesigned page. These take a filter object, not a backend list; `plan()` is for the ones above.
  buildPredicate, bucketKindFor, payloadPlan,
  keyFigures, periodCounts, series, projectsTable, modelsTable, backendsTable, sessionsTable,
  rhythmDays, rhythmGrid, sidebarSeries, facetModels, facetBackends,
};
