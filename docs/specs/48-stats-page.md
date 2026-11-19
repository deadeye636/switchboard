# 48 — The Stats page (one filter bar, key figures, drill-down, project scope)

Issue #877. Status: **planned** (nothing built). Requirements V1–V11 keep the issue's IDs. This file is the design
record; the working plan is local (gitignored). Decisions already made with the owner: all of V1–V11 are in scope,
V11 is a later phase; the page is rebuilt as a whole, not patched block by block; the shared multi-field filter in
SQL is the foundation every block depends on; rate limits stay unfiltered.

## What it does

The Stats tab becomes one page with one filter bar (time range, backend, project, model) that stays visible while the
page scrolls. Under it: a row of key figures with the change against the previous period, one main time series with
a measure switch and a split switch, a Rhythm block (year heatmap plus weekday-by-hour grid), and sortable breakdown
tables (projects, models, backends, sessions) whose rows set the matching filter or open the session. The left sidebar
lists the projects with a trend line while the page is open. Rate limits shrink to a compact strip that says it ignores
the filter. The tables export as CSV and JSON.

## Why the page is shaped as it is today (do not undo)

- **One filter, scoped in SQL (#159).** The backend filter lives in the first element of the page and every figure
  is scoped in `src/db/stats-queries.js`; only aggregates cross IPC. `session_metrics` has no `backendId` column on
  purpose: `sessionId` is `session_cache`'s key, the join cannot drift, and it is INNER so an orphan row is never counted.
  A NULL `backendId` means Claude.
- **A backend filter is a LIST of ids (#168).** "Codex" is the backend plus every template running on it; flattening
  the list to one string once blanked the page. `backendFilterIds` in `src/main.js` expands it, `plan()` in
  `src/db/stats-queries.js` keys the prepared statement on the id COUNT.
- **A GUI session counts under its owner CLI (#752).** The DB already files those rows under the owner; the page
  folds a template into the backend it runs on (`statsBucketOf` in `src/renderer/views/stats-view.js`).
- **Dates are LOCAL (#75).** Buckets are written by the parsers in local time (`src/backends/metrics-bucket.js`);
  every day key the page or main builds is a local `YYYY-MM-DD`, never `toISOString().slice(0, 10)`.
- **An estimate is never rendered as a bill.** A cost is settled only when the backend says so; any estimated
  contribution makes the whole sum an estimate; a token-only backend shows "—", not "$0.00".
- **Hour -1 is not midnight.** A bucket whose backend cannot say when within the day is left out of the hour grid.
  Hermes books its totals on the hour it was last active; the page says so.

## What is wrong in the issue's premise (found while reading the code)

1. "Filtering stays in SQL as it does today" is true for the charts only. The **summary tiles that matter most today are
   not SQL**: the per-backend cards (`collectBackendUsage`) and their sessions, tokens, cost and cache figures are summed
   in the renderer from `cachedAllProjects`, over the whole corpus, and ignore any time window. The "Total sessions" tile
   (`getTotalCounts`) counts every parent session ever, whatever the charts show. Both move into SQL (V2, V4).
2. The daily `sessionCount` (`dailyMetrics`) counts distinct session ids **including subagent sessions**, while the
   total counts parents only. One definition is needed (see "Sessions").
3. `refresh-stats` awaits `collectUsage()` (a network fetch) before it returns the stats, so a slow usage fetch
   delays the whole page. Not in the issue; the redesign splits the two (V8).
4. "The per-backend accumulator already collects cache tokens" is the renderer accumulator above. The SQL side already
   stores `cacheReadTokens` and `cacheCreationTokens` in `session_metrics` (migration that rebuilt the table), so
   **no migration and no parser bump is needed for V2**.
5. "A backend can have a filter pill but no breakdown card (Antigravity CLI)" was not reproduced: the card exists
   only when a cached session row exists for that bucket. It disappears with the cards (V5).

## Filter contract

One object, built by the renderer, sanitised and echoed back by main:

```
StatsFilter {
  v: 1,
  range:   { kind: '7d' | '30d' | '90d' | 'year' | 'all' | 'day' | 'custom', from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' },
  backend: <backend id> | null,        // null = all
  project: <project owner path> | null,
  model:   <model string> | null
}
```

- **Range.** Resolved in main (it owns the local clock), inclusive, today included: `7d` is today and the six days
  before it; `year` is the last 365 days, not the calendar year; `all` is from the first metrics date. `day` and
  `custom` carry both ends. The answer carries the resolved `{from, to, days}` so the page labels what ran.
- **Previous period.** The same number of days ending the day before `from`. `all` has none (the change shows
  "—"). Each key figure is computed in ONE pass over `[prevFrom, to]` with a `CASE` on the date, not two queries.
  Today is partial, so a `7d` comparison runs a little low; the label says "including today".
- **Backend.** The existing id list (backend plus its templates). The registry decides what "belongs to" a backend;
  nothing new is named in the renderer or in SQL.
- **Project.** The value is the project's **owner path**: `settingsOwnerPath(p)` (the project itself, or the top-most
  project a worktree hangs off), never a hand-built `project:<path>` key (CLAUDE.md reflex 17). A project filter means
  the project **and its worktrees**. Main resolves it like this: `session_cache.projectPath` is indexed
  (`idx_session_cache_projectPath`); main reads the DISTINCT `projectPath` values (hundreds, not thousands), maps each
  through `worktreeRootOf`/`settingsOwnerPath`, groups by the project's canonical key (`pathKey` in
  `src/app/path-containment.js`, so two spellings of one directory are one project, #563/#671), and hands SQL the
  member paths as bound parameters of an `IN` list on a `session_cache` subquery. The same fold runs the other way for
  the Projects table: SQL groups by raw `projectPath`, main folds worktrees into their owner. The worktree knowledge
  main already holds (`setKnownWorktrees`) must be loaded before this runs; the plan verifies it.
  Names shown come from `worktreeLabelOf` and the project registry's display name, not from a path split.
  A subagent belongs to its PARENT's project for every grouping and for the filter (a few stored subagent rows carry another `projectPath` than their parent); the SQL reads `COALESCE(parent.projectPath, projectPath)`.
- **Model.** Exact match on `session_metrics.model`. Two consequences the page must show: the model filter excludes
  the model-less bucket (`''`), where a parser files messages it could not attribute, so with a model filter the
  message count is that model's assistant messages and a session counts only if it has rows for that model.
- **Persistence.** The last filter is remembered across restarts under an internal key of the global settings blob
  (the way `dialog-dirs.js` remembers `lastDialogDir`: not a field of the settings screen). The write goes through
  main; the answer echoes the sanitised filter so a project that left the register, a backend turned off or a model that
  no longer has rows falls back to "all" for that field instead of showing an empty page. A `day` or `custom` range is
  stored as is. Because it is a settings-blob key, `docs/settings-reference.md` gets the entry in the same change
  (reflex 9). The Stats view lives in the main window only; no cross-window broadcast is needed.

## Main-process side

A **new** `src/app/` module (planned name: stats) owns the page's IPC (reflex 4; the table in
`.claude/rules/main-process.md` and the `WHERE_IT_GOES` string in `test/main-no-new-ipc.test.js` get a row in the
same change). Its handlers, bound in `src/preload.js`:

| Handler | Purpose |
|---|---|
| stats query | filter in; the whole page payload out (below) |
| stats set filter | persist the sanitised filter (may be folded into the query call) |
| stats export | V10 |

Rate limits keep their own existing `get-usage` handler (#191); the page calls it separately and never waits on it.
`get-stats-from-db` and `refresh-stats` are retired once the page has moved (their only caller is the Stats view);
removing handlers is not blocked by the no-new-IPC guard. `backendFilterIds` and `buildStatsFromDb` move out of
`src/main.js` into the new module.

SQL stays in `src/db/stats-queries.js` (Electron-free, testable against an in-memory SQLite with the real schema) and
`src/db/stats-store.js`. `compose()` there grows from "one optional backend predicate" to **one shared predicate
builder**: date range, backend id list, project path list, model. Every query below uses it, so no block can forget
a dimension; a test asserts that, for each query, adding each filter field narrows the result.

### One backend-neutral fold in main

SQL returns raw rows keyed by the stored `backendId` (and, for cost, the stored `costStatus`). Main folds them with the
registry, so no backend id or vocabulary enters SQL or the renderer (reflex 5):

- **Bucket** (the CLI a row is counted under): profile ids fold to the owner of their base (`rowOwnerOf`), a GUI
  driver is already filed under its owner. This replaces the renderer's `statsBucketOf`.
- **Label and colour** come from the registry projection the renderer already reads; the page names no backend.
- **Cost settled or not** is decided by a descriptor answer, not by the renderer's `SETTLED_COST_STATUS` list (that list
  holds Hermes' vocabulary in a renderer file and is moved behind the descriptor as part of this work; the default
  stays "estimated"). Built in T3 as the descriptor hook `costSettled(status) -> boolean`; only Hermes answers true for any status (Claude, Codex and agy write no `costStatus`, Pi writes `estimated`).
- **Cache accounting** (below).

### Aggregates per block

Each is one query (or one query per period flag), all over `session_metrics m JOIN session_cache sc`, all through the
shared predicate. No row-level data crosses IPC except the capped session table.

| Block | Query shape | Returns |
|---|---|---|
| Key figures (V2) | `GROUP BY backendId, costStatus` (`costStatus` is a column of `session_cache`, one value per session, not of `session_metrics`), with the period `CASE` | per period: sessions, messages, tool calls, input, output, cacheRead, cacheWrite, summed cost (estimated and actual separately), count of sessions with a cost, active days (`COUNT(DISTINCT date) WHERE messageCount > 0`) |
| Main series (V3) | `GROUP BY bucketKey, <split>` for the chosen measure and split | rows `{bucket, key, value}`; bucket is a day up to 90 days, a Monday-based week for a year, a month for all time, so a chart never exceeds about 100 bars; the split keeps the top 8 keys and folds the rest into "Other" |
| Projects table (V4) | `GROUP BY sc.projectPath` | per path: sessions, messages, tokens, cost; main folds worktrees into the owner |
| Models table | `GROUP BY m.model` (non-empty) | input, output, cacheRead, cost, sessions |
| Backends table | `GROUP BY backendId` | same figures as the key row, per bucket |
| Sessions table | `GROUP BY COALESCE(sc.parentSessionId, m.sessionId) ORDER BY <measure> LIMIT N` | N = 50; title, project, backend, dates, last model, messages, tokens, cost |
| Rhythm (V6) | `GROUP BY m.date` (year window) and `GROUP BY weekday, hour` (the range, hour >= 0) | per-day messages; the 7 x 24 grid |
| Sidebar list (V7) | the Projects aggregate plus a per-project series bucketed to at most 30 points, for the top 50 projects | total and sparkline per project. The SQL ranks the top 50 on the RAW `projectPath`, before the worktree fold: a project whose tokens are split over many worktrees can fall out of the 50 although its folded total would rank. The caller passes folded path groups, or accepts and states this limit |
| Facets | distinct models and distinct backends under the other filters | choices for the filter bar, so a choice never leads to an empty page |

Rules that every figure follows:

- **Sessions.** The count is distinct **parent** sessions that have metrics rows in range and under the filter
  (`COUNT(DISTINCT CASE WHEN sc.parentSessionId IS NULL ...)`). Subagents' tokens, messages and cost count; they never
  add a session (the existing "subagents ride with their parent" rule). The daily chart's session measure uses the same
  rule, which changes today's daily figure. A parent counts as soon as ANY of its rows, its own or a subagent's, matches
  the filter (the SQL counts `COALESCE(parentSessionId, sessionId)`), so the tiles agree with the Sessions table.
- **The session table keys on the parent**: a subagent's rows add into its parent's line.
- **Cost.** Rows where nobody reported money are excluded, never summed as zero. A zero estimate without an actual
  is "no figure" at the SQL level too (`NOT (estimatedCostUsd = 0 AND actualCostUsd IS NULL)`), the rule the renderer
  applies today and `dailyCost` does not. The tile shows `~$` when any contributing row is an estimate.
- **Tokens (the chart measure and the table column)** stay `input + output` as stored, so history reads as before.
  See O2 for the cross-backend caveat.
- **No unbounded result.** Every table has a LIMIT or a natural bound (backends, models, a project cap with an "Other"
  line), and the series is capped as above.

### Cache hit rate

Stored as `cacheReadTokens` and `cacheCreationTokens` per bucket, but the **meaning of `inputTokens` differs by
backend**: Claude and Pi store input apart from the cache counts, Codex's `input_tokens` already includes
`cached_input_tokens` (the parser takes it as a cache READ only; no creation concept). So a single formula in SQL or
in the renderer would be wrong for one of them, and the answer belongs to the backend:

- A **neutral descriptor answer** `cacheAccounting` (built in T3; the one formula is `src/backends/cache-accounting.js`, `cacheHit`) with three states: `additive` (input excludes the
  cache; rate = read / (input + read + write)), `included` (input includes the cached part; rate = read / input) and
  `none` (the backend reports no cache; Antigravity writes no metrics rows, totals 0). A backend that was not measured **declines** and
  `test/backend-parity.test.js` makes it say so, the shape used for `openedWithCommand` (renderer.md).
  Hermes stores cache read and write from its own state; it was unmeasured until plan step T1 (below).
- Main folds per backend into `{hit, base}` and sums those across backends, so the tile for "all" is a true weighted
  rate over the backends that report. A backend with state `none` or declining contributes nothing; the tile says
  "excludes <labels>".
- A rate with no base, or a backend that cannot report, is **null and renders "—"**, never 0 %. The input/output/cache
  split on the tile uses the same answer: for `included` the displayed input is input minus the cached part, so the
  three numbers do not overlap.
- The "saving against no cache" idea from the prior art is out of scope (it needs per-model prices the registry does not
  hold).

**Measured (T1, 2026-11-18, one real session or store per backend on the developer machine, read-only).** Each row
compares the raw usage fields of the source with what the parser stores in `session_metrics`; nothing is filled from
documentation. "Stored equals raw" means the parser adds nothing and subtracts nothing.

| Backend | Raw fields compared | Stored vs raw | State |
|---|---|---|---|
| Claude | `usage.input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` of a 2-turn session: input 4 against cache read 39 289 and write 11 442 (every turn has cache read above input, impossible if input held it) | equal field by field | `additive` |
| Pi | `usage.input/output/cacheRead/cacheWrite/totalTokens` of a 3-turn session: `totalTokens` equals `input + output + cacheRead + cacheWrite` on all three turns | equal field by field | `additive` |
| Codex | `total_token_usage` of the last `token_count` of a 47-event rollout: `total_tokens` equals `input_tokens + output_tokens` and `cached_input_tokens` is below `input_tokens` (a subset) | stored input equals raw `input_tokens`, stored cache read equals raw `cached_input_tokens` | `included` |
| Hermes | the store's `sessions` row (`input_tokens`, `cache_read_tokens`, `cache_write_tokens`); one session of five has cache read (76 544) above input (40 030). The installed Hermes' own `normalize_usage` subtracts the cached part from the provider's prompt total for the chat and Responses shapes and takes Anthropic's uncached input as is, and the session total adds that value | stored equals the store row | `additive` |
| Antigravity | no table or column of a conversation store is named token, cache or usage, and none of the first 200 `gen_metadata` blobs of the largest one holds such a word; the parser writes totals of 0 and no per-day metrics (`src/backends/agy/parser.js:355-365`) and the 46 agy sessions have no `session_metrics` row at all | not applicable | `none` (protobuf numeric fields are not decoded, so "reports no usage" is a finding about names, not a proof) |

Two findings the table does not hide. Codex's `total_token_usage` also carries `cache_write_input_tokens` (0 in the
measured rollout); the parser reads only `cached_input_tokens` (`src/backends/codex/parser.js:258`), so the "no
creation concept" above holds for the stored data, not for the source. And Hermes' answer is per stored field, not per
provider: its sessions come from several providers and its normaliser makes them all `additive`, so the descriptor
does not need a per-model branch.

### Cost of the queries (to measure, not assumed)

What exists: `session_metrics` has primary key `(sessionId, date, hour, model)` and `idx_session_metrics_date`;
`session_cache` has `idx_session_cache_backend` and `idx_session_cache_projectPath`. Rows in `session_metrics` grow with
sessions x active days x active hours x models, so "all time" is a full scan of the largest table, and today's
unfiltered page already runs about eight such scans on the main thread (better-sqlite3 is synchronous) on every open.

This spec does not guess the number. The first plan step runs the planned queries against a **copy of a real database
and an empty one** (`scripts/stats-query-probe.js`, which runs the way `scripts/db-probe.js` does, the db.md rule) and records time per block for `7d`, `year`, `all`, with and
without a project filter. Decision rules fixed now, so the measurement has something to be compared to:

- A date-bounded block uses `idx_session_metrics_date` and is expected cheap. If an "all time" block is too slow to
  hold the owner's feel of an instant page (O4), the options in order: one combined pass that fills several blocks
  (the key figures and the backend table share a grouping), a covering index `(date, sessionId)` or similar added by an
  **appended** migration (never edited in place; fingerprint test updated; verified with
  `scripts/db-migrate-probe.js`), a short-lived result cache keyed on `(filter, max(parser write time))`, or running the
  queries in a worker. A worker is the largest change and is chosen only if the measurement demands it.
- **Measured (T1, 2026-11-18, `scripts/stats-query-probe.js`, a copy of a real database of about 3 000 sessions and
  8 600 `session_metrics` rows over 70 active days, so `year` and `all` are the same window there).** The queries of
  one payload (key figures with the previous period, one series, projects, models, backends, sessions, both Rhythm
  grids, sidebar series; the probe prints this as its payload sum, SQL only) add up to about 45 to 60 ms for `7d` and about
  180 to 220 ms for `year` and `all` unfiltered, about 30 and 80 to 90 ms with a project filter (two runs differed by that much); the current page's seven queries take about 60 ms.
  Not in these figures: main's fold after the SQL (projects cap, series top-8 "Other", worktree fold), a worktree-wide project
  filter and a model filter. Cost grows with the rows in range,
  so the figures scale with the corpus; re-run the script against a copy of your own database for the per-block table.
- No migration is planned today. If one is added it is append-only (`migrations.length` is the version).
- Filter-bar choices (facets) are two `DISTINCT` queries under the other filters and are read lazily when a
  dropdown opens, not with every page load.

## Page layout

```
filter bar (sticky) : [7d|30d|90d|1y|All]  Backend v  Project v  Model v   [reset]        limits strip
key figures         : Sessions | Messages | Tokens (in / out / cache) | Cost | Cache hit | Active days
main chart          : measure [tokens|cost|messages|sessions]   split [none|backend|model|project]
breakdown tabs      : Projects | Models | Backends | Sessions            [Export v]
Rhythm (collapsible): year heatmap  |  weekday x hour grid
```

- **Responsive grid (V9).** The page is a CSS grid that fills the view: key figures `auto-fit` wrap, the chart spans the
  row, the tables and Rhythm take two columns when wide enough and stack when not. No fixed max width. The scroll
  container is the existing Stats body; the filter bar is `position: sticky` inside it, which also holds when the
  view is hosted in a pane (`stats` is a singleton pane kind, `.claude/rules/renderer.md`).
- **Reuse existing styling (reflex 8).** The filter controls, tabs, tables and the export menu reuse existing classes
  (the pill and button classes the old filter bar and the Backends panel use). The plan lists which before any markup
  is written; no bare `<button>` or `<select>`.
- **Empty states.** The filter bar is always drawn, even when the result is empty: a filter that vanishes with its own
  result set is a trap (the #159 principle). An empty result names the active filters and offers reset.
  As built (#877): an empty answer keeps the Rhythm block below the message (`renderStatsPage`): the fold toggle and the heatmap, which is the navigator back from an empty day and is drawn from the payload's `heatmap` (main builds it for any range, empty or not). The hour grid has no rows and draws nothing. Focus restore after an empty day lands on that day's cell, still only for the heatmap's own request. When the backend, project and model filters have no message in the whole 365-day window, there is no heatmap to navigate with: the block says "No activity in the 365 days up to the end of the range." and the way back is the filter bar's reset.
- **A failed answer (as built).** `stats-get` remembers the filter only after the payload was built, so a filter that makes the build throw is never asked again on reopen. In the renderer, a failed answer that is current (the generation check comes first) says so in the sidebar too: with a list on screen, a non-interactive line "Could not refresh. Showing the last list." (`role="status"`, class `stats-side-notice`, styled with the #431 notice rules) sits above the unchanged list; with only the placeholder, it is replaced by "The projects could not be read.". The notice lives inside `#stats-content`, so the next good `renderStatsSidebar` removes it. When no filter was ever echoed (first load failed, no filter bar), the page error offers "Reset filter" beside "Try again"; it sends an explicit empty filter, which main turns into the defaults.
- **Stale answers.** The generation counter of `loadStats` stays: a slower old answer never overwrites a newer one.
  Changing a filter field re-queries; the bar is not redrawn from the answer except for the echoed, sanitised filter.
- **Backend colours (V3).** The series colour for a backend comes from the registry (`colour` on the descriptor);
  for a model or project split, from a neutral palette. Axes and a tooltip per bar are required; the measure's unit
  is on the axis (tokens and cost are never stacked in one bar, which fixes the "Last 30 days" defect).
- **No per-model cards (V5).** The model cards and the standalone "Tokens by model", "Tokens by backend", "Cost" and
  "Last 30 days" blocks go; the Models table and the main chart replace them.

### Drill-down (V4, V6, V7)

| Click on | Does |
|---|---|
| A project row, a model row, a backend row | sets that filter field (clicking the active one clears it); the whole page re-queries |
| A session row | opens the session through the existing open path (the same one the sidebar uses); no new open logic |
| A heatmap day | sets `range` to that `day` |
| A project in the left sidebar | sets the project filter, like the Projects row |

A row that sets a filter shows it in the bar at once, so the way back is always visible. The Sessions table offers the
#809 roll-up as a second pair of columns, "own" and "incl. started sessions": the read-side roll-up through
`spawnedBy` the owner decided for #809 (E16 of its comment); it uses a recursive walk of `session_meta.spawnedBy` with a
depth cap and a cycle guard, only within the filter's range, and shows "—" where a backend reports no cost. Rolled-up
figures appear in that table only, never in a total, so nothing is counted twice.

### The left sidebar (V7)

`#stats-content` in `src/renderer/index.html` held "Click the Stats tab to view activity heatmap." and was dead
while the page was open (its placeholder now reads "Reading projects…" until the first answer). It becomes the **project list for the current filter**: project name (display name, worktrees
folded into their owner, label per `worktreeLabelOf`), a small trend line (at most 30 points) and the token total
for the current range, backend and model filter. The list is **not** narrowed by the project filter itself (it would
show one row); the active project is highlighted and a second click clears it. It comes from its own query (`sidebarSeries`), but with the
same token expression, the same parent-row join and the same owner fold as the Projects table, so the two agree per
owner for every project inside the sidebar's top 50. It is refreshed by the same query; it builds nothing when the Stats tab is
not shown (the owner's "no work nobody can see" rule). The sidebar's own morphdom and `preserveSidebarState` rules
apply (renderer.md); the plan decides whether it is a morphed list or a small replace-by-diff, with the click as the test.

As built (T6): `renderStatsSidebar` in `src/renderer/views/stats-view.js` replaces the list as a whole on each answer (at most 50
rows, in `#stats-content`, which the session list's morphdom and `preserveSidebarState` do not touch; the focused row is found
again by its path). It returns at once unless `#stats-content` is shown (`statsSidebarShown`), so a reply that lands after a tab
switch builds nothing. Rows are buttons flagged `selectable` by main (the "(no project)" line is not); the sparkline is a hand-drawn SVG polyline; a single point (a one-day range) draws nothing as a polyline, so it is a small `circle` in `currentColor`.

### Rhythm (V6)

The heatmap and the weekday-by-hour grid become one collapsible block, collapsed state remembered with the filter. The
hour grid follows the range; the heatmap is a navigator and is affected by O3. Local time, hour -1 excluded, as today.

As built (T7): `buildRhythm` in `src/renderer/views/stats-view.js` draws a header button (`aria-expanded`) and, only while open, the
heatmap and the hour grid; folded, neither DOM is built, and opening builds from the payload the page already holds, with no
query. The fold lives in the remembered filter as `rhythmCollapsed` (written only when true, sanitised in `src/app/stats.js`),
changed through the small `stats-set-rhythm` handler (`setStatsRhythm` in preload) that touches the stored filter and runs no
payload. A request already in flight was cloned over IPC with the old fold and main echoes that back, so the page keeps the fold the user set (`statsRhythmFold`), applies it onto the echo when the reply lands, says it to main once more and forgets it. Reset keeps the fold. The heatmap runs
365 days to `payload.heatmap.to` (the range end, O1 = A), its cells carry `data-date`, and one delegated click sets the range to
that day through `applyFilter({ rangeSpec })`, the same path a chart bar uses. The hour grid is the payload's `grid`, which main
already cuts to the range with hour -1 left out.

Weeks start Monday (O8, applied to both grids; the chart's week bucket already did). Heatmap: each column is Monday to Sunday,
rows top to bottom Mon..Sun, day labels Mon, Wed, Fri on rows 0, 2, 4, month labels keyed on the Monday that starts a column;
the last column ends at the range end (later cells are not drawn), cells before `heatmap.from` stay `is-outside`. Hour grid:
rows Mon..Sun, re-mapped in the renderer (row r is the payload weekday `(r + 1) % 7`); the SQL and payload are unchanged.

Keyboard (heatmap): one tab stop (roving `tabindex`, initially the range-end day, which is also the day of a single-day range).
The grid is a `role="group"` with an `aria-label`; each in-window cell is `role="button"` with an `aria-label` equal to its
title ("Nov 11, 2026: 24 messages"). Keys are handled on the grid element, never on `document`. The arrows are spatial, matching
the drawn layout (columns are weeks, rows are weekdays): Up/Down = previous/next day by date, so the last row wraps into the
neighbouring column (Down on a Sunday goes to the next Monday), Left/Right = 7 days back/on (the neighbouring column, same
weekday), PageUp/PageDown = 4 weeks back/on, Home/End = first/last day in the window. A step that would pass either end
clamps to the first or last in-window day (so Right from the last partial column lands on the last day, not on a weekday
that is not drawn), and movement never lands on an outside cell (`statsHeatmapKeyTarget`). Enter and Space apply the day exactly like a click (`statsHeatmapApplyDay`: same
`statsDaySpan` and `applyFilter` path, skipped when the range already is that day); the handler takes both keys itself. After the
redraw, focus goes back to that date's cell when it is drawn. The refocus is tied to the request the heatmap started
(`{ date, gen }` in `statsHeatmapRefocus`): only the answer to exactly that request may use it; any other request, an error and
an empty page clear it, and focus must have been on the heatmap or nowhere when the draw began (`statsHeatmapTakeRefocus`,
read before anything is replaced), so a user who moved to the filter bar keeps their place. The
focus ring is the global `[role="button"]:focus-visible` outline.

### Rate limits (V8)

They leave the page body. A compact strip at the right of the filter bar shows one chip per backend that reports a
limit, with its tightest window, and a tooltip that says plainly "Subscription limits, not affected by the filter". The
full per-window detail (what the page body drew before T7) opens from the chip. Data is the existing `get-usage`
answer; the strip is drawn when it arrives and never blocks the stats. Nothing here is filtered.

As built (T7): `drawUsageStrip` fills `.stats-limits` at the right of the sticky bar; the page body holds no limits block any more.
`loadUsage` is started, not awaited, by `loadStats`, and the strip is drawn when the answer arrives and again whenever the bar is
drawn, so either order works; a slow or failed `get-usage` leaves the stats untouched. One `backend-filter-pill` chip per backend
that has a window (`statsLimitChips`: a backend that reports no limit (`_noData`) or has no window has no chip; one that is rate limited or failed gets a warning-styled chip without a percentage, titled with its message, and its popover shows the notice text (`statsUsageNotice`)), showing the tightest
window (`statsTightestLimit`) with the level colour; label, icon and monogram come from the usage answer. A chip opens a popover
(`new-session-popover`, anchored under the strip) with the former `buildUsageSection` rendering for that backend (`buildUsageGroup`
over `getUsageLimitCards`) and its refresh. It closes on Escape and on a click outside; the document listeners exist only while it
is open. The strip's tooltip is the plain sentence above. The popover's refresh takes a `usageGen` number, so an older `loadUsage` answer cannot overwrite it. The heatmap's leading cells before `heatmap.from` (week alignment) are drawn hidden, not as zero days, and are not clickable.

## Export (V10)

A main-process handler re-runs the query from the filter it is given (it never trusts rows from the renderer), asks the
native save dialog, remembers the folder per kind like the other exports (`src/app/dialog-dirs.js`) and writes through
`src/app/safe-write.js`; the answer is `{ ok, canceled, error, name }`, never a path, and a thrown error is
translated, not passed on (the same shape as `src/app/flow-export.js`). What is exported is the **table the tab shows**
with the full row set of the filter, not the capped on-screen page: Projects, Models, Backends, Sessions (still
capped at a larger N with the cap written in the file), plus the key figures.

- **CSV:** UTF-8, one file per table, RFC 4180 quoting, a header row, dates as `YYYY-MM-DD`, numbers unformatted, a
  missing cost as an empty cell (never 0). A cell that starts with `=`, `+`, `-` or `@` gets a leading `'`: session
  titles are agent-written text and the file is opened in a spreadsheet.
- **JSON:** one document `{ schema: 'switchboard.stats/1', generatedAt, filter, range, previousRange, keyFigures,
  tables: { projects, models, backends, sessions } }`, cost fields as `{ usd, estimated }` or `null`.
- No backend id other than the neutral bucket id the registry already exposes; the file carries labels. The Projects
  and Sessions tables hold a project column, which is a local path in the user's own file; see O6.

## V11 — usage windows with burn rate (later)

Not specified in detail until the earlier phases land. Constraints now: it needs a descriptor answer that says a backend
reports a rolling limit window, and the per-window start and reset from the existing `get-usage` data; the burn rate
is tokens or cost in the window divided by elapsed time, the projection is the rate extrapolated to the reset, labelled
as a projection. A backend that reports no window shows nothing, not a zero. It is a separate block below Rhythm,
filtered by backend only (a window belongs to a subscription, not to a project). The "5-hour usage block" of the prior art
is Claude's window; this spec does not name it, a descriptor does.

## Retired and moved

Removed from the renderer: `collectBackendUsage`, `buildBackendBreakdown`, `sessionCost`, `costCellOf`,
`SETTLED_COST_STATUS`, `statsBucketOf`, `buildDailyBarChart`, `buildBackendTokensChart`, `buildCostChart`,
`buildModelTokensChart`, `buildStatsSummary` and the cards. Reused: `buildHeatmap`, `buildHourGrid` (redrawn from the
new payload), `localDateKey`, the usage rendering as the limits popover. The renderer keeps no per-session or per-backend
accumulation: it draws what the payload holds.

## Verification (what a green suite does not cover)

- SQL: tests over an in-memory SQLite with the real schema for every query and every filter field, the template fold, a
  NULL-`backendId` row, a worktree folded into its project, a subagent riding with its parent, the model-less bucket,
  and a period straddling the previous-period boundary.
- A real database copy and an empty one through `scripts/stats-query-probe.js` (db.md), with timings recorded in the plan.
- A backend-parity test for the cache-accounting answer, one entry per backend, undeclared backends decline.
- The click: `node scripts/drive-app.js console` for runtime errors, then each drill-down, the heatmap day click, the
  sidebar project click, the sticky bar while scrolling, the page in panes mode, and an export of each format opened
  in a spreadsheet. The demo instance (`npm run demo:start`) holds synthetic activity for this.

## Suggested phasing

1. Measure (queries on real copies, cache accounting per backend, Hermes) and the shared predicate with its tests.
2. The new module, the payload, filter persistence, key figures and the main chart; the old handlers and blocks go.
3. Breakdown tabs with drill-down, the session table, the left sidebar, Rhythm, the limits strip.
4. Export; then the #809 roll-up columns; V11 last.

## As built: T4a (the main-process half, #877)

`src/app/stats.js` answers the new page beside the old handlers (`stats-get`, `stats-facets`); the renderer is not swapped yet.
What is easy to miss:

- **One call, one echo.** `stats-get` sanitises the filter, remembers it under the internal key `statsFilter` only when it changed,
  resolves the range on the local clock that arrives through ctx and folds before the SQL: the project to its owner plus worktree
  paths (after `known-worktree.refresh`), the backend to the CLI, its templates and a GUI driver (`rowOwnerOf`).
- **A project value is matched lexically first.** It is capped (4096 characters), then looked up as the exact spelling the page
  knows, then refused when it is a network path no known project is on (`isForeignNetworkFile`, #780), and only then asked of
  `pathKey` (real paths). Display names are looked up by exact string and then by path key; the register's spelling names a project.
- **A stored backend id the registry no longer lists** (a deleted template) shares one bucket, "Removed backend or template": its
  base is unknowable once the template is gone. A NULL `backendId` is the legacy default everywhere, in the Sessions table too.
- **Table cost is parts, not one figure.** Projects, models and the cost series return the estimate on rows without an actual and the
  actual, grouped by the PARENT's backend and cost status (a subagent rides with its parent for cost, so a parent is never split
  over two groups). `costFold` calls the backend's `costSettled(status)` per group and a figure is settled only with an actual too;
  a fully settled row is not an estimate. The Sessions table carries the parts of its one parent row.
- **The sidebar's top 50 is ranked on the RAW `projectPath` before the worktree fold**, so a project whose tokens are split over many
  worktrees can fall out of the 50 although its folded total would rank. Accepted limit, not fixed.
- **Timing, end to end** (`scripts/stats-query-probe.js <copy> --e2e`, real db, real registry, real settings, fixed clock, copy of a
  real database of about 3 000 sessions): unfiltered all-time about 190 to 205 ms warm, `year` about 195 to 215 ms, 7 days about 55 to
  65 ms, project filter 40 to 90 ms; the module's own work (knowledge, folds) is about 1 ms. The first call after start can take about
  1 s when `known-worktree.refresh` has not run before (it reads each path's `.git` once); the sidebar build normally runs it first.
  Budget (O4): 250 ms.

## Open points (owner)

- [x] **O1.** Time range of the year heatmap. V1 says one range applies to every block; a heatmap of 7 days is useless as a
  navigator. Option A: the heatmap always shows the 365 days ending at the range end, filtered by backend, project and
  model but not by range, and a click sets the range (recommended). Option B: it follows the range like the rest.
  **Decided (owner, 2026-11-13): Option A.**
- [x] **O2.** What "tokens" means across backends. Stored `input + output` includes the cached part for Codex and excludes
  it for Claude and Pi, so a token total over "all" mixes two meanings. Option A: keep the stored sum so history reads
  as before and show the split on the tile with the normalised input (recommended for this change). Option B: define
  tokens as uncached input + output + cache everywhere through the descriptor answer, which changes every existing number.
  **Decided (owner, 2026-11-13): Option A.**
- [x] **O3.** Default filter on first start (no remembered value): 30 days, all backends, all projects (proposal; today the
  page is a year and all-time mix). **Decided (owner, 2026-11-13): as proposed.**
- [x] **O4.** The page's responsiveness budget on the owner's real corpus (for example "an unfiltered all-time open under
  X ms"). The measurement step reports the figures; the owner picks the limit that decides between the options in
  "Cost of the queries". **Decided (owner, 2026-11-18): 250 ms** for an unfiltered all-time payload on the owner's corpus. T1 measured 180 to 220 ms, so no index, cache or worker is built now. T2 measures again with the production queries; if the budget is broken, a result cache comes first.
- [x] **O5.** Whether a chart bar click should also set the range to that bucket. Not in the issue; cheap once the
  range object exists. **Decided (owner, 2026-11-18): yes**, a bar click sets the range to that bucket.
- [x] **O6.** Whether the export's project column carries the full local path or only the display name. A path makes the file
  unambiguous and machine-specific; a name is shareable. **Decided (owner, 2026-11-13): the display name only**, so an
  exported file carries no local path.
- [x] **O7.** Does the project filter match the owner project plus its worktrees (this spec's assumption), or can a
  single worktree be filtered on its own? The latter needs a second control; the former matches how settings and the
  sidebar already treat a worktree. **Decided (owner, 2026-11-13): owner project plus its worktrees.**
- [x] **O8.** The week boundary for the year view (Monday, as proposed, or the user's locale) and whether the year view's
  last bucket is shown partial. **Decided (owner, 2026-11-13): weeks start on Monday.** The partial last bucket is left
  to the plan. Applied to the chart's week bucket, the heatmap and the hour grid (see Rhythm V6).
- [x] **O9.** Charting: hand-drawn SVG or a library. The renderer has no chart library today (vanilla JS, no framework; third
  party code enters only through `scripts/bundle.js`); the existing charts are hand-built DOM and SVG in
  `src/renderer/views/stats-view.js`. The new needs are one time series (stacked bars with a split, a y-axis, a unit, a
  tooltip per bar), small sparklines (V7) and the existing heatmap and hour grid.
  - **Option A (recommended): hand-drawn SVG in one small shared renderer module** (`src/renderer/` stats chart helper).
    The shapes are bars, axes and polylines, at most about 100 bars; no new dependency, no bundle size or licence
    cost, colours and theme variables apply directly, nothing to keep in step with a library's release cadence.
    Cost: the axis ticks, the "nice" scale and the tooltip are ours to write and test (one pure scale function with
    unit tests, a drawing function, one tooltip).
  - **Option B: a library** (for example uPlot or Chart.js through `scripts/bundle.js`). Gains zoom, legends and
    resize for free. Costs: a bundled dependency (size, supply-chain review, the renderer's no-framework rule), canvas
    output that does not take CSS variables, and a second look for the existing heatmap and sparklines, which a
    library would not draw anyway.
  - Effort is a side point: A is more work now and less to carry later.
  **Decided (owner, 2026-11-18): Option A**, hand-drawn SVG in one shared renderer module with a unit-tested scale.
- [x] **O10.** Whether Stats views open in several windows or panes share one filter. The filter is one remembered
  value, so every open view reads the same one. **Decided (owner, 2026-11-18): one shared filter**; revisited only if
  the click test shows two views getting in each other's way.
- [x] **O11.** What a click on a Sessions row does: open the session the way the sidebar does, which resumes its CLI, or
  open it read-only. **Decided (owner, 2026-11-18): the sidebar's way.** One known behaviour for the same click; the
  session opens in the folder it ran in (`openPath`), and in panes mode the Stats tab stays beside it.
