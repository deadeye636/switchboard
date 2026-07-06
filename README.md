# Switchboard

Your command center for Claude Code sessions.

Switchboard is a desktop app that gives you a unified view of all your Claude Code sessions across every project. Launch, resume, fork, and monitor sessions from a single window — no more juggling terminal tabs or digging through `~/.claude/projects` to find that one conversation from last week.

> ## ⚠️ Read this first — private fork, no warranty, no liability
>
> This repository (codename **deadeye**) is a **private downstream fork**, maintained for our own use.
>
> - **Almost all of the software — and all of the credit — belongs to the upstream authors** ([Doctly](https://github.com/doctly/switchboard), [HaydnG](https://github.com/HaydnG/switchboard), and [JeanBaptisteRenard](https://github.com/JeanBaptisteRenard/switchboard)). This fork only adds a thin layer of our own features on top. See [Credits](#license--credits).
> - **This is not an official product.** It is **not affiliated with, endorsed by, or supported by** Anthropic, Doctly, or any upstream author.
> - **No warranty. No support. No liability.** The software is provided *"as is"* under the MIT license, with **no guarantees of any kind**. You use it **entirely at your own risk**. Neither this fork's maintainer nor the upstream authors are liable for any damage, data loss, security incident, or other consequence arising from its use.
> - **Builds are unsigned.** For anything you care about, **build it yourself from source** and run the code you audited — see [Security & Trust](#security--trust).

![Switchboard](build/screenshot.png)

### Key Features

- **Session Browser** — All your Claude Code sessions, organized by project, searchable by content
- **Built-in Terminal** — Connect to running sessions or launch new ones without leaving the app
- **Attention Inbox** — A prioritized queue of every session that needs you, with a "Focus next" jump and a keyboard shortcut
- **Native Notifications** — OS notifications, dock/taskbar badge, and a tray icon when an agent needs you — even when Switchboard is in the background
- **Session Health & Handoff** — Flags long/expensive sessions and turns "Handoff Recommended" into a one-click fresh-start with a context packet
- **Session Groups** — User-defined colored folders for organising agents, with a flexible resize/drag grid layout
- **Usage Monitoring** — Live Claude usage limits (5h / weekly / Opus / Sonnet / quota) with a durable cache
- **Fork & Resume** — Branch off from any point in a session's history
- **Full-Text Search** — Find any session by what was discussed, not just when it happened
- **IDE Emulation** — Switchboard acts as an IDE for Claude CLI, showing file diffs and opens in a side panel where you can accept, reject, or edit changes before they're applied. Supports both inline and side-by-side diff views. Disable this in Global Settings if you prefer Claude to use your own editor (VS Code, Cursor, etc.)
- **Plans & Memory** — Browse and edit your plan files and CLAUDE.md memory in one place
- **Activity Stats** — Heatmap of your coding activity across all projects
- **Session Names** — Picks up session names from Claude Code's `/rename` command automatically

## What this fork adds

Everything below is what **this fork** (deadeye) adds **on top of the base fork**
([HaydnG](https://github.com/HaydnG/switchboard)). Everything else in this README describes
features **inherited** from upstream — credit for those goes to the upstream authors. Some items
here are ports of other community forks (brianstanley, kreaddis), noted where applicable.

- **Tabbed single-view UI** — Session tabs replace the grid as the primary layout (grid stays as a legacy mode), with a right-click **tab context menu** (Close / Stop / Relaunch), auto-close, and viewer close buttons. The top menubar is removed for a cleaner window.
- **Projects tab** — A dedicated project-management view: add projects manually or automatically, hide/restore projects, rename them, and a per-project `.work-files/` browser (view, delete, JSON/JSONL export).
- **Sidebar power tools** — Mark projects as favorites, sort projects, keep an own favorites list, and configure the collapse state on startup.
- **Terminal comfort & fixes** — Configurable font, size and zoom (Ctrl+mouse-wheel plus status-bar buttons), paste images/files from the clipboard via Ctrl+V, a right-click behavior dropdown (Menu / Copy / Paste / Native), a mouse-mode dropdown (Native / Select PowerShell-style / Off — Select keeps native wheel scroll in a TUI while a left-drag selects text locally), an external-terminal + file-explorer launcher, and a batch of Windows ConPTY rendering fixes.
- **Bookmarks & session tags** — Per-message transcript bookmarks (with a hover gutter to bookmark, copy or turn a message into a task) and colored session tags, persisted in SQLite for fast recall.
- **Task / note system** — Scoped tasks (project, session, or a specific transcript message) with status (open / in progress / done / dropped), notes and a captured quote. Create one from a transcript selection or whole message (block gutter, right-click, or a configurable shortcut) or from the terminal (right-click / shortcut). Jump from a task to its transcript source, or open (and start, if stopped) the live session. Open the list from the project header or per-session from the terminal toolbar; session cards show an open-task count badge and the project icon highlights when a project has open tasks.
- **Saved Variables** — A reusable snippet/template panel with quick-pick, insert-template and a management tab (port of brianstanley's feature).
- **Handoff library** — Save handoff packets, edit the prompt before sending, resume from a saved handoff, seed a fresh "New session" directly, and pick the target in the review dialog.
- **Per-session AFK timeout** — Configurable idle handling per session.
- **Token/usage stats** — Per-(session, date, model) token, tool and message metrics collected into the DB.
- **Settings overhaul** — Two-column layout, sticky Save/Cancel bar, an optional pop-out settings window, and permission modes aligned to the Claude CLI.
- **Usage & search tweaks** — Status-bar usage as color-threshold progress bars; search with a 3-char minimum and an explicit reindex (Enter / refresh button).
- **About tab** and a **GitHub-Issues backlog** (issues are the task board, mirrored to `docs/BACKLOG.md`; an `upstream:check` tool detects portable upstream changes).
- **Extra security hardening** — Ported hardening (kreaddis #46) plus dependency audit fixes, on top of the upstream hardening wave.

A per-module breakdown of both the inherited and the fork-specific features lives in
[`docs/fork-features.md`](docs/fork-features.md).

## Session Grid Overview

Toggle the grid overview from the sidebar for a bird's-eye view of all your open sessions at once, grouped by project.

![Session Grid Overview](build/screenshot-grid.png)

- **Live terminals** — Every open session renders its full terminal in a card, so you can monitor multiple Claude agents simultaneously.
- **Status at a glance** — Each card shows a status chip (Needs You / Ready / Working / Running / Exited / Idle), an indicator dot, and last-activity timestamp.
- **Status filters** — Filter the grid to All / Needs You / Ready / Running, with live per-project and per-group counts.
- **Bulk actions** — Step through the attention queue, mark all ready sessions as seen (with undo), or stop all running sessions (with a confirmation listing what's affected).
- **Auto-open running sessions** — Sessions with a live process surface in the grid automatically by reattaching — never by spawning a new `claude`.
- **Flexible layout** — Resize cards (snap-to-grid spans) and drag to reorder them; the layout persists across restarts. A "reset layout" restores the uniform grid.
- **Click to focus, double-click to expand** — Click a card header to focus it; double-click to switch back to single-terminal view for that session.
- **Persistent** — Grid preference is saved across restarts.

## Session Groups

Organise agents into user-defined, named, colored **groups** ("folders") — beyond the automatic project and slug grouping.

- **Collapsible sections** in the sidebar and bounded, labeled **regions** in the grid.
- **Rolled-up counts** — A collapsed group still shows how many of its sessions need you.
- **Group filter** in the grid, and a one-click **"Launch all"** that opens every member (skipping ones already open).
- **Persistent** — Group membership and collapse state are saved across restarts.

## File Preview Side Panel & Claude IDE MCP Emulator

Switchboard can act as an IDE for your Claude Code sessions. When enabled, Claude's file opens and proposed edits appear in a side panel next to the terminal instead of being sent to an external editor.

![IDE Emulation](build/screenshot-ide.png)

- **Diff review** — When Claude proposes a file change, it shows up as a diff in the side panel. You can review the changes and accept or reject them directly.
- **Inline & side-by-side** — Toggle between inline (unified) and side-by-side diff views. Your preference is remembered across sessions.
- **Partial acceptance** — In inline mode, you can accept or reject individual chunks within a diff, then submit the final result.
- **File viewer** — Clickable file links in terminal output (OSC 8 hyperlinks) open in the side panel with syntax highlighting.

To disable IDE emulation entirely (e.g. if you want Claude to use VS Code or Cursor instead), uncheck **IDE Emulation** in **Global Settings**. This stops Switchboard from registering as an IDE, so Claude CLI will discover and connect to your real editor. Changes take effect on new sessions — running sessions are not affected.

## Status Notifications

Switchboard monitors all your sessions in the background and shows status indicators in the sidebar so you can tell at a glance which sessions need attention — even when you're working in a different one.

![Status Notifications](build/screenshot-notifications.png)

- **Waiting for input** — A session that needs your response is highlighted so you don't miss it.
- **Permission approval** — When Claude is blocked waiting for a permission grant, the session badge lets you know immediately.
- **Activity indicators** — See which sessions are actively running, idle, or finished.

### Notify me even when I look away

The attention signal follows you out of the app window:

- **Native OS notifications** when a session needs you while Switchboard is unfocused — click one to focus the window and that session.
- **Dock / taskbar badge** showing how many sessions are in the inbox, and a **tray icon** with a summary tooltip and quick menu (Open / Focus next attention / Quit).
- **Coalesced & throttled** — five agents finishing at once become one "3 sessions need you", not five toasts.
- **Hotkey** (default `Cmd/Ctrl+Shift+A`) to jump to the next session needing attention, and an optional **alert sound** on a new "Needs You".
- **Reliable detection** via Claude Code hooks (catches permission/tool prompts the terminal heuristic misses), with the original heuristic as a fallback. Opt-in in Global Settings.

Toggle notifications, sound, and notify-on-Ready in **Global Settings**.

## Agent Supervision

Switchboard treats your sessions like an agent control room — surfacing not just *that* a session changed, but what it's doing and whether it's getting expensive.

- **Attention inbox** — A prioritized list of every session needing you, with a "Focus next" button to cycle through them.
- **Session health** — Each session is rated Healthy → Growing → Marathon Risk → Handoff Recommended based on turns, transcript size, active time, and cache-read tokens — showing exactly which thresholds it crossed.
- **One-click handoff** — When a session gets long/expensive, a guided flow asks the agent for a handoff packet, starts a fresh lean session seeded with it, and switches to it. Every token-spending step is explicit.
- **"While you were away"** — Returning to a session shows a dismissible summary of what happened and which files it touched since you last looked.
- **Per-session timeline** — A searchable event log (started, busy, needs-you, ready, exited, stopped, forked) separate from raw scrollback.
- **Usage monitoring** — Live Claude usage limits (5h, weekly, Opus, Sonnet, extra-usage quota), with a durable cache that survives rate limits.
- **Spring cleaning** — Bulk-clear stale and "abandoned short" sessions (conservative bounds; never touches starred, archived, or live sessions).
- **Safer controls** — App-styled confirmation dialogs for destructive actions, with affected counts/names and an undo path where supported.

## Editor

| Shortcut | Action |
|----------|--------|
| `Cmd+F` / `Ctrl+F` | Find in file (also works in terminal) |
| `Cmd+G` / `Ctrl+G` | Go to line |
| `Cmd+Shift+A` / `Ctrl+Shift+A` | Focus next session needing attention |
| `Cmd+Shift+G` / `Ctrl+Shift+G` | Toggle grid overview |

## Security & Trust

These fork builds are **unsigned** and are **not audited, reviewed, or vouched for by anyone**.
For anything you care about, **build it yourself from source** rather than trusting a prebuilt
binary from a third party:

```bash
git clone https://github.com/deadeye636/switchboard.git
cd switchboard
npm install
npm run build   # or build:win / build:mac / build:linux
```

That way you run exactly the code you can read and audit, with no trust placed in an opaque
artifact. Any prebuilt release is **convenience-only** — see the disclaimer at the top of this
README: no warranty, no liability, use at your own risk.

## Download

Prebuilt (unsigned) releases for your platform — **convenience only**, prefer building from
source (see [Security & Trust](#security--trust)):

**[Download Switchboard](https://github.com/deadeye636/switchboard/releases/latest)**

- **macOS**: `.dmg` (Apple Silicon & Intel)
- **Windows**: `.exe` installer
- **Linux**: `.AppImage`, `.deb`, or `.pacman` (Arch/Manjaro)

### macOS: first launch (unsigned build)

These builds are **not code-signed or notarized by Apple**, so macOS Gatekeeper will block the app on first launch ("Switchboard is damaged" / "cannot be opened because the developer cannot be verified"). This is expected — to approve it:

1. Move **Switchboard.app** to `/Applications` and double-click it once (it will be blocked).
2. Open **System Settings → Privacy & Security**, scroll to the **Security** section, and click **Open Anyway** next to the Switchboard message.
3. Confirm **Open** in the dialog. You only need to do this once.

If it still won't open, clear the quarantine attribute from a terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Switchboard.app
```

> **Auto-updates are disabled on macOS for these builds.** Because the app is unsigned, `electron-updater` can't verify update signatures, so it won't auto-install new versions on macOS. Download newer releases manually and re-run the approval step above. (Signed Windows/Linux builds update normally.)

## Prerequisites

- **Node.js** 20+
- **npm** 10+
- Platform build tools for native modules:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `build-essential`, `python3` (`sudo apt install build-essential python3`)
  - **Windows**: Visual Studio Build Tools or `npm install -g windows-build-tools`

## Development Setup

```bash
# Install dependencies (runs postinstall automatically)
npm install

# Start the app
npm start
```

`npm start` bundles CodeMirror and launches Electron. For faster iteration after the first run:

```bash
npm run electron
```

## Building

All build commands bundle CodeMirror first, then invoke electron-builder.

```bash
# Current platform
npm run build

# Platform-specific
npm run build:mac     # DMG + zip (arm64 + x64)
npm run build:win     # NSIS installer (x64 + arm64)
npm run build:linux   # AppImage + deb + pacman (x64 + arm64)
```

Output goes to `dist/`.

### Building on Arch / Manjaro

The `deb` and `pacman` targets are built via the `fpm` binary bundled by
electron-builder, which links against `libcrypt.so.1`. Arch ships `libxcrypt`
without that legacy ABI, so install the compat shim once:

```bash
sudo pacman -S libxcrypt-compat
```

`AppImage` builds without it.

The pacman package is published as **`switchboard-doctly`** rather than
`switchboard` because the Arch `extra` repo already ships a package named
`switchboard` (elementary OS's Pantheon Control Center). Renaming avoids the
file-conflict that would block installation alongside it. The app itself is
still called Switchboard everywhere users see it — only the package identity
changes. Uninstall later with `sudo pacman -R switchboard-doctly`.

## Releasing

Releases are driven by git tags:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions workflow builds for all platforms and publishes to GitHub Releases. You can also release locally:

```bash
npm run release   # builds + publishes to GitHub Releases
```

Set `GH_TOKEN` in your environment (a GitHub personal access token with `repo` scope).

## Auto-Updates

The app uses `electron-updater` to check for updates from GitHub Releases on launch and every 4 hours. Updates are only checked in packaged builds (not during development). The flow:

1. App auto-downloads updates in the background
2. A toast notification appears when the update is ready
3. User can restart immediately or dismiss (installs on next quit)

> **macOS limitation:** auto-updates require a signed app. Since these fork builds are unsigned, `electron-updater` cannot verify the downloaded update and will not install it on macOS — update manually by downloading the latest `.dmg`. Windows and Linux builds auto-update normally.

## Code Signing

For distribution, set these environment variables:

- **macOS**: `CSC_LINK` (p12 certificate) and `CSC_KEY_PASSWORD`, or sign via Keychain
- **Windows**: `CSC_LINK` and `CSC_KEY_PASSWORD` for EV/OV code signing
- Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing (CI artifact builds)

The macOS build uses custom entitlements (`build/entitlements.mac.plist`) to allow JIT and unsigned memory execution, required by native modules (node-pty, better-sqlite3).

## Project Structure

```
main.js            Electron main process
preload.js         Context bridge (IPC bindings)
db.js              SQLite session cache & metadata
public/            Renderer (HTML/CSS/JS), incl. pure supervision modules
test/              Unit tests (node --test) for the pure modules
docs/              Feature docs (see docs/fork-features.md); backlog = GitHub Issues / docs/BACKLOG.md
scripts/           Build & postinstall scripts
build/             Icons, entitlements, builder resources
.github/workflows/ CI/CD
```

## License & Credits

Licensed under the **MIT License** — see [`LICENSE`](LICENSE). MIT includes an explicit
**no-warranty / no-liability** clause; it applies in full to this fork.

**Credits.** Switchboard was created by **[Doctly](https://github.com/doctly/switchboard)** and
substantially extended by **[HaydnG](https://github.com/HaydnG/switchboard)** and
**[JeanBaptisteRenard](https://github.com/JeanBaptisteRenard/switchboard)**. **Nearly all of the
work and merit belongs to them.** This fork (deadeye) only adds a small set of our own features on
top and repackages the app for our own use. Some of those additions are themselves ports of other
community forks (brianstanley, kreaddis), credited in the commit history.

This fork is **not affiliated with, endorsed by, or supported by** Anthropic, Doctly, or any of the
upstream authors.
