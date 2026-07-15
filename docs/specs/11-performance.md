# 11 — Performance: keeping the main thread responsive

**Status:** steps 1–4 + the step-5 pure-loop layer (5.1) as-built; the off-thread worker (5.2/5.3) in
progress. Issues [#199] (umbrella), [#200] (precondition).

## The problem

Intermittent short UI freezes during use — xterm input and the sidebar briefly stop responding. They
correlate with **high-output sessions** (a session whose transcript grows fast): live indexing ran
**synchronous SQLite + FTS writes on the main-process event loop**, and a per-`get-projects` reconcile
re-read changed files fully on the same thread.

Live `[perf]` logs pinned the dominant in-use stall to the **`get-projects` synchronous tail**:

```
[perf] get-projects 4964ms: reconcile=4916 backends=33 syncRegistry=5 autoHide=0 build=10
```

`reconcileCacheFromFilesystem` (throttled 5 s, run on every `get-projects`) tripped its per-folder
change-gate near-always while a session appended, entered `refreshFolder`, and there **full-read** every
changed file via `claude.readSessionFile` **and deleted the incremental memo** — so the pending debounced
`refreshFile` then re-read the same file fully too. Two readers fighting, cost growing with the session.

## Root cause, precisely

- **Double full read.** `refreshFile` (the watcher path) reads incrementally (`readSessionFileIncremental`
  + the `_fileReadState` memo, perf #74). The reconcile sweep did not — it full-read and wiped the memo.
- **Repair on the paint path.** `reconcile` + the Axis-B backend sweep + `syncRegistry` + `applyAutoHide`
  all ran inline inside the `get-projects` IPC handler, so the sidebar could not paint until the repair
  finished.
- **Precondition bug ([#200]).** `mergeDailyMetrics` keyed its cumulative bucket map on `(date, model)`
  without the hour, while `extractDailyMetrics` buckets per `(date, hour, model)` (the #159 hourly grid).
  On the incremental path this collapsed every hour of a day into the first-seen one — masked only because
  the reconcile's full reads re-wrote the rows every ~5 s. Removing those full reads (step 2) would make
  the corruption permanent, so #200 is a **hard precondition**.

## The plan (ranked)

| # | Step | Buys |
|---|------|------|
| 1 | **[#200]** — `mergeDailyMetrics` keys on `(date, hour, model)` + sums both cost columns; incremental-path test | Correct hourly stats; precondition for step 2 |
| 2 | Unify `refreshFolder` onto the incremental reader (shared `_fileReadState`, full read only on first-touch / rewrite / parser bump; `cancelReindex` for swept files); fix `getFolderIndexMtimeMs` subagent-dir blindness; `[perf]` counters inside reconcile | Kills the recurring stall + the double read |
| 3 | Take reconcile + backend sweep **off** the `get-projects` response path — handler becomes a pure cache read; repair runs on its own cadence and announces via the `projects-changed` push | Sidebar paint never waits on repair |
| 4 | Extract modules (`store-indexer.js`, generic Axis-B scan, a single `applyIndexResults` write sink, `projects-view.js`); `session-cache.js` stays a façade | The long-term structure; contains step 5 |
| 5 | Persistent index worker: fs walk + stat + parse off the main thread; **DB writes stay on main** (post-rows pattern, like the cold-scan worker) | Removes all parse stalls incl. first-touch |

**Rejected as over-engineering:** throttling FTS for live sessions (a crutch — hides the stall, does not
remove it); opening the DB inside a worker (single-writer WAL contention — the post-rows pattern needs no
second connection); persisting `_fileReadState` across restarts; one grand abstraction over all backends;
swapping `fs.watch` for chokidar.

## As-built (steps 1–3)

- **[#200]** — `mergeDailyMetrics` (`backends/claude/session-reader.js`) keys on `bucketKey(date, hour,
  model)` and sums the six counts plus both cost columns via `addCost` (null + null stays null — an absence
  is not a free day). Test: `readSessionFileIncremental` across an hour boundary in two chunks equals one
  full `readSessionFile`, bucket-for-bucket.
- **Step 2** — `refreshFolder` (`session-cache.js`) reads incrementally via the shared `_fileReadState`
  memo (`rememberFileReadState`), never deletes it, and `cancelReindex`es files it read so the pending
  `refreshFile` does not redo them. `getFolderIndexMtimeMs` (`folder-index-state.js`) now folds nested
  subagent `.jsonl` mtimes, so a subagent-only append trips the gate. This is the #194 incremental-scan
  parity fix finally applied to Claude's own store walk — the last one still full-reading changed files.
- **Step 3** — the `get-projects` handler (`main.js`) is a pure `buildProjectsFromCache` + `return`; the
  repair work moved into `queueIndexSweep()`, a coalesced `setImmediate` that runs after the response and
  pushes `projects-changed` when it moves the cache (the cold-start `needsPopulate → await` path is kept).

**Measured:** `get-projects` dropped from 2–5 s stalls to ~50 ms (pure cache read); `refreshFile` stays
incremental (`[perf] refreshFile … read=64 upsert=2 fts=10`).

- **Step 4 (done — extraction + neutral write sink).** `session-cache.js` (1381 lines) split into a 74-line
  **façade** re-exporting the same names, over four modules: `backends/claude/store-indexer.js` (Claude's
  folder-shaped walk + `_fileReadState` + the Claude `prepare` = `stampClaudeProvenance`), `backend-scan.js`
  (generic Axis-B walk + `_axisBReadState`), `projects-view.js` (buildProjectsFromCache/Admin), and
  `index-writes.js` — the **backend-neutral** write sink `applyIndexResults({sessions, wipeFolders, deleteIds,
  metricsMode})`. Every write path (cold-scan, refreshFolder, refreshFile, refreshBackendSessions) now runs a
  per-backend `prepare()` then the one sink; the sink carries no backend id and scopes every delete through the
  row's own `backendId`. `metricsMode` keeps the #154 split (Claude `always`, Axis-B `if-nonempty`).
  Behaviour-identical (verified: `npm test` green, exports unchanged, no require cycle, dev-app scan identical).
  This is preparation — no perf change — that makes step 5 a lift: the worker parses off-thread and posts raw
  sessions; main runs `prepare()` + the sink. The one harmonized deviation: the cold-scan search entry is now
  built before `setName` like the other three paths (the DB `name` column is unconditionally the customTitle
  either way; only the FTS title can be one pass stale in the rare rename+customTitle coexist case, self-healing).
- **Step 5.1 (done — pure parse-loops, on-thread).** The Claude walk (`parseClaudeFolder`) and the generic
  Axis-B walk (`parseBackendSessions`) are now PURE snapshot-in / reply-out functions: they compute and return
  everything main must persist and persist none of it. Their return **is** the reply shape the step-5 worker
  will post — every side-effect the worker cannot do is a reply field main replays (`storeProjects` →
  `noteStoreProject` #167, `vanishedFolders` → scoped delete, `reReadFiles` → `cancelReindex`, `folderStamps`
  → `setFolderMeta`, `skippedIds` → `markPersisted` #155, `incomplete`/store-not-found guards). The delete-diff
  is snapshot-scoped (`cachedIds − seenIds`, never live-cache) so it cannot reverse-resurrect a row once
  off-thread. Behaviour-identical (no perf change — preparation), so 5.2 lifts the loops into the worker as-is.
  **5.2a** then moved the loops + their `_fileReadState`/`_axisBReadState` memos into **Electron-free leaf
  modules** (`backends/claude/folder-parse.js`, `backend-parse.js`) that both main and the worker can require
  (the `folder-reader` precedent from #188 — the worker must not drag `index-writes`/the registry), added the
  missing single-file watcher pure fn (`parseClaudeFile`), and returned the Claude stat counters in the reply
  (a by-reference `stats` object can't cross the thread). Still on-thread + behaviour-identical.

### Known gaps / follow-ups

- The reconcile still executes **on the main thread**, just after the paint rather than blocking it —
  moving the parse off-thread is **step 5**.
- **The folder change-gate itself is now a recursive stat walk.** `getFolderIndexMtimeMs` recurses into
  subagent dirs (step 2, so a subagent-only append trips the gate), and it runs **unconditionally for every
  folder on every reconcile tick** — including folders that changed nothing. On a large, subagent-heavy
  store this reintroduces exactly the "many transcripts" main-thread I/O #199 is fighting, at the gate
  level. It is now **measured** (`gate=<ms>` in the `[perf] reconcile` line, logged even on an idle store
  when the gate walk is slow), not eliminated — **step 5** (the off-thread index worker) removes it, since
  the walk moves into the worker. Watch `gate=` on a busy install; if it grows, a cheaper gate (cap /
  skip-list folders whose top-level mtime is already old) is the interim mitigation.
- The sweep cadence is a coalesced `setImmediate` fired **after each `get-projects`**, not a wall-clock
  interval: while active changes are covered by the live watcher, the safety-net reconcile does not fire on
  its own if the sidebar is never re-fetched. A background interval is a one-line alternative if that gap
  matters.
- Steps 4 (module extraction) and 5 (index worker) are not done.

## Observability — the central perf surface

There is no separate perf file. `perf.js` (`startTimer` / `timed` / `timedAsync`) times a labelled span
and the call sites log a `[perf] <label> <ms>ms: …` line at **debug** only. The log level is a live global
setting (Sessions & CLI → Log level), so a running session can be profiled without a dev build. Query the
electron-log stream (`%APPDATA%/switchboard/logs/main.log`) for `[perf]`. Instrumented today: `refreshFile`
(read / upsert / metrics / FTS) and the reconcile (`folders` / `full` / `incr` / `bytes`) — `full=0` in
steady state is the signal that step 2 is holding. Use it to verify each further step before/after in a
live high-output session; do not scatter raw `Date.now()` deltas.
