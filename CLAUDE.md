# CLAUDE.md

Guidance for AI agents working in this repository. Keep changes minimal and match surrounding style.

## What this is

Switchboard — an Electron desktop app to browse, search, launch, and monitor Claude Code
sessions across projects. See `README.md` for the user-facing feature list.

## Fork context (important)

This repo is **our own version** ("deadeye" is the codename of our variant — it shows up in
code comments to distinguish our fork's behaviour from haydng/jbr). It lives in a single git
repo with our own `origin` plus the upstream forks we port from.

- Branch **`main`** = our main line (was `deadeye` before the GitHub move; the codename stays).
- **`origin`** = `git@github.com:deadeye636/switchboard.git` — our repo. `main` is the default branch.
  Pushed via SSH; `core.sshCommand` points at native Windows OpenSSH so the Bitwarden SSH agent
  is used (Git-bundled MSYS ssh can't reach the agent pipe — see memory `ssh-key-bitwarden`).
- **Reference branches on origin** (read-only snapshots of the porting sources, recognizable by
  name, not generic): `haydng` (= `haydng/main`, the base) and `jbr` (= `jbr/main`, feature source).
- **Upstream remotes** (fetch sources for porting): `haydng` (base), `jbr` (JeanBaptisteRenard —
  feature source), `upstream` (doctly — original). Plus extra read-only forks.
- `../switchboard-jbr` = a read-only **git worktree** on `jbr/main` for reference.
- All forks diverged from merge-base `b98c2f8`. Version numbers between forks are not comparable.

Feature-adoption catalogue: closed issue [#1](https://github.com/deadeye636/switchboard/issues/1)
(JBR candidates + refs live in its "Umsetzung" comment).

### Porting workflow

Adopt JBR features one at a time, never bulk-merge:

1. `git checkout -b port/<feature> main`
2. `git cherry-pick <commits>` — resolve conflicts (shared hot-paths: `src/main.js`, `src/renderer/shell/sidebar.js`,
   `src/db/db.js`, `src/index/session-cache.js` collide because both forks rewrote them).
3. `npm test` must be green — no new failures vs. the pre-port run.
4. `git checkout main && git merge --ff-only port/<feature>`.

`main` must always stay runnable and green.

**Detecting upstream changes:** `npm run upstream:check` fetches `haydng` + `jbr` and reports
new/updated/removed branches and new commits since the last review (marker in
`.git/upstream-seen.json`, not versioned). After reviewing/porting, `npm run upstream:seen`
marks the current state as seen so the next check only shows fresh activity. It watches **all**
upstream branches, not just `main`.

## Backlog & workflow

The task board is **GitHub Issues** on `deadeye636/switchboard`, not a file. Migrated 2026-07-03 from
the old `docs/ROADMAP.md` + plan docs — **issue number = old `#nr` (1:1)**, contiguous #1–#62.

- **Read the backlog:** `gh issue list` (open) / `gh issue view <n>`. For in-context grepping use the
  generated mirror **`docs/BACKLOG.md`**; for machine consumption **`docs/BACKLOG.jsonl`** (one issue
  per line: number, title, prio, labels, url, refs, body). Both open-issues-only, read-only — never hand-edit.
- **Regenerate the mirror:** `node scripts/build-backlog.js` after any issue change.
- **Issue shape (keep it):** body = **the requirement only**. Plan/design and implementation go in
  **comments** (normal issue timeline). Done → an "Umsetzung" comment (with `git log main` commit refs)
  + close the issue. Open items carry no completion comment.
- **Labels:** prio `P1`/`P2`/`P3` (open only), type `bug`/`feature`/`port`/`chore`, `source:*`
  (`jbr`/`brianstanley`/`supacode`/`kreaddis`), `wontfix`.
- **New task:** `gh issue create` with the requirement + labels; plan/discuss in comments.
- `gh` default repo is pinned to `deadeye636/switchboard` (`gh repo set-default`) — always our fork,
  never `doctly`. Decisions still land in commit messages + memory.

## Architecture

**All app code lives under `src/`.** The repo root holds only project metadata and tooling
(`package.json`, `docs/`, `scripts/`, `test/`, `build/`). `"main"` in package.json is `src/main.js`, and
`build.files` is `src/**/*` — an **allow-list**, so a new directory outside `src/` is silently absent from
the installer.

- **Main process** (`src/main.js`): the composition root. The lifecycle, the PTY management and the file
  watching it used to hold are modules now (below); what stays here is wiring and the small IPC handlers.
  **~2470 lines, down from 5011: the split is done (#213).** What is left is a composition root — the
  requires, `DATA_DIR`, the wiring for eleven modules, and ~86 small IPC handlers that stayed on purpose
  (thin, no shared state; moving them buys churn). `src/app/` holds `lifecycle.js` (the boot, the
  scheduler's runner, the ordered teardown), `windows.js`, `notifications.js`, `hooks.js`,
  `variables.js`, `settings.js`, `quit-guard.js`, `settings-transfer.js` and `terminal/`
  (`spawn.js` = open-terminal, `io.js` = input/resize/redraw/flow control, plus the PTY pure-logic).
  **A new IPC handler belongs in one of those modules, not here** — #222 is the guard that will say so.
- **The ctx object** — how every `src/app/*` and `src/watch/*` module gets what main.js owns. Three rules,
  each paid for:
  - **A `const` goes straight through; a `let` ONLY as a getter.** `activeSessions`, `liveStoreRef` and
    the other Maps are passed by reference — same object, every writer sees every write. `mainWindow`,
    `appQuitting`, `closeConfirmed` are reassigned, so they arrive as `getMainWindow()` /
    `getAppQuitting()`. A captured `mainWindow` addresses a window that no longer exists after a reopen:
    the UI stops updating, with no error anywhere. A captured `appQuitting` lets a late flush hit a closed
    DB (#90).
  - **Never top-level-`require('../db/db')`** — db.js resolves `DATA_DIR` at module load, before main.js
    sets it, and a dev build then silently writes to the installed app's database.
    `test/main-modules-no-db.test.js` enforces both halves.
  - **Electron arrives through ctx too** (`dialog`, `safeStorage`, `app`, even `ipcMain` via
    `registerIpc(ipc)`) — not for purity, but because it is what makes the module loadable in
    `node --test`. That is the whole reason #213 was worth doing: the hook server's token check (#77), the
    secret resolver, the settings write path, the cascade (#149) and the scheduler's enable gate (#162)
    had NO tests while they sat in Electron-bound main.js. Their guards could only grep main.js's source —
    and a grep cannot tell you the line does anything.
  - **Where a `let` lives is decided by counting readers, not taste.** Still read in main.js → it stays
    there and the module takes a getter. Read nowhere else → it moves into the module.
- **Preload** (`src/preload.js`): the **only** IPC surface. Renderer talks to main exclusively through
  `window.api.*` defined here (`ipcRenderer.invoke` for request/response, `.send`/`.on` for streams).
  Add a binding here when you add an IPC handler — which belongs in an `src/app/` module's
  `registerIpc(ipc)`, not in `src/main.js`.
- **`src/shared/`**: the four modules **both processes load** — `attention-source`, `custom-launchers`,
  `variable-insert`, `preview-kind`. They are `require()`d in main and a global in the renderer (which has
  no require — plain `<script>` tags). The preview in main must compute with the same code the insert runs
  in the renderer; two copies would be a bug factory. Nothing else belongs here.
- **Renderer** (`src/renderer/`): **vanilla JS, no framework**. Modules are plain `<script>` tags in
  `src/renderer/index.html` (load order matters — `test/script-tags.test.js` guards it). Sorted into folders
  (`shell/`, `session/`, `terminal/`, `views/`, `jsonl/`, `panels/`, …). DOM reconciliation via morphdom.
  Terminal = `@xterm/xterm`.
  Diffs = CodeMirror (`codemirror-setup.js`, bundled by esbuild into `codemirror-bundle.js`).
- **Persistence** (`src/db/`): `db.js` (`better-sqlite3`) + `stats-queries.js`, `search-query-util.js`,
  `sqlite-busy-retry.js`. Session cache + full-text search via **FTS5**.
  Migrations are an **ordered array** (`const migrations = [...]`); schema version = array length.
  Add a new migration by **appending** to the end — never insert or renumber.
- **Scan/index** (`src/index/`): `session-cache.js` is a **façade** (#199) over `index-writes.js`,
  `index-worker-client.js`, `search-worker-client.js`, `projects-view.js`, `folder-index-state.js`.
  The workers themselves are `src/workers/`.
- **Session data**: read from `~/.claude/projects/**/*.jsonl` — `src/session/derive-project-path.js`,
  `src/workers/scan-projects.js`, `src/index/session-cache.js`, `src/session/session-transitions.js`,
  and Claude's own readers in `src/backends/claude/` (`session-reader.js`, `store-indexer.js`).
- **Servers** (`src/servers/`): MCP IDE bridge (`mcp-bridge.js`), scheduler (`schedule-*.js`).
- **Watching** (`src/watch/`): `projects.js` (fs.watch on Claude's store — folders + per-file refreshes),
  `stores.js` (every OTHER backend's store; scan-generalization is not watch-generalization, so this
  works on `watchTargets()`, not on discovery's per-session handles), `adopt.js` (identity adoption +
  busy/idle for the backends that name their own sessions), `trigger-watcher.js`. `adopt.js` owns
  `liveStoreRef`/`liveBusy` and **exports the Maps themselves** — main's PTY-exit handler drops a dead
  session's claim from them, so a copy would leave the claim standing forever and a relaunch would
  inherit a dead ref.
- **Backends** (`src/backends/`): the app runs **several coding CLIs** (Claude, Codex, Hermes, Pi; `agy`
  planned), not just Claude. One folder per backend — `index.js` (registry) + `claude/`
  (a **thin adapter** over the modules above: the core still imports Claude's readers directly instead of
  going through the descriptor, which is why they are not in that folder) + a folder per Axis-B binary.
  **Everything else derives from the descriptor**: spawn routing, scanning, the watcher, the launch menu,
  the generated settings page and Configure dialog, the sidebar badge, search, stats, resume.

### Working on backends

- **Read first:** `docs/specs/09-multi-llm.md` (the contract + why each decision is what it is) and
  `docs/backend-formats.md` (what each backend actually writes — taken from real installs, because the
  published docs were wrong in three places).
- **Don't hardcode a backend id outside its own folder.** `src/main.js` / `src/app/**` / `src/watch/**` / `src/index/session-cache.js` / `src/renderer/**/*.js`
  contain no `if (backendId === 'codex')` and must not gain one.
- **A file-mode backend composes `src/backends/file-store.js` — it does not copy the walk.** Discovery,
  `watchTargets`, the birth-time `matchLiveSession` and the suffix `liveRefFor` are the same code for every
  backend that keeps one transcript per session; declare `root` (lazy), `matches`, `parseSession` and
  `refSuffix` and take the rest. `findOnPath` lives there too (PATHEXT — the npm CLIs are `.cmd` shims).
- **Adding or changing one → run `npm test`**: `test/backend-parity.test.js` asserts the properties every
  backend must share (an availability probe; an honest `supportsFork`; all three identity hooks if it
  names its own sessions; a versioned incremental parser). It exists because the same defect got fixed in
  one backend four separate times while its siblings quietly kept it — **fix a backend, check its
  siblings**.
- `session_cache.backendId` is the authoritative provenance. Any folder-wide delete must be **backend-scoped**
  (a project bucket is keyed on cwd and therefore shared) — `test/scoped-folder-deletes.test.js` guards it.
- **A `configFields` default describes what the CLI does anyway — it is NEVER sent.** It is what a control
  shows when nobody has said otherwise, not a value to put on the command line. Only what someone actually
  chose reaches the argv. Every non-empty default used to be seeded into the launch, so a plain Codex
  session carried `-a on-request -s workspace-write` although the user had chosen neither, overruling
  their own `config.toml` in silence. So write a default that **matches what that CLI already does** — it
  is a description of the CLI, not a wish. `test/backend-config-fields.test.js` also refuses a declared
  option that changes nothing (a control that lies), unless it says why: `appliesAt: 'spawn'`
  (`app/terminal/spawn.js` applies it, not the argv) or `requires: '<other>'` (meaningless on its own).
- **Options cascade PER OPTION, and every level stores only what it marked as set:**
  `backend default → global → project → template`. Without that marker, "not set" cannot be told from
  "deliberately empty / off", and an option whose default is ON could never be switched off. The Configure
  dialog sits on top as a per-session override; its markers start ticked, so opening it and pressing Start
  changes nothing.
- **Bump a parser and its sessions re-read themselves** (`PARSER_SCHEMA_VERSION` + `session_cache.parserVersion`).
  A parser change moves no file's mtime, so without this a metrics schema change lands in an empty table
  and stays there. Do not add a metrics field without bumping.

## Docs — where a document goes

| Kind | Home |
|---|---|
| **Design record** for a feature ("why is it like this", decisions, as-built + known gaps) | `docs/specs/NN-<feature>.md` + a row in `docs/specs/README.md` |
| **User-facing guide** ("how do I use it") | `docs/<feature>.md`, linked from the README's "What this fork adds" |
| **Reference** (formats, build gotchas, colors) | `docs/<topic>.md` (e.g. `backend-formats.md`, `build-windows.md`) |
| **Fork feature list** | `README.md` "What this fork adds" **and** `docs/fork-features.md` (Wave 4) — a new fork feature goes in **both** |
| **Backlog** | GitHub Issues. `docs/BACKLOG.md` / `.jsonl` are **generated** (`node scripts/build-backlog.js`) — never hand-edit |
| **Planning scaffolding** (task lists, state trackers, agent prompts, mockups) | **stays local / gitignored.** It is scaffolding: once the work lands, its lasting parts belong in a spec or a reference; the rest is noise, and stale plan text next to a correct spec is worse than no plan text |

## Commands

- `npm test` — runs `node --test` over `test/*.test.js`. No Electron needed. Keep it green (run it for the current pass count — don't rely on a hardcoded number here).
  (Takes ~20 s. `trigger-watcher.test.js` uses real `fs.watch`/timers and is the slowest file at ~19 s, which sets the wall clock since files run in parallel.)
- `npm start` — bundles CodeMirror, then launches Electron.
- `npm run start:debug` — the same, with the DevTools port open, so the app can be **driven from the CLI** (below).
- `npm run build:win` — NSIS installer → `dist/Switchboard Setup <ver>.exe`.

### Release artifacts

**Every installer lives in `dist/`** — the ones `build:win` produces and the ones you download from a
release. It is gitignored, and it is where the previous versions already are, so one look tells you what
exists. Downloading a build into a scratch or temp directory just scatters a 110 MB file somewhere nobody
will remember to delete.

```
gh release download v<version> --pattern "Switchboard.Setup.<version>.exe" --dir dist
```

**Install the build before releasing it.** `build.files` in `package.json` is an **allow-list**, and
`*.js` in it matches the **top level only** — so a new directory of modules is silently left out of the
package unless it is added there. 0.7.5's first draft shipped without `backends/` and died on its first
`require`: the repo ran, `npm start` ran, the whole suite was green, and only the installer was missing
anything. `test/packaged-files.test.js` now walks the real require graph against that allow-list, but a
test is not a substitute for starting the thing you are about to hand someone.

(Starting it is not as easy as it sounds: the **single-instance lock** hands your launch of
`dist/win-unpacked/Switchboard.exe` straight to an already-running installed Switchboard, which then looks
like a successful start and is not one. Close the installed app first, or you have verified nothing.)

### Pushing a tag ALREADY builds the release — never `gh release create`

`.github/workflows/build.yml` fires on `push` of a `v*` tag and builds **all three platforms**, then
creates the release as a **draft** and uploads 19 assets to it: the Windows installer, the macOS `.dmg`/
`.zip` (arm64 + x64), the Linux AppImage/`.deb`/pacman — **and the `latest*.yml` files the auto-updater
needs.**

So after `git push origin refs/tags/v<version>`, the release already exists. Adding your own with
`gh release create` produces a **second** release on the same tag, carrying only whatever you attached by
hand — no `latest*.yml`, so an auto-update from it silently cannot work — and whoever opens the releases
page sees the wrong one. It happened in 0.7.6 and it looked exactly like "why is there only a Windows
build?".

```
gh release list                                  # is there already a draft for this tag?
gh release edit v<version> --notes-file <file>   # yes -> only ever EDIT it
gh release edit v<version> --title "<version>"   # the title is 0.7.6; the TAG is v0.7.6
```

Two traps in that edit: `gh api -X PATCH …/releases/<id>` without `tag_name` **resets the tag to an
`untagged-…` placeholder** — pass it, or use `gh release edit`. And the release **title carries no `v`**
(`0.7.6`), while the tag does (`v0.7.6`) — match the ones already there.

## Where the data actually is

**Two databases.** Look at the wrong one and you will "verify" against a store that has not moved in weeks —
including a schema the migrations never touched (`no such column: parserVersion` is what that looks like).

| Running as | `DATA_DIR` | DB |
|---|---|---|
| `npm start` / `npm run start:debug` (dev, unpackaged) | `~/.switchboard-dev` | `~/.switchboard-dev/switchboard.db` |
| the installed app (packaged) | `~/.switchboard` | `~/.switchboard/switchboard.db` |
| a test sandbox / agent run | `$SWITCHBOARD_DATA_DIR` | there |

Set in `src/main.js` (~L82): unpackaged **and** no explicit `SWITCHBOARD_DATA_DIR` → `~/.switchboard-dev`, so a dev
instance never races the installed app on `session_cache`. `src/db/db.js` resolves `DATA_DIR` at module load, so the
env var must be set **before** anything requires it.

**A fix confirmed under `npm start` is confirmed in the DEV database only.** The installed app runs its own
migration + reindex the next time *it* starts.

The **source** stores are shared by both (they belong to the CLIs, not to us): `~/.claude/projects/**`,
`%LOCALAPPDATA%\hermes\state.db`, `(CODEX_HOME|~/.codex)/sessions`, `~/.pi/agent/sessions`.

## Driving the app (no clicking required)

Electron speaks the same DevTools protocol Chrome does, so the running app can be scripted. This is the missing
half of "run it and look": a test cannot see a sidebar, and a green suite has twice hidden a feature that was
plainly broken on screen (Codex stuck at "working"; a Save that discarded every backend setting).

```
npm run start:debug                                   # app + DevTools port 9222
node scripts/drive-app.js eval "<js>"                 # run JS in the renderer, print the result
node scripts/drive-app.js text "<selector>"           # innerText of the first match
node scripts/drive-app.js count "<selector>"          # how many match
node scripts/drive-app.js click "<selector>"          # click the first match
node scripts/drive-app.js clicktext "<sel>" "<text>"  # click the first match containing <text>
node scripts/drive-app.js shot out.png                # screenshot the window
```

No dependency (Node 22 ships a global `WebSocket`; CDP is JSON over one). `window.api.*` is reachable from
`eval`, so the app's own IPC can be exercised directly — e.g. `await window.api.getProjects(false)` to read what
the sidebar would render, or `await window.api.unhideProject(path)` to do what a click would do. Give the
renderer a second after launch; a query fired too early answers about an empty page.

### Windows build gotchas (this machine, VS 2026)

Full procedure + background: `docs/build-windows.md` (and memory `switchboard-win-build-vs2026`).
Two of the three historical workarounds are now durable in-repo; only one is per-shell:

1. **node-gyp ≥13** for VS 2026 (major 18) — durable via `"overrides": { "node-gyp": "13.0.0" }`
   in `package.json`. Don't remove.
2. **node-pty Spectre mitigation off** (else MSB8040: Spectre libs not installed) — durable via
   `patches/node-pty+1.1.0.patch` (`SpectreMitigation: 'false'` in node-pty's `binding.gyp` +
   `deps/winpty/src/winpty.gyp`). Re-applied automatically by the `postinstall` script
   (`patch-package`), so it survives `npm install`. Don't remove the patch or the postinstall hook.
3. **Unset `NoDefaultCurrentDirectoryInExePath`** before building (per-shell, not patchable) — winpty's
   gyp `.bat` step fails otherwise: `unset NoDefaultCurrentDirectoryInExePath && npm run build:win`.

The win target is **x64-only** (arm64 toolchain not available here).

## Logging

Three tiers (electron-log). Packaged builds default to `info`; the level is a global
setting (**Sessions & CLI → Log level**) and applies live, so a live session can be
diagnosed without a dev build. Log file: the installed app writes `%APPDATA%/switchboard/logs/main.log`; a
**dev** build writes `~/.switchboard-dev/userData/logs/main.log` (#216 gave dev its own `userData`, the same
way it already had its own DB — so the two stop fighting over one Chromium cache and a dev insert stops
writing secret-ref temp files into the installed app's directory). Reading the wrong one looks exactly like
"my log line never fired".

| Level | Use it for | Rule of thumb |
|---|---|---|
| `log.info` | **transitions & lifecycle** — busy edges (`→ BUSY` / `→ IDLE`), subagent spawn/complete/reopen, hook signals, server start | a handful of lines per turn |
| `log.debug` | **per-decision detail** while diagnosing | readable at a few lines per second |
| `log.silly` | **firehose** — one line per raw event (OSC title changes fire on every spinner frame, ~10/s per busy session) | only while reproducing a bug |

When you add a log line, put the **state change** at `info` and the **raw event that
led to it** at `silly`. Never log a per-frame event at `info` or `debug`. Landing a
diagnostic at `debug` that the packaged default hides is what made #120 invisible.

## Conventions

- **Git commits: Conventional Commits in English** (this is a public repo). The `git-commit`
  skill defaults to German, so write the message in English (translate its output, or commit
  directly). One logical change per commit.
- **Commit only after the feature is confirmed working.** Don't commit a change just
  because tests pass — wait until the behaviour has been verified (manual check in the
  app, or the user confirms it works). Green tests alone are not a green light to commit.
  Two bugs that shipped green: Codex sat permanently at "working" (a Claude-only OSC title
  heuristic ran on every backend), and a Save with a backend's gear page open silently
  discarded every backend setting. Both needed a click, not a test run, to be seen.
- Don't add a framework, build step, or bundler to the renderer beyond the existing esbuild CodeMirror bundle.
- **A new control in the renderer inherits NO styling.** A button with only a behaviour class renders as
  the browser's native control — a white box with black text, next to your styled ones. Reuse an existing
  class (`.settings-action-btn`, `.new-session-secondary-btn`, `.backend-btn`, …) or add one; never ship a
  bare `<button>`. Same for popovers and overlays. This has bitten repeatedly.
- **A dialog that holds work must not be dismissible by accident.** A stray backdrop click or a reflexive
  Escape closes a `showControlDialog` — fine for a question, wrong for anything holding something the user
  cannot get back (a handoff packet an agent spent tokens writing). Pass `dismissible: false`, or ask
  before discarding.
- When touching `src/db/db.js` schema: append a migration, never edit an existing one.
- When adding IPC: handler in `src/main.js` + binding in `src/preload.js` + (if it returns to UI) a renderer caller.
- Prefer `execFile` over shell string interpolation for any external process (security).
- **User-facing UI text is English** (settings labels/descriptions, sidebar labels, dialogs,
  tooltips) — match the existing strings. Commit messages are English (see above); code
  comments are English too, and anything shown in the app is English.
- **New fork feature → document it.** When you add a feature unique to this fork (not inherited
  from upstream), add it to the **README "What this fork adds"** list **and** to
  `docs/fork-features.md` (Wave 4). Keep entries terse and matched to the existing style.
- **No personal or local identifiers in public artifacts.** Never write absolute paths, local
  machine references (`C:\Users\<name>`, drive letters, home dirs), or personal names/emails into
  issues, commit messages, code, or docs — use generic placeholders (`~`, `<project>`, `<user>`).
  This repo is public: issues, issue **edit history**, and git history are all world-readable.
