# 11 — Performance: keeping the main thread responsive

**Status:** steps 1–5 as-built — the persistent off-thread index worker is now the ONLY scan path, for
Claude AND for every Axis-B backend (the env flag and the inline parse were removed after a live-install
validation; the Axis-B store watcher followed in [#208]). Issues [#199] (umbrella), [#200] (precondition),
[#208] (Axis-B watcher off-thread).

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
| 4 | Extract modules (`store-indexer.js`, generic Axis-B scan, a single `applyIndexResults` write sink, `src/index/projects-view.js`); `src/index/session-cache.js` stays a façade | The long-term structure; contains step 5 |
| 5 | Persistent index worker: fs walk + stat + parse off the main thread; **DB writes stay on main** (post-rows pattern, like the cold-scan worker) | Removes all parse stalls incl. first-touch |

**Rejected as over-engineering:** throttling FTS for live sessions (a crutch — hides the stall, does not
remove it); opening the DB inside a worker (single-writer WAL contention — the post-rows pattern needs no
second connection); persisting `_fileReadState` across restarts; one grand abstraction over all backends;
swapping `fs.watch` for chokidar.

## As-built (steps 1–3)

- **[#200]** — `mergeDailyMetrics` (`src/backends/claude/session-reader.js`) keys on `bucketKey(date, hour,
  model)` and sums the six counts plus both cost columns via `addCost` (null + null stays null — an absence
  is not a free day). Test: `readSessionFileIncremental` across an hour boundary in two chunks equals one
  full `readSessionFile`, bucket-for-bucket.
- **Step 2** — `refreshFolder` (`src/index/session-cache.js`) reads incrementally via the shared `_fileReadState`
  memo (`rememberFileReadState`), never deletes it, and `cancelReindex`es files it read so the pending
  `refreshFile` does not redo them. `getFolderIndexMtimeMs` (`src/index/folder-index-state.js`) now folds nested
  subagent `.jsonl` mtimes, so a subagent-only append trips the gate. This is the #194 incremental-scan
  parity fix finally applied to Claude's own store walk — the last one still full-reading changed files.
- **Step 3** — the `get-projects` handler (`src/main.js`) is a pure `buildProjectsFromCache` + `return`; the
  repair work moved into `queueIndexSweep()`, a coalesced `setImmediate` that runs after the response and
  pushes `projects-changed` when it moves the cache (the cold-start `needsPopulate → await` path is kept).

**Measured:** `get-projects` dropped from 2–5 s stalls to ~50 ms (pure cache read); `refreshFile` stays
incremental (`[perf] refreshFile … read=64 upsert=2 fts=10`).

- **Step 4 (done — extraction + neutral write sink).** `src/index/session-cache.js` (1381 lines) split into a 74-line
  **façade** re-exporting the same names, over four modules: `src/backends/claude/store-indexer.js` (Claude's
  folder-shaped walk + `_fileReadState` + the Claude `prepare` = `stampClaudeProvenance`), `src/backends/scan.js`
  (generic Axis-B walk + `_axisBReadState`), `src/index/projects-view.js` (buildProjectsFromCache/Admin), and
  `src/index/index-writes.js` — the **backend-neutral** write sink `applyIndexResults({sessions, wipeFolders, deleteIds,
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
  modules** (`src/backends/claude/folder-parse.js`, `src/backends/parse.js`) that both main and the worker can require
  (the `folder-reader` precedent from #188 — the worker must not drag `index-writes`/the registry), added the
  missing single-file watcher pure fn (`parseClaudeFile`), and returned the Claude stat counters in the reply
  (a by-reference `stats` object can't cross the thread). Still on-thread + behaviour-identical.
- **Step 5.2/5.3 + cleanup (done — the worker IS the scan path).** `src/workers/index-worker.js` (persistent)
  owns the fs walk, `stat`, parse (via the leaves), both incremental memos, and the `getFolderIndexMtimeMs`
  gate walk; it resolves backends by id from a posted **roster** (never `backends.list()` — settings aren't
  injected in a worker), derives `projectPath` itself (fs-only), and posts the per-backend reply the pure
  loops already return. `src/index/index-worker-client.js` (main) builds the request snapshot (DB reads), replays each
  reply through the one neutral sink, and holds the guards: an `appQuitting` check before any apply (no write
  to a closed DB), a **delete-epoch** guard on both the reconcile and file lanes (a reply can't
  reverse-resurrect a row deleted since its request), `postReconcile` coalescing (a get-projects burst → one
  in-flight + one trailing sweep), a re-check of `isRemovedProject` fresh at apply, and a debounced file-lane
  `projects-changed` push. **DB writes stay on main** (single writer, no `SQLITE_BUSY`); crash → respawn with
  an empty memo (self-healing, full == incremental per #194/#200); quit → terminate-then-close.
  - **Measured, live install:** the `gate=214 ms`/tick stat walk left the main thread entirely — main now
    only posts (`[index-worker] post reconcile … clone~33f/741rows postMs=0`), the compact staleness snapshot
    clones in **~0–1 ms** (fable's "measure the clone" corrective: it is not relocated, it is gone), and
    `get-projects` stays ~50–64 ms. Verified on-screen: session counts identical, xterm input responsive.
    `await window.api.indexWorkerStatus()` → `{alive, pending}` confirms the worker is live.
  - **Cleanup:** once validated, the `SWITCHBOARD_INDEX_WORKER` flag and the runtime-dead inline parse
    (`reconcileCacheFromFilesystem`, `refreshFile`, `refreshAllBackendSessions`, the inline `queueIndexSweep`
    body) were removed — one path, no toggle; git history (`6605aef`, pre-worker) is the fallback.

### Known gaps / follow-ups

- **RESOLVED by step 5** — the reconcile + parse + the recursive `getFolderIndexMtimeMs` gate walk
  (`gate=214 ms`/tick) no longer run on the main thread; they run in the persistent index worker. The
  `[perf] reconcile … gate=` line is gone from main (main logs `[index-worker] post … postMs~0` instead).
- **RESOLVED by [#208]** — the Axis-B store watcher no longer parses on main. `startBackendWatchers`'
  per-store-change flush now posts `indexWorker.postReconcile()` (the worker scans the whole ready+enabled
  `axisBRoster`, coalesced with the get-projects sweeps through the same gate) instead of the synchronous
  `refreshBackendSessions`, which was **deleted** — the worker is now the only Axis-B scan path too. The
  busy/idle spinner (`updateBackendLiveStates`) stays synchronous in the flush: it reads the live PTY set,
  not a transcript. Two things fell out of making the worker the sole path:
  - **A data-loss guard.** The worker's discovery-failure catch used to return an EMPTY reply
    (`incomplete: false`); on the only-scan-path it would let the reconcile delete-diff wipe a backend's
    entire cached history on one transient error (EMFILE/EACCES, a locked db). It now returns
    `unreadableBackendReply` (`incomplete: true`) — "could not read", not "empty" — so main keeps the rows,
    exactly as the old inline early-return did. Guarded by a test.
  - **Conditional `projects-changed`.** `afterReconcile(changed)` gates the push on whether the sweep moved
    the cache, restoring the old inline `if (upserted||deleted)` semantics — the watcher is the highest-
    frequency trigger, and a busy Codex/Hermes append the mtime/marker gate skips must not push at the
    600 ms watcher cadence.
- **REDUCED by [#282]** — a live session was driving multi-GB/day of disk **read** on main: measured
  ~34.5 MB/s with all backends live, dominated by the two SQLite backends. The [#208] flush above still
  swept the WHOLE roster every 600 ms, and `updateBackendLiveStates` re-OPENED each live backend's store per
  flush. Two levers:
  - **Scoped reconcile.** The flush now posts `postReconcile({backendIds})` for the backend(s) whose store
    actually changed (`src/watch/stores.js`); `scopedRoster` narrows the worker's roster to those
    (`claudeEnabled:false`, filtered to ready+enabled — `src/index/index-worker-client.js`). An agy append no
    longer drags Hermes' full-`messages` `GROUP BY` and the Codex/Pi store walks through the worker on every
    flush. The coalescing gate accumulates the scope union under sustained load and widens to a full sweep
    the moment any UNSCOPED caller (get-projects, the Claude watcher) arrives.
  - **Signature-gated `liveState`.** `updateBackendLiveStates` stays synchronous on main (it drives the
    spinner), but the SQLite backends (agy `.db`, Hermes `state.db`) now re-open only when a cheap signature
    — `mtime+size` of the db AND its `-wal` sibling, `src/backends/livestate-cache.js` — has moved. A flush
    from another backend, or a session that did not write, is served from a per-ref facts cache. The
    derivation still reruns with a fresh `now`, so the time-based staleness edge ([#166]) and the 30 s busy
    ticker are unchanged.
  - **Residual:** an UNCLAIMED (freshly spawned, or resumed but not yet paired) Axis-B session still walks
    the store / opens `state.db` on every flush until it pairs — throttling it was declined because it breaks
    the "keep asking until the locked DB answers" contract (`test/live-adopt.test.js`). Short-lived per
    session. The per-ref caches (`_factsCache`, `_liveStateCache`) are not evicted on session exit — bounded
    by live-session count, an evictable follow-up. Moving the remaining reads off-main is [#283].
- **MITIGATED by [#209]; the residual is [#210]** — the live-session identity match. `updateBackendLiveStates`
  stays synchronous in the watcher flush (it drives the spinner), and through `claimLiveRecord` it calls
  `matchLiveSession` (`src/backends/file-store.js`) for a freshly spawned, not-yet-paired Axis-B session. That
  correlates by BIRTH time, so it used to `statSync` **every transcript in the store**, on the main thread,
  on every flush until the session paired.
  **Measured first, then fixed** (the issue was filed as "a header parse runs on main"; measurement showed
  the header parse is ~1 file — the `sinceMs` gate already skips pre-spawn files — and that the real cost was
  the stat-per-file):

  | transcripts | before | after (`birthHint`) |
  |---|---|---|
  | 500 | 35 ms | 17 ms |
  | 2000 | 106 ms | 27 ms |
  | 5000 | 243 ms | 44 ms |

  The fix is an optional `birthHint(filename) -> ms | null` on `createFileStore`: Codex and Pi encode the
  session start time in the transcript name, so a record the NAME already dates before the spawn is rejected
  **without a syscall**. It is only ever a REJECT — survivors are still stat'd, so the precise birth and the
  oldest-wins tiebreak are unchanged — and it is applied with a deliberate **24 h margin**, because these
  filenames carry no timezone (Codex writes `rollout-2026-07-01T10-00-00-<id>`) and a hint that wrongly said
  "old" would stop a session pairing at all. A backend without the hook (agy: `<id>.db`, no timestamp) keeps
  the stat path. Hermes is db-mode and never had this walk.
  **Residual → [#210]:** the `discoverSessions()` readdir walk itself (~44 ms at 5000) still runs on main.
  Removing it means running the match in the worker — which makes `claimLiveRecord` async and re-opens the
  `activeSessions` re-key + stale-reply race surface, for a bounded cost an order below the #199 stall. Filed,
  not built; the trade-offs are written up in [#210].
- The sweep cadence is a coalesced `setImmediate` fired **after each `get-projects`**, plus the Axis-B
  watcher's post on a store change — not a wall-clock interval. Active changes are covered by the live
  watchers; the safety-net reconcile does not fire on its own if the sidebar is never re-fetched AND no
  store changes. A background interval is a one-line alternative if that gap matters. (Minor: the per-store
  `[scan] <backend>: N sessions in X ms` timing line went with `refreshBackendSessions` — the aggregate
  `[index-worker] post reconcile … postMs` covers the hot path; a lost trailing reconcile on a worker crash
  while the gate is held is re-covered by the next get-projects, not a timer.)

## Observability — the central perf surface

There is no separate perf file. `src/perf.js` (`startTimer` / `timed` / `timedAsync`) times a labelled span
and the call sites log a `[perf] <label> <ms>ms: …` line at **debug** only. The log level is a live global
setting (Sessions & CLI → Log level), so a running session can be profiled without a dev build. Query the
electron-log stream (installed: `%APPDATA%/switchboard/logs/main.log`; dev:
`~/.switchboard-dev/userData/logs/main.log` since #216) for `[perf]`. Instrumented today: `refreshFile`
(read / upsert / metrics / FTS) and the reconcile (`folders` / `full` / `incr` / `bytes`) — `full=0` in
steady state is the signal that step 2 is holding. Use it to verify each further step before/after in a
live high-output session; do not scatter raw `Date.now()` deltas.
