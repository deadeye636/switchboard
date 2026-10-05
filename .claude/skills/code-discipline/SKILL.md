---
name: code-discipline
description: The four engineering disciplines for planning, writing, and reviewing code (Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution). Use when drafting plans, implementing changes, or performing code reviews. Trigger - "/code-discipline", "code discipline", "engineering principles".
---

# Code discipline

Every agent that writes, refactors, or reviews code in this project follows these four principles.

## 1. Think before coding

- State assumptions. Never assume silently.
- When a requirement or edge case is ambiguous, lay out the readings and ask instead of guessing
  (a subagent reports `blocked` with `scope_unclear`).
- When a request adds needless complexity or breaks an invariant from `CLAUDE.md`, say so and offer
  the simpler way.
- On unexpected structure, a failing test, or unexplained behaviour: stop and diagnose. No
  speculative workaround.

## 2. Simplicity first

- The least code that solves the problem completely.
- No frameworks, helpers or config hooks for needs nobody asked for.
- No defensive branches for states that cannot occur.
- Would a staff engineer call the diff clever or overbuilt? Then simplify.

## 3. Surgical changes

- Touch only the files and lines the step or fix needs.
- No drive-by reformatting, renaming or reordering of working code outside the task.
- Match the local idiom, naming, indentation and comment density.
- Remove only the debt you created (unused imports, temporary variables); leave unrelated dead code
  alone unless the task names it.

## 4. Goal-driven execution

- Turn each task into a check that can fail: a reproduction test first, then make it pass.
- Work in small increments: implement, verify, check for regressions.
- Iterate toward green within the circuit breaker: after two consecutive failed fix attempts, stop
  and report `blocked` with `iteration_limit` (`output-contract` skill) instead of trying again.
- Green tests are not done. A renderer change is done after the click test (CLAUDE.md reflex 2), and
  a commit follows confirmed behaviour (reflex 1).
