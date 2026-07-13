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
2. `git cherry-pick <commits>` — resolve conflicts (shared hot-paths: `main.js`, `public/sidebar.js`,
   `db.js`, `session-cache.js` collide because both forks rewrote them).
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

- **Main process** (`main.js` + `main-lifecycle.js`): app lifecycle, IPC handlers, terminal (PTY)
  management, file watching, MCP IDE bridge (`mcp-bridge.js`), scheduler (`schedule-*.js`).
- **Preload** (`preload.js`): the **only** IPC surface. Renderer talks to main exclusively through
  `window.api.*` defined here (`ipcRenderer.invoke` for request/response, `.send`/`.on` for streams).
  Add a binding here when you add an IPC handler in `main.js`.
- **Renderer** (`public/`): **vanilla JS, no framework**. Modules are plain `<script>` tags in
  `public/index.html` (load order matters). DOM reconciliation via morphdom. Terminal = `@xterm/xterm`.
  Diffs = CodeMirror (`codemirror-setup.js`, bundled by esbuild into `codemirror-bundle.js`).
- **Persistence** (`db.js`): `better-sqlite3`. Session cache + full-text search via **FTS5**.
  Migrations are an **ordered array** (`const migrations = [...]`); schema version = array length.
  Add a new migration by **appending** to the end — never insert or renumber.
- **Session data**: read from `~/.claude/projects/**/*.jsonl` (`read-session-file.js`,
  `derive-project-path.js`, `workers/scan-projects.js`, `session-cache.js`, `session-transitions.js`).
- **Backends** (`backends/`): the app runs **several coding CLIs** (Claude, Codex, Hermes, Pi; `agy`
  planned), not just Claude. One descriptor per backend — `backends/index.js` (registry) + `claude.js`
  (thin adapter over the modules above) + a folder per Axis-B binary. **Everything else derives from the
  descriptor**: spawn routing, scanning, the watcher, the launch menu, the generated settings page and
  Configure dialog, the sidebar badge, search, stats, resume.

### Working on backends

- **Read first:** `docs/specs/09-multi-llm.md` (the contract + why each decision is what it is) and
  `docs/backend-formats.md` (what each backend actually writes — taken from real installs, because the
  published docs were wrong in three places).
- **Don't hardcode a backend id outside its own folder.** `main.js` / `session-cache.js` / `public/*.js`
  contain no `if (backendId === 'codex')` and must not gain one.
- **A file-mode backend composes `backends/file-store.js` — it does not copy the walk.** Discovery,
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
  option that changes nothing (a control that lies), unless it says why: `appliesAt: 'spawn'` (main.js
  applies it, not the argv) or `requires: '<other>'` (meaningless on its own).
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

## Where the data actually is

**Two databases.** Look at the wrong one and you will "verify" against a store that has not moved in weeks —
including a schema the migrations never touched (`no such column: parserVersion` is what that looks like).

| Running as | `DATA_DIR` | DB |
|---|---|---|
| `npm start` / `npm run start:debug` (dev, unpackaged) | `~/.switchboard-dev` | `~/.switchboard-dev/switchboard.db` |
| the installed app (packaged) | `~/.switchboard` | `~/.switchboard/switchboard.db` |
| a test sandbox / agent run | `$SWITCHBOARD_DATA_DIR` | there |

Set in `main.js` (~L82): unpackaged **and** no explicit `SWITCHBOARD_DATA_DIR` → `~/.switchboard-dev`, so a dev
instance never races the installed app on `session_cache`. `db.js` resolves `DATA_DIR` at module load, so the
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
diagnosed without a dev build. Log file: `%APPDATA%/switchboard/logs/main.log`.

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
- When touching `db.js` schema: append a migration, never edit an existing one.
- When adding IPC: handler in `main.js` + binding in `preload.js` + (if it returns to UI) a renderer caller.
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
