# Session-flow fixtures (#826)

Hand-built, no real data. Every path, id, model name and text is invented; nothing is copied from a transcript.
`test/flow-fixtures.test.js` parses every line and scans for local identifiers. The shapes follow the #826
sections of `docs/backend-formats.md` (Claude, Codex, Pi).

| File | Represents | Measured shape |
|---|---|---|
| `claude-main.jsonl` | Main lane: `instructions` attachment with `files[]`, prompt, meta user line (`isMeta`), thinking, `tool_use` + `tool_result`, text with `message.usage` and a model, `permissionMode` and a `mode` change, `compact_boundary` + summary line, interrupt | Claude, "Steps, instruction files and permissions" |
| `claude-parent.jsonl` | Parent whose `tool_result` names the subagent by `agentId` | same |
| `claude-parent/subagents/agent-a1b2c3.jsonl` + `.meta.json` | The subagent file (`isSidechain: true`, own `instructions` attachment) and its meta | same |
| `codex-rollout.jsonl` | `session_meta`, `turn_context` (permission fields), AGENTS.md message, reasoning, `custom_tool_call` `exec` + output, `function_call`, `token_count` incl. `model_context_window`, `compacted`, the zero `token_count` after it, `turn_aborted` | Codex, "Agents, approvals and compaction" |
| `codex-parent.jsonl` | `spawn_agent` / `wait_agent`, an escalated `exec` (`require_escalated` + `justification`) under `auto_review` | same |
| `codex-child.jsonl` | Child header: `source.subagent.thread_spawn` with `parent_thread_id`, `depth`, `agent_path`, `agent_nickname` | same |
| `codex-guardian.jsonl` | Guardian rollout, two turns: short `{"outcome":"allow"}` and the full verdict form | same |
| `pi-session.jsonl` | `session`, `system` message with `sections.project_context`, `usage`, `toolCall` read/bash, refusal `toolResult`, `subagent` call, `compaction` | Pi, "Instruction files, refusals, subagents and compaction" |

Measured or documented, with fake values: the Claude `compact_boundary` and summary-line keys (`compactMetadata`,
`isVisibleInTranscriptOnly`, `turnPosition`), the subagent `toolUseResult` and `.meta.json` keys, the Codex
`compacted` payload (its `latest_token_usage_record` is the summarising call, the trap a reader must ignore) with the
`world_state` + `turn_context` lines and the zero `token_count` after it, the guardian header (`thread_source`,
`parent_thread_id`, `session_id`), and the Pi refusal text.

Found wrong against real data (T4): a `mode` line carries the prompt-input mode (`normal`), not a permission mode, so the fixture's `"mode":"acceptEdits"` line is not what a real file holds; the reader ignores it and gets the change from the next user line's `permissionMode`. An `instructions` attachment can also repeat (`changed`, `reason`) and its files have a `type`.

Still guessed: the `Agent` tool name, the `agentId` on the child file's lines, the `spawn_agent` / `wait_agent` argument
and output keys, the exec input key `cmd`, the `status` values in `wait_agent` output, and Pi's `usage` key names and entry
wrapper. Confirm against a real transcript before a reader relies on them.
