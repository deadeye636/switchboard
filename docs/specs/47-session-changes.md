# 47 — Session changes (the sidebar's Changes group)

Issue #870. Status: **planned** (owner decisions of 2026-11-12 recorded below; nothing built). The plan is local
(docs/plans/870-session-changes/PLAN.md, gitignored); this file is the lasting record.

## What it does

A compact **Changes** group in a session's sidebar (spec 43) that answers one question: *what did THIS session do
since I last looked?* It shows the files the session edited with how often, the commits it made with their messages,
whether it pushed, and totals in the collapsed header. **Details** opens the commits, the files and their diffs (and the
review log). **Clear** means "I have reviewed this": the baseline moves to now and a review-log entry is kept.

It is review only. It never blocks, gates or undoes anything, and it never writes to the repository.

## Decided by the owner (2026-11-12, issue comment)

- **O1 = B, the transcript decides attribution, git supplies the content.** Which files this session edited and how
  often, which commits it made and which pushes it ran come from its own transcript (commit SHAs from the `git commit`
  tool output, the push from the `git push` output). `git diff --numstat <baseline>`, `git log <baseline>..HEAD` and, on
  Details only, the full diff supply the content. It stays correct when several sessions share one working tree, because
  a file or a commit is listed only when this session's transcript says it did it.
- **O2 = C2, Clear moves the baseline AND keeps a review log** (time, from/to SHA, transcript offset). Earlier reviews
  can be reopened.
- **O3, the transcript is read inside the existing incremental scan** (session cache / index worker), one aggregated row
  per session and file. This changes what the parsers store, so `PARSER_SCHEMA_VERSION` is bumped in every affected
  parser in the same step and one full rescan follows (`.claude/rules/db.md`). Not a separate on-demand worker.
- **Git side only while the group is open and shown**, triggered by the poller's `vcs-status-changed` pushes (as the
  Repository group does, spec 43 #858). No timer of its own. A closed group makes no git call.
- **The logic lives in `src/app/`**, not in the renderer, so MCP tools and rules can use it later.

## Design (approved by the owner on 2026-11-12, with the open points below decided)

### Data flow

```
transcript --(parser, inside the incremental scan)--> row.changes --(index-writes)--> session_change_* tables
                                                                                            |
sidebar group opens / vcs-status-changed / scan notice --> src/app/session-changes.js --> git (read only)
                                                                                            |
                                                              neutral view model --> renderer group, Details window
```

### 1. Attribution: a neutral accumulator, a per-backend extractor (reflex 5)

No backend id and no transcript format leaves its folder. The pieces:

- **src/backends/change-events.js** (shared, requires nothing): the accumulator the parsers feed. `noteEdit(path, pos, at)`,
  `noteCommit({ sha, subject, pos, at })`, `notePush({ ok, pos, at, summary })`, and `toRow()`, which returns the neutral
  `row.changes` shape below with its caps applied. It also keeps the **pending-call map** (tool call id to the intended
  event), bounded, so a call counts only when its result arrives and is not an error (a failed `Edit` is not an edit).
- **src/backends/git-command-events.js** (shared, like `flow-command-patterns.js`): git's own command line and output
  language, which no CLI owns. It finds `git commit` and `git push` inside a command string (reusing `splitSegments`
  from `flow-patterns.js`, so `a && git commit -m "x" && git push` and `git -C <dir> commit` work and quoted text is data),
  reads the new commit's SHA and subject from the commit's output (`[branch abc1234] subject`), and the push outcome from
  the push output (a ref update line, `Everything up-to-date`, `! [rejected]`, `error:`). A commit whose output carries no
  SHA (a hook failed, nothing to commit) is not a commit.
- **`<backend>/change-events.js`** (per backend, in its folder): how THAT backend finds a file edit (its tool names and
  fields), a shell command and the result that belongs to it. The parser calls it per transcript entry. It hands the shell
  command and its output to `git-command-events.js` and the edit paths to the accumulator.
- **Descriptor declaration `reportsChanges`** (`true` or `false` with a comment naming why), a capability row
  `sessionChanges` in `src/backends/capabilities.js` (`yes` / `limited` / `no`, a `limited` answer says which half is
  missing), pinned in `test/backend-parity.test.js`. A template and a driver forward their base's / owner's answer
  (`profileToDescriptor`; `test/template-descriptor-shape.test.js`). The core never calls a hook per entry: it reads
  `row.changes`, which a backend either fills or leaves absent.

`position` is the one ordering key. For the file backends it is the transcript **byte offset** of the line that carried
the event (the owner's "transcript offset"); a store backend uses its own monotone message id. The review log, the
baseline and the "since" filter all compare positions and nothing else.

### 2. Which backends can answer

First pass, from what the readers already extract. Every row is **verified against a real transcript in T1** before the
extractor is written, and a signal that cannot be verified becomes an honest `no` (the descriptor rule in
`.claude/rules/backends.md`), never a guess.

| Backend | Edits | Commits / pushes | Position |
|---|---|---|---|
| Claude (and claude-native, which reads Claude's rows) | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` calls with a file path, counted on a non-error result | `Bash` call + its result | byte offset |
| Codex | patch calls (the patch text names its files) and shell-command writes | shell call + its output | byte offset |
| Pi (and pi-native) | its edit / write tools | its bash tool + result | byte offset |
| Hermes | candidate: `tool_calls` in its message rows; decided by T1 | same | message row id |
| agy | **no**: no verified signal in its `.db`; it answers `reportsChanges: false` and the group says so | no | none |

A session of a backend that does not report shows the group with one sentence ("This CLI does not report which files it
changed.") and no figure. The group is not hidden, so the user is not left wondering where it went (hiding is the user's
choice, spec 43 #835).

### 3. What the scan stores

New tables, appended migrations (`src/db/migrations.js`, never inserted; `test/db-migrations.test.js` pins them), a store
src/db/changes-store.js and a pure src/db/changes-record.js (shape, caps, normalising; outside the store because no
test loads a module that opens the database):

| Table | Holds | Written by | Lifetime |
|---|---|---|---|
| `session_change_file` | one row per session and path: edit count, first / last position, last time | the scan | derived, replaced whole per session |
| `session_change_event` | the session's commits (SHA, subject, position, time) and pushes (outcome, position, time) | the scan | derived, replaced whole per session |
| `session_change_baseline` | the baseline: SHA, position, time, repository root, how it was set | the app (first sight, Clear) | user state |
| `session_change_review` | one row per Clear: time, from / to SHA, from / to position, totals, the per-file counts at that time (capped JSON) | the app | user state, newest per session kept |

Rules:

- **Derived vs user state.** The two derived tables are replaced in one transaction when a parsed row carries `changes`
  (like `replaceSessionMetrics`, and only when it changed since the last emission, tracked in the parser's retained
  state). A folder wipe + reinsert therefore costs nothing that matters. Baseline and review rows are the user's and are
  **not** touched by a wipe or by the "source gone" delete; they go with the session's deliberate delete and with the
  project's (`project-refs.js`, `test/scoped-folder-deletes.test.js`).
- **Caps** are named constants in `changes-record.js` (files per session, commit and push events per session, review
  entries per session, bytes of a review's file list). A row over a cap says `truncated` and the group says so.
- **A re-key** (`/clear`, fork, resume under a new id) moves nothing: a new session id has its own baseline (see E1).
- **Counts since the baseline** are a subtraction, not a second table: total edits of a file minus the edits it had when
  the last review was taken (`session_change_review.files`). A file is "touched since" when its last position is greater
  than the baseline position. Determinism of the parser is what keeps this stable across a rescan; a parser bump that
  changes what counts as an edit is a known cause of a one-off skew (stated, not hidden).
- **Subagents** of a Claude session are separate rows (`parentSessionId`). See E4.

### 4. The git side, src/app/session-changes.js

One `src/app/` module (IPC registered in it, bound in `src/preload.js`, no handler in `src/main.js`, reflex 4). The
renderer sends a **session id**, never a path: main resolves cwd and backend from its own cache row. The core is
VCS-blind: every argv comes from a **provider hook** in `src/vcs/git.js` (`numstatArgs`, `logRangeArgs`, `revExistsArgs`,
`headArgs`, `revBeforeArgs`, `diffArgs` gaining a `rev`, `showCommitArgs`), pinned in `test/vcs-parity.test.js`. Every
call is async `execFile` with `provider.bin` (absolute, reflex 10), `--no-optional-locks` first, the repository as cwd,
a timeout and an output cap. Nothing runs through a shell.

What a refresh costs, per session whose group is open and shown:

1. `rev-parse --verify -q <baseline>^{commit}`: does the baseline still exist.
2. one `diff --numstat -z --no-renames <baseline>` (whole tree, then **filtered in JS to the session's files**, which is
   what keeps a shared tree correct and avoids a pathspec list that grows with the session).
3. one `log --format=... <baseline>..HEAD` with a cap; the rows whose SHA matches one the transcript recorded are the
   session's commits, the rest are counted as "other commits".
4. untracked files the session created (`Write`) are not in `git diff <baseline>`; the poller's status summary already
   lists them, so the group reads that, and the line count of a new file is read lazily in Details with the hardened reader
   of `readUntrackedDiff`.

Paths from a transcript are untrusted input: each is resolved against the session's checkout with
`src/app/path-containment.js` (real paths, reflex 13) before it is used; a path outside the checkout is listed as
"outside this checkout" without a diff and is never passed to git.

**Triggers.** The group subscribes to `onVcsStatusChanged` exactly as the Repository group does (spec 43 #858) and reads
again when the push for the session's directory changes branch, counts, files or ahead / behind, when the scan notice for
that session says its `changes` moved, and on the reload button. `vcsFollow` reports a folder when its Repository **or**
Changes group is open and shown (the poller's watch list is unchanged in kind). A closed or hidden group, a closed
sidebar and a destroyed tab end the subscription. One refresh in flight per session; a push during it marks it dirty and
runs one more.

**The collapsed header figure** ("3 files · 2 commits") needs no git: it is two small reads of the derived tables since the
baseline position (like Context's figure, spec 43 #840). It is refreshed on the same scan notice and shows no figure
rather than `0` when there is nothing.

### 5. Clear and the review log

Clear writes, in one transaction: a `session_change_review` row (the totals and the per-file counts of what was shown),
then moves the baseline to the current `HEAD` and the transcript's current position. It runs no git write. It is one
click, no confirmation (nothing is lost: the review is logged), and a toast says what was cleared. The review log is
listed in Details; opening an entry is read-only and shows that review's commits (`from..to`), its files with the counts
it had, and the committed part of its diff. Uncommitted content of a past review is not reconstructible and the entry
says so.

### 6. Renderer

- **Group `changes`** added to `SESSION_SIDEBAR_GROUP_NAMES` (`src/renderer/lib/sidebar-groups.js`), so the order and
  hide mechanisms of spec 43 (#829, #835) apply unchanged. Default place and open state: E6.
- **Rows use the existing pattern** (`.ssb-row`, `.ssb-row-main`, `.ssb-row-meta`, `.ssb-subhead`, `.ssb-note`,
  `.ssb-sublist`; spec 43 "The row pattern (#822)"). A file row: path (folder name dimmed), edit count in the meta slot.
  A commit row: subject, short SHA in the meta slot, a pushed / not pushed mark. Click on a file or commit opens Details at
  that item; hover buttons follow `sidebarRowActions` (open the file, copy the path / SHA). A plain click does not insert into the
  prompt, unlike the other groups: a changed file is not something one pastes by reflex. That deviation is E5.
- **Buttons** "Details" and "Clear" reuse the existing small-button styling (no bare `<button>`, reflex 8).
- All text is escaped (a commit subject and a path are someone else's).
- Pure parts (`changesRowModel`, `changesHeadFigure`, `changesStateOf`) in `src/shared/` or the renderer's pure file, with
  tests in the style of `test/session-sidebar-rows.test.js`.

### 7. Details

A standalone window per session, like the changes window of spec 15 (focus-if-exists, destroy-on-close, destroyed with
the main window), with an external script because of `script-src 'self'`. Sections: **Commits** (subject, short SHA,
time, pushed mark, "rewritten" mark), **Files** (path, edit count, `+/-` lines, "new"), a **diff pane** (the colouring and
the `Open in window` bar of spec 15 / #287 are factored into one shared renderer file both windows load; large diffs open
in the existing CodeMirror diff window with `fileVersions` learning a `rev` mode: old = `<baseline>:<path>`, new = working
copy), and the **Review log** (reopen, E3 in the mockup). Every diff line is escaped; the diff text is read only when a
row is opened.

## States the group must draw (each is a test case)

| State | Shown |
|---|---|
| Nothing since the last review | "Nothing since the last review." No Clear button (nothing to review). |
| Edits, no commit | files with counts; no commits subhead |
| Commits, none pushed | commits with "not pushed" |
| Commits pushed | commits with "pushed" and the time of the last push |
| Not under version control | transcript-derived files and counts, no diff, "No repository: diffs are not available." |
| Baseline gone (garbage-collected, history rewritten) | transcript-derived list stays; "The review point is no longer in this repository's history." and a **Set review point to now** action (same as Clear without a log entry for a missing SHA, E2) |
| Git unavailable / a read failed | the last good view stays with a note; the failure's text is generic (git's stderr carries paths) |
| Backend does not report | one sentence, no figure |
| Truncated | "Only the first N files are listed." |

## Open points for the owner

Numbered `E`; each has options and a recommendation. **All decided by the owner on 2026-11-12: every recommendation
below is taken** (E1 (a) with the (b) fallback and a `/clear` child's own baseline, E2 (a), E3 (a), E4 (a), E5, E6, E7
(b), E8 (b), E9 commit baseline with the footer note, E10 list as outside, no diff). Also accepted: commits and pushes
are small capped event rows beside the per-file aggregate, and the single `PARSER_SCHEMA_VERSION` bump comes after
storage and all extractors. The byte-offset cost (more than 10 % on a full Claude parse) is measured in the build and
brought back to the owner before the sequence-number fallback is used.

- **E1. Initial baseline for a session that has none** (every session existing before the rescan, and every new one).
  - (a) **The commit that was `HEAD` when the session started**: `rev-list -1 --first-parent --before=<session start> HEAD`.
    Deterministic, works for old sessions, needs nothing recorded live. Weak on a shared branch that moved a lot (the
    commit "at start" is a time guess), and a session resumed days later has an old start.
  - (b) **`HEAD` at the first time the app sees the session** (or first opens the group). Cheap and exact for new sessions,
    but an old session starts "clean" and hides everything it already did.
  - (c) **Lazy: the first time the group is opened**, as (b) but explicit ("since you first looked"), and until then no baseline.
  - **Recommend (a), falling back to (b) when the start time is missing or the repository has no commit before it.** Old
    sessions then show real history, and (a) is reproducible. Transcript-derived lists never depend on the SHA.
    A `/clear` child starts its own baseline by the same rule (not its parent's): recommended, since the user's
    review point for a cleared conversation is a new one.
- **E2. When the baseline SHA is gone** (prune, history rewrite): the transcript-derived list stays; the diff and the log
  cannot be built. (a) say so and offer "Set review point to now"; (b) silently re-anchor to the merge-base with the
  upstream or to the current `HEAD`. **Recommend (a):** (b) hides that something was rewritten. The review log entry
  made by that action records `from = (missing)`.
- **E3. Amend / rebase after the baseline.** A commit the transcript recorded may no longer be in `baseline..HEAD`.
  (a) show it with its recorded subject and a "rewritten" mark (not in history); (b) try to match its replacement by
  subject / patch-id; (c) drop it. **Recommend (a):** it is honest and free; (b) is a heuristic that can attach the wrong
  commit. The session's own `git commit --amend` is a new commit event whose SHA replaces the old one in the list.
- **E4. Subagents.** A Claude subagent's edits are in its own row (`parentSessionId`). (a) the parent's group **includes**
  its subagents' edits, commits and pushes (read-time union), each file counted once with summed edits; (b) parent only.
  **Recommend (a):** the user reviews what the session's agent did, and a delegated edit is still this session's work.
  Cost: a join on `parentSessionId` at read time, nothing more in the scan.
- **E5. Row click.** Spec 43's row pattern says a click inserts into the prompt. For files and commits that is the wrong
  default. **Recommend:** click opens Details at the item, hover buttons "Open file" and "Copy path / SHA", Shift+click
  inserts the path / short SHA (so the pattern's text insert is still one gesture away).
- **E6. Place and default state.** **Recommend** right after Repository, closed by default (it reads git when open, E10 of
  spec 43), the header figure visible when closed. It is new to a user's saved order, so `orderSidebarGroups` puts it
  after the section that precedes it by default. Settings reference: the default order list.
- **E7. Manual edits outside any session.** A file nobody's transcript names is never listed (attribution is the point of
  O1). But a file the session edited and a person edited afterwards shows the combined diff. (a) say nothing;
  (b) in Details only, "N other files changed in this working tree and not by this session", from the poller's status
  summary, no diff. **Recommend (b),** one line, because a reviewer who sees a clean list and a dirty tree should know why.
- **E8. Two sessions edited the same file.** The diff cannot be split by session. (a) show it as is; (b) mark the row
  "also edited by N other sessions" from `session_change_file` rows of other sessions in the same repository root since the
  baseline (a DB read, no git). **Recommend (b):** it states the limit instead of leaving the user to find it.
- **E9. Baseline is a commit, not a snapshot.** Clear sets the baseline to `HEAD`. Uncommitted edits made before Clear
  still differ from `HEAD`; they are not listed (transcript position) but appear inside the diff of a file the session
  edits again afterwards. The alternative is a working-tree snapshot (a tree object written with a temporary index), which
  is more exact and is a git write (objects only) and a second concept. **Recommend the commit baseline**, stated in the
  Details footer ("diffs are against <short SHA>, which may include earlier uncommitted work in a file edited again").
- **E10. Worktree sessions.** The session's cwd is a linked worktree; the object store and refs are shared, `HEAD` and the
  working tree are the worktree's. All git calls run in the session's checkout (`-C` is not repeated, `vcs.md` invariant 3),
  paths are relative to that checkout, a path in another checkout of the same repository is "outside this checkout".
  Not an open question as such; the owner is asked only whether a session that edits a file in the **main** checkout from a
  worktree session should list it (recommended: list it as outside, no diff).

## Constraints that are not open

- **Performance.** The parse cost is the byte-offset bookkeeping and a per-entry check on lines the parsers already
  decode. T3 measures a large real transcript before and after (`docs/specs/11-performance.md` method) and has a fallback
  (a per-session event sequence number instead of a byte offset) if the offset bookkeeping costs more than the plan's
  budget. The write cost is bounded by the caps and by writing only when the aggregate changed.
- **No new IPC in `src/main.js`**, no backend id outside its folder, English only, no personal paths.
- **Privacy of the stored data.** Paths are stored as the transcript spelled them (they are already in the transcript and
  in `session_cache`); nothing from `session_change_*` leaves the machine except through the existing exports, which
  do not include it.

## Known gaps (written down now, before building)

- A commit or push made **outside** the session (another terminal) is invisible by design (O1).
- A tool that edits a file indirectly (a code generator, `sed -i` in a shell) is an edit git sees and the transcript
  extractor may not. v1 counts only the edit tools and `Write`-like calls; shell-made writes are not attributed (a known
  under-report, not a wrong claim).
- agy answers nothing; Hermes depends on T1.

## Files (planned)

src/backends/change-events.js, src/backends/git-command-events.js, src/backends/<backend>/change-events.js;
src/db/changes-record.js, src/db/changes-store.js, `src/db/migrations.js`; `src/index/index-writes.js`;
`src/vcs/git.js`, `src/vcs/index.js`; src/app/session-changes.js, src/app/session-changes-model.js, `src/app/vcs.js`
(follow list, `fileVersions` rev mode); `src/preload.js`; `src/renderer/session/session-sidebar.js`,
`src/renderer/lib/sidebar-groups.js`, src/renderer/session-changes.{html,js}, src/renderer/diff-render.js,
`src/renderer/style.css`. Tests: test/change-events.test.js, test/git-command-events.test.js,
test/<backend>-change-events.test.js, test/changes-record.test.js, test/session-changes-model.test.js,
test/session-changes-git.test.js, test/session-changes-rows.test.js, plus the parity and migration pins.
