---
paths:
  - "src/backends/**"
  - "src/session/**"
  - "src/servers/**"
  - "src/projects/**"
  - "src/vcs/**"
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

**A project's IDENTITY is the same question, and three more compares were answering it by string (#563).**
`session/derive-project-path.js` (`normPath` / `samePath` / `isDescendant`), `projects/projects.js`
(`samePathKey`) and `backends/rewrite-cwd.js` (`samePath`) all go through `app/path-containment.js` now.
They are the same failure as #545 in the place it costs most: a project reached through a junction, a
symlink or a `subst` drive is spelled two ways, so it grouped as two projects, and `rewrite-cwd` skipped
exactly the transcript lines the remap was called to move — leaving the phantom project at the old path
that #171 built that file to prevent.

Two things about doing it, both of which the issue said to check rather than assume:

- **Grouping needs a KEY, not a predicate**, so `path-containment.js` answers that too: `pathKey(p)` is the
  canonical real path, `''` for a blank one. Do not write a second canonical form beside it — two copies of
  the canonical form is how #245 started.
- **`\` and `/` fold only where the HOST folds them now**, and a test fixture that assumed otherwise is how
  this nearly shipped red. The old key rewrote every `\` into `/` on every platform; the real path leaves
  that to `path`, which folds them on Windows and not on POSIX — correctly, because a backslash is an
  ordinary character in a POSIX filename. So a fixture that spells one directory both ways is a **Windows**
  fixture. On POSIX use a trailing separator, which folds everywhere. The suite runs on Linux CI and this
  repo develops on Windows, so a green local run proves nothing about the separator.
- **`pathKey` is MEMOISED and the guards are not, deliberately.** Resolving a path through the filesystem
  costs ~92 µs against ~0.7 µs for the string compare it replaces. Measured on one sidebar rebuild
  (`projects-view.buildProjectsFromCache`, 2 000 session rows over 200 real directories): 16 ms as it
  stands, 311 ms with the memo taken out, and ~28 ms for a rebuild that starts with nothing remembered —
  which is what a 15-second scan actually pays. `claudeLine` asks the same question on every line of a
  transcript that can reach hundreds of megabytes. `isInside` / `isAtOrInside` / `samePath`
  keep asking the disk every time: they decide whether the app may read, write or delete somewhere, and a
  remembered answer there is a weaker guard, while a remembered answer about which BUCKET a row belongs in
  costs a regrouping at worst. Do not "unify" the two by giving the guards the memo.

**And a WRITE to the register asks it too (#566).** Answering the compare correctly is only half of it:
`project_meta` is keyed on the path STRING and `setProjectState` upserts on it, so an act written at the
caller's spelling opens a SECOND row rather than changing the one the sidebar reads. The caller rarely
holds the registered spelling — `buildProjectsFromCache` hands out the one that HAS SESSIONS, the settings
window carries that through its URL, and Remove Project sends it back. Removal therefore reported success,
tombstoned a project that was not on the list, and left the listed one alone. `registeredPathFor` in
`projects/projects.js` is the one way to address a register row: the registered spelling first, then the
exact one, then any row for the same directory, and the caller's own path when there is no row at all —
because a removal of a config-only project still has to leave its tombstone somewhere. Every act that
takes a path from OUTSIDE the register goes through it — `ensureProjectAdded`, `hideProject`,
`removeProject`, `unhideProject`, and `syncRegistry`'s bring-back, which picks its row out of the keying
pass it already makes. The two that do not are the two whose path came out of the register in the first
place: the tombstone sweep iterates `getProjectTombstones()`, and `remapProject` writes at the path
`renameProjectRefs` has just filed the row under. **A new caller that hands `setProjectState` a path from
anywhere else is the same bug again**, and it fails the way this one did: silently, reporting success.

**And two of them live outside this file**, which is how they were missed when #566 was written — an
enumeration that only looked where the fix was. The settings **import** writes a register row per project
in the imported file, and the **worktree removal** un-registers a directory the renderer named. Neither
path had ever seen the register. `registeredPathFor` is exported for them, and main.js wraps the
`setProjectState` it hands `app/settings.js` rather than that module requiring this one — `projects.js`
already requires `app/settings`, so the direct import would be a cycle. Grep for `setProjectState` across
`src/` rather than trusting this list; that is the check that would have found these two.

**And the READ side asks the same question, which #566 never enumerated (#579).** A read that resolves a
row differently from the write is the same bug facing the other way, and three readers still decided by the
raw string. The precedence therefore lives in `projects/register-lookup.js` — a pure leaf over
`app/path-containment`, so `index/index-writes.js` can hold it too — and `registeredPathFor` is its path
half rather than its own copy. The three:

- **`unlistedProjects`**, and this one was MEASURED wrong: a tombstone under one spelling, an admin row
  under another, and it offered the removed project straight back, while its own docstring claimed it could
  not contradict the register. The admin row's spelling comes out of `deriveProjectPath` — the CLI's raw
  cwd — so the divergence needs nothing exotic. It keys the register ONCE and looks each row up.
- **`isRemovedProject`**, which runs per session in the scan loop and therefore may not do what
  `registeredPathFor` does. Three tiers, and the ordering IS the fix: the primary-key lookup it always was
  (a registered row for the caller's own path settles it, at the old cost), then `getProjectTombstones` —
  short, two columns, usually empty — keyed through the memoised `pathKey`, and only then the whole
  register, for the handful of directories that really carry a tombstone. **Nothing is memoised across
  calls**: `index-worker-client.js` re-asks on main precisely because the worker's snapshot may be stale.
- **`pruneProjectIfGone`**, the one act here that destroys data, and the one #566 could not have found:
  `deleteProjectRefs` is an exact-match DELETE and this writer never goes through `setProjectState`. It
  addresses the register's row AND the caller's own, because the footprint it drops is wider than the
  register — the tags and the `project:<path>` settings blob are keyed on the string it was called with.

A test fake that stands in for a spelling-folding read has to fold too, or the test passes for the wrong
reason: `test/projects.test.js`'s `getCachedByProjectPath` did not, while `session-store.js` does.

## Deleting a project's history refuses while we are running a session in it (#574)

`deleteProjectSessions` is the one project action that takes files off disk — `removeProject` touches
none and says so. So it is the one that must not race: a CLI **this app started** is appending to the very
transcripts the delete removes, and there is nothing to undo afterwards.

- **Live means `ctx.activeSessions` holds a non-exited session for that path.** Not "wrote recently", not
  "has rows in the cache". A transcript on disk says a session existed; only the map says one is alive with
  a process behind it. `liveSessionsIn(projectPath)` counts them, because the refusal names the number and
  "a session" reads wrong for three.
- **`liveSessionsIn` is the ONE asker.** `applyAutoHide` folded the same map itself, with the same rule and
  the same key, and the two agreed — which is where two readings of one question sit until they do not. It
  asks through the function now, and a third reading is a bug however carefully it is written;
  `test/projects.test.js` counts `ctx.activeSessions` in `projects.js` and expects one.
- **Asked canonically and about the path alone** — the same `samePathKey`, so a terminal opened under the
  other spelling of the directory still counts (#245), and never a question about which backend the session
  belongs to.
- **A refused delete stops the WHOLE action**, in the renderer. `projects-admin.js` used to carry on to
  `removeProject` and the config deletes after a failed delete — its comment said `// always` — which left
  the history in place and the project gone. That is neither of the two things the dialog offers, and it
  also clears the cached rows the delete reads to find the transcripts, so the user cannot even ask again.
- **And a delete that removed NOTHING is that same failure through the success path (#580).** A
  `deleteSessions` that threw was logged and skipped; one answering `{removed: 0}` was skipped in silence.
  Either way `deleted` and `refused` came back empty together, so the renderer fired no toast at all and
  went on to `removeProject`. `refused` carries `{backendId, label, kind, reason}` now: `unsupported` is
  the answer that was known before the dialog opened and does NOT stop the act, `failed` and `empty` are
  the delete not doing what it was asked and do. A backend with no rows in the project is neither — there
  was nothing to keep, and calling that a refusal would block the removal of a project it was never in.

The neighbouring question is HALF settled now, and the half that is settled is the one below. Whether a
removal should be REFUSED while a session is live there is still open in
`docs/specs/10-project-registry.md` under *Known gaps*; what the tombstone admits afterwards is decided.

## A store sighting reports a START, not only a recency (#575)

The scan tells the register what it found in a backend's store, and that report is what the tombstone is
compared against. It used to be one time — the newest recency, `newestAt: row.lastEntryAt || row.modified`
— and a CLI live in the project at the moment of removal appends within seconds, so the recency moved past
the tombstone and the project came back on the next flush. "Remove" was a no-op for exactly the project
the user was working in.

A `storeProjects` entry is `{ projectPath, newestAt, startedAt }` now, `noteStoreProject` keeps the two
maxima **apart** (the newest start and the newest write need not be the same session), and
`shouldRegister` takes `sessionStartedAt`. The recency is still reported and still means what it meant —
it just decides nothing.

Three things to keep in mind when you touch a reporter:

- **The START is the reader's, and a reader that cannot say answers `null`.** That is the descriptor rule
  in this file applied to a timestamp: agy's `.db` carries none, so its parser sets `startedAt: null` on
  purpose. **Never substitute the recency**, in the loop, in the replay, or in the register. For agy it
  would be the worst possible substitution — its `lastEntryAt` IS the file mtime — and the register refuses
  the bring-back instead, which the user can always undo by adding the project or launching a session in
  it (`source: 'user'` registers in both modes). The reasoning lives in `project-registry.js` and in
  spec 10; do not re-decide it in a new reporter.
- **Claude's REMOVED-folder branch reads HEADS, and still parses nothing.** It never parsed — a removed
  project's rows were purged and re-reading them would put them back — so it had only the folder index
  mtime, a recency it was reporting as a start. `sessionReader.readSessionStartedAt` reads the first chunk
  of each transcript and stops at the first timestamped entry, memoised per file because a start never
  changes. A **failed** read is deliberately not memoised: a header-only file is a session about to exist,
  and remembering "no start" for it would make that permanent.
- **A new reporter must feed both.** Grep for `noteStoreProject` rather than trusting an enumeration —
  there are reply replays in `src/backends/scan.js` and `src/backends/claude/store-indexer.js`, plus the
  cold-scan branch in the latter, and a caller that passes only a recency silently makes removal permanent
  for its backend.

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
a backend id the id-hunt cannot see). `test/backend-integrations.test.js` guards the renderer — **only**
the renderer, from a hand-listed file map; nothing hunts ids in the main process, so there the rule is
prose and the reviewer is you.
The same migration ran through `src/projects/projects.js` under #211, which is CLOSED — what is left
there is the absence of a GUARD, not open work. Treat an id you find there as a defect to remove.

The one place this paragraph is knowingly not true today is the pre-#161 legacy default — see the
exception under the two honest answers below before you "fix" a `|| 'claude'` in main-process code.

**Reaching for a backend id nobody named? There are exactly two honest answers** (#212/#225), and
the code must say which:

1. it is **reading a record from before the multi-LLM era** — a template with no `backendId`
   predates #161, when a template was always Claude. Bind it to a named `LEGACY_TEMPLATE_BASE` /
   `LEGACY_SESSION_BACKEND`.
2. it resolves to a backend that **can actually launch** — and the two processes answer that with
   different functions, so name the one that exists where you are standing.
   In the **renderer**: `firstLaunchableBackendId()`, a window global defined in
   `src/renderer/backends/backend-registry.js`. It answers `''` when nothing is launchable, and `''`
   must not be turned back into an id.
   In the **main process**: `backends.getDefaultLaunchTarget()` (`src/backends/index.js`) — the stored
   choice, then Claude if it is launchable, then whatever else is; `null` when nothing is, and `null`
   must not be turned back into an id either. `firstLaunchableBackendId` is **not** reachable here
   (`grep -rn firstLaunchable src/ --exclude-dir=renderer` finds nothing), so a rule or a comment that
   sends main-process code to it is sending it nowhere.

`|| 'claude'` as a **live launch target** is neither: Claude is disablable (#162), so it hands back a
backend that cannot spawn.

**The one exception, written down so nobody has to either break this rule or "fix" correct code to
obey it.** Answer 1 — a NULL `backendId` on a row written before #161 was a Claude session — is spelled
as the bare literal `|| 'claude'` in main-process code today: `src/main.js`, `src/app/terminal/spawn.js`,
`src/index/index-worker-client.js`, `src/index/projects-view.js` (`grep -rn "|| 'claude'" src/` is the
list; a count written here would be stale by the next split). Every one of them is answer 1 and is
correct — what they are missing is the NAMED constant that `src/renderer/**` and
`src/index/index-writes.js` bind it to (`LEGACY_SESSION_BACKEND` / `LEGACY_TEMPLATE_BASE`). Two things
follow, and they pull in opposite directions on purpose:

- **Do not go replacing them as a drive-by.** Renaming them is a decision of its own; it is not a side
  effect of touching the line above one, and a diff that does it while doing something else is the shape
  this repo has already paid for.
- **Do not read their existence as permission.** A NEW one binds the named constant and says in a
  comment which of the two answers it is — because nothing in the main process will tell you if you get
  it wrong.

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

**The module stays here (#541).** Shell discovery had the same open stdin pipe, and moving `cli-probe.js`
somewhere `src/app/**` could import it was the obvious answer. It was refused: the header's scope
sentence is what the sibling sweep rests on, and an app module importing from a backend folder is the
direction this file spends a section forbidding. `src/app/terminal/shell-profiles.js` closes its own
stdin instead, with a comment naming this module — spec 9's decision 11 is the record.

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

**And the mirror of that: an option `buildLaunch` READS must be declared** (#562). Claude honoured
`appendSystemPrompt` for months with no field naming it — no settings page offered it, no scope stored
it, the Configure dialog could not set it, and its one caller (the schedule creator) left with #246. An
argv path nobody can reach states a capability the app does not have, so it goes, unless a caller that
is not the settings screen sets it — and then that caller is the declaration and is named where the
option is read. The guard is a subtraction, not a list: `declaredFlags` (the launch shapes, the
live-binding hook and the declared fields) taken off `managedFlags` (the same, plus an options object
that answers everything), with the core's `SENT_ELSEWHERE` as the one door. What is left is a flag
gated on a key `configFields` never named — `test/backend-launch-flags.test.js`, pinned against a stub
so the check can still fail now that no real backend trips it.

**And the flag has to EXIST — nobody's list can answer that** (#548). Hermes shipped a `checkpoints`
toggle emitting `--checkpoints`, which bare `hermes` does not take (it is a flag of its `chat`
subcommand), so every session launched with it on died at spawn. Nothing caught it because
`scripts/check-*-help.js` compared the CLI's help against a hand-typed `MANAGED` set: a flag can be
missing from the CLI **and** missing from that list at once, and the audit stays green. The set is
derived from the descriptor now — `scripts/managed-flags.js` runs `buildLaunch` at every launch shape,
with every option at a value that reaches the argv (and an options object that answers everything, so a
branch no `configFields` entry declares is still seen), plus `buildLiveBinding`. **Write the flag, and
the audit covers it; write a list, and it does not.** The one hand-written door left is a script's
`SENT_ELSEWHERE`, for a flag the CORE adds outside the descriptor (Claude's `--ide` after the MCP
bridge, Pi's `--list-models` probe) — each entry names where it is sent, and a test checks that file
really sends it. A flag a help line only MENTIONS is not advertised: the extraction reads definition
lines, because scraping every `--word` made four Claude flags "advertised" by other flags' prose.

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

`src/projects/projects.js` and `project-registry.js` carry no guard for the id-neutrality rule above —
the migration itself is done (#211 is closed). They are not special in that: **no main-process
directory is guarded for ids.** `test/backend-integrations.test.js` iterates a map of renderer files
and nothing else, and `test/backend-path-neutrality.test.js` walks all of `src/` but guards store
PATHS, not ids. So the id-hunt covers `src/renderer/**`; everywhere else the rule is prose.
Treat every backend id you find here as a defect to remove,
not as precedent to copy: the same two honest answers apply (a `LEGACY_*` binding for a pre-#161
record, or `backends.getDefaultLaunchTarget()` — **not** the renderer's `firstLaunchableBackendId()`,
which does not exist in this process), and per-project config/meta belongs behind the descriptor's
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

## `src/vcs/**` — the same seam, for version control (#277)

`index.js` is a REGISTRY that mirrors `src/backends/index.js`: `detect(cwd)` finds the provider that
owns a working directory, and the core drives that provider's hooks. `git.js` is the only shipped
provider; `parse-git-status.js` is a pure porcelain-v2/diff parser with no process and no DOM.
**The core is VCS-blind** — `src/app/vcs.js` names no VCS, exactly as the core names no backend, and a
Mercurial or Subversion provider would be a sibling file registered here with no core change.
So the id rule above applies unchanged with "backend" read as "provider": no `'git'` in a branch or a
composed path outside `git.js`, and a capability that varies by provider is a hook on the descriptor.

This directory had no path-scoped rule at all until it was added to this file's frontmatter — it was
the only subtree under `src/` that auto-loaded nothing, while `CLAUDE.md`'s router had been promising
this file for it. The poller, the IPC and the standalone changes/diff windows are **not** here: they
are `src/app/vcs.js`, under `.claude/rules/main-process.md`.

Two things git costs that the parser must not be "cleaned up" into forgetting:
`--no-optional-locks` is a GLOBAL flag and has to precede `status`, or git rejects it and the
background poll starts fighting the session's own agent over `index.lock`; and the in-progress state
(merging / rebasing / cherry-picking) is not in porcelain output at all — it is read from `.git/`
markers, filesystem-only, so it costs no second spawn.

## Session data sources

`~/.claude/projects/**/*.jsonl` via `src/session/derive-project-path.js`,
`src/workers/scan-projects.js`, `src/index/session-cache.js`,
`src/session/session-transitions.js`, and Claude's own readers in `src/backends/claude/`
(`session-reader.js`, `store-indexer.js`).

Store roots are overridable per backend (`SWITCHBOARD_STORE_<BACKEND>`), and where the CLI *writes*
is a separate thing (`cliHomeEnv`) — see `docs/ai/running-and-data.md`.
