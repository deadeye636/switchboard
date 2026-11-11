# Session-flow fixtures (#826)

Hand-built, no real data. Every path, id, model name and text is invented; nothing is copied from a transcript.
`test/flow-fixtures.test.js` parses every line and scans for local identifiers. The shapes follow the #826
sections of `docs/backend-formats.md` (Claude, Codex, Pi).

| File | Represents | Measured shape |
|---|---|---|
| `claude-main.jsonl` | Main lane: `instructions` attachment with `files[]`, prompt, meta user line (`isMeta`), thinking, `tool_use` + `tool_result`, text with `message.usage` and a model, `permissionMode` and a `mode` change, `compact_boundary` + summary line, interrupt | Claude, "Steps, instruction files and permissions" |
| `claude-parent.jsonl` | Parent whose `tool_result` names the subagent by `agentId` | same |
| `claude-parent/subagents/agent-a1b2c3.jsonl` + `.meta.json` | The subagent file (`isSidechain: true`, own `instructions` attachment) and its meta | same |
| `codex-rollout.jsonl` | `session_meta`, `turn_context` (permission fields, a change on the second), a `developer` message, the AGENTS.md message with its `<environment_context>` part, reasoning, `custom_tool_call` `exec` + its parts-array output, `function_call` + string output (one failing with an exit code), `token_count` incl. `model_context_window` (once repeated), `compacted`, the zero `token_count` after it, `turn_aborted` | Codex, "Agents, approvals and compaction" |
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

Checked against local transcripts (T11, keys and tool names only): the Claude spawn tool is `Agent` (a `Task` spelling is accepted by the reader but was not seen), `agentId` sits in the result user line's top-level `toolUseResult` and on every line of the child file, the meta file names the spawn call by `toolUseId`, and a background launch has `status: "async_launched"` (the fixture, a foreground one, has `status: "completed"`).

Checked against local Codex rollouts (T14, key and type names only): the `exec` input is a plain string of script source, not a
JSON object with a `cmd` key; a `custom_tool_call_output` `output` is a list of `{ type: "input_text", text }` parts whose first part
starts `Script completed` and a `Wall time` line, while a `function_call_output` `output` is a string; the AGENTS.md user
message carries a second `<environment_context>` part; a `reasoning` item's `summary` is empty on every item seen (the text is
`encrypted_content`); `token_count.info` has `total_token_usage`, `last_token_usage` and `model_context_window`, and
`last_token_usage.input_tokens` already includes the cached part. One compaction was seen: the `compacted` line, `world_state`,
`turn_context`, then a `token_count` with input 0. No `turn_aborted` was in the local rollouts.

Still guessed: the `Exit code: N` / `exit_code=N` form a failing tool call's output ends in (the local `exec` outputs state no exit
code; a code seen in them was quoted script output), the `turn_aborted` line (documented, not seen locally), the `spawn_agent` / `wait_agent` argument
and output keys, the `status` values in `wait_agent` output, and Pi's `usage` key names and entry
wrapper. Confirm against a real transcript before a reader relies on them.
