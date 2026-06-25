# CLAUDE.md

Guidance for AI agents working in this repository. Keep changes minimal and match surrounding style.

## What this is

Switchboard — an Electron desktop app to browse, search, launch, and monitor Claude Code
sessions across projects. See `README.md` for the user-facing feature list.

## Fork context (important)

This repo is **our own version**, built in a single git repo with three remotes:

- Branch **`<old-codename>`** = our main line. Base = the **HaydnG** fork.
- Remotes: `haydng` (base), `jbr` (JeanBaptisteRenard — feature source), `upstream` (doctly — original).
- `../switchboard-jbr` = a read-only **git worktree** on `jbr/main` for reference.
- Both forks diverged from merge-base `b98c2f8`. Version numbers between forks are not comparable.

Feature-adoption catalogue: `docs/jbr-uebernahme-katalog.html` (JBR candidates with refs).

### Porting workflow

Adopt JBR features one at a time, never bulk-merge:

1. `git checkout -b port/<feature> <old-codename>`
2. `git cherry-pick <commits>` — resolve conflicts (shared hot-paths: `main.js`, `public/sidebar.js`,
   `db.js`, `session-cache.js` collide because both forks rewrote them).
3. `npm test` must be green (baseline: **185 passing**).
4. `git checkout <old-codename> && git merge --ff-only port/<feature>`.

`<old-codename>` must always stay runnable and green.

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

## Commands

- `npm test` — runs `node --test` over `test/*.test.js` (27 files). No Electron needed. Keep it green.
- `npm start` — bundles CodeMirror, then launches Electron.
- `npm run build:win` — NSIS installer → `dist/Switchboard Setup <ver>.exe`.

### Windows build gotchas (this machine, VS 2026)

A clean `build:win` needs three workarounds (see memory `switchboard-win-build-vs2026` for detail):

1. **node-gyp must be ≥13** for VS 2026 (major 18). Enforced via `"overrides": { "node-gyp": "13.0.0" }`
   in `package.json`. Don't remove.
2. **Unset `NoDefaultCurrentDirectoryInExePath`** before building, or winpty's gyp `.bat` step fails:
   `unset NoDefaultCurrentDirectoryInExePath && npm run build:win`.
3. **node-pty Spectre libs** aren't installed → MSB8040. Workaround sets `SpectreMitigation: 'false'`
   in `node_modules/node-pty/binding.gyp` + `deps/winpty/src/winpty.gyp`. This is a node_modules patch
   that is **lost on `npm install`** — see open task to make it durable with patch-package.

The win target is **x64-only** (arm64 toolchain not available here).

## Conventions

- Commits: Conventional Commits, **German** messages (project preference). One logical change per commit.
- Don't add a framework, build step, or bundler to the renderer beyond the existing esbuild CodeMirror bundle.
- When touching `db.js` schema: append a migration, never edit an existing one.
- When adding IPC: handler in `main.js` + binding in `preload.js` + (if it returns to UI) a renderer caller.
- Prefer `execFile` over shell string interpolation for any external process (security).
