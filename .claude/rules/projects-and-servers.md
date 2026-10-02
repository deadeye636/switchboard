---
paths:
  - "src/projects/**"
  - "src/servers/**"
---

# Projects & Servers Registry

Rules for project metadata management and MCP server integrations (#211, #241, #392, #393, #398).

## Projects (`src/projects/**`)

- **Backend Neutrality:** Since #211, project management is backend-neutral. Use `projectMeta` and `transcriptPathFor` without requiring specific backend modules.
- **Safety on Active Sessions:** Project removal or deletion must refuse if an active session is currently running in that directory (#574, #578).
- **No Hardcoded Backend IDs:** Do not hardcode backend IDs or config literals (like `~/.claude.json`) in `src/projects/projects.js` or `project-registry.js`. Use `backends.getDefaultLaunchTarget()` or descriptor hooks.
- **Store Isolation:** Claude home paths must resolve per call from `SWITCHBOARD_STORE_CLAUDE`, never bare `os.homedir()` (#241, `test/store-isolation.test.js`).

## Servers & MCP Bridge (`src/servers/**`)

- Houses `src/servers/mcp-bridge.js`, the MCP IDE bridge.
- **Store Isolation:** Resolves lock file destinations from `SWITCHBOARD_STORE_CLAUDE`, never `os.homedir()`.
- **Window Lifetime (`startMcpServer`):** Takes a GETTER (`() => BrowserWindow`), never a static window object (#392). The bridge outlives window teardowns and re-openings.
- **Pending Diffs & Windows:** A pending diff records `pending.win` (the window it was sent to, not necessarily the session host). Cleaning up a window must call `rejectPendingDiffsForWindow` and inspect `hasPendingDiffsForWindow` (#393).
- **Concurrency in Message Handling:** `handleMessage` dispatches `tools/call` without awaiting, allowing multiple simultaneous diffs for a session (#398).
- **DI via Context:** Modules take `ctx`, never top-level `require('electron')`, ensuring testability under unit runners.
