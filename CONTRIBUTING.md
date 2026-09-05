# Contributing

Issues and pull requests are both welcome.

One thing to know before you start, because it explains the rest of this page: this project is built
largely by AI agents working against a written rulebook. `CLAUDE.md` is the entry point and
`.claude/rules/` holds the path-scoped rules; both are in the repository and both are addressed to
whoever is doing the work, human or not. The conventions below are unusually explicit for a project this
size because a rule nobody wrote down is a rule that gets broken every third session.

None of it is meant to make contributing hard. It is meant to make it possible to accept a change from
someone I have never met.

## Reporting something

Open an issue. There is no template — a report that says what you did, what happened and what you
expected is enough.

Two things help more than anything else:

- **What you measured, separately from what you concluded.** "The picker was empty" and "the model probe
  is broken" are different claims, and the first one is the useful one.
- **Version and platform.** The app's version, the CLI's version if a backend is involved, and the OS.
  Several defects in the history were a CLI that had changed under us.

**Do not put personal or local details in an issue.** No real paths, no machine or account names, no
screenshots of a directory tree with your name in it. The repository is public, and issue *edit history*
is public too — deleting it afterwards un-publishes nothing. Use `~`, `<project>`, `<user>` or an
obviously invented path.

## Before you write code

**Open an issue first and let it be discussed**, unless the change is small enough to be self-evident (a
typo, a broken link, a one-line fix with an obvious cause).

This is not gatekeeping. The task board is GitHub Issues, several things are half-planned in issue
comments that are not visible from the code, and a large PR that cuts across a design decision made three
issues ago is painful for both of us to unwind. A short issue costs you ten minutes and can save you an
evening.

**One logical change per pull request.** A fix and a refactor of the code around it are two.

## What a change has to satisfy

These are the rules the project applies to itself. They are enforced by tests where that is possible and
by review where it is not.

### Tests

- **`npm test` passes.** It is `node --test` over `test/*.test.js` and needs no Electron. It takes about
  30 seconds.
- **A new test must fail against the code as it was.** This is the one that gets skipped, and it is the
  most important line on this page. A test written after a fix tends to describe the fix rather than the
  defect, and then it passes against the broken code too. Check yours: stash the source change (not the
  test), run it, and see it fail. If it does not, it pins nothing — rewrite it or drop it and say so.
- **Green tests are not a green light for anything the renderer does.** The suite has almost no opinion
  about `src/renderer/**`; a change there has to be clicked. Say in the PR what you clicked and what you
  saw.

### Measure, do not read off documentation

Where the project records what an external CLI does — `docs/backend-formats.md` above all — every row was
taken from a running install. Published documentation has been wrong here more than once, in both
directions, and a keymap has been read as fact and shipped as a defect twice.

If you are adding or changing such a row, say how you measured it. "The help text says so" is not a
measurement; "I pressed the key and watched what reached the process" is.

### Language and privacy

- **English**, everywhere: code, comments, tests, commit messages, documentation, issue and PR text.
- **No personal or local identifiers in anything that lands in the repository.** No real paths (a bare
  drive letter and folder counts), no user or machine names, no email addresses. This binds test fixtures
  and file names too. Git history is permanent and world-readable.

### Commits

[Conventional Commits](https://www.conventionalcommits.org/): `fix(scope): what changed`. Write the body
for someone who will read it in a year without the issue open — what was wrong, and why this is the fix
rather than another one.

### A few structural rules that will trip you up

They are documented where they apply; this is the short list of the ones with teeth:

- **Database migrations are append-only.** The number of migrations *is* the schema version. Renumbering
  or editing an existing one corrupts databases that are already in the field.
- **No new IPC handler in `src/main.js`** — it belongs in an `src/app/` module. A test enforces this.
- **No backend id outside its own folder.** A capability that differs per backend is declared on the
  backend's descriptor, never branched on in the core.
- **Never `fs.writeFileSync` a file a CLI reads.** There is one way to do that safely, and it is used for
  a reason: an editor holding stale text must not overwrite what an agent wrote in the meantime.
- **`docs/BACKLOG.md` is generated and untracked.** Do not edit or commit it.

`CLAUDE.md` has the full list with the cost of each; the path-scoped files under `.claude/rules/` load the
detail for whichever area you are in.

## What will get a pull request sent back

Not to be discouraging — these are simply the things that cannot be merged as they are:

- A test that would also pass against the unfixed code.
- A real path, a personal name, or non-English text anywhere in the diff.
- A large refactor nobody discussed. It may well be a good refactor; it still has to start as an issue.
- A behaviour claim about an external CLI that came from its documentation rather than from running it.
- A renderer change with no account of what was clicked.

## Reviews take a while

This is a side project. An issue may sit for a bit; a pull request will be read properly rather than
quickly. If something has gone quiet for a couple of weeks, a nudge on the thread is welcome rather than
rude.

## Security

Please do not open a public issue for a vulnerability. Report it privately through GitHub's **Security →
Report a vulnerability**, and give me a reasonable window to fix it before disclosing.

Note the standing caveat in the README: released builds are unsigned and unaudited. Building from source
is the honest path for anything you care about.

## Licence

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE), like the
rest of the project.
