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
session **newer** than that.

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
The scan is now the one that reports it (`session-cache.js` → `getStoreProjectPaths()`, `path → newest
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
the offer can never contradict what the register would do. The tombstone therefore holds: a project you
removed is not offered back until a session newer than the removal turns up.

## As built — where the pieces are

| Piece | Where |
|---|---|
| The decisions (register / skip / resurrect / sweep / visible) — pure, no db, no fs | `project-registry.js` |
| The columns + the seeding migration | `db.js` |
| The sidebar reads the register; the scan reports what the stores hold | `session-cache.js` |
| add / hide / unhide / remove / discovery + sweep (it releases too, #184) | `projects.js` |
| What is indexed but not listed (`unlistedProjects`, #183) | `projects.js` |
| `syncRegistry()` before the list is built; one visibility rule for every view | `main.js` |
| "Listed" toggle (both modes), hide ≠ remove | `public/projects-admin.js`, `public/sidebar.js` |
| The "not on your list" line + the manager's filter (#183) | `public/app.js`, `public/projects-admin.js` |

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

The rule lives in `sessionProjectPath` (`derive-project-path.js`); `PARSER_SCHEMA_VERSION` was bumped with
it, or the sessions v3 had already scattered into phantom projects would never be re-read — their mtimes
settled long ago.

## What a removal clears — and what it does not

A removal purges the project's cached rows **from every backend, row by row**. Not folder-scoped: a store
folder is keyed on the cwd a session *started* from, so since #157 it can hold rows of other projects, and
clearing by folder would drop those while their transcripts sat on disk. And not Claude-only: a removal
that leaves the Codex and Pi rows in the cache, the search index and the stats has removed a sidebar row,
not a project.

**No session file is touched.** Deleting the history is a separate act (*Delete this project's sessions*).

Every write path is gated on the removal, or the removal would not stick: `refreshFolder`, `refreshFile`,
the backend scan — **and the worker rebuild**, which walks the whole store and knows nothing about the
register. Miss that one and a "Rebuild session cache" puts a removed project's sessions back into the
cache and the search index as an invisible, searchable zombie that nothing ever purges again (the register
hides the sidebar row; the tombstone stops it from ever being listed and swept).

## Known gaps

- A removed project's sessions are out of **search** until it is registered again. Intended — it was
  removed from Switchboard — but it is a behaviour change worth knowing.
- The sweep's "no session anywhere" check sees a backend store only once that backend has been scanned in
  the current run. It errs on the safe side: an unscanned store means the tombstone is **kept**.
- A session that is **live** at the moment of removal keeps writing, so its file is newer than the
  tombstone and the project comes back on the next flush. Defensible as "fresh activity", but it is not
  what "remove" looks like from the outside.
- The register keys on the path as written. Windows spells the same directory two ways, so the tombstone
  and the state lookups compare case-insensitively there — but two spellings can still end up as two
  *registered* rows for one directory.
