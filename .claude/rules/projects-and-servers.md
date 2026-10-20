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
- **Worktrees outside the layout (#757):** `src/projects/known-worktree.js` recognises a checkout by its `.git` file, reading it once per path per run; the fact is stored (`src/db/worktree-store.js`), the owner is not — it is the nearest listed project holding the repository, recomputed when the list changes. A path someone listed or removed keeps its own behaviour, and nothing automatic lists such a checkout. Callers ask `src/shared/worktree-path.js` as for any worktree; do not add a second detection. Full record: `docs/specs/10-project-registry.md`, section "A gone checkout leaves the sidebar" (#757).

## Servers & MCP Bridge (`src/servers/**`)

- Houses `src/servers/mcp-bridge.js`, the MCP IDE bridge.
- **Store Isolation:** Resolves lock file destinations from `SWITCHBOARD_STORE_CLAUDE`, never `os.homedir()`.
- **Window Lifetime (`startMcpServer`):** Takes a GETTER (`() => BrowserWindow`), never a static window object (#392). The bridge outlives window teardowns and re-openings.
- **Pending Diffs & Windows:** A pending diff records `pending.win` (the window it was sent to, not necessarily the session host). Cleaning up a window must call `rejectPendingDiffsForWindow` and inspect `hasPendingDiffsForWindow` (#393).
- **Concurrency in Message Handling:** `handleMessage` dispatches `tools/call` without awaiting, allowing multiple simultaneous diffs for a session (#398).
- **A client's path is the model's (#780):** `openFile` and `openDiff` ask `refusePath` before they read, and a network path no project is on is answered with an error instead. main.js sets the guard with `setPathGuard`; the default refuses every network path, so a bridge used before that fails closed.
- **The HTTP listener (`src/servers/mcp-http.js`, spec 34):** one per app instance, bound lazily on the first `registerSession`, loopback only, port 0. A session is a registration on it, named by a Bearer token compared in constant time; the token, not a socket, is the identity, so a token of one session cannot reach another's pending diffs. A `Host` other than the loopback address and port, or any `Origin`, is refused; the body is capped; every handler is wrapped so a throw answers an error and the listener keeps serving. A reply is a JSON body or an SSE event, by the request's `Accept`. A bind failure answers `unavailable` and never throws into the spawn path.
- **One registry, two transports:** the HTTP entries live in the same registry as the WebSocket ones in `mcp-bridge.js`, with a `kind` and a list of exposed tool groups. `resolvePendingDiff`, `rejectPendingDiffsForWindow`, `rekeyMcpServer` and `shutdownMcpServer` work for either kind; a re-key moves the registration to the new session id and the token stays valid. Claude keeps its WebSocket path and its five tools unchanged (a golden test pins it, `test/mcp-bridge-transport-neutral.test.js`).
- **Shutdown:** `shutdownAll` settles every pending diff, then closes the HTTP listener, so no token outlives the app. A session's registration is released on its exit.
- **The agent-facing `openDiff` (group `diff`)** is stricter than Claude's dialect on purpose: a relative `filePath` resolves against the project, and a path outside it (real-path containment) or on a foreign network path is answered with an error. The server never writes the file.
- **DI via Context:** Modules take `ctx`, never top-level `require('electron')`, ensuring testability under unit runners.
