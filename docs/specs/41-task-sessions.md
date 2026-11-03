# 41 — Task sessions on another backend: what was measured before the design

Issues #804 (start a task session), #805 (worktree isolation), #806 to #810 (the rest of the former #507). Status:
**draft, measurements only**. Nothing here is built. The working plan is `docs/plans/507-mcp-orchestration/PLAN.md`
(local); its step T1 produced this file. The design sections are written when the first build phase starts.

## Decided by the owner (2026-11-03)

#507 was closed as built for discovery (spec 35) and review (spec 39) and split into #804 to #810 (E1). Every other open
decision was answered as recommended. Each issue's first comment lists its own.

| ID | Decision |
|---|---|
| E2 | A new `tasks` group (`startTask`, `taskResult`) beside `review`, with its own toggle; the runner is shared with the review. |
| E3 | An approval a task raises is shown in its row; unanswered past a bound, it is refused and the task ends `needs-input`. A per-backend allow-list may follow. |
| E4 | Only pipe-driven backends can be a task target for now (claude-native, pi-native). |
| E5 | The app manages the worktree outside the project tree. Nothing is merged automatically; the caller is told the branch. |
| E6 | A writing task gets a worktree, a read-only one works in the caller's folder; a folder that is not a git repository refuses a writing task. |
| E7 | A caller resumes only what it started. |
| E8 | When the caller ends, running children stop; rows and worktrees stay. |
| E9 | No tab opens or closes by itself; there is an explicit "Open as tab". |
| E10 | An OS notification for a task that needs input, through the existing attention engine. |
| E11 | Depth stays 1. |
| E12 | Tasks get their own caps (constants), with a longer time cap than a review. |
| E13 | agy and Codex may call `review` and `tasks` once their tool-call timeouts are known; Pi as its own step. |
| E14 | Privacy text in the backend's settings; the worktree is the visible boundary. |
| E15 | Messaging is deferred. |
| E16 | Cost is rolled up on read through `spawnedBy`. |

## Measurements (T1, 2026-11-03)

Versions on the measuring machine: Claude 2.1.314, Codex 0.166.0, agy 1.4.12, Hermes 0.21.0, Pi 1.1.0, git 2.56.0
(Windows). No model turn was started. Sources are the code, the CLIs' own help and docs, and the installed sources.

### M1. How a terminal session's turn end reaches the app

The pipe-driven backends announce the idle edge themselves (`src/app/agent-rpc.js`, `outcome` on `busy: false`). The
terminal backends do not, and only two of them report it exactly.

| Backend | Signal | Exact? | How it fails silently |
|---|---|---|---|
| Claude | `Stop` / `UserPromptSubmit` hooks (`src/app/hooks.js`, `src/backends/claude/live-binding.js`); the OSC title as fallback | yes | a `Stop` before a queued prompt (held by `readTurnQueue`); `StopFailure` (a turn ending on an API error) is not subscribed; the `restricted` option drops the settings hook |
| Pi | its binding extension posts `busy` / `idle` on `agent_settled` (`src/backends/pi/live-binding.js`) | yes | a dropped post until the transcript tail corrects it |
| Codex | `task_started` / `task_complete` / `turn_aborted` in the rollout tail (`src/backends/codex/state.js`) | inferred | a crash mid-turn stays busy until the process exits; no rollout before the first turn |
| agy | the last step's status in its database (`src/backends/agy/state.js`), a 15 s settle after a tool step | inferred | a turn reads idle up to 15 s late, or idle during a long tool gap; a waiting prompt maps to idle |
| Hermes | the last message row in `state.db` (`src/backends/hermes/state.js`) | inferred | a cut stream reads busy for minutes; an interrupt writes no closing row |

Consequence: a task in a terminal session would need a hard time cap and a process-exit check as its only signals that
cannot hang. This is why E4 keeps tasks on pipe-driven backends.

### M2. How an approval is asked, and whether something can answer it

| Backend | Visible to the app while open | A channel that answers without the terminal |
|---|---|---|
| Claude | yes: the `Notification` hook (`permission_prompt`) and OSC 9 (`src/shared/attention-source.js`) | a `PermissionRequest` or `PreToolUse` hook answering allow / deny; launch modes and tool lists |
| Codex | no code path | a `PermissionRequest` hook (stable in 0.166), which must first be trusted by hash; launch policy flags |
| agy | no; a waiting prompt maps to idle | permission rules in its settings file and launch modes only |
| Hermes | no | approval mode, deny globs, allow-list, a `pre_tool_call` shell hook (its answer format is not documented in what was read) |
| Pi (terminal) | nothing to see: Pi asks no approval; the pipe-driven pi-native has the app's own gate | `--no-tools` / `--no-builtin-tools` |

There is no common "answer this prompt" channel. What all of them share is a policy set at launch.

### M3. How long a CLI waits for one MCP tool call

| CLI | Default | Configurable | Confidence |
|---|---|---|---|
| agy | 180 s per call, 300 s to connect | `timeoutSeconds` per server; the app writes none | documented, not measured |
| Codex | 60 s per the docs, 300 s per the 0.166 source; the two disagree | `tool_timeout_sec` per server (`-c mcp_servers.<name>.tool_timeout_sec=<n>`); the app writes none | conflicting, a live probe decides |
| Pi | 60 s per request, reset by progress notifications | `timeout` per server | documented |
| Hermes | 300 s in the installed source, 120 s in a mirrored doc | `timeout` per server | code-read |

Handle and poll (spec 39) keeps every call short, so none of these limits constrains the `tasks` group.

### M4. The CLIs' own `--worktree`

- **Claude:** creates `.claude/worktrees/<name>/` with branch `worktree-<name>`, locked; the pipe-driven claude-native reports
  the directory as `cwd` in its `system/init` (spec 32). On an interactive exit a clean unnamed worktree is removed with its
  branch; `-p` runs never clean up.
- **Hermes:** creates `<repo>/.worktrees/hermes-<hex>` with branch `hermes/<name>`, adds `.worktrees` to the repo's ignore
  file, prints the path only as terminal text, and at exit removes a worktree without unpushed commits with
  `remove --force` (uncommitted changes appear to be discarded; its docs say they are kept).

Neither reports the path in a form the app can rely on before the session starts, and both delete on their own terms. This
supports E5: the app makes its own worktree.

### M5. Can Pi and Hermes take the `switchboard` entry

- **Pi:** yes, through `pi.registerMcpServer(name, { url, headers, timeout })` from the per-spawn resources extension
  (`src/backends/pi/resources-extension.js`), session-scoped, with the token in an environment variable. Today
  `providesMcpInjection` is `false` and Pi takes only stdio rows (`src/backends/pi/index.js`, `session-resources.js`).
  Whether it works for an HTTP server with a bearer header on Windows needs one turn on the smallest Pi model.
- **Hermes:** no clean channel. It reads MCP servers only from `config.yaml` under `HERMES_HOME`, with no launch flag; writing
  the user's file or moving `HERMES_HOME` per session both break existing rules. It keeps declining.

### M6. `git worktree` in the cases a worktree service meets

Repeatable with `scripts/measure-git-worktree.sh` (Git Bash; it builds throwaway repositories in the demo sandbox and
removes them).

| Case | What git does | What the service does |
|---|---|---|
| Not a repository | `rev-parse --is-inside-work-tree` exits 128 | refuse a writing task with a sentence |
| Bare repository | `worktree add` works; `list` names the bare entry first; `--is-inside-work-tree` prints `false` with exit 0 | skip the `bare` entry; do not use that check alone |
| Dirty main checkout | the new worktree does not see uncommitted or untracked files, no warning | tell the user before the task starts |
| Detached HEAD | `add -b` branches from the commit | record the base commit |
| Branch already checked out | refused, exit 128; `-b` with an existing name exits **255** | pick a unique branch name; never decide on the exit code alone |
| Submodules | the new worktree has them uninitialised; a local-path submodule needs `protocol.file.allow=always`; `remove` is **always** refused | initialise or tell the agent; check for changes itself, then `remove --force` |
| Uncommitted changes in the worktree | `remove` refused (exit 128), even for one untracked file | ask, never `--force` silently |
| Locked worktree | `remove` refused | treat the lock as the user's |
| Folder deleted by hand | `list` marks it `prunable`; `prune` clears it | `prune` before `add` and at start |
| Branch after `remove` | always left behind | delete it (`-d`, `-D` only with consent) or keep it on purpose |
| Worktree path of about 220 characters or more (Windows) | `fatal: '$GIT_DIR' too big`, with or without `core.longpaths`; 210 works | keep the worktree root short and refuse a longer path up front |
| A failed `add -b` | the branch exists although no worktree was made | delete the branch it just created |
| Path with spaces | works with an argument vector | `execFile`, never a shell string |
| Cost | about 0.3 to 0.4 s per `add`, 0.3 s per `remove` | off the main thread |

`list --porcelain` spells paths with forward slashes and the drive letter as git writes it, so compare them through
`src/app/path-containment.js`, never as strings.

## Probes not run

These need a real turn. E4 keeps tasks on pipe-driven backends, so none of them blocks the first build phase.

| ID | Probe | Needed for |
|---|---|---|
| P1 | Claude: does `Stop` fire on Esc; the `Notification` body for a permission prompt | a terminal target (E4 B) |
| P2 | Claude: does an HTTP `PermissionRequest` hook answer the prompt within its timeout | an allow-list (E3 C) |
| P3 | Codex: the approval's trace in the rollout; the `PermissionRequest` hook after trust; the real tool timeout with a stub tool that sleeps | E13, E3 C |
| P4 | agy: the step status an open prompt writes; a `timeoutSeconds` in the plugin bundle | E13 |
| P5 | Hermes: the database row while a prompt is open and after an interrupt; the cwd it records for `-w` | a terminal target |
| P6 | Pi: `registerMcpServer` over HTTP with a bearer header | Pi as a caller (#808) |
