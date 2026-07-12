# Backend session formats

What each backend actually writes, and where. Every entry here was taken from a **real install**, not from
documentation — in three places the published docs (or our own assumptions) were wrong, and those are
called out.

Read this before touching a parser, and before adding a backend.

Related: [`specs/09-multi-llm.md`](specs/09-multi-llm.md) (the contract), [`multi-llm.md`](multi-llm.md)
(the user guide).

---

## Claude Code — file, JSONL

```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
~/.claude/projects/<encoded-cwd>/<session-id>/subagents/<agent-id>.jsonl
```

- The folder name encodes the working directory; the app decodes it centrally.
- Entries: `{type:'user'|'assistant', message:{role, content}}` plus tool/meta lines.
- Claude accepts `--session-id`, so **we** choose the id — the only backend where that is true.
- State: the CLI **reports** it in the terminal (OSC 0 title: a braille spinner = working, `✳` = idle;
  OSC 9;4 progress as a second source).

## Codex — file, JSONL (date-bucketed)

```
(CODEX_HOME | ~/.codex)/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
```

- **Date-bucketed** → discovery recurses, and the live watcher must survive midnight (a new `DD` folder
  appears).
- Identity + cwd come from the `session_meta` entry (`payload.id`, `payload.cwd`) — never from the
  filename or the folder.
- Model: the **last** `turn_context` wins.
- State: Codex **states** it — `event_msg` payloads `task_started` / `task_complete`. Read the tail, but
  with a **growing** window: a busy turn writes reasoning and tool output, so `task_started` scrolls out
  of a fixed 64 KB tail long before `task_complete` arrives.
- **Trap:** the first "user" message is usually **not** the user's prompt — Codex injects the project's
  `AGENTS.md` / an instructions block. Taking it as the title puts the same text on every session of a
  project (and poisons the search index with it).
- Windows: `codex` on PATH is an npm **`.cmd` shim**, which `CreateProcess` cannot execute → argv spawn
  falls back to the shell.

## Hermes — SQLite

```
(HERMES_HOME | %LOCALAPPDATA%\hermes | ~/.hermes)/state.db      (WAL mode)
```

The only backend whose history is **not** in files — the reason the discovery seam is dual-mode.

- `sessions` table carries `id`, `title`, `model`, **`cwd`**, `source` (`cli` | `gateway` | …), token
  columns, `parent_session_id`, and cost: `estimated_cost_usd`, `actual_cost_usd`, `cost_status`,
  `cost_source`, `pricing_version`.
  **Corrects the plan:** we had assumed there was *no* `cwd` column and that Hermes sessions would have to
  live in a synthetic bucket. There is one — Hermes groups into normal projects like everyone else, and
  the bucket is only a fallback for sessions that genuinely have no directory (gateway/cron chats).
- Only `source = 'cli'` is ingested by default (a gateway/Telegram chat is not a coding session).
- **No `updated_at` column** → the change marker is synthesized from `ended_at` + `MAX(messages.timestamp)`
  + the message count.
- Timestamps are REAL epoch seconds.
- Read it **read-only, `PRAGMA query_only`, short-lived connections**, and watch the `-wal` file as well as
  the DB: a WAL commit can leave the main file's mtime untouched.
- State: Hermes states only that a turn **ended** (`ended_at IS NULL` = still open). Busy is inferred from
  recent message activity, so a long silent turn needs the terminal-liveness signal.
- Auth: Hermes self-authenticates from its own `.env` / OAuth. Switchboard **injects nothing** and never
  reads its credential files.
- The TUI takes ≈ 12 s to paint (a heavy Python import) — a fresh tab looks dead until then, so the
  descriptor prints a hint.

## Pi — file, JSONL

```
(PI_CODING_AGENT_SESSION_DIR | ~/.pi/agent/sessions)/<encoded-cwd>/<ISO>_<uuid>.jsonl
```

- First line is the **header**: `{type:'session', version, id, timestamp, cwd}` — identity and cwd come
  from here, never from the folder name.
- The turn payload is nested **one level down**, under `.message`:
  `{type:'message', message:{role, content:[{type:'text',text}], model, provider, stopReason, usage}}`.
- **Pi is multi-provider *within* one session** — a real session switched from `anthropic/claude-opus-4-7`
  to `openai-codex/gpt-5.5` mid-flight. So "the session's model" is the **last** one seen, and the token
  and cost totals span providers.
- **Cost — corrects the plan:** `usage.cost` is an **object** (`{input, output, cacheRead, cacheWrite,
  total}`), not a number. Sum `usage.cost.total` across assistant turns. It is Pi's own estimate from its
  own price table, so it is recorded as an estimate and never as a settled amount.
- A failed turn is written with `stopReason:'error'`, an **empty** content array and an all-zero usage —
  it must not be counted as a turn, and its zero must not be reported as a cost.
- State: Pi states **nothing** — no OSC, and its lifecycle events exist only in `--mode json`, which is
  mutually exclusive with the interactive TUI. Busy is inferred from which line exists last (a trailing
  user prompt = a turn is running), with a growing tail window (one message is one line, and a large
  answer can exceed the window entirely) plus the terminal-liveness signal.
- Undocumented dependencies: **Node ≥ 22.19** (the one on PATH, not the app's embedded one) and, on
  Windows, a **bash**. Both are probed, because a launch without them dies with nothing to act on.
- **Trap:** a stored `pi /login` OAuth session takes **priority over env vars**, so an injected key can be
  silently shadowed. The descriptor surfaces that in Settings.

## agy (Antigravity CLI) — planned, recon needed

Google **retired the Gemini CLI in June 2026**; its successor is the Antigravity CLI, binary **`agy`** — a
single Go binary (install script → `~/.local/bin/agy`, or `npm i -g @google/antigravity-cli`), which signs
in with a Google account and offers to import an existing `~/.gemini` config.

It ships as a **"Coming soon"** dummy: never in the picker, never scanned. **What it stores, where, and how
it resumes is unknown** — the old Gemini CLI's paths (`~/.gemini/tmp/<hash>/chats/…`) are explicitly **not**
carried over as an assumption. Recon it against a real install before building it.

---

## What each CLI accepts on its command line (#160)

Read off each binary's **own `--help`** on a real install. The Settings page and the Configure dialog are
**generated** from `configFields`, so this list *is* the configuration surface — an option missing here
is an option the user cannot set at all. Until #160, Pi and Hermes declared **one** field each (model),
which meant they were, in practice, not configurable from Switchboard.

| Backend | Declared | Deliberately left out, and why |
|---|---|---|
| **Claude** | `permissionMode`, `model`, `worktree` (+`worktreeName`), `chrome`, `addDirs`, `mcpEmulation`, `afkTimeoutSec` | — |
| **Codex** | `model`, `approvalMode`, `sandbox`, `profile` (Codex' *own* config profile), `search`, `oss`, `localProvider`, `addDirs`, `configOverrides` (`-c key=value`) | `--dangerously-bypass-approvals-and-sandbox` — its own help calls it "EXTREMELY DANGEROUS… solely for externally sandboxed environments". `sandbox: danger-full-access` already lets a user drop the sandbox on purpose; a single toggle that removes approvals *and* the sandbox is a different thing. `-C/--cd` (we own the cwd). |
| **Hermes** | `model`, `provider`, `toolsets`, `skills`, `worktree`, `checkpoints`, `safeMode`, `acceptHooks`, `yolo` | `--cli`/`--tui` (we run it in a PTY — interactive is the point), `-q`/`-Q` (non-interactive), anything that moves its session store. |
| **Pi** | `model`, `provider`, `thinking`, `tools`, `excludeTools`, `appendSystemPrompt`, `noContextFiles` | **`--api-key`** — it would put a raw key on the COMMAND LINE, readable in any process listing. Pi reads its key from the environment; a template's `$VAR` env bundle (resolved at spawn, never on disk) is the only route we offer. Also `--mode json/rpc` and `--print` (non-interactive), `--session-dir`/`--no-session` (they move or suppress the store we watch). |

**Some options belong to Switchboard, not to a CLI**, and the registry adds those to *every* backend
(`backends/index.js`, `UNIVERSAL_FIELDS`) rather than letting four descriptors carry four copies that
drift apart. Today that is **`preLaunchCmd`** — a raw shell prefix (`nvm use 20 &&`, `aws-vault exec
profile --`) with nothing Claude-specific about it. It *was* Claude's, for a reason nobody wrote down and
which turned out to be about the **spawn mode**: Claude starts through a shell (there is a command line to
prefix), the Axis-B backends start argv (no shell — Windows shell quoting mangles their arguments). So the
option is universal now, and setting one drops **that session** to the shell path; argv stays the default
for everyone who sets nothing.

Two markers a field may carry, because two honest exceptions exist and both must be **declared** rather
than discovered by a puzzled reader:

- **`appliesAt: 'spawn'`** — the option is real, but it is not in the argv `buildLaunch` returns. main.js
  applies it at the spawn site: Claude's `preLaunchCmd` *prefixes* the command line, `mcpEmulation`
  starts the MCP bridge and appends `--ide`, `afkTimeoutSec` becomes an env var.
- **`requires: '<otherOption>'`** — the option only means anything while another one is on (a worktree's
  branch name).

`test/backend-config-fields.test.js` enforces the contract: **every declared option must change the
command line**, unless it declares one of those two reasons — and a `spawn`-applied one must actually be
read by main.js. A control that does nothing is the exact bug this file exists to prevent.

**Hermes corrects an earlier claim of ours.** The old comment on its `configFields` said the list was
"deliberately small" because its model/provider config lives in its own `config.yaml`. Half true, wholly
misleading: Hermes self-authenticates (we inject no env, and that stays), but it takes a dozen meaningful
**flags**. "No env" was read as "nothing to configure", and it made the backend unconfigurable.

---

## The recurring lessons

1. **Read the format from a real install.** The plan was wrong twice (Hermes' `cwd` column, Pi's cost
   shape) and both errors would have shipped as silent data loss — an empty cost column, or every Hermes
   session dumped into a synthetic bucket.
2. **Never parse the folder name.** Every backend's transcript carries its own cwd; the encoded folder is
   a convenience, not a source of truth.
3. **Never read a tail with a fixed window.** One message is one line, and one line can be megabytes.
4. **A backend that names its own sessions needs all three identity hooks** — the resume one is the easy
   one to forget, and forgetting it collapses two tabs onto one id.
