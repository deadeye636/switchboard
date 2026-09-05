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

**A row leaves the table as its own file lands, not when the batch does.** The first version deleted
nothing and dropped the table only once every row had been exported — which reads as careful and is the
opposite: one row whose project directory was missing kept the table alive, so every *other* row was
exported again on the next start, under a `-2`, `-3`, … name. Silent duplication, in the code path whose
whole promise is that no packet is lost. Write the file, then forget the row; that order also survives a
failed write, which the reverse does not. A verifier found this by reading, after the feature had shipped
and been pushed — no test could see it, because no test starts the app twice.

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

A row says when the packet last changed as well as what it is called (#475). The list is newest first and
was not saying so, and the picker is where "which of these five" is decided without the library open
beside it. The wording comes from the same helper the Plans list uses, so the two read alike; a date that
cannot be read is left off rather than replaced by a placeholder.

## One date, and it is the file's (#577)

That paragraph claimed an agreement the code did not have. The list was ordered by the `created:` header
and the row showed the mtime, so the packet worked on most recently was not the one on top — and the date
beside it said today, which is what made it read as a broken sort rather than a second sort key.

The argument for ordering by the header was that editing a packet does not make it a newer handoff. That
is true of a packet written once, and a handoff is not written once. It is a running log: an update
appended per session, with the header untouched since the first write. Ordered by the header, the file
somebody worked in this morning sinks below one started last week and never opened again.

**Every handoff surface now orders by, and shows, the file's mtime** — the resume picker, the palette and
the Agent Files group. The old sort had a second defect that alone would settle it: `created:` is optional
by design, so a file with a header sorted by when the work was handed over and a file without one by when
it was last written, in the same list. Measured in one project's directory, 7 of 31 files carried a header.
One clock now, for every row.

`created:` is still written into a new packet and still read back — `createdAt` is null for a file that
does not carry one, rather than the mtime wearing the creation date's name. It decides nothing about the
order, and it is not on the row: the row is one line, and for a running log the header names the day the
log was started, which is the one date that does not help anyone pick between five packets.

## Writing one from the keyboard (#473)

Both ways into the flow were chips on a row you have to leave the terminal to reach — the health chip in
the sidebar and the same chip on a grid card. The decision to hand over is made *in* a session, and from
there the flow had no route at all. Worse, the picker made it a dead end: open it in a project with no
packets and it said "No handoffs in this project.", which is true and unhelpful at exactly the moment
someone wants to write one.

Two routes, and neither is a new surface:

- **The command palette gained the actions the focus makes possible**, and this is the first of them. Which
  session it means and how the row says so is spec 23's rule (`focusedActionSession`, and the row names the
  session) — it is written down there because the next such action has to answer it the same way.
- **The picker's empty state offers it.** `emptyEnter` already existed for the saved-variable picker, which
  turns "no variables yet" into "press Enter to open the Variables tab". A picker with nothing to pick
  offers the thing that would give it something, and names the key.

Both end in `showHandoffPrompt` — the same producer choice, review and save the chips open. A second way in
must not become a second flow: that is where the token spend is confirmed, and a route that skipped it
would spend without asking.

## The note about version control, and the check that never fired

A packet quotes paths, machine names and whatever the session was looking at, so a handoff directory that
is going to be committed is worth one sentence at the moment a packet lands in it. The plans convention
had exactly that check and it lived inside `plans-memory.js`, which already requires this module — so
copying it would have been the cheap edit and the wrong one. It moved to `src/app/vcs-ignore.js` and both
callers share it.

The move paid for itself immediately. The original compared a normalised directory name against
un-normalised `.gitignore` lines: it stripped a leading dot from `.plans` and not from the ignore file's
own `.plans`, so the two could never match. The check answered "not ignored" about every dot-directory —
which is every default this app has — and nothing noticed, because the only thing it produces is a note.

## The prompt says where the packet goes (#485)

While Switchboard captures the agent's answer and writes the file itself, the directory need not appear in
the prompt at all. That stops being true the moment the agent writes the packet — which is exactly what a
slash-command prompt does: `/handoff` runs the CLI's own skill, the skill picks the directory, and the app
then looks in the project for a packet sitting in the skill's home.

So both prompts take `{handoffDir}` (project-relative) and `{handoffPath}` (absolute), filled per session
from the cascade, and a prompt that **is** a slash command is sent with the directory appended on a line of
its own — only then, and only when it does not already name the directory. A prompt written as prose is
someone's own text and is sent as written.

`src/app/convention-dirs.js` answers where a project keeps handoffs and plans, and it is the only thing
that does: the prompt, the plan prompt (spec 20) and a saved variable's insert template all ask it, or they
would name different directories. A configured path that escapes the project falls back to the default
rather than being handed to an agent — `path-containment.js`, asked about the directory before any `stat`.

## What this does not do

- **No CLI is configured.** Plans need a setup step because the CLI writes the plan and Claude's
  `plansDirectory` refuses three kinds of path silently. Switchboard writes the handoff itself, so there is
  no setting to push anywhere and no refusal to diagnose.
- **No handoff is written without being asked for.** The flow in spec 04 is unchanged: every token-spending
  step and every save is a deliberate action.
- **Deleting deletes a file.** The confirmation says so, because a row and a tracked file are not the same
  thing to lose.
