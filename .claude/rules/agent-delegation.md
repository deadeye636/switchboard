# When to hand work to a subagent

No `paths:` on purpose — this applies to every task in the repo. The goal is to keep the main
session's context for decisions, not for file dumps, test logs, or unstructured discussions.

## The agents

Subagents are leaves: Claude Code gives a subagent no Agent tool, so whatever you spawn reports back
to you and spawns nothing itself.

- **Main session.** Talks to the user, settles decisions, drives the app for the click test. In a
  normal session it also makes small edits itself (see below).
- **`orchestrator`** — not a subagent. Start a session with `claude --agent orchestrator` for a
  multi-step plan; that main session then writes no code and no documents and dispatches everything
  below. Spawned as a subagent it would be inert. Starting it is not yet a go to build: the user
  approves each plan once, and that go covers every `implementer` step of that plan — not the next
  plan, and not steps added after the approval.
- **`planner`** — writes specs (`docs/specs/`) and plan bundles (`docs/plans/<number>-<slug>/PLAN.md`)
  with step IDs `T1:`, `T2:`. Read-only on code.
- **Domain advisors** (read-only, with web research):
  - `electron-desktop-expert` — process lifecycle, preload IPC, native module ABI, packaging.
  - `terminal-pty-expert` — xterm.js, ConPTY, ANSI/VT sequences, screen buffers.
  - `backend-format-expert` — CLI transcript grammars, SQLite stores, Protobuf.
  - `performance-memory-expert` — event loop, workers, SQLite and FTS5, memory bounds.
  - `ui-codemirror-expert` — morphdom, CodeMirror 6, keyboard navigation.
- **Workers:**
  - `implementer` — one step ID at a time.
  - `test-runner` — noisy runs; returns pass/fail, the count, and the decisive line per failure.
  - `verifier` — adversarial, read-only conformance check. Always on Opus.

## Delegate without asking

1. **Domain advice** — consult the matching advisor before designing a cross-cutting change.
2. **Broad search or analysis** — "where is X used", a sweep across more than a handful of files, a
   map of an area before a change. Use `Explore` or `caveman:cavecrew-investigator`. Ask for the
   conclusion with `file:line`, not the contents.
3. **Long runs with noisy output** — `npm test`, `node --test`, a build, a `backends:*` check, a log
   hunt. Use `test-runner`.
4. **Verification** — `verifier`, as required after every non-trivial change.

## Delegate only when the user says so

5. **A bounded build** — `implementer` or `general-purpose`. By default one builder at a time in the
   shared tree, so tests, verifier and click test see its diff directly. Use `isolation: "worktree"`
   when another session works in this checkout, two builders run at once, or the tree holds
   uncommitted changes that are not this step's — never a builder beside those edits, never two in
   one tree. A worktree step is committed to its branch, verified there, and brought back with
   `git cherry-pick --no-commit` after a read-only preflight: the step is one commit, and its files
   (both sides of a rename) are clean in the main tree and identical in `HEAD` and in the step's
   parent — see `.claude/agents/orchestrator.md` rule 5. When the preflight fails or git refuses,
   the main session touches nothing and hands back to the user. In both modes the step ends
   uncommitted in the main tree and is committed only after tests, verifier and click test confirm
   it (CLAUDE.md reflex 1). One go covers every step of the plan it was given for — not the next
   plan, and not steps added after it.

## Do it in the main session

- An edit to one to three files, a lookup whose target is known, iterative debugging in dialogue.
  (Not when the session runs as `orchestrator` — then the `implementer` does it.)
- Anything the click test depends on — the main session drives the app and reads the result
  (`docs/ai/driving-the-app.md`).
- Decisions. An agent reports; it does not settle an open point from an issue or a plan.

## Limits

- At most three concurrent subagents.
- **Circuit breaker:** an `implementer` that fails its tests after two consecutive fix attempts stops
  and reports `blocked` with `iteration_limit`. Do not resend the same step unchanged.
- **Model:** advisors, `planner` and `implementer` run on Sonnet; rerun a step on Opus when it reports
  `complexity_high` or the blast radius is wide. `verifier` and `orchestrator` run on Opus.

## What every prompt carries

The agent knows only its prompt. A missing line is a rule it will break.

- The goal, the scope, and what is already ruled out.
- The files or the issue number to start from, the step ID if there is one, and the rule file for the
  area (the table in `CLAUDE.md`).
- Decisions from the conversation that touch the task — they are in no issue.
- Navigation through the index: jcodemunch for code, jdocmunch for `docs/` and `.claude/rules/`.
- **The shared-tree ban, verbatim:** no `git stash`, `git reset`, `git checkout --`, no branch
  switch; an older revision only through `git show <ref>:<path>`.
- The expected output shape — the `output-contract` skill, or the verdict format of `test-runner` and
  `verifier`. Short, with `file:line`, no pasted source.

## Trust, but read

An agent's mistakes come back in the same confident tone as its findings. Before a finding drives an
edit, check the cited `file:line` yourself. Do not re-run the whole search.
