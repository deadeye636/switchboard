# 20 — Plans

Status: **built** (#448, #449, #450, #452, #453, #454, #743), with follow-ups in #442, #455 and #456.
Written after the fact, as a design record.

The user-facing half is [`docs/plans-convention.md`](../plans-convention.md). This file is the why.

## The problem

The Plans tab read one directory: the one a backend declares as its own plans store. In practice that
meant `~/.claude/plans`, a flat pile of every plan from every project, named `hazy-zooming-pebble.md`
and sorted by date. Nothing on a row said which project it belonged to, because nothing in the file
does.

Three separate things came out of that: a plan could not be found, a plan could not be handed to a
running CLI, and a plan could not be shared between CLIs at all.

## A plan file carries no identity, and it cannot be given one

Measured against a real install, not inferred:

- The filename is adjective-gerund-noun from three hardcoded word lists in the Claude binary. Not
  derived from the title, not configurable.
- There is no frontmatter. The first `#` heading is the only human-readable handle.
- Claude **tracks a plan by that generated slug**: it caches plan files per working directory, and
  `copyPlanForResume` / `copyPlanForFork` copy the plan under a new slug when a session is resumed or
  forked. Renaming the file underneath it tells Claude the plan is gone.

The last point is the one that shapes everything else. **Nothing may depend on a plan's filename**, so
the convention hangs on a header block, which is part of the content and therefore something every
writer can produce.

## Attribution: the session knows, and it already told us

The transcript records `{"type":"attachment","attachment":{"type":"plan_mode","planFilePath":…}}` and
carries a top-level `slug` on nearly every line of the session that produced the plan. The session knows
its project. So the attribution is a lookup, not a heuristic.

The first design proposed a table and a backfill. That was wrong twice over:

1. **The slug is already indexed.** `session_cache` holds the slug, the project, the session and the
   backend in one row with an index on the slug — Claude's parser has read it since long before this
   feature. A grep over `src/workers` and `src/index` found nothing only because Claude's parser
   deliberately does not live there.
2. **The cheap thing first.** `migrations.length` is the schema version and appending is irreversible; a
   query is not. The residue that would justify a durable table — plans whose session has been pruned by
   `cleanupPeriodDays` — is measurable once the query ships, and was zero of two on the machine this was
   built on.

Which reference belongs to which file is the backend's business: a backend with a plans store may declare
`planRef(filePath)`, and the core does the lookup without learning what the string means. Claude's is the
filename stem. A backend that declares none gets no attribution rather than a guessed one.

**A plan whose session is gone keeps its place**, in a group labelled with what is actually missing. It
is a fact about the record, not a failure of the app, and dropping it would hide a document the user can
still open.

## `plansDirectory`, and its three silent refusals

Claude has an undocumented setting: *"Custom directory for plan files, relative to project root. If not
set, defaults to ~/.claude/plans/"*. Its containment check refuses

- a path outside the project root,
- a path with a symbolic link or junction component anywhere in it,
- a path whose resolved real path disagrees with how it was spelled,

and each refusal falls back to the global directory with nothing but an error line in a log the user
never sees. On Windows the second case is ordinary — a project on a `subst` drive or behind a junction
hits it without anyone doing anything unusual.

Two consequences that are load-bearing:

- **A central plans folder is impossible.** The setting cannot be pointed outside the project. Whatever
  else the convention is, it is per project.
- **Switchboard reports what arrived, never what was configured.** A configured directory holding no
  plans is called out above the list — and deliberately *before* the empty branch, because a project that
  configured a directory and got nothing is exactly the case where the list is otherwise empty.

## Switchboard reads plans; it does not write them

Owner decision, and it settles the shape of the whole feature. If the app does not produce plans, a
layout it declares is a recommendation and the tools that write are the ones that decide. So:

- **Recognising** what a project already does is the more valuable half — `docs/plans/`, `.plans/`,
  `plans/`, `.agent/plans/`, with the candidate list a setting. Nothing is created or configured.
- **Configuring** is still allowed: pointing a CLI at a directory, reversibly, after showing exactly what
  would be written. That is the same act as wiring the attention hook into Claude's settings.
- Which file a CLI needs changed is the CLI's business. A backend declares `planDirSetup` and answers
  with the file, its current contents and what they would become. It takes a **`shared`** flag besides:
  the file a project normally commits, or the one that stays on this machine — a team convention belongs
  in the first, a personal preference in the second, and only the caller knows which this is. And the
  answers come back in **two** lists, not one (#556): a backend that TRIED and refused is a different
  answer from one that had nothing to do, and folding them together read as success. The first attempt put a `.claude`
  literal in `src/app/` and `test/backend-path-neutrality.test.js` caught it — see
  [`docs/ai/lessons.md`](../ai/lessons.md).

`plansDir` takes a scope for the same reason: without it, pointing Claude at a project directory would
have hidden exactly the plans the setting was meant to organise.

### The read list is a setting per PROJECT (#470)

`planDirNames` was in the settings cascade from the start and half of it was never wired: there was no
field for it anywhere in the app, so the only way to change it was to export the settings blob, edit it
and import it back. And a project that did override it was ignored anyway, because `planDirCandidates()`
asked the cascade with `null` while `planDir` beside it resolved per project correctly.

**A WORKTREE inherits the name, not the directory.** It reads its project's settings (#593), and
`conventionDirs` resolves that relative name against the path it is handed — so plans written from a
worktree live in the worktree, which is where the work they describe is. An absolute `planDir` is not
inside the worktree and the escape guard drops it to the default there: the one case where a worktree
does not get its project's answer. Same rule for handoffs, `docs/specs/25-handoffs.md`.

That combination is worth naming, because nothing could see it. A setting that reads as global-only
*because it behaves that way by accident* looks exactly like a setting that is global by decision — and
the Plans tab renders identically either way unless a project actually has a directory the global list
does not name. It took building the same pair for handoffs (#468) to notice that plans had only half of
it.

So the pair is now symmetrical with the handoff one: a read LIST and a write TARGET, both in the cascade,
both with a field in global and project settings. Two rules come with it, both borrowed from #468 rather
than invented here:

- **Reading is a list, writing is one directory.** Otherwise reordering the read list would silently move
  where the next document lands.
- **An emptied field means the default, not "no directories".** A list that can be emptied is a setting
  that hides every plan the project has, and no error would ever be shown for it.

**A `planDir` the app cannot use falls back silently; a directory somebody typed is refused (#630).** A
setting that leaves the project, or that names the project root — `.`, `./`, `docs/..`, the project's own
absolute path — is replaced by `.plans` everywhere it is read: the plan prompt, a saved variable's insert
template, and since #630 the convention setup's preview and the welcome tour's figure as well. Before that the preview was the one
surface that read the setting itself, so it answered "has to be a directory inside the project" for a value
the prompt beside it had already quietly replaced — the divergence #623 closed on the handoff side, one
setting over. What the preview still refuses is a directory the CALLER named — and telling the two apart is
the renderer's job, because the setup dialog's input is PREFILLED with the effective setting: it sends
`planDir` only when the field differs from the `defaultValue` the markup was rendered with, and otherwise
sends nothing and lets the main process answer from the setting. Routing `planDirFor` through
`conventionDirs` was not enough on its own for exactly that reason — the field's value went out
unconditionally, so every setup looked like a path somebody had just named and the fallback never ran
outside the tests. The asymmetry is the whole of it: a setting nobody can use has nothing worth reporting about,
while a path somebody chose is the thing they asked about, and writing somewhere else would not be an
answer to it. The root falls back rather than being accepted because Claude refuses it in any case — the
three refusals above — so taking it would only move the silent failure into the CLI.


### A plan can be a folder (#743)

A project directory on the read list is WALKED, not read flat. Teams that keep a plan as a bundle,
`docs/plans/<slug>/PLAN.md` with its notes beside it, had an empty list, and a CLI's configured directory
holding only bundle folders was reported "empty" above it. The walk in `plans-memory.js` has four limits,
each one a place where a plan could vanish or a foreign file appear, and `test/plan-bundles.test.js` pins all
of them:

- **Three folder levels** below the plans directory. A plans folder is written by hand; deeper than that
  is a checkout or an archive, not a plan.
- **No hidden folder and nothing `build-dirs.js` names** (`.git`, `node_modules`, `dist` and the rest). The
  same list the other walks use, for the same reason.
- **No links.** A folder is entered only if its REAL path is inside the plans directory, asked through
  `path-containment.js` (CLAUDE.md reflex 13); a link to a folder is never followed, and a linked file is
  listed only when its target is inside. A junction spelled inside the directory cannot put another tree
  on the list.
- **A bounded number of entries per folder**, so a plans directory somebody unpacked a dump into costs a
  bounded read. A folder the cap cuts short is logged once at `debug`, so a missing plan has an answer.

**The read list may not name the project root.** `.`, `./` or `docs/..` in `planDirNames` is dropped the
way a blank entry already was, and any other spelling of the root is dropped on real paths: walked, the
root would list every markdown file three levels deep. A BACKEND's own setting that names the root (a
Claude `plansDirectory` of `.`) is kept, because that is where the CLI writes; the depth limit bounds it.

Rows are deduplicated by `pathKey` (real path, case-folded on Windows), so nested candidates or two
spellings of one directory give one row per file.

The open and save guards ask the same question: a file the walk would not reach (under `.git`, past the
depth) is refused even when it is inside a plans directory. The path below the directory is taken between
the two REAL paths, so a second spelling of the plans directory meets the same limits. They must not drift from the list, for the
reason already given above `plansDirs()`: a row the viewer refuses is worse than no row.

**What a row is called changed; what it IS did not.** A row's identity was `filePath` before and stays
so, which is what the selection, the reader, the save and a detached viewer all key on. `filename`
becomes the path below the plans directory (`60-migration-lock-timeout/PLAN.md`) for a nested file and
stays the bare name for a top-level one, so the list, the picker and `{filename}` in the insert template
all name the bundle. A plan without a heading takes its folder's name before its filename stem: a bundle's
file is named for its role, and the folder is what names the plan.

**A folder with a `PLAN.md` is a bundle, and only its `PLAN.md` is a plan** (owner decision on #743). The
first version listed every `.md` in a bundle, so a plan's notes, research and README sat in the list
beside it as plans of their own. Now the walk lists the bundle's `PLAN.md` (matched in any letter case;
the `.md` extension stays case-sensitive, as everywhere in this list) and does not descend further. A
folder without one keeps the plain rule, every `.md` in it within the depth limit, so a `drafts/` folder of
loose plans still works. The plans directory ITSELF is never a bundle: a `PLAN.md` at its top is one plan
among the others there. The empty-check uses the same walk, so a bundle holding only its `PLAN.md` counts.

The open and save guards were deliberately NOT narrowed for this. A note inside a bundle is no longer
listed, but it is still inside a plans directory and within the walk's limits, so opening it by path is
allowed. Refusing it would add a rule only the guard knows, for a file nobody can reach from the list.

A backend's OWN store is still read flat. It belongs to the CLI, which writes it flat.

The watch follows: a plans directory is watched **recursively** — natively on Windows and macOS, and on
Linux since Node 20, which Electron 41 is well past. Where a recursive watch throws, it falls back to the
flat one it had before, so top-level plans stay live and a bundle appears on the next list load. Events
from a folder the walk does not enter, or from past its depth, are dropped before they rebuild the list.
Dropped, not unwatched: `fs.watch` takes no exclusion list, so on Linux every subfolder of a plans
directory costs an inotify watch, skipped ones included. Accepted for a directory this small.

## Asking for one, without writing it (#486)

The rule above holds, and this is the shape that respects it: the command palette's **Write a plan** types
a prompt into the focused session and stops. No file is written by the app, nothing is captured, nothing is
reviewed. The plan directories are already watched, so what the agent writes appears in the list by itself
— which is why this needs no machinery of its own.

**The prompt is the whole feature**, because the CLI writing the file has not read this document. So the
built-in one carries the convention: `{planPath}`, `<date>-<slug>.md`, the title as first heading, the
`status:` / `updated:` block. It is editable globally and per backend, and per backend matters more here
than it does for handoffs — Claude has a plan mode that names its own files, Codex, Hermes and Pi have
none at all, and one wording cannot fit both.

A prompt that is a **slash command** is the case we cannot word: `/plan` runs the CLI's own skill and the
skill picks the directory. Such a prompt is sent with the directory on a line of its own, unless it names
it already; a prompt written as prose is sent exactly as written. The mechanic is shared with the handoff
side (spec 25), and the directory itself comes from `src/app/convention-dirs.js` — one resolver, or a
prompt and an insert template would name different directories.

The row is offered only for a session with a **live PTY** that is not a plain terminal. `seedSessionWhenReady`
returns silently otherwise, and an ungated row reported "asked the agent" over a session nothing was typed
into.

## The convention degrades

Not everyone has an issue tracker and not everyone has git. The header works with a heading, a status and
a date; a binding to a work item is optional and can be an issue URL, one of Switchboard's own
per-project tasks, or nothing at all. Retirement degrades too: under version control a finished plan is
deleted because history is the recovery net, and without it the plan stays and is marked done, because
deleting there is data loss.

## Handing a plan to a running CLI

`insertPlan` (default `Ctrl/Cmd+Shift+P`) is a second instance of the saved-variable palette, not a
second design — same anchoring, same keys, same CSS. That palette's geometry, focus recovery and
outside-click rules were paid for in bugs, and a subtly different popover beside it would have had to pay
for them again.

It inserts a **reference**, never the plan: hundreds of lines do not belong in a prompt box when the
agent has file tools. The wording is a template in the settings cascade, so a project can phrase it its
own way, and an empty template falls back to the default rather than inserting nothing.

The picker depends on the attribution above, and it is a filter rather than a sort order: the list holds
this session's project and nothing else. It once drew the other projects underneath, grouped by name, on
the argument that a plan written in one project is sometimes what you want to hand to another. That is
true and it is still the wrong default — a list opened by hotkey mid-session is a list of things about to
be handed to a running agent, and a foreign plan sitting in it is another codebase's instructions one
Enter away. A plan nothing could attribute is dropped on the same reading: unattributed is unknown, not
local. The Plans tab keeps the full list, which is where borrowing across projects belongs — chosen, not
mistyped.

Two ways to end up with an empty picker, and the palette names which one it is: a project with no plans
yet, and a terminal the app cannot place. They have different fixes, and one message for both reads as a
broken hotkey.

A row carries the date the plan last changed beside its filename (#475). The Plans list had shown it all
along; the picker is where the choice is actually made, and it was the one place the app dropped it. The
filename is not an answer to "which of these" on its own — a plan a CLI wrote is named whatever that CLI
names it. `paletteMetaWithDate` in `palette-core.js` is where both pickers get it, worded through
`formatDate` so a row reads like the list it came from, and silent when the date cannot be read.

## A plan changes while you read it

The viewer already reloaded a file that changed on disk, which was enough while the only writer was the
user. It is the whole feature once an agent is rewriting a plan for twenty minutes while the user reads
it. Six defects, none of which raised an error — the document simply stopped being true. They are
recorded in #452 and the fix lives in `src/app/file-watch.js` and `src/renderer/views/text-sync.js`.

The four that shape the design:

- **The reload applies a change, not a replacement.** Every position inside a replaced range maps to its
  boundary, so a full-document swap moved the cursor and scrolled the view away on every write.
- **The conflict is symmetric.** An external change that would overwrite edits is announced instead of
  applied, and a save over a file that moved underneath is refused. The second direction is the one that
  costs more: a reflexive Ctrl+S used to write a stale copy over twenty minutes of an agent's work.
- **The side-by-side view follows the conflict it is about** (#456). It is a snapshot of two strings,
  and the file can move again while it is up — this panel is the one surface where a document is read
  while an agent rewrites it, so a second write mid-decision is the expected case. Leaving the first
  version on screen meant the reader compared their edits against something that was no longer there and
  then answered a bar that had quietly moved on: "Reload" applied content they had never seen. The view
  repaints from the same field the buttons read, and the change is announced rather than swapped in.
- **Answering the bar moves the baseline, whichever answer it was** (#442). The baseline is what both
  directions measure against, so "Keep mine" has to adopt the version it was shown before discarding it —
  otherwise the user answers the bar, presses Ctrl+S, and the save's own readback raises the same bar
  again, forever. Keeping a version is a decision about that one change and not a standing waiver: a
  later external write is measured against what was kept and announces itself as usual.

## Known gaps

- The instruction line for the CLIs with no plan mode is text to copy in the convention document.
  Switchboard does not write into a project's `AGENTS.md`, and does not install a skill into another
  CLI's store. Both would be the same decision one step further and deserve their own issue.
- Claude writes a `.workshop.md` sibling next to a plan when a session is forked. It is listed as an
  ordinary plan today. Folding it into the row of the plan it belongs to would change the shape of the list and has no demand
  behind it yet.
- Only the plans directories are watched for liveness. The other lists this module serves walk project
  trees reaching tens of thousands of files, where a recursive watch would cost more than the staleness
  it fixes.
- A watch whose file is renamed away keeps looking for it, backing off, and stops after a bounded window
  (#455). Stopping is a state `watchStats()` reports rather than a silence, and reopening the document
  revives it — but a file that comes back after that window is not noticed until something asks again.
