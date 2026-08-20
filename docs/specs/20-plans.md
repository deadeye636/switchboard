# 20 — Plans

Status: **built** (#448, #449, #450, #452, #453, #454), with follow-ups in #442, #455 and #456.
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
  with the file, its current contents and what they would become. The first attempt put a `.claude`
  literal in `src/app/` and `test/backend-path-neutrality.test.js` caught it — see
  [`docs/ai/lessons.md`](../ai/lessons.md).

`plansDir` takes a scope for the same reason: without it, pointing Claude at a project directory would
have hidden exactly the plans the setting was meant to organise.

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

The picker depends on the attribution above. Without it, it would open on the same flat pile the tab used
to show, only smaller.

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
  ordinary plan today. Treating a plan as a bundle would change the shape of the list and has no demand
  behind it yet.
- Only the plans directories are watched for liveness. The other lists this module serves walk project
  trees reaching tens of thousands of files, where a recursive watch would cost more than the staleness
  it fixes.
- A watch whose file is renamed away keeps looking for it, backing off, and stops after a bounded window
  (#455). Stopping is a state `watchStats()` reports rather than a silence, and reopening the document
  revives it — but a file that comes back after that window is not noticed until something asks again.
