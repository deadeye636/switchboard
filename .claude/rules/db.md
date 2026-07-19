---
paths:
  - "src/db/**"
  - "src/index/**"
  - "src/workers/**"
---

# Persistence & indexing

## Layout

`src/db/db.js` is a **façade** (#217, 1997 → 156 lines) over modules named after what they hold —
same exports, so `require('../db/db')` is unchanged and no caller outside `src/db/` cares.

- `connection.js` (DATA_DIR + the one handle), `schema.js`, `migrations.js`
- stores: `meta-store` (what the **user** decided), `session-store` (what the **scanner** derived),
  `search-store` (FTS5), `tags-store`, `tasks-store`, `settings-store`, `stats-store`
- `project-refs.js` — a project's footprint moved across four stores, atomically
- helpers predating the split: `sqlite-busy-retry.js` (wraps every write; **not** usable inside an
  open transaction — that is why `project-refs.js` takes the stores' raw statements),
  `search-query-util.js` (the MATCH cap shared with the search worker, #79), `stats-queries.js`
  (the Stats SQL, Electron-free so it can be tested)

`src/index/session-cache.js` is a **façade** (#199) over `index-writes.js`,
`index-worker-client.js`, `search-worker-client.js`, `projects-view.js`, `folder-index-state.js`.
The workers themselves are `src/workers/`.

## `migrations.length` IS the schema version

One array, one file, **append only** — never insert, reorder or edit a shipped entry; retire one as
a no-op `() => {}` in place. Not a bug: a corrupted user database.
`test/db-migrations.test.js` pins every shipped entry by fingerprint (appending is free).

Schema changes live here, **not in `db.js`**: the CREATE TABLEs and CREATE INDEXes in `schema.js`,
the migrations in `migrations.js`.

## `schema.js` is a BASELINE, not the final shape

`applySchema` then `runMigrations` runs on *every* database including a brand-new one (version 0 →
all of them run), so both paths converge. A column **or index** a migration adds does **not** have to
be repeated in `schema.js` — the codebase does it both ways
(`idx_session_cache_parent`/`_backend` live only in the migration,
`idx_session_cache_projectPath` is in both), and either is correct.

## A store is required BELOW `runMigrations(db)`

It prepares its statements at load, so requiring it at the top dies on a **fresh** database with
`no such table:` while every existing install is fine. `test/db-store-load-order.test.js` guards it.

## No test loads `db.js` — a green suite says NOTHING here

better-sqlite3 is built against Electron's ABI. Verify with `scripts/db-probe.js` under
`ELECTRON_RUN_AS_NODE=1`, against a **copy** of a real DB **and** an empty one — several of the bugs
found during #217 were visible only on the fresh one.

An **appended migration** is verified with `scripts/db-migrate-probe.js` (same invocation, same
copy-of-a-real-DB rule): it must show the database moving exactly one version, the register seed
still taking effect, and an already-current database firing nothing. Every migration swallows its own
throw, so "it ran" is not "it did something" — that probe is the only thing that can tell the two
apart, and it sat broken from #193 to #224 because nothing pointed at it.

## Provenance & scoped deletes

`session_cache.backendId` is the authoritative provenance. Any folder-wide delete must be
**backend-scoped** (a project bucket is keyed on cwd and therefore shared) —
`test/scoped-folder-deletes.test.js` guards it.

## Bump a parser and its sessions re-read themselves

`PARSER_SCHEMA_VERSION` + `session_cache.parserVersion`. A parser change moves no file's mtime, so
without this a metrics schema change lands in an empty table and stays there. **Do not add a metrics
field without bumping.**

## Which database

`npm start` (dev) → `~/.switchboard-dev/switchboard.db`. Installed app → `~/.switchboard/switchboard.db`.
Sandbox → `$SWITCHBOARD_DATA_DIR`. Looking at the wrong one "verifies" against a store that has not
moved in weeks — `no such column: parserVersion` is what that looks like. Details:
`docs/ai/running-and-data.md`.
