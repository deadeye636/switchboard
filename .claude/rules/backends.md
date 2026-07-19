---
paths:
  - "src/backends/**"
  - "src/session/**"
  - "src/servers/**"
  - "src/projects/**"
---

# Backends

The app runs **several coding CLIs** (Claude, Codex, Hermes, Pi; `agy` planned), not just Claude.
One folder per backend — `index.js` (registry) + `claude/` (a **thin adapter**: the core still
imports Claude's readers directly instead of going through the descriptor, which is why they are not
in that folder) + a folder per Axis-B binary.

**Read first:** `docs/specs/09-multi-llm.md` (the contract + why each decision is what it is) and
`docs/backend-formats.md` (what each backend actually writes — taken from real installs, because the
published docs were wrong in three places).

## THE DESIGN RULE: the core is neutral, the backend declares what it can do

A capability that varies per backend (lineage/provenance, cost, usage, fork, compaction, live-id
adoption, …) is NOT a `switch (backendId)` in the core and NOT a Claude implementation with the
others bolted on. It is a **descriptor hook** each backend implements to declare *whether* it
supports the thing and *how* it reads it from its own format; the core calls the hook and treats a
missing/`null` answer as "this backend doesn't do that."

Build the neutral seam FIRST, then fill it in per backend — **never ship the Claude path and call
the rest a follow-up**, because that is exactly how a feature ends up hard-wired and an "island"
(#193 shipped Claude+Hermes only and had to be redone). If you cannot verify a backend's signal
against its real format, the hook returns `null` for it *on purpose* and that is documented — an
honest gap, not a fake read. `test/backend-parity.test.js` is where you assert every backend answers
the hook (even if to decline).

Everything derives from the descriptor: spawn routing, scanning, the watcher, the launch menu, the
generated settings page and Configure dialog, the sidebar badge, search, stats, resume — plus session
**lineage** (`resolveLineage`, #193/#223), the **transcript path** for a row (`transcriptPathFor`,
#211), per-project **config/meta** (`projectMeta`, #211 — Claude's `~/.claude.json`), where a backend
keeps its **plans + memory/instruction files** (`plansDir` / `memorySources`, #227), whether it has
**subagents** (`supportsSubagents`, #230 — only Claude does), and its CLI home variable
(`cliHomeEnv`, #241).

## Don't hardcode a backend id outside its own folder

`src/main.js` / `src/app/**` / `src/watch/**` / `src/index/session-cache.js` / `src/renderer/**`
contain none and must not gain one. The core reads no backend's format and hardcodes no `~/.claude`
path; `test/backend-path-neutrality.test.js` is the guard for the last one (a hardcoded store PATH is
a backend id the id-hunt cannot see). `test/backend-integrations.test.js` guards the renderer.
**#211** is the same migration in `src/projects/projects.js` and is still open.

**Reaching for a backend id nobody named? There are exactly two honest answers** (#212/#225), and
the code must say which:

1. it is **reading a record from before the multi-LLM era** — a template with no `backendId`
   predates #161, when a template was always Claude. Bind it to a named `LEGACY_TEMPLATE_BASE` /
   `LEGACY_SESSION_BACKEND`.
2. it resolves to the **first LAUNCHABLE backend** — `firstLaunchableBackendId()` in
   `backend-registry.js`; `''` when nothing is launchable, and `''` must not be turned back into an id.

`|| 'claude'` is neither: Claude is disablable (#162), so it hands back a backend that cannot spawn.

## A file-mode backend composes `src/backends/file-store.js`

It does not copy the walk. Discovery, `watchTargets`, the birth-time `matchLiveSession` and the
suffix `liveRefFor` are the same code for every backend that keeps one transcript per session;
declare `root` (lazy), `matches`, `parseSession` and `refSuffix` and take the rest. `findOnPath`
lives there too (PATHEXT — the npm CLIs are `.cmd` shims).

## `configFields`: a default describes what the CLI does anyway — it is NEVER sent

It is what a control shows when nobody has said otherwise, not a value to put on the command line.
Only what someone actually chose reaches the argv. Every non-empty default used to be seeded into the
launch, so a plain Codex session carried `-a on-request -s workspace-write` although the user had
chosen neither, overruling their own `config.toml` in silence. **Write a default that matches what
that CLI already does** — it is a description of the CLI, not a wish.

`test/backend-config-fields.test.js` also refuses a declared option that changes nothing (a control
that lies), unless it says why: `appliesAt: 'spawn'` (`app/terminal/spawn.js` applies it, not the
argv) or `requires: '<other>'` (meaningless on its own).

**Options cascade PER OPTION**, and every level stores only what it marked as set:
`backend default → global → project → template`. Without that marker, "not set" cannot be told from
"deliberately empty / off", and an option whose default is ON could never be switched off. The
Configure dialog sits on top as a per-session override; its markers start ticked, so opening it and
pressing Start changes nothing.

## Adding or changing one → run `npm test`, then check the siblings

`test/backend-parity.test.js` asserts the properties every backend must share (an availability probe;
an honest `supportsFork`; all three identity hooks if it names its own sessions; a versioned
incremental parser). It exists because the same defect got fixed in one backend four separate times
while its siblings quietly kept it — **fix a backend, check its siblings**.

## `src/projects/**` — the migration that is still open (#211)

`src/projects/projects.js` and `project-registry.js` are the **last** place the id-neutrality rule
above is not yet enforced by a guard. Treat every backend id you find there as a defect to remove,
not as precedent to copy: the same two honest answers apply (a `LEGACY_*` binding for a pre-#161
record, or `firstLaunchableBackendId()`), and per-project config/meta belongs behind the descriptor's
`projectMeta` hook (#211), never behind a `~/.claude.json` literal.

Its Claude-home reader **and writer** was one of the four modules that composed a path from
`os.homedir()` inside an isolated instance — resolve it from `SWITCHBOARD_STORE_CLAUDE`, per call
(#241, `test/store-isolation.test.js`).

## `src/servers/**`

`mcp-bridge.js` (the MCP IDE bridge) and `schedule-*.js` (the scheduler). Two things bite here:

- The scheduler **ticks every 60 s on EVERY boot** and pre-seeds session files, and the bridge writes
  lock files. Both did that against the real Claude home from an instance that promises it touches
  nothing real — resolve the home per call (#241).
- The scheduler's enable gate (#162) had no test while it sat in Electron-bound main.js. Anything
  moved here takes `ctx`, not a top-level `require('electron')` — see
  `.claude/rules/main-process.md`.

## Session data sources

`~/.claude/projects/**/*.jsonl` via `src/session/derive-project-path.js`,
`src/workers/scan-projects.js`, `src/index/session-cache.js`,
`src/session/session-transitions.js`, and Claude's own readers in `src/backends/claude/`
(`session-reader.js`, `store-indexer.js`).

Store roots are overridable per backend (`SWITCHBOARD_STORE_<BACKEND>`), and where the CLI *writes*
is a separate thing (`cliHomeEnv`) — see `docs/ai/running-and-data.md`.
