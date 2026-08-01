# 18 — Pi RPC runtime evaluation

Status: evaluated in #413; no runtime switch was shipped. Keep Pi on the PTY/TUI path for now and track any future RPC runtime as a separate feature.

## Context

Pi exposes an RPC mode over stdin/stdout with strict JSONL framing for structured operations such as prompt, steer, follow-up, abort and state. Switchboard currently integrates every interactive CLI through a terminal PTY, then uses backend-owned seams for transcripts, live identity rebinding and state.

## Decision

Do not replace or shadow the Pi PTY integration with RPC yet. RPC is promising for automation, but it is a different runtime contract, not a drop-in improvement for the terminal session Switchboard presents today.

## Trade-offs

- Terminal UX: PTY preserves Pi's TUI, keybindings, prompts, command palette and extension UI. RPC would need a separate renderer and would not show the native terminal experience.
- Live state: the current Pi extension reports exact busy/idle edges through Switchboard's neutral terminal-binding channel. RPC could expose structured state, but would need a new backend-neutral runtime-state seam before it is useful beyond Pi.
- Launch/resume/fork: PTY launch already supports new sessions, resume and `--fork`. RPC support must prove equivalent semantics, including how Pi names sessions and where transcripts land.
- Safety: RPC makes programmatic prompt/abort/follow-up easier. That is useful, but it also bypasses some human-visible TUI affordances, so it needs explicit policy and UI review.
- Compatibility: indexing/search/message history already consume Pi's persisted JSONL. Any RPC path must still write the same store or provide an equivalent transcript source.
- Cross-backend design: Switchboard should not add a Pi-only runtime branch in core. A future design should be a neutral "structured runtime" capability that other backends can decline or implement.

## Follow-up shape

If this is revisited, open a new design/feature issue for an optional structured runtime capability. The first milestone should be a prototype behind a backend descriptor hook, with no replacement of the existing PTY path until launch/resume/fork, transcript indexing and state reporting match the current behavior.
