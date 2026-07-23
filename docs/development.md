# Development

Everything you need to build, run and package Switchboard from source. The [README](../README.md)
covers what the app *does*; this page covers working on it.

## Prerequisites

- **Node.js** 20+
- **npm** 10+
- Platform build tools for the native modules (`node-pty`, `better-sqlite3`):
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `build-essential`, `python3` (`sudo apt install build-essential python3`)
  - **Windows**: Visual Studio Build Tools — [`build-windows.md`](build-windows.md) has the current
    toolchain notes (node-gyp override, node-pty patch)

## Setup

```bash
git clone https://github.com/deadeye636/switchboard.git
cd switchboard
npm install          # runs postinstall automatically
```

## Running

| Command | What it does |
|---|---|
| `npm run demo:start` | **The default for development.** A fully isolated instance against seeded demo stores — never touches your real sessions. See [`demo-env.md`](demo-env.md). |
| `npm start` | Bundles CodeMirror, then launches Electron against your **real** stores. |
| `npm run start:debug` | The same with DevTools on port 9222, so the app can be driven from the command line. |
| `npm run electron` | Skips the bundle step — faster iteration once you have run one of the above. |
| `npm run stop:dev` | Stops **this checkout's** dev run (never a different one, never an installed build). |

Both start commands can refuse on purpose — a single-instance lock, or an occupied debug port. That
is the guard working, not a bug.

### Which database

| How you started it | Database |
|---|---|
| `npm start` (dev) | `~/.switchboard-dev/switchboard.db` |
| The installed app | `~/.switchboard/switchboard.db` |
| `npm run demo:start` | `<demo dir>/data/switchboard.db` — see `SWITCHBOARD_DEMO_DIR` |
| A sandbox | `$SWITCHBOARD_DATA_DIR` |

A fix confirmed under `npm start` is confirmed in the **dev** database only.

## Tests

```bash
npm test             # node --test over test/*.test.js — no Electron needed
```

Takes around twenty seconds; `trigger-watcher.test.js` uses real `fs.watch` and timers and sets the
wall clock on its own.

Green tests are not the same as a working app. On any renderer change, drive the running app and
look at what the browser console says:

```bash
npm run start:debug
node scripts/drive-app.js console            # what the renderer logged, incl. failed loads
node scripts/drive-app.js shot out.png       # a screenshot of the window
node scripts/drive-app.js click "<selector>" # click something
```

Any command takes `--target=<substring>` to address a second window (the pop-out settings window, a
changes window) instead of the main one.

## The demo environment

`npm run demo:start` seeds and launches a permanent, isolated demo: five projects, ~40 sessions
across Claude, Codex and Pi, two of the projects are real git repositories with a deliberately dirty
working tree, plus tags, tasks and a synthetic activity history for the Stats page. It writes only
under `SWITCHBOARD_DEMO_DIR` and never reads `~/.claude`, `~/.codex`, `~/.pi` or the real
`~/.switchboard`.

```bash
npm run demo:start            # seed (idempotent) + launch
npm run demo:start -- --debug # the same, with DevTools on port 9222
npm run demo:seed             # just (re)seed the stores, no launch
npm run demo:auth             # copy your CLI logins into the demo home, so a live session can run
```

Full details, including what each isolation variable covers: [`demo-env.md`](demo-env.md).

The demo is also where the README screenshots come from — it is the only place the app can be
photographed without photographing someone's real projects.

## Building

All build commands bundle CodeMirror first, then invoke electron-builder. Output goes to `dist/`.

```bash
npm run build         # current platform
npm run build:mac     # DMG + zip (arm64 + x64)
npm run build:win     # NSIS installer (x64)
npm run build:linux   # AppImage + deb + pacman (host arch; arm64 is built in CI)
```

### Building on Arch / Manjaro

The `deb` and `pacman` targets go through the `fpm` binary bundled by electron-builder, which links
against `libcrypt.so.1`. Arch ships `libxcrypt` without that legacy ABI, so install the compat shim
once:

```bash
sudo pacman -S libxcrypt-compat
```

`AppImage` builds without it.

The pacman package is published as **`switchboard-doctly`** rather than `switchboard`, because the
Arch `extra` repo already ships a package by that name (elementary OS's Pantheon Control Center).
Renaming avoids the file conflict that would block installing both. Only the package identity
changes — the app is called Switchboard everywhere a user sees it. Uninstall with
`sudo pacman -R switchboard-doctly`.

### Code signing

Releases from this repository are **unsigned**. To sign your own build, set:

- **macOS**: `CSC_LINK` (p12 certificate) and `CSC_KEY_PASSWORD`, or sign via Keychain
- **Windows**: `CSC_LINK` and `CSC_KEY_PASSWORD` for EV/OV code signing
- `CSC_IDENTITY_AUTO_DISCOVERY=false` skips signing entirely (CI artifact builds)

The macOS build uses custom entitlements (`build/entitlements.mac.plist`) to allow JIT and unsigned
memory execution, which the native modules require.

## Releasing

Releases are driven by git tags:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions workflow builds every platform and publishes a **draft** release, which is then
published by hand. A local release is possible too — `npm run release` builds and publishes, with
`GH_TOKEN` set to a personal access token with `repo` scope.

There is **no auto-update mechanism**: the upstream `electron-updater` integration was removed on
purpose, because an unsigned build cannot verify an update signature. Updating means downloading the
next release and installing it over the previous one.

## Project structure

All application code lives under `src/`; the repository root holds only project metadata and
tooling. `build.files` in `package.json` is an **allow-list** of `src/**/*` — a new directory
outside `src/` is silently absent from the installer.

```
src/
  main.js          Electron main process — a composition root: requires, DATA_DIR, wiring
  preload.js       Context bridge — the only IPC surface
  app/             Main-process areas: lifecycle, windows, notifications, settings, VCS,
                   variables (+ secrets), hooks, quit guard, terminal/ (spawn, I/O, PTY logic)
  watch/           File watching: Claude's projects dir, the other backends' stores, adoption
  db/              SQLite session cache, metadata, stats, tags, tasks & search queries
  index/           Scan/index layer; session-cache.js is a façade over it
  session/         Transcript reading & session identity
  projects/        The project registry
  vcs/             The version-control seam: provider registry, git provider, porcelain parser
  servers/         MCP IDE bridge
  backends/        One folder per coding CLI (Claude, Codex, Hermes, Pi, agy)
  workers/         Off-thread scanning, indexing, search
  renderer/        HTML/CSS/JS, in folders (shell/, session/, terminal/, views/, …)
  shared/          The few modules BOTH processes load

test/              Unit tests (node --test) for the pure modules
docs/              Feature docs, specs, references
scripts/           Build, demo, and app-driving scripts
build/             Icons, entitlements, builder resources
.github/workflows/ CI/CD
```

## Working on the code

`CLAUDE.md` in the repository root is written for AI agents but describes the same rules a human
contributor follows — where a module goes, why migrations are append-only, why no new IPC handler
belongs in `main.js`, and which document to read before touching an area. The path-scoped rules in
`.claude/rules/` go into more detail per area.

The task board is **GitHub Issues**; `docs/BACKLOG.md` and `docs/BACKLOG.jsonl` are generated
mirrors of it (`node scripts/build-backlog.js`) and are never hand-edited.
