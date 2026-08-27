# Where plans live

A plan document is written by one coding CLI and then read by nobody else. Claude writes into its own
home directory under a generated name; Codex, Hermes and Pi write no plan at all. So planning in one tool
and implementing in another means copying the plan by hand.

This is the convention that fixes that. It is a recommendation, not a rule: Switchboard reads plans and
never writes one, so the tools that do the writing are the ones that decide. What follows is what the app
expects to find, and what it will set up for you if you ask.

## One directory per project

Plans belong to the project they are about, in a directory inside it. The default is `.plans/` at the
project root, and it is a dot-directory on purpose: a plan is written by a tool that knows nothing about
what may not be published, and the bodies are full of absolute paths and machine names. Keeping them out
of the repository by default is the setting that cannot leak. If you want them tracked, point the setting
at `docs/plans/` and take on the review that comes with it.

There are two settings, not one, and the difference matters. **Plans directory** is where a new plan is
written; **Plan directories** is the list the app reads. Both have a global default and a per-project
override, both in Settings under Plans. Project settings also have a button that writes the setting each
installed CLI needs, after showing you every file it would change.

The read list starts as `.plans/`, `docs/plans/`, `plans/` and `.agent/plans/`, so a project that already
keeps plans somewhere is listed as it is rather than converted. Point it somewhere else per project and
that project is searched there — the list is resolved for each project separately, so one project naming
`team-plans/` does not change what any other project is searched for. Emptying the field means the default
rather than "no directories": a list that can be emptied is a setting that hides every plan you have.

Reading is all it does. Nothing on that list is created, and a directory that is not there costs a failed
stat and nothing else.

## What a plan looks like

The first heading is the title. That is the whole requirement for being listed, because a document
written to be read has one.

Beyond that, a header block carries the state. It works with nothing else present:

```markdown
# Remove the end date from the tariff — it follows from the successor

> status: active · updated: 2026-08-20
> issue: https://example.invalid/team/repo/-/issues/26
> refs: src/tariffs/model.py, docs/technik/tariffs.md
```

`status` is `active`, `done`, `superseded` or `blocked`; a blocked plan says what would unblock it.
`updated` is the last day someone touched it. Both are for a human scanning a directory.

Everything else is optional, and that matters more than it sounds: **not everyone has an issue tracker,
and not everyone has git.** A plan with no `issue` line is a valid plan. Where there is no tracker,
Switchboard's own per-project tasks do the same job. Where there is neither, the heading is the identity
and that is enough.

## Naming

Plans written through this convention are named `<date>-<slug>.md` by default — `2026-08-20-tariff-end-date.md`.
It works without a tracker, without version control and without a running count. A project with an issue
tracker will want `issue-<n>-<slug>.md` instead, which ties each plan to exactly one issue mechanically,
with no mapping table to drift.

Nothing may depend on the name. Claude's plan mode names its own files from three word lists —
`hazy-zooming-pebble.md` — and it tracks the plan by that name afterwards, so renaming the file underneath
it tells Claude the plan is gone. That is why the header carries the state and the filename carries
nothing.

## When a plan is finished

A plan is an execution tracker, not an archive. When the work lands, move what should outlive it to where
it belongs — decisions to the decision log, rules to the rules, knowledge to memory — and then:

- **Under version control:** delete the plan. History is the recovery net, and the closed issue is the
  record.
- **Without version control:** keep it and set `status: done`. Deleting here is data loss, not tidying.

Switchboard knows which case a project is in and says so rather than assuming.

## For the CLIs that have no plan mode

Codex, Hermes and Pi write no plan documents. For them this convention can only be carried by
instructions — a line in the project's `AGENTS.md` or `CLAUDE.md` reaches all of them and costs nothing:

```markdown
Plan documents go in `.plans/` in this project. Start each one with a `# heading` and a
`> status: active · updated: <date>` line. Read what is already there before writing a new one.
```

That is a suggestion the model can ignore, which is the honest limit of the approach. Claude is the one
case where the directory is enforced rather than suggested, because it has a setting for it.

## Asking for one

The command palette has a **Write a plan** action. It types a prompt into the session that has focus and
stops there — the app still writes no plan, and it does not review what comes back. The plan directories
are watched, so what the agent writes turns up in the list by itself.

The prompt is the part that carries this convention, since the CLI writing the file has not read it:
where the file goes, what it is called, the title as the first heading, the header block. It is editable
under **Settings → Documents → Plans**, and a backend that needs different wording gets its own on its
page under **Backends** — which matters more here than it does for handoffs, because Claude has a plan
mode that names its own files while Codex, Hermes and Pi have none at all.

`{planDir}` is the directory relative to the project, `{planPath}` its full path, `{today}` the date for
the header block. A prompt that is a slash command — `/plan` — runs the CLI's own skill, and that skill
decides where it writes; such a prompt is sent with the directory appended on a line of its own, unless
it names the directory itself. `docs/handoffs-convention.md` describes the same mechanic on its side.

## What can go wrong quietly

Claude refuses a plans directory outside the project root, one reached through a symbolic link or a
junction, and one whose resolved path disagrees with how it was spelled. It refuses all three silently,
falling back to its own home with nothing but a line in a log. Windows makes the second case ordinary —
a project on a `subst` drive or behind a junction hits it without anyone doing anything unusual.

So Switchboard reports what actually arrived rather than what was configured. A directory that a project
asked for and that holds no plans is called out above the list. If plans keep appearing in the CLI's own
home after you set this up, that is what happened.
