# When to hand work to a subagent

No `paths:` on purpose — this applies to every task in the repo. The goal is to keep the main
session's context for decisions, not for file dumps and test logs.

## Delegate without asking

1. **Broad search or analysis** — "where is X used", a sweep across more than a handful of files, a
   map of an area before a change. Use `Explore` or `caveman:cavecrew-investigator`. Ask for the
   conclusion with `file:line`, not the contents.
2. **Long runs with noisy output** — `npm test`, a build, a `backends:*` check, a log hunt. The agent
   runs it and returns pass/fail, the count, and the one decisive line per failure.
3. **Verification** — `verifier`, as already required after every non-trivial change.

## Delegate only when the user says so

4. **A bounded build in its own worktree** — `general-purpose` with `isolation: "worktree"`. Never a
   building agent in this shared tree beside the main session's own edits.

## Do it in the main session

- An edit to one to three files, a lookup whose target is known, iterative debugging in dialogue.
- Anything the click test depends on — the main session drives the app and reads the result
  (`docs/ai/driving-the-app.md`).
- Decisions. An agent reports; it does not settle an open point from an issue or a plan.

## What every prompt carries

The agent knows only its prompt. A missing line is a rule it will break.

- The goal, the scope, and what is already ruled out.
- The files or the issue number to start from, and the rule file for the area (the table in
  `CLAUDE.md`).
- Decisions from the conversation that touch the task — they are in no issue.
- Navigation through the index: jcodemunch for code, jdocmunch for `docs/` and `.claude/rules/`.
- **The shared-tree ban, verbatim:** no `git stash`, `git reset`, `git checkout --`, no branch
  switch; an older revision only through `git show <ref>:<path>`.
- The expected output shape — short, with `file:line`, no pasted source.

## Trust, but read

An agent's mistakes come back in the same confident tone as its findings. Before a finding drives an
edit, check the cited `file:line` yourself. Do not re-run the whole search.
