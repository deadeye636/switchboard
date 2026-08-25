# 25 — Handoffs live in the project

Status: **built** (#468, #469).
Written after the fact, as a design record.

The user-facing half is [`docs/handoffs-convention.md`](../handoffs-convention.md). This file is the why.
Spec [`04-one-click-handoff.md`](04-one-click-handoff.md) is the flow that produces a packet, and it is
unchanged: what changed is where the packet goes afterwards.

## The problem

A handoff was a row in `project_handoffs` — project path, label, content, timestamp, and since #148 the
backend that wrote it. That is a perfectly good place to put a string, and the wrong place to put this one.

- **Nothing outside the app could read it.** Not an editor, not `grep`, not version control, and not the
  agent that is supposed to act on it. The packet existed only inside a dialog.
- **It did not travel.** Written on one machine, invisible on the next. The project it belongs to syncs;
  the row does not.
- **The ecosystem was already writing files.** The handoff skills several CLIs ship write markdown into
  the project — `prompts/`, `docs/handoffs/`, `.claude/handoffs/`. Switchboard could not see any of it,
  while presenting itself as the place a project's handoffs live.
- **A picker was impossible.** #469 wants a reference in the prompt, the way the plan picker inserts one.
  A row has no path, so the only thing a picker could have inserted was the whole packet — which is
  exactly what the plan picker refuses to do, for the same reason: a document belongs in an agent's
  context through its own file tools, not pasted into a prompt.

The last point is why the two issues are one design. The file is not a nicer storage backend; it is the
precondition for handing a handoff to a running session at all.

## Files replace the database — not join it

Keeping both would have meant two stores for one thing, a row that has a path beside a row that does not,
and every list merging them. The whole surface came out in one pass instead: the statements in
`tasks-store.js`, the façade entries in `db.js`, the table in `schema.js`, the two hooks in
`project-refs.js`, three legacy handlers in `main.js`, and their preload bindings.

**The export runs before the drop, and a failure stops the drop.** `src/app/handoffs.js` reads the old rows
at startup through `src/db/legacy-handoffs.js`, writes each into its project, and drops the table only when
every one of them landed. A row whose project directory is gone is the case that matters: it is not
discarded, no directory is invented for it, and the table stays until the folder is back. That is the
version of "clean end state" that cannot lose a packet on the way to it.

`legacy-handoffs.js` prepares its statements **inside** its functions rather than at module load, which is
the opposite of every store beside it and the only shape that works here: after the first successful pass
there is no table to prepare against, and a fresh database never had one.

**Migrations were the wrong tool.** The table drop looks like a schema migration, but the export is a
filesystem write and has to consult the settings cascade to know which directory each packet goes to.
`migrations.js` runs on the database, at open, before any of that exists. So the schema baseline simply
stops declaring the table, and the app-level step above empties it.

## Two settings, because a read list is not a write target

`handoffDirNames` is the list that is read; `handoffDir` is the one directory that is written. The obvious
saving — "the write target is the first entry of the read list" — is a trap: reordering a list is a
reading decision, and it would silently move where future packets land.

Both are in the cascade, both are project-relative, and a path that escapes the project root is refused
wherever it comes from, including the folder picker offered after a failed write.

`prompts/` is **not** in the default read list even though the skills write there first. In many
repositories that directory is prompt assets, and scanning it offers files that are not handoffs at all.
A project that does keep them there adds it.

Neither is `.claude/handoffs/`, and that one is a rule rather than a judgement call: **no backend id
outside its own folder.** A backend declares its own handoff directory through `handoffDirs({ projectPath })`
on its descriptor, and the core reads both sources without learning what `.claude` means.
`test/backend-path-neutrality.test.js` caught this on the first attempt, where the directory was a literal
in `src/app/settings.js` — the guard is the reason the seam exists rather than a comment saying it should.

## A file needs an identity a row got for free

A row had a label column and an id. A file has a name, and a name is the thing tools rename.

So the heading is the title and a header block carries the rest (`created`, `backend`), the same shape the
plans convention landed on and for the same reason: **nothing may depend on the filename**. Packets this
app writes are named `<date>-<slug>.md` with a numeric suffix on collision, and that name carries nothing.

Both header fields are optional. A packet a skill wrote before any of this existed is still a handoff: the
file's timestamp answers the date, and nothing answers the backend — which is what the `NULL` column meant
in #148, arrived at again from the other direction.

## Saving can now fail, and the packet must survive that

A database insert effectively does not fail. A file write does: a read-only directory, a full disk, a
folder outside the project. And this write happens in the one moment where losing the text is worst —
immediately after an expensive session spent tokens producing it.

`saveHandoffPacket` in `src/renderer/handoff/handoff.js` is the answer. A refusal comes back **still holding
the packet**, with the two ways out that do not require the dialog to have guessed right: choose another
folder, or take it to the clipboard. It is `dismissible: false`, and a cancelled folder picker returns to
that dialog rather than out of it — leaving on a cancel is the one path that would drop the packet without
anyone choosing to.

## The picker is one more description of one popover

#469 adds no popover. `palette-core.js` (#462) already renders the saved-variable, plan and skill pickers;
`handoff-palette.js` is a fifth description object beside the command palette's.

It follows the **plan** picker rather than the skill picker in the one place they differ: taking a row
leaves the reference in the prompt instead of submitting it. Picking a skill is asking for it to run;
picking a handoff is saying "here is the context", and what to do with it is the next sentence the user
is still writing.

Scoping is the plan picker's rule, restated because it is worth restating: **this project's handoffs and
nothing else.** Main answers per project, and the renderer filters again where it renders — a list a hotkey
opens mid-session is a list of things about to be handed to an agent, and another project's packet in it is
another codebase's context one Enter away.

## What this does not do

- **No CLI is configured.** Plans need a setup step because the CLI writes the plan and Claude's
  `plansDirectory` refuses three kinds of path silently. Switchboard writes the handoff itself, so there is
  no setting to push anywhere and no refusal to diagnose.
- **No handoff is written without being asked for.** The flow in spec 04 is unchanged: every token-spending
  step and every save is a deliberate action.
- **Deleting deletes a file.** The confirmation says so, because a row and a tracked file are not the same
  thing to lose.
