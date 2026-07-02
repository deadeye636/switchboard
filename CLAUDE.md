# CLAUDE.md

Guidance for AI agents working in this repository. Keep changes minimal and match surrounding style.

## What this is

Switchboard — an Electron desktop app to browse, search, launch, and monitor Claude Code
sessions across projects. See `README.md` for the user-facing feature list.

## Fork context (important)

This repo is **our own version** ("<old-codename>" is the codename of our variant — it shows up in
code comments to distinguish our fork's behaviour from haydng/jbr). It lives in a single git
repo with our own `origin` plus the upstream forks we port from.

- Branch **`main`** = our main line (was `<old-codename>` before the GitHub move; the codename stays).
- **`origin`** = `git@github.com:deadeye636/switchboard.git` — our repo. `main` is the default branch.
  Pushed via SSH; `core.sshCommand` points at native Windows OpenSSH so the Bitwarden SSH agent
  is used (Git-bundled MSYS ssh can't reach the agent pipe — see memory `ssh-key-bitwarden`).
- **Reference branches on origin** (read-only snapshots of the porting sources, recognizable by
  name, not generic): `haydng` (= `haydng/main`, the base) and `jbr` (= `jbr/main`, feature source).
- **Upstream remotes** (fetch sources for porting): `haydng` (base), `jbr` (JeanBaptisteRenard —
  feature source), `upstream` (doctly — original). Plus extra read-only forks.
- `../switchboard-jbr` = a read-only **git worktree** on `jbr/main` for reference.
- All forks diverged from merge-base `b98c2f8`. Version numbers between forks are not comparable.

Feature-adoption catalogue: `docs/jbr-uebernahme-katalog.html` (JBR candidates with refs).

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

- `npm test` — runs `node --test` over `test/*.test.js`. No Electron needed. Keep it green (run it for the current pass count — don't rely on a hardcoded number here).
  (Note: `trigger-watcher.test.js` uses real `fs.watch`/timers and takes ~5 min — run the suite in the background.)
- `npm start` — bundles CodeMirror, then launches Electron.
- `npm run build:win` — NSIS installer → `dist/Switchboard Setup <ver>.exe`.

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

## Conventions

- **Git commits: always via the `git-commit` skill**, not raw `git commit`. The skill
  builds a Conventional-Commits message in **German**. Only fall back to raw `git commit`
  if the skill is unavailable. One logical change per commit.
- **Commit only after the feature is confirmed working.** Don't commit a change just
  because tests pass — wait until the behaviour has been verified (manual check in the
  app, or the user confirms it works). Green tests alone are not a green light to commit.
- Don't add a framework, build step, or bundler to the renderer beyond the existing esbuild CodeMirror bundle.
- When touching `db.js` schema: append a migration, never edit an existing one.
- When adding IPC: handler in `main.js` + binding in `preload.js` + (if it returns to UI) a renderer caller.
- Prefer `execFile` over shell string interpolation for any external process (security).
- **User-facing UI text is English** (settings labels/descriptions, sidebar labels, dialogs,
  tooltips) — match the existing strings. Commit messages stay German (see above); code
  comments may be either, but anything shown in the app is English.
