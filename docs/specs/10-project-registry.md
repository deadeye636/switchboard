# 10 — The project list is a list

**Status:** implemented (#167).
**Design record**, written after the fact: what the project list is now, why it had to change, and the
traps that only showed up in the running app.

## The problem it fixes

The sidebar's projects were **derived**, on every render, from the transcripts on disk. Three things
followed from that, and all three were bugs:

1. **A project with no transcript could not exist.** `deriveProjectPath()` reads a project's path out of
   the `cwd` of a session file, so no session, no project — whatever else the app knew about it. A
   project could be trusted, carry a cost history, be listed in the Projects admin, and still be
   impossible to see or start a session in.
2. **"Add project" could not add.** The manual-mode allowlist (`addedProjects`) was a *filter* over the
   derivation, applied only in manual mode, and a filter can only ever **remove**. Adding a path with no
   sessions ticked a box that changed nothing. To paper over it, `addProject` created a store folder and
   wrote a **fake transcript** into it — a session that never happened, saying "New project".
3. **"Remove" could not remove.** The transcripts stay on disk, so the next scan would derive the project
   straight back. So remove was implemented as a permanent **hide** — and hiding and deleting became the
   same operation, neither of which was what the other should be.

## The model

The list is a **stored list**: `project_meta` gains `registered`, `registeredAt`, `hidden`, `removedAt`.
It is the same row that already held the favourite and the auto-hide timer — a project is one row, not a
row plus two entries in a settings blob that can disagree with it.

Both modes feed the same list. What the mode governs is **who may write to it**:

| mode | who registers a project |
|---|---|
| **auto** | discovery does — a session found in **any** backend's store (Claude, Codex, Hermes, Pi), including one started outside Switchboard. The user may also add one by hand. |
| **manual** | only the user. |

An **explicit act registers in both modes**: adding by hand, and launching a session there. Manual mode
means "nobody but me writes to the list", not "I cannot start anything anywhere".

### The three invisible states, kept apart

They always existed as three. Two of them shared one code path, and that was the bug.

| state | on the list? | what brings it back |
|---|---|---|
| **auto-hidden** (#57) | yes | activity, or an unhide. It is a staleness *view* and it resets itself. |
| **hidden** (manual) | yes | only an unhide. New sessions do **not** unhide it — that is the point of saying "hide". Its sessions keep being indexed, so unhiding shows them at once. |
| **removed** | no (+ tombstone) | a session **newer than the tombstone**, or a manual add. The sessions it left behind do not. |

Precedence: **removed > hidden > auto-hidden**. A removal clears the hide flags — `hidden` qualifies a
*listed* project, and a removed one is not on the list — so a project that comes back comes back
**visible**. Anything else silently swallows a project the user just re-added.

## Remove needs a memory

The sessions that put a project on the list stay on disk when it is removed. A register with no memory
would re-register it on the very next scan, so a removal would be a no-op — which is exactly why the old
code turned remove into a hide.

So a removal records **when**: `removedAt`. Auto-registration then re-registers the project only on a
session that **started** after that — see *A session that was already running is not a new one* below for
why the word is "started" and not "newer".

### The sweep, and the trap in it

A tombstone exists to stop **old** sessions from re-registering the project. Drop it while those sessions
still exist and the project **resurrects itself** on the next scan — the cleanup would undo the deletion.

```
drop a tombstone when:
      no session remains, in ANY backend store, for that path
  AND it is older than 30 days                     <- the safety belt
```

The age is the belt, not the criterion. An unmounted network drive looks exactly like a deleted one;
without the grace period every tombstone on a `Z:\` would be swept the moment it went offline, and every
project on it would come back on reconnect.

**"Delete for good"** needs no second button: *Delete this project's sessions* already exists. Removing
the transcripts makes the tombstone collectable on the next sweep. Permanence is a consequence, not a
mechanism.

## Two traps that only the running app found

Both were green in every unit test.

**1. "Removed" quietly meant "banned for good."** A removed project is deliberately not indexed — that is
what makes the removal stick. But discovery looked at the **cache**, so a brand-new session in that
project produced no row and was never noticed: the project could never come back, whatever you did in it.
The scan is now the one that reports it (`src/index/session-cache.js` → `getStoreProjectPaths()`, `path → newest
session seen`), because the scan parses the transcript **before** it decides to skip it. The same map is
what keeps the sweep from being blind: ask the cache whether a removed project still has sessions and it
says "none" **by construction**.

**2. The project came back empty.** While it was removed the scan skipped its folder — and stamped the
folder's mtime memo as up to date on the way past. After re-registration nothing would ever index it
again: the project sat in the sidebar with no sessions, its transcripts on disk, and no way to bring them
in. `syncRegistry()` now refreshes the folder at the moment it registers a project that had a tombstone.

## Migration

One rule: **the sidebar shows exactly what it showed the day before.** The catch is that the old list was
not one list — it depended on the mode:

| mode | the old list |
|---|---|
| auto | everything derivable from the store, minus `hiddenProjects` |
| manual | `addedProjects`, and nothing else (a *subtractive filter* over the derivation) |

So the seed depends on the mode too. Seeding a manual-mode install from the derivation would flood its
sidebar with every project it had spent months not showing.

- `hidden` = the old `hiddenProjects`, **except** the ones that are only hidden because they went stale —
  those already carry `autoHidden`, and conflating the two is the bug this feature fixes.
- A store folder that has since been **deleted** leaves its `cache_meta` row behind. Seeding from that row
  would resurrect the project as a `missing` row that was not in yesterday's sidebar, so only folders that
  are still on disk count.
- `registeredAt` is left **NULL** for a seeded project. It is the recency an *empty* project sorts by, and
  stamping it with the migration time would send every session-less project to the top of the sidebar as
  if it were brand new. A project put on the list from here on gets a real one; these were already there.

No tombstones are seeded: nothing has been removed yet under the new meaning of the word.
`hiddenProjects` and `addedProjects` are **migration input only**; nothing reads them any more.

### Settings export / import

The list used to be in the settings blob, so an export carried it for free. It is a table now, so it is
carried **explicitly** — a `projects` section next to `global`. Without that, an export silently drops the
whole list: a restore arrives with every hidden project visible again and, in manual mode, with no
projects at all.

- A **tombstone does not travel.** It is about the transcripts on *this* disk; carrying it over would
  suppress a project on a machine whose sessions were never removed.
- A file with **no list at all** (an older export, or a machine that never had a project) changes nothing.
  Importing "nothing" must not mean "wipe it".
- A **legacy file's** `addedProjects` / `hiddenProjects` are folded into the register on import — that is
  where the list used to live.

## The auto-hide never gave anything back (#184)

The table above says an auto-hide *"resets itself"*. It did not. `applyAutoHide` only ever **set** the
flag; the only things that cleared it were an unhide by hand and a remap. A project that went quiet long
enough was gone for good, however much work went into it afterwards — and the one thing that separates the
machine's decision from the user's is that the machine takes its own back.

The sweep now releases as well as hides: back inside the window, or a live session running there, and the
flag goes. **Only** the flag — stamping the grace timer as well would hand the project a reprieve it did
not earn and it would never age out again. A hide the **user** made is skipped entirely; activity does not
undo it. And switching the feature off (`autoHideDays = 0`) releases everything it was holding: it used to
`return` before looking, so every project it had ever taken stayed hidden with no machine left to give it
back.

## What the sidebar is NOT showing (#183)

A session in a project that is not on the register is indexed and searchable and painted **nowhere**. That
is the design working — the register decides, and in manual mode discovery may not write to it — and it was
also silent: the session you were in an hour ago was simply not there, with nothing to click and no reason
given. The only way to find out was to read the database.

A line under the project list says how much is being withheld (*"4 sessions in 1 project not on your list"*)
and opens the project manager filtered to exactly those projects, where the **Listed** toggle adds one. It
adds nothing by itself: the register stays the single source of truth, and manual mode stays manual.

What it offers is exactly what auto-add **would** have taken — it asks `registry.shouldRegister` itself, so
the offer can never contradict what the register would do — with the same time, which is why the admin row
carries `lastStartedAt` beside its recency. The tombstone therefore holds: a project you removed is not
offered back until a session that **started** after the removal turns up (#575).

## As built — where the pieces are

| Piece | Where |
|---|---|
| The decisions (register / skip / resurrect / sweep / visible) — pure, no db, no fs | `src/projects/project-registry.js` |
| The columns + the seeding migration | `src/db/schema.js` (columns) + `src/db/migrations.js` (the seed) |
| The sidebar reads the register; the scan reports what the stores hold | `src/index/session-cache.js` |
| The store sighting itself — the newest write AND the newest session start, kept apart (#575) | `src/index/index-writes.js` (`noteStoreProject`), fed by `src/backends/parse.js` + `src/backends/claude/folder-parse.js` |
| add / hide / unhide / remove / discovery + sweep (it releases too, #184) | `src/projects/projects.js` |
| What is indexed but not listed (`unlistedProjects`, #183) | `src/projects/projects.js` |
| `syncRegistry()` before the list is built; one visibility rule for every view | `src/main.js` |
| "Listed" toggle (both modes), hide ≠ remove | `src/renderer/panels/projects-admin.js`, `src/renderer/shell/sidebar.js` |
| The "not on your list" line + the manager's filter (#183) | `src/renderer/app.js`, `src/renderer/panels/projects-admin.js` |

## Which project a session belongs to (#157, #182)

A session is attributed **per session**, not per store folder: the folder is keyed on the directory a
session *started* from, and a session that walks out of it — into a worktree — belongs where it is working
(#157).

That rule read "the git root of the current cwd", and it misfired on an ordinary layout (#182): a directory
that coordinates several repositories, with the session launched in the coordinating directory. Ask it to
look at one of them, its shell cwd follows it in, and from that moment the session belonged to
`<project>/<sub-repo>` — a project nobody added, never registered in manual mode, and therefore **painted
nowhere**. Indexed, searchable, invisible; it did not come back.

**The launch directory decides.** A session that merely went *deeper* into its own project stays with it —
a subdirectory that happens to carry a `.git` is still a subdirectory. Claude names its own transcript
folder by the same directory, so this keeps us in step with it. Re-attribution is for a session that
genuinely **leaves** the tree:

| the session is working in | it belongs to |
|---|---|
| a plain subdirectory (`build/`, `.claude/scratchpad`) | the project (unchanged) |
| a nested repository inside its own project | **the project** (#182) |
| a worktree (`<project>/.claude/worktrees/<name>`) | the worktree — the explicit exception (#147, #157) |
| the parent repo, having started in a worktree | the parent (an ancestor is not a descendant) |
| an unrelated repository elsewhere on disk | that repository |

The rule lives in `sessionProjectPath` (`src/session/derive-project-path.js`); `PARSER_SCHEMA_VERSION` was bumped with
it, or the sessions v3 had already scattered into phantom projects would never be re-read — their mtimes
settled long ago.

## What a removal clears — and what it does not

A removal purges the project's cached rows **from every backend, row by row**. Not folder-scoped: a store
folder is keyed on the cwd a session *started* from, so since #157 it can hold rows of other projects, and
clearing by folder would drop those while their transcripts sat on disk. And not Claude-only: a removal
that leaves the Codex and Pi rows in the cache, the search index and the stats has removed a sidebar row,
not a project.

**No session file is touched.** Deleting the history is a separate act (*Delete this project's sessions*).

**And when the Remove dialog runs both, a delete that kept a history stops the removal (#580).** The two
are ordered — the delete reads the project's cached rows to find the transcripts, and the removal clears
those rows — so carrying on past a delete that did not happen leaves the history on disk, the project
gone, and no way to ask again. #574 established that for a delete that *errored*; the same shape was
reachable through the success path, because a backend whose `deleteSessions` threw was logged and skipped
and one answering `{removed: 0}` was skipped in silence, leaving nothing for the renderer to report and
nothing to stop it. `deleteProjectSessions` names every backend that kept its history and why, and the
renderer stops on any of them except the one that was known before the dialog opened — a backend that
cannot hand over its history at all, which the dialog has already said and which must not block a removal
the user asked for.

Every write path is gated on the removal, or the removal would not stick: `refreshFolder`, `refreshFile`,
the backend scan — **and the worker rebuild**, which walks the whole store and knows nothing about the
register. Miss that one and a "Rebuild session cache" puts a removed project's sessions back into the
cache and the search index as an invisible, searchable zombie that nothing ever purges again (the register
hides the sidebar row; the tombstone stops it from ever being listed and swept).

## An act on a project has to FIND its row (#566)

Remove Project on a project's settings screen reported success and left the project in the sidebar. There
was no error to report and nothing to catch, because from the register's point of view nothing had gone
wrong: it had removed a project that was not on the list, and left alone the one that was.

`project_meta` is keyed on the projectPath string and `setProjectState` upserts on it, so a write lands on
whatever spelling the caller happens to hold — and the caller rarely holds the registered one. The sidebar
hands out the spelling that HAS SESSIONS (`buildProjectsFromCache`: the session loop runs first, so the
spelling that has sessions wins), the settings window carries that string through its URL, and the button
sends it straight back. A cwd a CLI wrote with a different drive-letter case, a project opened through a
junction, a symlink or a `subst` drive — any of those, and the removal opened a *second* row with the
tombstone on it while the first row kept `registered = 1`.

So the rule is the one #563 established, applied one layer up: **#563 made the COMPARE answer about the
real path; #566 makes the WRITE address the row that identity names.** `registeredPathFor` in
`src/projects/projects.js` resolves a caller's spelling to the row the project is filed under — a
registered row first (that is the row the act is about, and the caller's own spelling wins among those),
then the exact spelling, then any row for the same
directory — and `ensureProjectAdded`, `hideProject`, `removeProject`, `unhideProject` and discovery's own
bring-back all write through it. The two register writes that do not are the two whose path came out of
the register to begin with: the tombstone sweep iterates the tombstones themselves, and a remap writes at
the path `renameProjectRefs` has just filed the row under.

The Projects admin was never affected, and the reason is worth knowing: `buildProjectsAdmin` already
overwrites its display path with the REGISTERED spelling when it meets one ("that is the one the user's
actions are stored against"). `buildProjectsFromCache` deliberately does not — the sidebar shows the
spelling its sessions carry — so the same button reached the right row from one surface and the wrong one
from the other. Fixing it at the write covers both, and covers a path that arrives from neither.

Two things it deliberately does not do:

- **A path with no row at all comes back unchanged.** A removal of a project that exists only in a
  backend's own config still has to leave its tombstone somewhere, and the Projects admin's hard delete
  calls `removeProject` unconditionally. "Nothing to remove" is not an error here, unlike `hideProject`,
  where `hidden` qualifies a listed project and there is genuinely nothing to set.
- **It resolves the row; it does not merge rows.** Two registered rows for one directory (a database that
  already had them) still render as one project — the sidebar buckets on the canonical key — and an act on
  either now reaches the registered one. Collapsing them is a migration, not a lookup.

### And the READ side asks it too (#579)

#566 fixed the writes and left "which row is this" as a rule that only writers followed. A read that
resolves differently from the write is the same bug facing the other way, and three readers still decided
by the raw string. The precedence moved out of `registeredPathFor` into `src/projects/register-lookup.js`
— a pure module over `src/app/path-containment.js` — so `src/index/index-writes.js` can apply it without
importing the projects module; `registeredPathFor` is now its path half rather than a second copy of it.

- **`unlistedProjects`**, and this one was measured before it was fixed: a tombstone filed under one
  spelling, an admin row under another whose sessions all began before the removal, and the offer handed
  the removed project straight back. The admin row's spelling is `deriveProjectPath`'s — the raw cwd the
  CLI wrote — which is the same divergence #245, #563 and #566 are all about, so nothing exotic is needed
  to reach it. Its own docstring claimed the offer could not contradict the register.
- **`isRemovedProject`**, which runs per session in the scan loop and therefore may not read and key the
  whole register the way an act does. Three tiers, and the ordering is what makes it affordable: the
  primary-key lookup it always was (a registered row for the caller's own spelling settles it, at the old
  cost), then the tombstones — a short, two-column read, usually empty — keyed through the memoised
  `pathKey`, and only then the whole register, for a directory that really carries one. Nothing is
  remembered between calls, because the reconcile re-asks this on main precisely to get past the worker's
  snapshot.
- **`pruneProjectIfGone`**, the only act here that destroys data, and the one #566 could not have found:
  `deleteProjectRefs` is an exact-match `DELETE` and this writer never passes through `setProjectState`,
  which is what that follow-up grepped for. It addresses the register's row **and** the caller's own,
  because what it drops is wider than the register — the tags and the `project:<path>` settings blob are
  keyed on the string it was called with.

## A session that was already running is not a new one (#575)

The register's rule always read "only a session **newer** than the removal brings the project back", and
the code could not tell what that meant. The scan handed it one time per project — the newest **recency**
(`newestAt: row.lastEntryAt || row.modified`) — so a CLI that was live in the project at the moment of
removal moved that time past the tombstone with its next line, seconds later. "Remove" was therefore a
no-op for exactly the project the user was working in, which is the one they are most likely to remove.

The scan reports a **start** now, alongside the recency, and the tombstone is compared against the start.
A session that began after the removal registers the project; one that was merely still running does not,
however recently it wrote. The recency stays in the reply and in the scan-state — it is what a sighting
means, and the bring-back log line names both — but nothing decides on it any more.

This was Option B in #566's closing discussion. It changes the **scan protocol**, not the register's
model: `storeProjects` entries carry `{ projectPath, newestAt, startedAt }`, `noteStoreProject` keeps the
two maxima apart (the newest start and the newest write need not come from the same session), and
`shouldRegister` takes `sessionStartedAt` instead of `sessionAt`.

Where each reporter gets a start, because they differ and the difference is the interesting part:

| Reporter | Start from |
|---|---|
| The generic Axis-B loop (`src/backends/parse.js`) | the reader's own `startedAt` — the row already carried it |
| Claude's cold scan (`src/backends/claude/store-indexer.js`) | the newest `startedAt` across the batch it fully parsed |
| Claude's REMOVED-folder branch (`src/backends/claude/folder-parse.js`) | the newest first-entry timestamp across the folder's transcripts, read from their **heads** |

The last one is the one that needed deciding, because that branch deliberately parses nothing — a removed
project's rows were purged and re-reading them would put them back — and all it used to have was the
folder index mtime, a recency it reported as if it were a start. It reads the head of each transcript
instead (`readSessionStartedAt`), memoised per file: a session's start never changes, so steady state is
zero reads and a file that appears after the removal is read once. The reads are bounded anyway by the
reconcile gate, which trips this branch only when the folder's index mtime moved.

### The two decisions inside it

**A backend that cannot report a start is refused the bring-back, not given the recency.** agy's store
carries no timestamp at all, so its parser sets `startedAt: null` on purpose; a Claude transcript whose
head holds no entry yet says the same thing. Falling back to the recency there would restore the whole
bug for precisely the cases that cannot argue with it — and for agy it would be maximally wrong, because
its `lastEntryAt` **is** the file mtime. The two failure modes are not symmetrical:

- Refusing costs a project that discovery will not offer back. The user can still put it back at any
  time: adding it by hand, or launching a session in it, is `source: 'user'`, which registers in both
  modes and buries the tombstone. The 30-day sweep also still applies once nothing is left at that path.
- Falling back costs a removal that silently never happens, and there is nothing the user can do to make
  it stick.

So the refusal is the affordable mistake, and it is stated where the fallback would have gone —
in `shouldRegister`, in `parse.js`, and in the reply-replay comments in `scan.js` and `store-indexer.js`.

**Equal timestamps do not bring the project back, and a missing start beside a present recency does not
either.** A start that is not *newer* than the removal is not a session that began after it, and at the
same instant the removal is the later act — the same answer the recency comparison gave, kept deliberately
rather than inherited. A start that does not parse takes the same route: `ms()` reads it as 0, older than
any removal. A recency is never consulted as a substitute in any of these.

Both are pinned in `test/project-registry.test.js`; the reporting half is in
`test/store-project-start.test.js`, which also covers the agy-shaped reader and the header-only transcript.

## A live session refuses BOTH acts, and hiding is the way out (#574, #578)

Two acts can take a project away from the user while a CLI this app started is running in it, and they
now answer the same question the same way.

**Deleting its history refuses (#574)** because it removes transcripts from the backends' own stores
while a process of ours appends to them. Nothing comes back afterwards.

**Removing it from the list refuses too (#578).** This was Option C in #566's discussion and stayed open
through #575, on the reading that a row which reappears is an annoyance and a file that does not is a
bug. The reading was right about the cost and wrong about what happens: since #575 only a session that
*started* after the tombstone brings the project back, so the one that is running never will. The
removal therefore takes the project the user is working in off the list and leaves it there, silently,
for as long as that terminal is open. That is not the cheap half of anything, and the symmetry matters
on its own — a delete that refuses beside a removal that does not is a pair of buttons the user has to
learn separately.

Neither offers to do it anyway. An "anyway" on one of them is how the two start to differ again.

What the user does instead is **hide** the project, and both refusals say so. Hiding writes a flag,
takes nothing off the list, touches no file and is reversible, so a running session is no reason to
refuse it — `hideProject` has no guard and must not grow one, or the refusals would point at a door
that is also shut.

**Live has one definition and both acts ask it**: `liveSessionsIn` counts the non-exited entries in
`ctx.activeSessions` for that path. Not "wrote recently" and not "has rows in the cache" — a transcript
on disk says a session existed; only the map says one is alive with a process behind it. Asked
canonically through the same `samePathKey` `applyAutoHide` folds, so a terminal opened under the other
spelling of the directory — a junction, a `subst` drive, another case — still counts (#245, #563), and
about the path alone, never about which backend the session is. Each act phrases its own sentence,
because they offer different ways out; neither decides for itself what running means.

**A refused act changes nothing else, and that half lives in the renderer.** `projects-admin.js` runs
the delete, the removal and the per-backend config deletes as one sequence, and each step used to fall
through to the next — the removal's comment said `// always`. A refusal that carries on reads as
"history kept, project gone" or "project kept, its Codex entry gone", neither of which the dialog
offered, and the removal clears the cached rows the delete reads to find the transcripts, so the user
cannot even ask again. Both steps stop the whole action now, and so does the on-the-list toggle, which
used to throw the answer away entirely.

## Known gaps

- A removed project's sessions are out of **search** until it is registered again. Intended — it was
  removed from Switchboard — but it is a behaviour change worth knowing.
- The sweep's "no session anywhere" check sees a backend store only once that backend has been scanned in
  the current run. It errs on the safe side: an unscanned store means the tombstone is **kept**.
- ~~Whether removing a project should be refused while a CLI this app started is running in it~~ —
  **decided (#578): it is refused**, the way deleting its history already was (#574). Both acts and the
  one definition of "live" they share are described above, under *A live session refuses BOTH acts*. What
  is left is not a gap but a consequence worth stating: the refusal does not stop the session either, and
  nothing here does. Ending a session is the user's act, in the terminal that owns it; a project action
  that killed a process to get its way would be a much larger promise than any of these buttons make.
- **A backend with no start time cannot be brought back by discovery at all** — the deliberate half of
  #575's start-time rule, and the honest name for what agy's users will see. The way back is an explicit act. If a
  future agy release stamps its store, or the file's own creation time is judged trustworthy enough to
  stand in, that is the change to make; a recency fallback is not.
- The register keys on the path as written. What the lookups COMPARE is no longer a string (#563), and
  since #566 neither is what a WRITE addresses (the section above). The tombstone, the state
  lookups, the "does this project still have sessions on disk" check and the store-folder refresh all key
  on `app/path-containment.js`'s `pathKey` — the real path of the directory, with case ignored only where
  the filesystem ignores it. That closes the half of this gap that a user could not see coming: a project
  reached through a junction, a symlink or a `subst` drive used to answer "different directory" about its
  own store folders, so it grouped as two projects and a remap moved half of them. A register row is
  still FILED under the string the user added — that has not changed, and does not need to.

  Two decisions inside that change are worth keeping, because both look like details and are not:

  - **Grouping needs the canonical form itself, not a predicate.** `samePath` answers about two paths;
    a sidebar bucket needs a key. So `path-containment.js` answers both, and there is no second canonical
    form beside it — two copies of it is how #245 started.
  - **That key is memoised and the containment GUARDS are not.** Asking the filesystem costs ~92 µs
    against ~0.7 µs for the string compare it replaced; one sidebar rebuild over 2 000 session rows in 200
    real directories measures 16 ms as it stands and 311 ms with the memo taken out, and a rebuild that
    begins with nothing remembered costs ~28 ms — the number a 15-second scan pays. The guards keep asking
    the disk every time, because a remembered answer about where the app may WRITE is a weaker guard,
    while a remembered answer about which bucket a row belongs in costs a regrouping.

  And one thing the change deliberately took AWAY, which is easy to read as a regression and is not.
  The old key rewrote every `\` into `/` on **every** platform, so the two separators folded even on
  Linux and macOS. The real path folds them only where the host's own `path` module does — Windows.
  That is the correct answer rather than a narrower one: on POSIX a backslash is an ordinary character
  in a filename, so `/x/a\b` is one directory named `a\b` and folding it into `/x/a/b` merged two
  genuinely different paths. What it costs is a store written on Windows and then read on a POSIX
  install, where the backslash spellings no longer group with the forward-slash ones — a case the old
  behaviour got right by accident while getting native POSIX paths wrong on purpose. It is also why the
  `\`-vs-`/` fixture in `test/projects-view-path-spelling.test.js` is Windows-only now, and why the
  POSIX half of that fixture uses a trailing separator, which folds everywhere.
