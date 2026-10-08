# CLAUDE.md

Guidance for AI agents working in this repository. Keep changes minimal and match surrounding style.

## What this is

Switchboard — an Electron desktop app to browse, search, launch, and monitor coding-CLI sessions
(Claude, Codex, Hermes, Pi, agy — Claude and Pi also driven over a pipe, without a terminal) across
projects. `README.md` has the user-facing feature list.

## Read this first

Before you touch an area, read its path-scoped rule file:

| You are about to touch | Read first |
|---|---|
| `src/main.js`, `src/app/**`, `src/watch/**`, `src/preload.js` | `.claude/rules/main-process.md` |
| `src/renderer/**`, `src/shared/**` | `.claude/rules/renderer.md` |
| `src/db/**`, `src/index/**`, `src/workers/**`, `src/perf.js` | `.claude/rules/db.md` |
| `src/backends/**`, `src/session/**` | `.claude/rules/backends.md` (resource sharing between CLIs: `docs/specs/31-resources-from.md`) |
| `src/backends/*-native/**` | `.claude/rules/backends-native.md` + `docs/specs/32-claude-native.md` (Claude) / `docs/specs/30-pi-native.md` (Pi) |
| `src/projects/**`, `src/servers/**` | `.claude/rules/projects-and-servers.md` |
| `src/vcs/**` | `.claude/rules/vcs.md` + `docs/specs/15-vcs-status.md` |
| `test/**`, `scripts/**` | `.claude/rules/guards-and-scripts.md` |
| `docs/**`, `README.md`, `CONTRIBUTING.md` | `.claude/rules/docs.md` |
| handoffs / plans | `docs/specs/25-handoffs.md` + `docs/specs/20-plans.md` + `docs/specs/29-agent-side-conventions.md` |
| settings / welcome tour / session health | `docs/specs/26-settings-screen.md`, `27-welcome-tour.md`, `28-session-health.md` |
| document cards in the conversation view | `docs/specs/33-document-preview.md` |
| driving the app / performance | `docs/ai/driving-the-app.md` + `docs/ai/lessons.md` |
| running, data isolation, release | `docs/ai/running-and-data.md` + `docs/ai/release.md` |
| syncing with upstream / porting a change | `docs/ai/fork-and-porting.md` |

## The reflexes (strictly binding invariants)

1. **Commit after the behaviour is confirmed**, not when tests pass. Green tests are not a green light (`docs/ai/lessons.md`).
2. **On renderer change the click IS the test.** Run `node scripts/drive-app.js console` to catch runtime errors. Note: renderer reload does not reload `src/app/**`, and synthesized events do not match real user interactions.
3. **Migrations are append-only.** `migrations.length` IS the schema version. Parsers modifying stored field semantics must bump `PARSER_SCHEMA_VERSION` across all affected parsers in the same commit (`.claude/rules/db.md`).
4. **No new IPC handler in `src/main.js`** — place it in an `src/app/` module and bind in `src/preload.js` (`test/main-no-new-ipc.test.js`).
5. **No backend id or format outside its own folder.** Capabilities are descriptor hooks; never use `switch (backendId)`. Pre-#161 NULL records defaulting to `|| 'claude'` are grandfathered. Formatting and transcript grammar rules belong in backend descriptors, never renderer/shared helpers (`test/backend-integrations.test.js`).
6. **No personal or local identifiers anywhere that leaves this machine.** No real names, emails, machines, or local paths (`<drive>:\...`). Use placeholders (`~`, `<project>`, `<user>`). Enforced by `test/no-local-paths.test.js`.
7. **English in every artifact** (code, tests, commits, issues, docs, rules). Sole exception: `docs/customizing-colors.md` (retained third-party guide).
8. **A new renderer control reuses existing styling.** Never ship an unstyled bare `<button>` or input element.
9. **Settings changes go into `docs/settings-reference.md`.** Applies to any added, renamed, or re-defaulted setting, `SWITCHBOARD_*` env var, or script.
10. **Prefer `execFile` and close a probe's stdin.** Avoid shell interpolation. Because `execFile` ignores `stdio: 'ignore'`, use `closeStdin(execFile(...))` from `src/backends/cli-probe.js`.
11. **Never `fs.writeFileSync` a file a CLI reads.** Always use `src/app/safe-write.js` (`writeTextFile`) for baseline checks, atomic rename, and EOL retention. Exemptions: `src/backends/rewrite-cwd.js` (per-line append) and ephemeral per-spawn files.
12. **One answer for where a project keeps its documents.** `src/app/convention-dirs.js` is the sole authority for handoff and plan directories. Lexical fallback rule lives in `src/shared/convention-dir-name.js` (`test/convention-dirs.test.js`, `test/convention-dir-name.test.js`).
13. **Path containment is decided on real paths.** `src/app/path-containment.js` is the only way: checks canonical resolved paths before `fs.stat()`. Never rely on lexical string prefix matching.
14. **Never strip comments with a pair of regexes.** Always use `test/helpers/strip-comments.js` (`test/strip-comments-shape.test.js`).
15. **Shared working tree: no git stash, reset, checkout -- or branch switch.** Tree is shared across parallel sessions. Inspect past revisions with `git show <ref>:<path>`. Commit only with explicit pathspecs (`git commit <path1> <path2>`), never `git add -A` or `git commit -a`.
16. **An issue is not law — check against concept before building.** Verify whether requirements still fit and confirm root causes independently. If building creates a new user flow or contract, state pros/cons and 2+ alternatives before proceeding.
17. **Never assemble `project:<path>` by hand.** Use `settingsOwnerPath` (`src/shared/worktree-path.js`) for cascading settings; `worktreeRootOf` for ownership; `worktreeLabelOf` for display names (`test/worktree-path.test.js`).

## Backlog & workflow

Task board is GitHub Issues on `deadeye636/switchboard`:
- **Read:** `gh issue list` / `gh issue view <n>`. Rebuild local gitignored mirror: `node scripts/build-backlog.js`.
- **New task:** `gh issue create`. Issue body = requirement only. Plans, designs, and decisions live in issue comments.
- **Completion:** Comment with `git log main` commit refs + close issue.
- **Repo constraint:** Pinned to `deadeye636/switchboard` (`gh repo set-default`). Guard hook blocks pushing to read-only remotes or targeting `doctly`.

## Architecture map

All app code lives under `src/`:

| Area | What lives there |
|---|---|
| `src/main.js` | Composition root, `DATA_DIR`, module wiring, grandfathered IPC handlers. |
| `src/app/**` | Core subsystems (settings, terminal, vcs, window management, handoffs, safe-write). |
| `src/preload.js` | The only IPC surface (`window.api.*`). |
| `src/shared/**` | Modules loaded by both main and renderer processes. |
| `src/renderer/**` | Vanilla JS (no framework), morphdom, `@xterm/xterm`, CodeMirror via esbuild. |
| `src/db/**` | SQLite database façade (`db.js`), connection, schema, migrations, and one `*-store.js` per table family. |
| `src/index/**` | Cache layer (`session-cache.js`), `projects-view.js`, `worktree-dirs.js`, index writes and folder state, the clients of the two worker threads. |
| `src/workers/**` | Scan and search worker threads (`index-worker.js`, `scan-projects.js`, `search-query.js`). |
| `src/perf.js` | Timing primitive (`startTimer`). |
| `src/watch/**` | Store and project filesystem watchers, adoption, trigger watchers. |
| `src/backends/**` | CLI backend descriptors, registry (`index.js`), file-store, probe utilities. |
| `src/session/**` | Session transitions, lineage, clear-claims, project-path derivation, subagent tail and transcript. App lifecycle is `src/app/lifecycle.js`. |
| `src/servers/**` | MCP IDE bridge (`mcp-bridge.js`). |
| `src/vcs/**` | VCS provider registry, git provider (including the diff argv), porcelain-v2 status parser. Diff output is not parsed. |
| `src/projects/**` | Backend-neutral project registry and metadata. |

## Commands

- `npm test` — runs recursive suite (`test/**/*.test.js`) with 120s timeout.
- `npm run demo:start` — **default for dev/verify**: isolated demo instance against `C:\temp\switchboard`. Clean up after tests (`docs/demo-env.md`).
- `npm start` — bundles CodeMirror/PDF.js and launches Electron against real stores.
- `npm run start:debug` — launch with DevTools port 9222 open (`docs/ai/driving-the-app.md`).
- `npm run stop:dev` — stop this checkout's dev run (guard blocks global `taskkill /IM electron`).
- `npm run build:win` — build NSIS installer (`docs/ai/release.md`).
- `npm run backends:help-check` / `backends:changelog-check` — audit CLI flags and upstream changelogs (per-backend `<id>:help-check` and `backends:changelog-seen` beside them).
- `npm run upstream:check` / `upstream:seen` — compare against the upstream repo (`docs/ai/fork-and-porting.md`).
- `npm run demo:seed` / `demo:auth`, `npm run bundle`, `npm run build` / `build:mac*` / `build:linux` / `release` — the full list with what each does is in `docs/settings-reference.md`.

## Which database

- `npm start` (dev) → `~/.switchboard-dev/switchboard.db`.
- Installed app → `~/.switchboard/switchboard.db`.
- Sandbox / demo → `$SWITCHBOARD_DATA_DIR` (`docs/ai/running-and-data.md`).

## Logging

Three tiers via `electron-log`:
- `log.info`: Lifecycle edges and transitions (session spawn, subagents, hook signals).
- `log.debug`: Per-decision diagnostics while troubleshooting.
- `log.silly`: High-volume raw events (OSC spinner frames). Never put per-frame events in `info`/`debug`.
