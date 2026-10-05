---
name: output-contract
description: Standard report format and escalation codes for subagent reports to the orchestrator or main session. Short, with file:line, no pasted source. Trigger - "/output-contract", "output contract", "status report", "agent reporting format".
---

# Agent output contract

Advisors, `implementer` and `planner` report in this shape. `test-runner` and `verifier` keep the
verdict formats in their own agent files; those formats take precedence over this one.

## Structure

```markdown
### 1. Status
<done | blocked | provisional | info>

### 2. Findings / Changes
- Concrete findings, changes, or recommendations.
- Every code reference cites `file:line` (e.g. `src/backends/agy/state.js:115`). No pasted source.

### 3. Risks & Assumptions
- Trade-offs, possible regressions, unverified assumptions, "needs click test".

### 4. Verification Commands
- The exact commands that were run (e.g. `node --test test/agy.test.js`), with their result.

### 5. Escalation / Next Action
- The next step for the caller, or an escalation code if blocked.
```

## Status values

- `done` — the task is complete and verified as far as this agent can verify it.
- `blocked` — the agent stopped; an escalation code says why.
- `provisional` — a result exists but rests on an assumption the agent could not check. Name it
  under Risks.
- `info` — advice or analysis only; nothing was changed.

## Escalation codes

- `iteration_limit` — circuit breaker: two consecutive failed fix attempts.
- `complexity_high` — deeper algorithmic complexity or wider blast radius than expected; rerun on Opus.
- `architectural_conflict` — the change conflicts with an invariant (migrations, path containment,
  IPC placement, backend boundaries).
- `scope_unclear` — ambiguous requirement or missing decision; needs the user.
- `convention_violation` — the request or approach breaks a project rule (e.g. a local path in a
  tracked file, a new IPC handler in `src/main.js`).
- `tooling_failure` — broken build, missing native toolchain, or environment problem.
