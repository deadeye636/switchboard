# AGENTS.md

> **Authoritative project instructions, conventions, and rules are defined in [`CLAUDE.md`](CLAUDE.md).**
> Before executing any task, you MUST read `CLAUDE.md` and
> [`.claude/rules/agent-delegation.md`](.claude/rules/agent-delegation.md), then strictly follow all
> instructions and behavioral guidelines.

Cross-tool adapters mirror Claude's project resources:

- `.codex/agents/` exposes the Claude subagent roles to Codex.
- `.agents/skills/` exposes Claude skills to Codex and points back to their authoritative workflow.

When changing an agent or skill, keep its Claude source and cross-tool adapter synchronized.
