---
paths:
  - "src/backends/claude-native/**"
  - "src/backends/pi-native/**"
---

# Pipe-Driven Native Backends

Architectural invariants for backends driven directly over stdin/stdout pipes without terminal emulation (`claude-native`, `pi-native`). Specs: `docs/specs/30-pi-native.md`, `docs/specs/32-claude-native.md`.

## Core Principles

1. **Protocol Rigor:** Communications adhere strictly to measured RPC protocols (`src/backends/claude-native/rpc-protocol.js`). Read messages line-by-line using streaming JSON parsers.
2. **Approval & Interactive Cards:** Decisions, tool approvals, questions, and plans must be rendered onto dedicated conversation cards rather than falling back to pseudo-terminal inputs. The one exception is an ask a core observer answers first (`agentRpc.observe`): a review session's asks are refused by the review runner and draw no card (spec 39, "Read-only enforcement").
3. **Session Ownership & Forwarding:** Native drivers must cleanly delegate descriptor hooks (such as `skillInvocation`) to their underlying CLI counterpart while preserving pipe session identity.
4. **Clean Process Teardown:** Ensure child processes receive graceful termination signals before killing streams to avoid orphaned background agent processes.
