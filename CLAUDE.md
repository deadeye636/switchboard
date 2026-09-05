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
(Claude, Codex, Hermes, Pi, agy) across projects. `README.md` has the user-facing feature list.

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
| handoffs — where a packet lives, the picker, leaving the database | `docs/specs/25-handoffs.md` (why) + `docs/handoffs-convention.md` (what) |
| plans — the list, the picker, the convention, the viewer's liveness | `docs/specs/20-plans.md` (why) + `docs/plans-convention.md` (what) |
| writing a file a CLI reads — a skill, a rule, a settings blob | `docs/specs/24-resource-editing.md` (why) + `.claude/rules/main-process.md` (the rule) |
| the settings screen — a category, a count, a per-backend page, what the search may open | `docs/specs/26-settings-screen.md` (why) + `.claude/rules/renderer.md` (the rule) |
| attention — busy/ready, the hooks, a turn that announces nothing | `docs/specs/05-hook-attention-detection.md` (why) + `.claude/rules/main-process.md` (the rule) |
| a release, a tag, an installer | `docs/ai/release.md` |
| the human-facing build/run/package instructions | `docs/development.md` |
| running/verifying, databases, store isolation | `docs/ai/running-and-data.md` |
| driving the app without clicking | `docs/ai/driving-the-app.md` |
| a performance question — what the app costs, what a frame did, whether an animation is composited | `docs/ai/driving-the-app.md` (the two tools) + `docs/ai/lessons.md` (how this measurement goes wrong) |
| remotes, cherry-picking from a fork | `docs/ai/fork-and-porting.md` |
| the Windows build toolchain | `docs/build-windows.md` |
| why a rule exists / what it cost | `docs/ai/lessons.md` |

## The reflexes (these bite everywhere)

1. **Commit only after the behaviour is confirmed**, not when tests pass. Green tests are not a green
   light — see `docs/ai/lessons.md` for the four that shipped green and broke on first click.
2. **On any renderer change the click IS the test.** `node scripts/drive-app.js console` catches the
   `ReferenceError` the suite cannot see. Two ways to check the wrong thing: a **renderer reload does
   not reload `src/app/**`** (restart the app, or you are reading the previous main process), and a
   **synthesised event is not an interaction** (`drive-app.js drag` exists because dispatched
   `DragEvent`s passed a drag that a real mouse could not perform).
3. **Migrations are append-only.** `migrations.length` IS the schema version; renumbering corrupts
   user databases.
4. **No new IPC handler in `src/main.js`** — it goes in an `src/app/` module.
   `test/main-no-new-ipc.test.js` will say so.
5. **No backend id outside its own folder.** A capability that varies per backend is a descriptor
   hook, never a `switch (backendId)` in the core, and never `|| 'claude'`.
6. **No personal or local identifiers. Anywhere that leaves this machine.** No personal name, email,
   machine or account name, and **no real path** — that includes a bare drive letter and folder
   (`<drive>:\<your-folder>\…`), not only a home directory. Use `~`, `<project>`, `<user>`, or an
   obviously invented path. It binds **every** artifact, and an enumeration is how the last one got missed, so
   read it as *all of them*: code, comments, tests and their **fixtures**, docs, specs, `.claude/**`,
   file **names**, commit messages, issue and PR titles, bodies **and comments**. The repo is public;
   git history and issue **edit history** are world-readable and effectively permanent, so a deletion
   afterwards un-publishes nothing. **The check happens before you write, because there is no
   afterwards** — a rewrite of public history is not on the table for a stray path.
7. **English. Every artifact in the previous rule, same list, no exceptions.** Not "commits and UI
   text" — docs, specs, rules, test names, handoffs and issue comments too. `docs/build-windows.md`
   sat in the public repo in German for months because the rule used to name three artifact kinds and
   a reader could conclude a doc was not one of them. What you write **to** a person in chat follows
   the conversation's language; what you write **into a file or an issue** is English regardless.
   One logical change per commit, Conventional Commits.

   Both rules are cheap to audit and nothing enforces them yet:
   `grep -rP '\b(nicht|wird|dass|keine|damit|beim)\b'` over the tracked tree finds German prose,
   `grep -riP '(C:\\Users\\[A-Za-z]|[A-Z]:[\\/]\w+[\\/])'` finds real paths. Run them on what you are
   about to commit rather than trusting that someone else did.
8. **A new control in the renderer inherits NO styling** — reuse an existing class, never ship a bare
   `<button>`.
9. **A setting added/renamed/re-scoped/re-defaulted → `docs/settings-reference.md`.** Same for a new
   `SWITCHBOARD_*` env var or script.
10. **Prefer `execFile`** over shell string interpolation for any external process — and a probe that
    only READS a CLI's output must close the child's stdin, or a CLI that reads standard input hangs until
    the timeout. `spawnSync`/`execFileSync` take a `stdio` option for that; **`execFile` silently ignores
    one** and needs `closeStdin(execFile(...))`. `src/backends/cli-probe.js` is the one way there, and it
    does **not** move: its scope stays `src/backends/**`, so a probe outside that folder closes its own
    stdin locally — `src/app/terminal/shell-profiles.js` does (#541); the `git` calls in `src/app/vcs.js`
    and `src/main.js` still do not, and `.claude/rules/main-process.md` says why they were left.
11. **Never `fs.writeFileSync` a file a CLI reads** — `src/app/safe-write.js` is the one way: a baseline
    compare so a stale editor cannot overwrite an agent's work, an atomic rename so a half-written config
    is impossible, and the file's own line endings and BOM kept.
12. **Never ask the settings blob where a project keeps its documents** — `src/app/convention-dirs.js` is
    the one answer for handoffs AND plans, relative and absolute, with the escape guard applied. Three
    surfaces name those directories (the handoff prompts, the plan prompt, a saved variable's insert
    template), and a second reading of `eff.handoffDir` is how two of them start naming different ones.
13. **Never decide "is this path inside that one" with a string compare** — `src/app/path-containment.js`
    is the one way, and it answers about the REAL path of both sides. A junction or a symlink is spelled
    inside a project it is not in, and on Windows a `subst` drive hits that without anyone trying. Ask it
    about the DIRECTORY where the file may not exist yet, and **before** the `stat` — a guard placed after
    one never sees a path that escaped and had nothing at the end of it (#474, #476).
14. **Never strip comments with a pair of regexes** — a test that answers a question about code by reading
    it as text calls `test/helpers/strip-comments.js`, which scans once and knows whether it stands in
    code, a string, a template, a regex or a comment. A line pass plus a block pass loses real code in
    BOTH orders, and these are guards where over-stripping HIDES a violation, so they report success about
    text they never read. `test/strip-comments-shape.test.js` refuses a hand-rolled one anywhere under
    `test/` and has no exemption list — keep it that way (#554, `docs/ai/lessons.md`).

## Backlog & workflow

The task board is **GitHub Issues** on `deadeye636/switchboard`, not a file. Migrated 2026-07-03 from
the old `docs/ROADMAP.md` + plan docs — **issue number = old `#nr` (1:1)**, contiguous #1–#62.

- **Read it:** `gh issue list` / `gh issue view <n>`. For in-context grepping the generated mirror
  `docs/BACKLOG.md`; machine-readable `docs/BACKLOG.jsonl`. Both open-issues-only — **never hand-edit**.
- **Both are gitignored** — a fresh clone or worktree has neither. If one is missing or stale, run
  `node scripts/build-backlog.js`; the result stays local and is **never committed**.
- **Regenerate:** `node scripts/build-backlog.js` after any issue change.
- **New task:** `gh issue create` with the requirement + labels; plan/discuss in comments.
- **Issue shape (keep it):** body = **the requirement only**. Plan/design and implementation go in
  **comments**. Done → an "Umsetzung" comment (with `git log main` commit refs) + close the issue.
  Open items carry no completion comment.
- **Labels:** prio `P1`/`P2`/`P3` (open only), type `bug`/`feature`/`port`/`chore`, `source:*`
  (`jbr`/`brianstanley`/`supacode`/`kreaddis`), `wontfix`. An effort that spans several issues also
  carries an **effort label** so its issues stay findable together — `pi-native` is the first, and
  it sits on the runtime-driven Pi backend plus the work it depends on. List the labels rather than
  trusting this line: `gh label list`.
- `gh` default repo is pinned to `deadeye636/switchboard` (`gh repo set-default`) — always our fork,
  never `doctly`. Decisions still land in commit messages + memory. **A hook refuses** a `gh` command
  naming `doctly`, and a `git push` to any of the read-only fork remotes
  (`.claude/hooks/guard-commands.js`).

## Architecture map

**All app code lives under `src/`.** The repo root holds only project metadata and tooling
(`package.json`, `docs/`, `scripts/`, `test/`, `build/`). `"main"` in package.json is `src/main.js`,
and `build.files` is an **allow-list** led by `src/**/*` — so a new directory outside `src/` is silently
absent from the installer.

| Area | What lives there |
|---|---|
| `src/main.js` | composition root: requires, `DATA_DIR`, the module wiring (count the `.init(` calls rather than trusting a number here), the legacy IPC handlers (`GRANDFATHERED` in `test/main-no-new-ipc.test.js` is the list — count it there) |
| `src/app/**` | the areas main.js used to hold — **list the directory**, an enumeration here goes stale (it missed `backend-models` and `backend-resources` for as long as they existed) |
| `src/preload.js` | the **only** IPC surface — `window.api.*` |
| `src/shared/**` | the four modules **both** processes load (`attention-source`, `custom-launchers`, `variable-insert`, `preview-kind`) |
| `src/renderer/**` | vanilla JS, no framework; plain `<script>` tags, morphdom, `@xterm/xterm`, CodeMirror via esbuild |
| `src/db/**` | `db.js` = façade (#217) over `connection`/`schema`/`migrations` + the stores |
| `src/index/**` | `session-cache.js` = façade (#199) over the index/search worker clients |
| `src/workers/**` | the scan + search workers |
| `src/watch/**` | `projects.js`, `stores.js`, `adopt.js`, `trigger-watcher.js`, `record-claim.js` |
| `src/backends/**` | one folder per coding CLI + `index.js` registry + the shared modules beside them (`file-store.js`, `capabilities.js`, `cli-probe.js`, `resource-expand.js`, … — **list the directory**) |
| `src/session/**` | what happens to a session across its life — transitions, clear-claims, the subagent seam |
| `src/servers/**` | MCP IDE bridge (`mcp-bridge.js`) |
| `src/vcs/**` | the VCS seam (#277) — provider registry + git provider + pure porcelain-v2/diff parser; core is VCS-blind. The poller/IPC live in `src/app/vcs.js` |
| `src/projects/**` | the project registry — backend-neutral since #211 (`projectMeta` / `transcriptPathFor`, no backend module required) |

## Commands

- `npm test` — `node --test` over `test/*.test.js`. No Electron needed. Keep it green (run it for the
  current pass count — don't trust a number written down here). Takes ~20 s:
  `trigger-watcher.test.js` uses real `fs.watch`/timers and is the slowest file at ~19 s, which sets
  the wall clock since files run in parallel. That same file has **hung outright** more than once under
  load — the run sits there with its child alive and no output, for hours if nobody looks — which is why
  the script carries `--test-timeout=60000`: a test that stops making progress fails loudly instead. The
  cap is per TEST, so it does not catch a file that hangs between them; a run past a minute or two is
  still worth killing and re-running rather than waiting out.
- `npm run demo:start` — **the default for dev/verify work**: an isolated demo instance against
  seeded stores under `C:\temp\switchboard`. Backend limitations and the explicit read-only usage
  exception are documented in `docs/demo-env.md`. `npm run demo:seed` seeds
  without launching; `npm run demo:auth` copies credentials into the isolated home. See
  `docs/demo-env.md`.
- `npm start` — bundles CodeMirror and PDF.js, then launches Electron against the **real** stores. The exception,
  for when you deliberately want live data.
- `npm run start:debug` — the same with DevTools port 9222 open → `docs/ai/driving-the-app.md`.
- `npm run stop:dev` — stop **this checkout's** dev run. Killing every `electron` image takes the
  installed app and the other checkouts with it, so a hook refuses that
  (`.claude/hooks/guard-commands.js`).
- `npm run build:win` — NSIS installer → `dist/Switchboard Setup <ver>.exe` → `docs/ai/release.md`.
- `npm run upstream:check` / `upstream:seen` — → `docs/ai/fork-and-porting.md`.
- `npm run backends:help-check` (and one per backend) — does each CLI still advertise the flags this app
  sends, and has it grown any nobody has decided about? Every exclusion carries its reason in the script.
- `npm run backends:changelog-check` / `backends:changelog-seen` — what the backend CLIs shipped since
  the last review. Reports only; whether an entry is worth an issue is a conversation, not a filter.
  Flags and the seen-marker: `docs/settings-reference.md`.

Both start commands can **refuse** on purpose (single-instance lock, occupied debug port). That is
the guard working, not a bug — `docs/ai/running-and-data.md` has the two-line fix.

## Which database

`npm start` (dev) → `~/.switchboard-dev/switchboard.db`. The installed app → `~/.switchboard/switchboard.db`.
A sandbox → `$SWITCHBOARD_DATA_DIR`. **A fix confirmed under `npm start` is confirmed in the DEV
database only.** Verifying against the wrong one looks exactly like a schema the migrations never
touched. Isolation, `userData`, and the per-backend store overrides: `docs/ai/running-and-data.md`.

## Logging

Three tiers (electron-log). Packaged builds default to `info`; the level is a global setting
(**Maintenance → Log level**) and applies live.

| Level | Use it for | Rule of thumb |
|---|---|---|
| `log.info` | **transitions & lifecycle** — busy edges, subagent spawn/complete, hook signals, server start | a handful of lines per turn |
| `log.debug` | **per-decision detail** while diagnosing | readable at a few lines per second |
| `log.silly` | **firehose** — one line per raw event (OSC titles fire on every spinner frame) | only while reproducing a bug |

Put the **state change** at `info` and the **raw event that led to it** at `silly`. Never log a
per-frame event at `info` or `debug` — landing a diagnostic at `debug` is what made #120 invisible.
Log file locations differ between dev and installed: `docs/ai/running-and-data.md`.
