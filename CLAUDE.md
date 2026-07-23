# CLAUDE.md

Guidance for AI agents working in this repository. Keep changes minimal and match surrounding style.

<!--
Maintainer note (stripped before this file enters context — costs no tokens):
This file is the ALWAYS-LOADED layer. Keep it under ~200 lines.
Detail lives in .claude/rules/*.md (path-scoped -> loads only when a matching file is read)
and docs/ai/*.md (loaded when the router below sends you there).
Do NOT use `@`-imports here: imported files load at launch and save nothing.
When you add a rule, ask: does it hang off a code path? -> a rules file. Is it a procedure? -> docs/ai.
Is it a reflex needed everywhere? -> here, one line, with its consequence.
-->

## What this is

Switchboard — an Electron desktop app to browse, search, launch, and monitor coding-CLI sessions
(Claude, Codex, Hermes, Pi) across projects. `README.md` has the user-facing feature list.

## Read this first

Detail is deliberately not in this file. Before you touch an area, read its file — the path-scoped
rules load themselves when you read a matching file, but **not** when you only create one, so this
table is the fallback and it is binding.

| You are about to touch | Read first |
|---|---|
| `src/main.js`, `src/app/**`, `src/watch/**`, `src/preload.js` | `.claude/rules/main-process.md` |
| `src/renderer/**`, `src/shared/**` | `.claude/rules/renderer.md` |
| `src/db/**`, `src/index/**`, `src/workers/**` | `.claude/rules/db.md` |
| `src/backends/**`, `src/session/**`, `src/servers/**`, `src/projects/**`, `src/vcs/**` | `.claude/rules/backends.md` |
| `docs/**`, `README.md` | `.claude/rules/docs.md` |
| a release, a tag, an installer | `docs/ai/release.md` |
| running/verifying, databases, store isolation | `docs/ai/running-and-data.md` |
| driving the app without clicking | `docs/ai/driving-the-app.md` |
| remotes, cherry-picking from a fork | `docs/ai/fork-and-porting.md` |
| the Windows build toolchain | `docs/build-windows.md` |
| why a rule exists / what it cost | `docs/ai/lessons.md` |

## The reflexes (these bite everywhere)

1. **Commit only after the behaviour is confirmed**, not when tests pass. Green tests are not a green
   light — see `docs/ai/lessons.md` for the four that shipped green and broke on first click.
2. **On any renderer change the click IS the test.** `node scripts/drive-app.js console` catches the
   `ReferenceError` the suite cannot see.
3. **Migrations are append-only.** `migrations.length` IS the schema version; renumbering corrupts
   user databases.
4. **No new IPC handler in `src/main.js`** — it goes in an `src/app/` module.
   `test/main-no-new-ipc.test.js` will say so.
5. **No backend id outside its own folder.** A capability that varies per backend is a descriptor
   hook, never a `switch (backendId)` in the core, and never `|| 'claude'`.
6. **No personal or local identifiers in public artifacts** — no absolute paths, machine names, home
   dirs, personal names or emails in issues, commits, code or docs. This repo is public, and issue
   **edit history** is world-readable too.
7. **Commits, code comments and all user-facing UI text are English.** One logical change per commit,
   Conventional Commits.
8. **A new control in the renderer inherits NO styling** — reuse an existing class, never ship a bare
   `<button>`.
9. **A setting added/renamed/re-scoped/re-defaulted → `docs/settings-reference.md`.** Same for a new
   `SWITCHBOARD_*` env var or script.
10. **Prefer `execFile`** over shell string interpolation for any external process.

## Backlog & workflow

The task board is **GitHub Issues** on `deadeye636/switchboard`, not a file. Migrated 2026-07-03 from
the old `docs/ROADMAP.md` + plan docs — **issue number = old `#nr` (1:1)**, contiguous #1–#62.

- **Read it:** `gh issue list` / `gh issue view <n>`. For in-context grepping the generated mirror
  `docs/BACKLOG.md`; machine-readable `docs/BACKLOG.jsonl`. Both open-issues-only — **never hand-edit**.
- **Regenerate:** `node scripts/build-backlog.js` after any issue change.
- **New task:** `gh issue create` with the requirement + labels; plan/discuss in comments.
- **Issue shape (keep it):** body = **the requirement only**. Plan/design and implementation go in
  **comments**. Done → an "Umsetzung" comment (with `git log main` commit refs) + close the issue.
  Open items carry no completion comment.
- **Labels:** prio `P1`/`P2`/`P3` (open only), type `bug`/`feature`/`port`/`chore`, `source:*`
  (`jbr`/`brianstanley`/`supacode`/`kreaddis`), `wontfix`.
- `gh` default repo is pinned to `deadeye636/switchboard` (`gh repo set-default`) — always our fork,
  never `doctly`. Decisions still land in commit messages + memory.

## Architecture map

**All app code lives under `src/`.** The repo root holds only project metadata and tooling
(`package.json`, `docs/`, `scripts/`, `test/`, `build/`). `"main"` in package.json is `src/main.js`,
and `build.files` is `src/**/*` — an **allow-list**, so a new directory outside `src/` is silently
absent from the installer.

| Area | What lives there |
|---|---|
| `src/main.js` | composition root: requires, `DATA_DIR`, wiring for twelve modules, 76 legacy IPC handlers |
| `src/app/**` | the areas main.js used to hold — lifecycle, windows, notifications, hooks, variables, settings, quit-guard, settings-transfer, plans-memory, `terminal/` |
| `src/preload.js` | the **only** IPC surface — `window.api.*` |
| `src/shared/**` | the four modules **both** processes load (`attention-source`, `custom-launchers`, `variable-insert`, `preview-kind`) |
| `src/renderer/**` | vanilla JS, no framework; plain `<script>` tags, morphdom, `@xterm/xterm`, CodeMirror via esbuild |
| `src/db/**` | `db.js` = façade (#217) over `connection`/`schema`/`migrations` + the stores |
| `src/index/**` | `session-cache.js` = façade (#199) over the index/search worker clients |
| `src/workers/**` | the scan + search workers |
| `src/watch/**` | `projects.js`, `stores.js`, `adopt.js`, `trigger-watcher.js` |
| `src/backends/**` | one folder per coding CLI + `index.js` registry + `file-store.js` |
| `src/servers/**` | MCP IDE bridge (`mcp-bridge.js`) |
| `src/vcs/**` | the VCS seam (#277) — provider registry + git provider + pure porcelain-v2/diff parser; core is VCS-blind. The poller/IPC live in `src/app/vcs.js` |
| `src/projects/**` | the project registry — the last place the backend-id migration is still open (#211) |

## Commands

- `npm test` — `node --test` over `test/*.test.js`. No Electron needed. Keep it green (run it for the
  current pass count — don't trust a number written down here). Takes ~20 s:
  `trigger-watcher.test.js` uses real `fs.watch`/timers and is the slowest file at ~19 s, which sets
  the wall clock since files run in parallel.
- `npm run demo:start` — **the default for dev/verify work**: a fully isolated demo instance against
  seeded stores under `C:\temp\switchboard`. Never touches real data. `npm run demo:seed` seeds
  without launching; `npm run demo:auth` copies credentials into the isolated home. See
  `docs/demo-env.md`.
- `npm start` — bundles CodeMirror, then launches Electron against the **real** stores. The exception,
  for when you deliberately want live data.
- `npm run start:debug` — the same with DevTools port 9222 open → `docs/ai/driving-the-app.md`.
- `npm run stop:dev` — stop **this checkout's** dev run. Never `taskkill /IM electron.exe`.
- `npm run build:win` — NSIS installer → `dist/Switchboard Setup <ver>.exe` → `docs/ai/release.md`.
- `npm run upstream:check` / `upstream:seen` — → `docs/ai/fork-and-porting.md`.

Both start commands can **refuse** on purpose (single-instance lock, occupied debug port). That is
the guard working, not a bug — `docs/ai/running-and-data.md` has the two-line fix.

## Which database

`npm start` (dev) → `~/.switchboard-dev/switchboard.db`. The installed app → `~/.switchboard/switchboard.db`.
A sandbox → `$SWITCHBOARD_DATA_DIR`. **A fix confirmed under `npm start` is confirmed in the DEV
database only.** Verifying against the wrong one looks exactly like a schema the migrations never
touched. Isolation, `userData`, and the per-backend store overrides: `docs/ai/running-and-data.md`.

## Logging

Three tiers (electron-log). Packaged builds default to `info`; the level is a global setting
(**Sessions & CLI → Log level**) and applies live.

| Level | Use it for | Rule of thumb |
|---|---|---|
| `log.info` | **transitions & lifecycle** — busy edges, subagent spawn/complete, hook signals, server start | a handful of lines per turn |
| `log.debug` | **per-decision detail** while diagnosing | readable at a few lines per second |
| `log.silly` | **firehose** — one line per raw event (OSC titles fire on every spinner frame) | only while reproducing a bug |

Put the **state change** at `info` and the **raw event that led to it** at `silly`. Never log a
per-frame event at `info` or `debug` — landing a diagnostic at `debug` is what made #120 invisible.
Log file locations differ between dev and installed: `docs/ai/running-and-data.md`.
