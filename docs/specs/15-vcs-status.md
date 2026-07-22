# Spec 15 — VCS-aware session cards (chip + changes window)

> Read `docs/specs/README.md` first.

**Status:** Implemented (#277) · **Independent:** renderer + a new `src/app/` module + a new `src/vcs/` seam

## Problem

A session's working directory is usually a git repo, but Switchboard showed nothing about its state — you
had to drop to a terminal to see the branch or whether the tree was dirty. The ask: surface live
version-control state on the sidebar project/worktree headers and grid session cards (branch + change
counts, an in-progress badge for rebase/merge), with a click-through to the changed files — and do it so a
non-git VCS (Mercurial, Subversion) can be added later without touching the core.

## The neutral seam — the core never names a VCS

Mirrors the backend registry (Spec 09). `src/vcs/` is a registry of **providers**, each a descriptor with
hooks; the core detects the owning provider for a working directory and drives those hooks. git is the only
shipped provider; hg/svn would be sibling files, registered with one line, no core change.

| Hook | git provider |
|------|--------------|
| `detect(cwd)` | walk up for a `.git` **file or dir** (worktrees write a `.git` file), filesystem only, no spawn |
| `capabilities` | `{ branch, staging, untracked, conflicts, state }` — what this VCS has |
| `statusArgs(opts)` | `['--no-optional-locks','status','--porcelain=v2','--branch','-z', …]`; adds `-uno` when untracked counting is off |
| `parse(raw, opts)` | pure porcelain-v2 parser → normalized summary (`src/vcs/parse-git-status.js`) |
| `detectState(cwd)` | in-progress op from `.git/` markers (MERGE_HEAD → merging, rebase-merge → rebasing, …) — filesystem only, no extra spawn |
| `probe()` | is the binary on PATH |
| `netFree` | `true` — the status path must never hit the network (parity-asserted) |

`test/vcs-parity.test.js` requires every registered provider to answer the whole contract (even to decline)
and asserts `netFree`.

### Normalized form (the contract)

```
summary = { branch: string|null, state: null|'merging'|'rebasing'|'detached'|'cherry-picking'|'reverting',
            staged: n|null, unstaged: n|null, untracked: n|null, conflicted: n|null, files: [...], truncated }
```

`null` ≠ `0`: a segment a VCS does not have (Subversion has no index → `staged: null`) is `null`, and the
chip omits it — never a false `0`. A file staged **and** modified again (`MM`) counts on both sides and
appears once per group, so the chip counts always equal the file list. Counts derive from the file rows.
`--no-optional-locks` is a **global** git flag — it MUST come before `status` (git rejects it as a status
option). The parser caps the file list (memory + CPU) and flags `truncated`.

## The poller — `src/app/vcs.js` (no worker)

git runs via **async `execFile` directly in the main process** — the same pattern the old `worktree-status`
handler used (which moved into this module, gaining `--no-optional-locks`). No worker: the git subprocess is
off the event loop already, and the parse is capped. A dedicated `createScheduler(...)` holds the
dedupe/backoff/concurrency logic and is injected with its deps so it is `node --test`-able
(`test/vcs-scheduler.test.js`); `init`/`registerIpc` wire the real `execFile` + Electron on top (ctx rule).

- **Poll scope (F1):** the renderer reports the repo cwds currently on screen (`vcs-watch`); the poller polls
  exactly those, cached per cwd, with a 4 s timeout, per-cwd exponential backoff, a concurrency cap with
  jitter, and a 1 s heartbeat governed by each cwd's `nextDue`. Open changes-window cwds are unioned in so an
  open window keeps polling.
- **git init detected live:** a non-repo cwd is re-detected on each `watch`, so a project the user just ran
  `git init` on gets a chip on the next render, not only after a restart.
- **H1 (`--no-optional-locks`):** the background poll must never take `index.lock` and fight the session's
  own agent. Non-negotiable — these are the sessions the chip describes.
- **State merge:** a rebase detaches HEAD, so `parse` would say `detached`; `detectState` wins.

## Renderer — the chip

The main-process pushes `vcs-status-changed`; `src/renderer/shell/sidebar-vcs.js` keeps a renderer-side cache
and reads it **synchronously when a header is built** (the `tasksBtn` pattern) — never an async DOM patch,
which the next morphdom render would wipe (the #229 trap). A push updates the cache and requests a debounced
re-render.

- A **git glyph button** sits on every project/worktree header (and grid card) — always present for a repo,
  always opens the changes window. This is the "button suffices" affordance.
- A **branch/counts badge** (pill) is **opt-in** (`vcsShowBadge`, default off): branch + `+staged ●unstaged
  ?untracked`, an amber `rebase`/`merge` badge for in-progress, `✓` for clean. The pill is a header SIBLING,
  so it carries its cwd in `dataset.vcsCwd`, read by a single **top-level `.vcs-open`** delegate in
  `sidebar-events.js` (a header-scoped delegate could never catch a sibling).
- **Grid card chip:** `buildCardChip` renders the full badge when `vcsShowBadge` is on, else a glyph-only
  icon; `patchCardChips` live-updates mounted cards (the grid keeps cards in place). No backend/VCS id in the
  renderer.

## The changes window — one per repo

A standalone `BrowserWindow` per cwd (`Map`, focus-if-exists, **destroy-on-close**; `destroyAllVcsWindows`
is called from the main-window close in `windows.js`, or `window-all-closed` never fires). Loads
`src/renderer/changed-files.html` + `changed-files.js` — an **external** script, because the app enforces a
`script-src 'self'` CSP that blocks inline. It lists the changed files grouped by state (conflicts first),
renames as `old → new`, with **Open** (the existing hardened `open-path`) and **Reveal**
(`shell.showItemInFolder`), a Refresh button and live refresh on the same per-repo poll. Chip counts and the
file list come from one porcelain snapshot, so they never disagree.

## Settings (global)

| Key | Default | Effect |
|-----|---------|--------|
| `vcsChipEnabled` | `true` | master switch; off → no chip, poll cleared |
| `vcsShowBadge` | `false` | show the branch/counts badge; off → glyph button only |
| `vcsPollSeconds` | `20` | poll interval (min 5, clamped) |
| `vcsCountUntracked` | `true` | off → `git -uno`, faster/quieter in huge repos, `untracked: null` |

Under **Settings → Projects & Sidebar → Version control**. Documented in `docs/settings-reference.md`.

## As built / known gaps

- The `worktree-status` handler for the worktree-delete dialog moved out of `main.js` into `src/app/vcs.js`
  (behaviour-identical + `--no-optional-locks`); removed from the `main-no-new-ipc` allow-list.
- A project shown only as a grid card but filtered out of the sidebar is not polled (its cwd never enters the
  watch set) → no chip. Degraded, not broken.
- A null-summary push removes a mounted grid card chip until the next full grid rebuild.
- hg/svn are validated against on paper only; no provider ships. The seam + parity test keep the core honest.

## Files

`src/vcs/{index,git,parse-git-status}.js`; `src/app/vcs.js`; `src/renderer/shell/sidebar-vcs.js`,
`sidebar.js`, `sidebar-events.js`; `src/renderer/views/grid-view.js`; `src/renderer/changed-files.{html,js}`;
`src/renderer/panels/settings-global-html.js`, `settings-panel.js`; `src/renderer/style.css`; `src/main.js`,
`src/preload.js`, `src/app/windows.js`. Tests: `test/vcs-{parse-git-status,parity,scheduler}.test.js`.
