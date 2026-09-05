---
paths:
  - "src/backends/**"
  - "src/session/**"
  - "src/servers/**"
  - "src/projects/**"
---

# Backends

The app runs **several coding CLIs** (Claude, Codex, Hermes, Pi, agy — all five ready), not just Claude.
One folder per backend — `index.js` (registry) + `claude/` (a **thin adapter**, and the one backend whose
readers the core still imports directly instead of going through the descriptor) + a folder per Axis-B
binary + the shared modules beside them (`file-store.js`, `resource-expand.js`, `capabilities.js`,
`cli-probe.js`, … — list the directory rather than trusting an enumeration here).

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
keeps its **plans + memory/instruction files** (`plansDir(scope)` / `memorySources(scope)`, #227 —
both scoped since #450, because a project can point its CLI at a plans directory of its own), how one
of its plan files is **referred to** in its sessions and what it would take to **point it at a project's
plans directory** (`planRef` / `planDirSetup`, #449/#450), where it keeps **handoff packets inside a
project** (`handoffDirs({ projectPath })`, #468 — Claude's handoff skills write into `.claude/handoffs`,
and a core that spelled that would have learned one backend's layout), whether it has
**subagents** (`supportsSubagents`, #230 — only Claude implements the seam; Hermes writes delegated child
sessions its descriptor could describe and does not yet, #553), where its CLI **publishes what changed**
(`changelogSource`, #528 — `npm run backends:changelog-check` asks every backend rather than holding a
list of pages, and a CLI without a public changelog declares `null`), whether it still **owes a turn** it has
not announced (`readTurnQueue`, #495 — a `Stop` that arrives with a prompt still queued is a `Stop`
the core must not believe; Claude reads it out of its own transcript, Pi is told by its binding extension
and remembers it (#530), and a backend that cannot tell answers `null`, which is **not** the same as
"nothing is queued"), and its CLI home variable (`cliHomeEnv`, #241).

## A directory is listed; `expandResource` reads it (#440)

`listResources` names a customization directory as ONE row. What is inside it comes from
`expandResource({ path, source, scope })`, and the walk itself is shared —
`src/backends/resource-expand.js` holds three modes (`skillTree`, `flatFiles`, `dirs`) and each backend
declares which rule each of its directories follows, keyed by the `source` its listing entry carries.

**The rules may be a FUNCTION, not only a map** (#463). Plugin skills are one directory per installed
plugin, so the source carries the plugin's name and no static key can spell it; the backend resolves the
rule instead. That keeps a plugin layout inside the backend's own folder — the walk is still the shared
one. **Two backends do this now** — Claude (#463) and Codex (#536) — and the second one is the reminder
that the resolver has to keep answering the STATIC sources too: a resolver that forgot its map would leave
every ordinary directory unexpandable, and `reachable()` gates read, write and delete on that same answer
(`expandResource.knowsSource`), so nothing else would notice.

A listing entry may also carry `originLabel`, for a directory whose path does not say what a reader should
call it (a plugin is cached under the MARKETPLACE's name, not its own). **And a name that becomes a path
segment is checked before it is joined**: Codex builds its cache path out of an install key from
`config.toml`, and a key spelled `../../..@marketplace` put an arbitrary directory into the listing — which
IS the allow-list every other guard consults. A segment out of a config file is user input.

**Do not put the walk back into `listResources`.** hermes and pi used to enumerate inline, so every
settings-panel open paid for a recursive scan — hermes capped at 500, pi uncapped and unguarded, where
one unreadable subdirectory threw and took the whole listing with it.

**Containment is checked against `realpath`, not against how a path was spelled.** A skills directory is
where symlinks live; `path.relative` alone passes a link that points at a private key.
`app/backend-resources.js` re-derives the listing per call and refuses anything not under a listed
directory — that re-derivation is also what makes a changed store override fail closed.

The real-path half is `app/path-containment.js` since #474, so this file and the plan/handoff directories
give one answer rather than two that drift. What stays here is the CHEAP half and the one difference: the
lexical pre-check that catches `..` before the filesystem is touched, and the rule that a resource has to
EXIST to be handed over. The shared check answers about the nearest existing ancestor instead, because its
other callers name files that are not there yet — do not "simplify" that difference away.

**A path this app HANDS BACK is spelled in the namespace it was ASKED about (#544).** The listing is the
allow-list, and it is spelled the way the project was opened; a path derived from `realpathSync` is spelled
the way the disk holds it. On a project reached through a junction or a symlink those are two strings for
one file, and `createResource` used to validate against the real one and answer with it — so the renderer
opened what it had just created and was told the path is not a discovered resource. Validate against the
real path, write through it, and answer under the directory that was named. `expandResource` already works
this way: it joins onto the listed directory, which is why nothing else in the chain had this bug.

**And a compare that reaches a SCOPE is a containment question too (#545).** `claude/plugins.js` decides
whether a locally installed plugin belongs to the project in front of the user; that answer becomes the
listing entry's `scope`, and it went through a resolved-string compare that was blind to links and
lowercased unconditionally. It asks `app/path-containment.js` (`samePath`) now — the same import direction
`codex/plugins.js` already takes, and the same one CLAUDE.md rule 11 makes mandatory for `safe-write.js`.

## Writing one back is a SECOND declaration (#441)

Reading a resource asks whether the path is reachable. WRITING one asks two more questions, and both
are the backend's:

- **`resourceEditing: { extensions: [...] }`** — which of its files the app may save at all. This is
  what makes "nothing executable" mechanical rather than a promise: pi keeps skills as markdown but
  extensions as `.ts`, hermes hooks are arbitrary files, and a list in the core naming which is which
  would be backend knowledge in the one place this file forbids it. **A backend that declares nothing is
  read-only** — the honest default, rather than a guess about what is safe to overwrite.
- **`resourceScaffolds: [{ kind, layout, sources, template }]`** — what it can CREATE and where. `sources`
  is the same key `expandResource` reads, which is what ties a scaffold to a directory the listing
  already names: a new directory in the listing cannot silently become a create target, and a kind
  cannot be created in a directory that holds a different one. An empty array is an answer.

Three rules around them that are not the backend's:

- **Every guard is re-derived per call** — the listing, the containment check, the format check. Nothing
  is cached in the renderer, so a store override that changed since the list was drawn fails closed.
- **The bytes go through `src/app/safe-write.js`**, never `fs.writeFileSync`: the baseline compare that
  refuses to overwrite a change the editor has not seen, the atomic rename, and the file's own line
  endings and BOM. `src/app/format-validate.js` decides whether the text still parses — by extension,
  because TOML is TOML for every backend.

  **This is not only about the resource editor.** A backend that writes a CLI's config for a feature of
  its own is under the same rule, and both places that did it kept their own temp-file-and-rename for
  months (#542): `claude/config.js` (`~/.claude.json`), `codex/trust.js` (`config.toml`) and
  `pi/trust.js` (`trust.json`) are the writers, and each one is a read-modify-write of the WHOLE file —
  which is what makes the baseline the property that matters. A refusal there is not a failure: re-derive
  against the text that IS on disk and write again, bounded (three attempts is what all three take).
- **Deleting is narrower than writing.** The path must be one the EXPANSION named, of a kind with a
  lifecycle. A settings file is a listed FILE and never an expansion entry, so it is unreachable by
  construction rather than by a deny-list. Which kinds those are is the core's vocabulary, and the
  payload stamps each row with the answer so the renderer never names one.

## The capability matrix is DECLARED, not derived (#439)

`src/backends/capabilities.js` holds the catalog of "what can this backend do"; each descriptor answers
every row with `yes` / `limited` / `no`, and a `limited` answer carries a note saying which half is
missing. **Do not replace that with `typeof descriptor.hook === 'function'`** — nearly every hook exists
on every backend, several of them precisely in order to decline (agy's `cliHomeEnv` returns null, Codex'
`resolveLineage` returns null), so presence says a backend answered the question, not what it answered.

Derivation stays as a *check*: `test/backend-capabilities.test.js` refuses a `yes` whose declaring field
is absent, and pins every backend's every answer by name.

**A new row means every backend answers it, declining included.** A row nobody answered renders as a
visible gap rather than as a no — that is deliberate, not a bug to paper over.

## "Is something else already running this session?" is TWO hooks (#172)

`liveOwnersCached()` reads a cache and **never spawns**; `refreshLiveOwners()` is the one that costs a
child process. The split is what lets the spawn path ask on the click for free — only Claude declares
them (`claude agents --json`, ~0.4 s), and a backend that cannot answer declares neither and keeps
today's behaviour. `app/live-owners.js` polls, filters out sessions **this app** is running (ours is not
"elsewhere") and broadcasts; the sidebar marks the row, the spawn path asks before opening a tab.

Three things that were paid for once each:

- **The cache TTL must be LONGER than the poll interval.** At 15 s against a 45 s poll the guard was
  unreachable for two thirds of every interval — measured, with a real resume spawning anyway. Both
  constants carry a note pointing at the other.
- **The list is not a verdict.** A background agent listed as `blocked` resumed perfectly well. It says a
  process is *associated* with the session, so the app asks (fork / resume anyway / cancel) instead of
  refusing — a confident refusal of a session that was free is the worse failure.
- **The two entry shapes differ**: a background agent has no pid and reports `state`, an interactive one
  has a pid and reports `status`. Normalise in the backend folder, never at the reader.

## Don't hardcode a backend id outside its own folder

`src/main.js` / `src/app/**` / `src/watch/**` / `src/index/session-cache.js` / `src/renderer/**`
contain no backend id **in a branch or a composed path**, and must not gain one. They do `require` Claude's
readers directly (`session-cache.js`, `main.js`, both workers) — the documented exception named above, not
a violation. The core reads no backend's format and hardcodes no `~/.claude`
path; `test/backend-path-neutrality.test.js` is the guard for the last one (a hardcoded store PATH is
a backend id the id-hunt cannot see). `test/backend-integrations.test.js` guards the renderer.
The same migration ran through `src/projects/projects.js` under #211, which is CLOSED — what is left
there is the absence of a GUARD, not open work. Treat an id you find there as a defect to remove.

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

**`readFileTail` is there for the same reason** (#495). Two backends read a fact out of the END of a
transcript that grows to tens of megabytes — Codex' rate limits and Claude's prompt queue — and both
are asked while the user is waiting. One implementation, because reading the whole file for a question
about its last few kilobytes is exactly the shape this repo has watched get fixed in one backend and
kept in its twin. It reports whether the view is `partial`, and **that answer is load-bearing**: a
caller whose question cannot be answered from a fragment has to notice and read the file.

## A probe goes through `src/backends/cli-probe.js` (#532)

Running a CLI just to read what it prints — `agy models`, `pi --list-models`, `claude agents --json`,
`tasklist` — must close the child's stdin, or a CLI that reads standard input before answering waits
for an EOF that never comes and the probe burns its whole timeout.
**And what it says when it fails goes through `cliComplaint`** (#540): a spawn errno names the executable
it failed on, and a CLI's own stderr can be a stack trace full of absolute paths — both used to reach the
message a user reads. It hands back the CLI's first line, capped, or `null` when that line looks like a
path, and the caller words its own sentence. **The two call shapes need different
fixes and that is the trap**: `spawnSync`/`execFileSync` honour a `stdio` option and take `PROBE_STDIO`,
while `execFile` silently IGNORES one (Node passes `spawn` an allow-list without it) and has to be
wrapped — `closeStdin(execFile(...))`. `test/cli-probe.test.js` sweeps this directory for both forms, so
a new probe that skips them fails there rather than in a user's model picker.

**And a probe that FAILED has not measured anything** (#546). Pi collapsed every failure of
`node --version` into `null` and read that as "no node on your PATH at all", so a call that ran out of
its 3 seconds under load — 12 of 60 while the suite ran — told a user with Node 22 installed to go and
install Node, and held that for five minutes. Two rules come out of it:

- **Absence is the claim that needs the evidence.** Only a spawn that could not find the binary
  (`ENOENT`) proves there is none; a timeout, a kill, a permission error, a non-zero exit, output that
  does not parse — all of those are "could not be answered", and the caller keeps today's behaviour
  rather than asserting a fact. Do NOT invert this into a match on `ETIMEDOUT`: that names the one
  failure someone happened to observe and asserts absence for every other one. `null` means no
  information here, the way it does in `claude/live-agents.js` and `readTurnQueue` (#530).
- **A cache is for an answer.** An unanswered probe is held for seconds, not minutes — long enough that
  the 15-second scan does not shell out on every pass (#155), short enough that one unlucky exec does
  not decide the next five minutes. Pi keeps both numbers side by side with the reason for each.

The siblings were swept: agy, Codex and Hermes `probe()` only resolve a path (no child, nothing to
collapse), and the two model probes got the same fix under #540. `src/vcs/git.js`'s provider probe still
has the shape — any failure of `git --version` becomes "git was not found on PATH", cached for the life
of the process — and it is outside this rule's directory.

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

## `src/projects/**` — migrated (#211), but unguarded

`src/projects/projects.js` and `project-registry.js` are the **last** place the id-neutrality rule
above is not enforced by a guard — the migration itself is done (#211 is closed). Treat every backend id you find there as a defect to remove,
not as precedent to copy: the same two honest answers apply (a `LEGACY_*` binding for a pre-#161
record, or `firstLaunchableBackendId()`), and per-project config/meta belongs behind the descriptor's
`projectMeta` hook (#211), never behind a `~/.claude.json` literal.

Its Claude-home reader **and writer** was one of the four modules that composed a path from
`os.homedir()` inside an isolated instance — resolve it from `SWITCHBOARD_STORE_CLAUDE`, per call
(#241, `test/store-isolation.test.js`).

## `src/servers/**`

`mcp-bridge.js`, the MCP IDE bridge. It writes lock files into Claude's home — resolve that home per
call from `SWITCHBOARD_STORE_CLAUDE`, never from `os.homedir()` (#241), or an isolated instance drops
its locks where the user's real CLI finds them.

Three things about the bridge that cost something to learn:

- **`startMcpServer` takes a GETTER, never a window** (#392). The ctx rule that says so is written for
  `src/app/**` and `src/watch/**`, so it never covered this directory — which is exactly where it was
  violated. A bridge outlives a window reopen, and the captured one addressed a window that no longer
  existed: nothing appeared, nothing errored, and every diff sat out its full ten-minute timeout.
- **A pending diff records `pending.win`** — the window its view was **sent** to, deliberately not the
  one that renders the session, because the view does not follow a session that moves. Whatever destroys
  that window must answer for it: `rejectPendingDiffsForWindow`, and `hasPendingDiffsForWindow` so the
  app does not take a window down under a review the user is deciding on (#393).
- **`handleMessage` dispatches `tools/call` WITHOUT awaiting**, so one session can have several diffs
  open at once. That is why the renderer pages between reviews instead of showing one (#398) — a
  "concurrency fix" here would quietly break that.

Anything moved here takes `ctx`, not a top-level `require('electron')`, or it cannot be tested — see
`.claude/rules/main-process.md`. The scheduler used to live here and was removed in #246; spec 14
records how it worked, and `docs/ai/lessons.md` records what it cost.

## Session data sources

`~/.claude/projects/**/*.jsonl` via `src/session/derive-project-path.js`,
`src/workers/scan-projects.js`, `src/index/session-cache.js`,
`src/session/session-transitions.js`, and Claude's own readers in `src/backends/claude/`
(`session-reader.js`, `store-indexer.js`).

Store roots are overridable per backend (`SWITCHBOARD_STORE_<BACKEND>`), and where the CLI *writes*
is a separate thing (`cliHomeEnv`) — see `docs/ai/running-and-data.md`.
