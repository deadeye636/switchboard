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
// A row indexed before #161 has a NULL backendId and was a Claude session (backends rule, answer 1): the one literal.
const LEGACY_SESSION_BACKEND_SQL = "'claude'";
const BACKEND_EXPR = `COALESCE(sc.backendId, ${LEGACY_SESSION_BACKEND_SQL})`;
// A subagent belongs to its PARENT's project: a few subagent rows are stored under another projectPath, and grouping or
// filtering on the row's own path would count one parent in two projects. Needs the `p` join (PARENT_JOIN).
// The row's own path is used only when there is NO parent row (a parent itself, or an orphaned subagent) — never because
// the parent's path is NULL, or that parent would count once under NULL and once under its subagent's path. The project
// filter in buildPredicate makes the same three-way choice, so a row total can always be reproduced by filtering on it.
const PARENT_JOIN = 'LEFT JOIN session_cache p ON p.sessionId = sc.parentSessionId';
const PROJECT_EXPR = 'CASE WHEN p.sessionId IS NULL THEN sc.projectPath ELSE p.projectPath END';

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
 * the `sc` join (backend) and, for `projects`, the parent's project via subselects (no join): a project is the PARENT's project.
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
    // The member sessions, driven from the project (projectPath index, then the parent index), not from the date: the
    // parents in the list, their subagents wherever those are stored, and orphaned subagents (parent row gone) on their
    // own path — the same three-way choice PROJECT_EXPR makes, so filtering on a grouped row reproduces its total.
    // A condition on a computed parent key instead made the planner scan every metrics row in range (52 -> 120-199 ms).
    // One level deep on purpose: stored subagents hang off a top-level session (none nested on a real copy, 2026-11-18).
    // A subagent of a subagent would group under the middle one's path and match no branch here.
    const list = `(${paths.map(() => '?').join(', ')})`;
    const parents = `SELECT sessionId FROM session_cache WHERE parentSessionId IS NULL AND projectPath IN ${list}`;
    where.push(`m.sessionId IN (${parents}
      UNION ALL SELECT c.sessionId FROM session_cache c WHERE c.parentSessionId IN (${parents})
      UNION ALL SELECT c.sessionId FROM session_cache c WHERE c.parentSessionId IS NOT NULL AND c.projectPath IN ${list}
        AND NOT EXISTS (SELECT 1 FROM session_cache x WHERE x.sessionId = c.parentSessionId))`);
    params.push(...paths, ...paths, ...paths);
  }
  if (!skip.has('model') && f.model) { where.push('m.model = ?'); params.push(String(f.model)); }
  return { where, params };
}

// ---- The redesigned page (#877, spec 48): one filter object, one payload ------------------------------------------
//
// These take a FILTER ({from, to, backend, projects, model}, see buildPredicate) and ALWAYS join session_cache: the
// project, backend, parent and cost-status columns all live there, and the INNER join keeps an orphan metrics row out
// of every block alike.

const FROM_JOINED = `FROM session_metrics m\n${BACKEND_JOIN}`;
// Only the queries that GROUP BY project join the parent row (it costs every query that does not need it).
const FROM_PARENT = `${FROM_JOINED}\n${PARENT_JOIN}`;
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
// The cost of a table row as the TWO parts the caller needs to say whether it is settled (spec 48): the estimate on rows
// WITHOUT an actual, and the actual. Whether an actual counts as settled is a backend's answer (`costSettled(status)`) per
// backend and status, so these rows are grouped by the PARENT's backend and costStatus beside their own key: a subagent rides
// with its parent for cost too, so one parent is never split over two groups and its session count is never added twice.
// (A subagent row of another backend or status than its parent is filed under the parent's; measured 0 of 2 656 on a real copy.)
const COST_BACKEND = `COALESCE(CASE WHEN p.sessionId IS NULL THEN sc.backendId ELSE p.backendId END, ${LEGACY_SESSION_BACKEND_SQL})`;
const COST_STATUS = 'CASE WHEN p.sessionId IS NULL THEN sc.costStatus ELSE p.costStatus END';
const COST_EST = `SUM(CASE WHEN ${COST_OK} AND m.actualCostUsd IS NULL THEN m.estimatedCostUsd END)`;
const COST_ACT = `SUM(CASE WHEN ${COST_OK} THEN m.actualCostUsd END)`;
const COST_PARTS = `${COST_BACKEND} AS costBackendId, ${COST_STATUS} AS costStatus, ${COST_EST} AS estimatedCostUsd, ${COST_ACT} AS actualCostUsd`;

/** SELECT ... FROM joined WHERE <shared predicate> [AND extra] <tail>. `lead` params bind before the WHERE ones (a ? in the column list). */
function selectFrom(columns, filter, { without, extra = [], tail = '', lead = [], parent = false } = {}) {
  const pred = buildPredicate(filter, { without });
  const where = pred.where.concat(extra);
  return {
    sql: `SELECT ${columns}\n${parent ? FROM_PARENT : FROM_JOINED}${where.length ? '\nWHERE ' + where.join(' AND ') : ''}${tail ? '\n' + tail : ''}`,
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
const SPLIT_EXPR = { none: "''", backend: BACKEND_EXPR, model: 'm.model', project: PROJECT_EXPR };

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
 * model or project and bucketed by day, week or month (bucketKindFor). The cost measure also carries the cost parts
 * (costBackendId, costStatus, estimatedCostUsd, actualCostUsd) per group, so the caller can say whether the axis is an estimate;
 * its `value` is their sum and a bucket and key may therefore repeat over groups. Raw keys: the top-8 fold, "Other" and the
 * backend/worktree fold belong to the caller. The cost measure leaves unpriced rows out, so a bucket with no figure is
 * absent rather than 0; a model split leaves the model-less bucket out.
 */
function series(filter, { measure = 'tokens', split = 'backend', bucket } = {}) {
  if (!bucket) throw new Error('series needs a bucket (bucketKindFor)');
  const extra = [];
  const cost = measure === 'cost';
  if (cost) extra.push(`(${COST_OK})`);
  if (split === 'model') extra.push("m.model != ''");
  return selectFrom(
    `${pick(BUCKET_EXPR, bucket, 'bucket')} AS bucket, ${pick(SPLIT_EXPR, split, 'split')} AS key,
       ${pick(MEASURE_EXPR, measure, 'measure')} AS value${cost ? `, ${COST_PARTS}` : ''}`,
    filter, { extra, tail: cost ? `GROUP BY 1, 2, ${COST_BACKEND}, ${COST_STATUS}` : 'GROUP BY 1, 2', parent: split === 'project' || cost });
}

/**
 * Per raw projectPath, a subagent under its parent's (worktrees are separate rows here; the caller folds them into the owner).
 * One row per project AND cost group (costBackendId, costStatus; see COST_PARTS): the caller sums the rows of a path.
 */
function projectsTable(filter) {
  return selectFrom(
    `${PROJECT_EXPR} AS projectPath, ${PARENT_COUNT} AS sessions, SUM(m.messageCount) AS messages,
       ${TOKENS} AS tokens, ${COST_PARTS}`,
    filter, { tail: `GROUP BY ${PROJECT_EXPR}, ${COST_BACKEND}, ${COST_STATUS}`, parent: true });
}

/** Per model, the model-less bucket left out. One row per model AND cost group (see COST_PARTS); the caller sums them. */
function modelsTable(filter) {
  return selectFrom(
    `m.model AS model, SUM(m.inputTokens) AS inputTokens, SUM(m.outputTokens) AS outputTokens,
       SUM(m.cacheReadTokens) AS cacheReadTokens, SUM(m.cacheCreationTokens) AS cacheCreationTokens,
       ${PARENT_COUNT} AS sessions, ${COST_PARTS}`,
    filter, { extra: ["m.model != ''"], tail: `GROUP BY m.model, ${COST_BACKEND}, ${COST_STATUS}`, parent: true });
}

/** Per stored backend id and cost status: the same figures as the key row, for the caller to fold per CLI. */
function backendsTable(filter) {
  return selectFrom(
    `${COST_BACKEND} AS backendId, ${COST_STATUS} AS costStatus, ${PARENT_COUNT} AS sessions,
       SUM(m.messageCount) AS messages, SUM(m.inputTokens) AS inputTokens, SUM(m.outputTokens) AS outputTokens,
       SUM(m.cacheReadTokens) AS cacheReadTokens, SUM(m.cacheCreationTokens) AS cacheCreationTokens,
       SUM(CASE WHEN ${COST_OK} AND m.actualCostUsd IS NULL THEN m.estimatedCostUsd END) AS estimatedCostUsd,
       SUM(CASE WHEN ${COST_OK} THEN m.actualCostUsd END) AS actualCostUsd`,
    // The PARENT's backend and status, like the other cost tables: a parent falls into exactly one group, so the
    // fold's sum over groups counts no session twice.
    filter, { tail: 'GROUP BY 1, 2', parent: true });
}

const SESSION_ORDER = { tokens: 'tokens', cost: 'cost', messages: 'messages' };

/**
 * The sessions table: one line per PARENT session (a subagent's rows add into its parent's line), top `limit` (at most 501: the export asks for its cap plus one to know whether the list was cut) by the
 * measure (tokens, cost or messages; a session with no cost figure sorts last). `lastModel` is the session's latest
 * model over all its rows and its subagents', not narrowed to the range.
 */
function sessionsTable(filter, { by = 'tokens', limit = 50 } = {}) {
  const order = pick(SESSION_ORDER, by, 'sort measure');
  const n = Math.max(1, Math.min(501, Number(limit) | 0 || 50));
  const inner = selectFrom(
    `${SESSION_KEY} AS key, SUM(m.messageCount) AS messages,
       ${TOKENS} AS tokens, MAX(m.date) AS lastDate, ${COST_VALUE} AS cost,
       ${COST_EST} AS estimatedCostUsd, ${COST_ACT} AS actualCostUsd`,
    filter, { tail: `GROUP BY 1 ORDER BY ${order} IS NULL, ${order} DESC, key LIMIT ${n}` });
  return {
    sql: `SELECT g.key AS sessionId, g.messages, g.tokens, g.cost, g.estimatedCostUsd, g.actualCostUsd, g.lastDate,
       s.aiTitle, s.projectPath, COALESCE(s.backendId, ${LEGACY_SESSION_BACKEND_SQL}) AS backendId, s.costStatus, s.created,
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

// How many generations of "a session started a session" the roll-up follows; a chain deeper than this is cut, not an error.
const ROLLUP_MAX_DEPTH = 8;
// Separates ids in the walk's path string (a unit separator: no session id holds one), for the cycle guard.
const PATH_SEP = "char(31)";

/**
 * The #809 roll-up for the Sessions table (spec 48, E16): for each given top-level session id, the figures of every session it
 * STARTED, transitively, through `session_meta.spawnedBy` (the child holds the caller's id). Rows are DESCENDANTS only, per
 * (session, cost group) so the caller folds cost exactly like the own column (`costFold`); "incl." is own + these, summed by the
 * caller, and appears in that table only.
 *
 *   - Only the given ids are walked (the table's top N), never the corpus. A recursive CTE with a depth cap
 *     (ROLLUP_MAX_DEPTH) and a path-string cycle guard (A spawns B spawns A stops at the second A).
 *   - A spawn record whose CALLER is a subagent id is lifted to that subagent's top-level parent (`edge`), so the started session
 *     counts under the parent's line (owner decision 21).
 *   - A started session is filtered by the RANGE ONLY (owner decision 20): backend, project and model do not narrow it, so "incl."
 *     is the full price of the delegated work even when it ran on another backend or in another project.
 *   - No double count: a started session's rows are taken by its top-level id and its subagents (`parentSessionId`), once; a node
 *     that is itself a subagent row contributes nothing (its rows already ride with its parent) and takes no subagents of its own
 *     (`top`), and `spawnedBy` gives a node one parent so a session is reached once per root. A root's own subagents are never walked.
 *   - Cost: the walk starts from `member` (CROSS JOIN: the metrics rows are looked up by sessionId), never a scan of the range.
 */
function sessionsRollup(filter, sessionIds) {
  const ids = [...new Set((sessionIds || []).filter(Boolean).map(String))].slice(0, 501);
  if (!ids.length) return { sql: 'SELECT 1 AS sessionId WHERE 0', params: [] };
  const pred = buildPredicate(filter, { without: ['backend', 'projects', 'model'] });
  return {
    sql: `WITH RECURSIVE roots(id) AS (VALUES ${ids.map(() => '(?)').join(', ')}),
edge(child, caller) AS MATERIALIZED (
  SELECT c.sessionId, COALESCE(pc.parentSessionId, c.spawnedBy)
  FROM session_meta c LEFT JOIN session_cache pc ON pc.sessionId = c.spawnedBy
  WHERE c.spawnedBy IS NOT NULL
),
tree(root, id, depth, path) AS (
  SELECT id, id, 0, ${PATH_SEP} || id || ${PATH_SEP} FROM roots
  UNION ALL
  SELECT t.root, e.child, t.depth + 1, t.path || e.child || ${PATH_SEP}
  FROM tree t JOIN edge e ON e.caller = t.id
  WHERE t.depth < ${ROLLUP_MAX_DEPTH} AND instr(t.path, ${PATH_SEP} || e.child || ${PATH_SEP}) = 0
),
top(root, id) AS (
  SELECT t.root, t.id FROM tree t JOIN session_cache s0 ON s0.sessionId = t.id AND s0.parentSessionId IS NULL WHERE t.depth > 0
),
member(root, sid) AS (
  SELECT root, id FROM top
  UNION ALL
  SELECT t.root, c.sessionId FROM top t JOIN session_cache c ON c.parentSessionId = t.id
)
SELECT mem.root AS sessionId, ${TOKENS} AS tokens, ${COST_PARTS}
FROM member mem
CROSS JOIN session_metrics m ON m.sessionId = mem.sid
JOIN session_cache sc ON sc.sessionId = m.sessionId
${PARENT_JOIN}${pred.where.length ? '\nWHERE ' + pred.where.join(' AND ') : ''}
GROUP BY mem.root, ${COST_BACKEND}, ${COST_STATUS}`,
    params: [...ids, ...pred.params],
  };
}

/**
 * The cheap gate before the roll-up: does any spawn record name one of these ids, or one of their subagents, as its caller? One
 * EXISTS on `spawnedBy`; when it is false the roll-up cannot return a row and is not run.
 */
function rollupGate(sessionIds) {
  const ids = [...new Set((sessionIds || []).filter(Boolean).map(String))].slice(0, 501);
  if (!ids.length) return null;
  const list = `(${ids.map(() => '?').join(', ')})`;
  return {
    sql: `SELECT EXISTS(SELECT 1 FROM session_meta WHERE spawnedBy IN ${list}
      OR spawnedBy IN (SELECT sessionId FROM session_cache WHERE parentSessionId IN ${list})) AS any`,
    params: [...ids, ...ids],
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
    sql: `WITH top AS (SELECT ${PROJECT_EXPR} AS projectPath ${FROM_PARENT}
                WHERE ${base}${PROJECT_EXPR} IS NOT NULL
                GROUP BY ${PROJECT_EXPR} ORDER BY ${TOKENS} DESC LIMIT ${Math.max(1, Number(limit) | 0 || 50)})
SELECT ${PROJECT_EXPR} AS projectPath,
       CAST((julianday(m.date) - julianday(?)) / ? AS INTEGER) AS bucket, ${TOKENS} AS tokens
${FROM_PARENT}
WHERE ${base}${PROJECT_EXPR} IN (SELECT projectPath FROM top)
GROUP BY ${PROJECT_EXPR}, bucket`,
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

module.exports = {
  idList,
  // #877: the page's queries. They take a filter object (see buildPredicate).
  buildPredicate, bucketKindFor, payloadPlan,
  keyFigures, periodCounts, series, projectsTable, modelsTable, backendsTable, sessionsTable, sessionsRollup, rollupGate, ROLLUP_MAX_DEPTH,
  rhythmDays, rhythmGrid, sidebarSeries, facetModels, facetBackends,
};
