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
- Resource discovery is read-only through Claude's `listResources()` hook. It surfaces settings,
  instructions, commands, agents, plugins, hooks, skills and customization directories, including project
  `.claude/` resources when a project is in scope. It deliberately excludes credentials, logs, history,
  transcripts and Claude's main config file, which can carry secrets.

### Not every `user` entry is the user (#495)

Three things wear `type: 'user'` and none of them is somebody typing. Reading them as a turn is how the
app came to report a turn start on every tool call:

| Marker | What it is |
|---|---|
| `message.content` is an array holding `tool_result` blocks | the result of a tool call the agent made |
| `isSidechain: true` | a subagent's line, from its own conversation |
| `isMeta: true` | injected text — a skill's body, a system reminder — written as a user message with an ordinary text block |

The last one is the least obvious and the most common: **452 of them** in the store this was measured
against, each with a perfectly ordinary `[{type: 'text', …}]` content array.

### The prompt queue is in the transcript (#495)

Type while Claude is working and the prompt is queued rather than sent, and every movement of that queue
is a line of its own. This is the only record of it: the `UserPromptSubmit` hook fires at **enqueue**, so
a hook alone cannot say whether a prompt is still waiting.

```json
{"type":"queue-operation","operation":"enqueue","sessionId":"<id>","content":"<the prompt>"}
{"type":"queue-operation","operation":"remove","sessionId":"<id>","content":"<the prompt>"}
{"type":"queue-operation","operation":"dequeue","sessionId":"<id>"}
{"type":"queue-operation","operation":"popAll","sessionId":"<id>"}
```

- **Every `enqueue` is closed by exactly one of the other three.** Measured over 116 transcripts: 1625
  enqueues against 1617 closures, and the difference is prompts still queued when the file was read. So
  the depth is countable — `enqueue` adds one, `remove` and `dequeue` take one, `popAll` empties.
- `remove` carries the prompt it took and `dequeue` does not, but both mean one prompt left the queue.
  Nothing should read meaning into which of the two it was.
- **A tail read cannot answer "is anything queued".** The depth is a count over the whole history, and a
  window cuts it in two places that each mislead. An enqueue that is still open gets pushed out of view
  by the very turn that is still running: over 1570 real pairs, 7 are more than 128 KB apart and the
  widest is **985 KB**. And the queue is FIFO, so a closure seen inside a window takes the oldest queued
  prompt rather than the one whose enqueue sits beside it.
- These lines carry **no `timestamp`**, unlike the message entries around them.

## Codex — file, JSONL (date-bucketed)

```
(CODEX_HOME | ~/.codex)/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
```

- **Date-bucketed** → discovery recurses, and the live watcher must survive midnight (a new `DD` folder
  appears).
- Identity + cwd come from the `session_meta` entry (`payload.id`, `payload.cwd`) — never from the
  filename or the folder.
- Model: the **last** `turn_context` wins.
- State: Codex **states** it — `event_msg` payloads `task_started` / `task_complete`, and a third that
  cost a bug: a turn interrupted with Esc ends on `turn_aborted` and **no `task_complete` ever follows**,
  so a reader that knows only the first two holds the session at "Working" until some LATER turn finishes
  (#511). The vocabulary lives in `src/backends/codex/state.js`; nothing else spells it out. Two more were
  checked against real rollouts and are deliberately NOT turn ends: `error` appears inside a turn that
  still completes, and `shutdown_complete` is never written to a rollout at all. Read the tail, but with a
  **growing** window: a busy turn writes reasoning and tool output, so `task_started` scrolls out of a
  fixed 64 KB tail long before the turn ends.
- **The rollout appears with the FIRST TURN, not with the spawn** (#512). Measured over 29 rollouts on one
  machine: none has a `session_meta` header without a `task_started` beside it (median 0 s between them),
  and none exists for a session that was opened and then abandoned — the file is laid down with its header
  already written, not created empty and filled later. So a Codex session sitting at its prompt cannot be
  paired with anything, and the descriptor says so through `recordAppearsAt: 'first-turn'`.
- **Trap:** not every rollout is a session. Since cli 0.151.0 Codex spawns internal review subagents of
  its own — the guardian that judges a planned action — and each one writes a rollout of the same name
  shape into the same day folder. The header is the only thing that says so: `thread_source` names the
  kind (`guardian_review`), `source.subagent` says there was one at all, and `parent_thread_id` points
  back at the session it was spawned for. Note that `payload.id` is then the SUBAGENT's id and
  `payload.session_id` the parent's, so an id read alone looks like a perfectly ordinary new session.
  The parser reads the presence of a subagent source rather than a list of kind names, and yields no row
  at all (#492).
- **Trap:** the first "user" message is usually **not** the user's prompt — Codex injects the project's
  `AGENTS.md` / an instructions block. Taking it as the title puts the same text on every session of a
  project (and poisons the search index with it).
- Windows: `codex` on PATH is an npm **`.cmd` shim**, which `CreateProcess` cannot execute → argv spawn
  falls back to the shell.
- Resource discovery is read-only through Codex' `listResources()` hook. It surfaces config, profile
  configs, instructions, plugins, skills, rules, memories and model catalogs, including project
  `AGENTS.md` / `.codex/` resources when a project is in scope. It deliberately excludes auth, logs,
  transcripts and secret sandboxes.
- **Installed plugins**, measured on 0.153.2 (#536): `config.toml` carries one table per plugin, keyed
  `[plugins."<plugin>@<marketplace>"]` with `enabled = true`, and the files sit under
  `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`. The top level is the MARKETPLACE's name, not
  the plugin's; `.codex-plugin/plugin.json` carries the real one, and `skills/` is a skills tree with a
  `SKILL.md` at each leaf — the same shape Claude's plugins have. More than one version can be cached and
  nothing says which is live, so the highest is taken, compared as numbers. A plugin that ships no
  `skills/` (scripts and an MCP manifest only) is real and simply has nothing to list.
  Whether a project's own `.codex/config.toml` can enable a plugin for that project is **not measured**,
  so every plugin row is reported as global.
- **A plugin's skills are editable and deletable, and that is deliberate parity with Claude** (#463/#536),
  not an oversight of "read-only first". Both backends list the skills tree itself, and the generic guards
  then allow what the backend's `resourceEditing` extensions allow. What a user should know, and what the
  app cannot tell them from the row: the CLI owns that cache and re-fetches it on the next plugin update,
  so an edit made there is temporary. A plugin skill worth keeping belongs in the user's own skills
  directory, which is a different row.
- **An install key is user input that becomes a path.** `[plugins."../../..@marketplace"]` in `config.toml`
  would put an arbitrary directory into the listing — and the listing is the allow-list every other guard
  consults. Both halves of the key are checked for being a single path segment, and the resolved directory
  is checked against the cache root through `app/path-containment.js`, before anything is listed.
- Forking uses Codex' native `codex fork <session-id>` command. Switchboard can launch/adopt the forked
  rollout, but no verified on-disk parent field has been found in Codex JSONL yet, so `resolveLineage()`
  still returns `null` rather than inventing a relationship.

### Rate limits ride along in the transcript (#191)

Codex writes its **usage quota into every `token_count` event**, so reading it costs a file read — no
network call, no credential access, and `~/.codex/auth.json` stays untouched:

```json
{"type":"event_msg","payload":{"type":"token_count",
  "info":{"total_token_usage":{…},"model_context_window":258400},
  "rate_limits":{
    "limit_id":"codex","limit_name":null,"plan_type":"<plan>",
    "primary":  {"used_percent":0.0,"window_minutes":10080,"resets_at":<epoch seconds>},
    "secondary":null,
    "credits":{"has_credits":false,"unlimited":false,"balance":null},
    "individual_limit":null,"rate_limit_reached_type":null}}}
```

- **Two windows, and Codex does not name them.** `primary` / `secondary`, each with its own
  `window_minutes` — the label (`5h`, `7d`) is **derived** from that number, never hardcoded: the provider
  is free to change the window, and `secondary` is frequently `null`.
- `used_percent` is a **float**, `resets_at` is **epoch seconds** (Claude sends an ISO string).
- **The last block that MEASURES something wins — not the last block** (#494). A session ends by writing
  one with no windows at all, so the literal final block is regularly a reason rather than a reading:

  ```json
  {"limit_id":"premium","primary":null,"secondary":null,
   "credits":{"has_credits":false,"unlimited":false,"balance":null},
   "individual_limit":null,"spend_control_reached":null,"plan_type":"<plan>",
   "rate_limit_reached_type":"workspace_member_credits_depleted"}
  ```

  Taking it literally threw away the forty-odd good readings earlier in the same file and reported
  “no data” while Codex had said exactly what was wrong.
- **`rate_limit_reached_type` is the reason, and it is worth reading.** `null` in the ordinary case;
  `workspace_member_credits_depleted` is the value captured from a real install.
- **`credits` carries no denominator.** The current shape is `{has_credits, unlimited, balance}` — a
  balance, never a total — so there is no percentage to draw from it and Switchboard reports no quota
  rather than a bar at nought. An older CLI wrote `used_percent` / `used` / `limit` instead, which is the
  only shape the quota is read from.
- **It is not live.** The figure is the state as of that turn — go three days without running Codex and it
  is three days old. Anything rendering it beside Claude's live number has to say so, or the number
  silently promotes itself to “now”.
- A rollout that never got a reply carries no `rate_limits` at all → fall through to the next-newest.

A session's **title is not in its own transcript.** Codex keeps the names the user gave their threads in a
separate append-only file next to the store:

```
(CODEX_HOME | ~/.codex)/session_index.jsonl

{"id":"019daeed-…","thread_name":"Rework the permission system","updated_at":"2026-04-21T07:25:57.4155311Z"}
```

- `id` is the same uuid as `session_meta.payload.id` — this is the join.
- **It is an overlay, not a title source.** Measured on a real install: **four entries against nine
  rollout files**, last written three months ago. An entry exists only for a thread the user bothered to
  name, and Codex does not backfill the rest. So a session with no entry is the **common case**, and the
  first real user prompt stays the title. A per-session fallback is mandatory, not polish.
- The parser reads it once, memoised on the file's mtime (`src/backends/codex/thread-names.js`).
- It does **not** go through `customTitle`: that field is promoted into `session_meta.name` by the scan,
  which would overwrite a rename the user made in Switchboard, on every rescan. A thread name is a label,
  not a claim on the name column.

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
- **`source` is an OPEN set** (#535, corrected — an earlier version of this bullet enumerated it and was
  wrong twice over). `hermes --source <anything>` writes a free value through `HERMES_SESSION_SOURCE`, and
  every gateway platform contributes its own name. The ones worth knowing: `cli` is ours; `bot_room` is a
  group chat room and `discord` / `telegram` / … are gateway chats; `subagent` is a delegated child;
  `claude-code` and `codex-cli` are sessions imported by `hermes sessions import`; `recovered` is a
  repaired stub. **Bot Mode and its rooms — default-on since 0.21.0 — are held out without the filter
  needing to know they exist**, which is the argument for an allow-list rather than a deny-list.
  Two of the excluded values are not noise: **`recovered`** (rebuilt from orphaned messages after a crash;
  no `cwd`, #551) and **`claude-code` / `codex-cli`** (imported coding sessions, and those DO carry a cwd,
  #552).
- **A CLI at 0.21.0 does not mean a store at 0.21.0.** Hermes migrates on open, so a machine that has
  updated but not started a session still has the old schema — this was measured on one at version 23 while
  0.21.0's own `SCHEMA_VERSION` is **30** (58 columns against that store's 48). Whatever a store is at, the
  columns arrive through `SELECT *` and the change marker reads only `ended_at`, the last message timestamp
  and the message count, so a new column cannot move it and no parser change was needed. Two of the ten
  columns version 30 adds are worth knowing: **`last_activity_at`**, a rate-limited heartbeat Hermes' own
  code says never to trust alone (so the synthesised marker stays), and **`hidden`**, which is how a
  `bot_room` member row is written — it does not exist below schema 30.
- **Contention with a live CLI is fine, measured** (#535, after 0.20.4's SessionDB fixes): 301 writes and
  301 discovery+parse reads interleaved on one WAL database produced no exception, no empty answer, no
  short answer and no null parse. The failure mode to watch for is a silent EMPTY result — `openDb`
  degrades quietly by design, and a scan that returns nothing looks exactly like a user with no sessions.
- **Hermes DOES have delegated child sessions** (#535, corrected — the first pass claimed the opposite).
  `tools/delegate_tool.py` builds each child with `platform="subagent"` and a `parent_session_id`, and
  `run_agent.py` writes its `sessions` row into the SAME `state.db` — Hermes' own comment says it must, or
  "lineage / session_search break". So the transcript a subagent seam would need is there.
  **The discriminator is `model_config._delegate_from`, not `source`**: a child under a CLI turn gets
  `source: 'subagent'`, but one spawned under a gateway turn inherits the gateway's source while still
  carrying the marker. And `parent_session_id` alone does not identify one either — a conversation
  compression continuation has one and no marker, which is lineage (already declared through
  `resolveLineage`), as does `/branch`. `async_delegations` (`state`, `task_json`, `result_json`,
  `delivery_state`) is the async queue beside all this, not the register. `supportsSubagents` stays false
  because nothing implements the seam yet (#553), not because the concept is missing.
- **No `updated_at` column** → the change marker is synthesized from `ended_at` + `MAX(messages.timestamp)`
  + the message count.
- Timestamps are REAL epoch seconds.
- Read it **read-only, `PRAGMA query_only`, short-lived connections**, and watch the `-wal` file as well as
  the DB: a WAL commit can leave the main file's mtime untouched.
- **State — corrects the plan (#165):** `ended_at` looked like the signal and is **not**. On a real store it
  is **null on every session**, including ones finished the day before; Hermes simply never writes it. So a
  rule of "not ended + wrote recently → busy" reads the agent's own ANSWER as activity, and the session sits
  at "working" for the whole activity window after every reply.

  The signal is the **last message row**: `messages.finish_reason` is `stop` on every assistant row and
  null on every user row.

  | last row | state |
  |---|---|
  | `user` | **busy** — asked, not yet answered |
  | `assistant`, `finish_reason` ∈ {`tool_calls`, `tool_use`, `function_call`} | **busy** — it stopped in order to *call* something |
  | `assistant`, no `finish_reason` | **busy** — still generating, or a cut-off stream |
  | `assistant`, any other `finish_reason` | **idle** — the message is complete, so the turn is over |
  | `tool` | **busy** — a tool answered the agent; the agent has not yet answered the user |
  | none | **idle** — nobody has asked anything |

  The tool set is a **denylist**, and the direction is the whole point. `finish_reason` says *why generation
  stopped*, and nearly every answer means the message is **complete** — `stop`, `end_turn`, `length`,
  `content_filter`, and each provider's own additions (Gemini says `SAFETY`, `RECITATION`, `OTHER`). Only the
  tool family means the turn continues, and that vocabulary is small and stable because every provider copied
  it from the last one. An allowlist of "over" reasons would read an unknown *terminal* reason as still-running
  — and a still-running turn can be held busy indefinitely by the PTY-liveness net while the TUI repaints. That
  is the "permanently working" bug, through a different door.

  The activity window stays as a **ceiling** (a "running" turn that has written nothing for minutes and whose
  terminal is silent is crashed, not working), and terminal output remains a liveness signal only: it may keep
  a long silent turn out of idle, never declare one busy.
- **A tool-using turn, row for row off a real run** (this is what the state rule has to walk):

  | # | role | `finish_reason` | note |
  |---|---|---|---|
  | 1 | `user` | — | the prompt |
  | 2 | `assistant` | **`tool_calls`** | **content is EMPTY**; `tool_calls` holds the request |
  | 3 | `tool` | — | one row per result (`tool_name`, `tool_call_id`) |
  | 4 | `tool` | — | …and another |
  | 5 | `assistant` | `stop` | the actual answer |

  Row 2 is why the state rule is a denylist: it is a `finish_reason` on an assistant row that does **not** end
  the turn.
- `messages` also carries `tool_name`, `tool_calls`, `tool_call_id`, `token_count`, `reasoning*`, `observed`,
  `active`, `compacted`.
- The non-interactive flag is **`-z PROMPT`** (`hermes -z "…"`), not `-q`/`--query`. Useful for reading what
  the store really writes without driving the TUI.
- Auth: Hermes self-authenticates from its own `.env` / OAuth. Switchboard **injects nothing** and never
  reads its credential files.
- Resource discovery is read-only through Hermes' `listResources()` hook. It surfaces config, SOUL.md,
  skills, skill bundles, plugins, hooks, memories and model catalogs as neutral rows. Switchboard only
  displays, copies or opens discovered paths; it never runs Hermes management commands or installs/updates
  resources.
- The TUI takes ≈ 12 s to paint (a heavy Python import) — a fresh tab looks dead until then, so the
  descriptor prints a hint.

## Pi — file, JSONL

```
(PI_CODING_AGENT_SESSION_DIR | ~/.pi/agent/sessions)/<encoded-cwd>/<ISO>_<uuid>.jsonl
```

- First line is the **header**: `{type:'session', version, id, timestamp, cwd}` — identity and cwd come
  from here, never from the folder name.
- **A FORKED session's header carries one more key: `parentSession`** — the full PATH of the parent
  transcript (#193). Only a fork has it, which is how four surveys of real sessions concluded Pi records no
  parent at all: none of the sessions read happened to be one. The parent's session id is the filename
  after the underscore (`<ISO>_<uuid>.jsonl`), so the link is exact rather than a lookup.
- Entries after the header form a **tree** through `id` / `parentId`; the current visible conversation is
  the parent walk from the last written leaf, not every line in the file. The parser indexes the active
  branch, includes compaction/branch summaries and displayed extension messages, and ignores abandoned
  branch text so search does not find a reply the user is no longer looking at.
- Message History goes through Pi's descriptor-owned `normalizeTranscriptEntries()` adapter. It returns
  renderer-neutral entries for the same active branch: `toolCall` → `tool_use`, `toolResult` →
  `tool_result`, `bashExecution` → a local command block, and compaction/branch/custom/label/model events
  → generic `transcript-meta` rows. The renderer knows none of Pi's role names.
- `session_info` carries Pi's display name (`--name`, `/name`, extension `setSessionName()`); Switchboard
  maps it to the row title overlay and to a Message History title event instead of treating it as chat text.
- The turn payload is nested **one level down**, under `.message`:
  `{type:'message', message:{role, content:[{type:'text',text}], model, provider, stopReason, usage}}`.
- **Pi is multi-provider *within* one session** — a real session switched from `anthropic/claude-opus-4-7`
  to `openai-codex/gpt-5.5` mid-flight. So "the session's model" is the **last** one on the active branch,
  and token/cost totals are booked from that branch's assistant turns. For launch configuration, Pi declares
  backend-owned model discovery: Switchboard asks `listModels({search})`, Pi runs `pi --list-models`, parses
  the provider/model table, caches it briefly, and the generic renderer shows those ids as suggestions.
- **Cost — corrects the plan:** `usage.cost` is an **object** (`{input, output, cacheRead, cacheWrite,
  total}`), not a number. Sum `usage.cost.total` across assistant turns. It is Pi's own estimate from its
  own price table, so it is recorded as an estimate and never as a settled amount.
- A failed turn is written with `stopReason:'error'`, an **empty** content array and an all-zero usage —
  it is still a transcript message, but its zero must not be reported as a cost.
- State: Pi states **nothing in OSC**. Switchboard therefore keeps the transcript-tail inference (a
  trailing user/tool result, or an assistant `stopReason:'toolUse'`, means the turn is still running),
  with a growing tail window (one message is one line, and a large answer can exceed the window entirely)
  plus the terminal-liveness signal. For sessions launched
  by Switchboard, Pi also gets a per-spawn `--extension` file that posts the current `session_id` and
  neutral lifecycle edges to the existing terminal-binding ingest; this is declared by Pi's descriptor,
  not by a core backend-id branch. What it sends, measured on 0.84.4:
  `busy` (`turn_start`, and `ui_prompt_end` when a turn was open) with `turn_start: true` only on a real
  turn beginning, `idle` (`turn_end`, `agent_settled`, and `ui_prompt_end` outside a turn), and `waiting`
  with a `prompt_kind` on `ui_prompt_start` (#529) — plus `pending` from `ctx.hasPendingMessages()` on
  every post (#530). Note `ui_prompt_start`/`ui_prompt_end` fire only for prompts an EXTENSION raises;
  Pi's own dialogs go through a different path and emit nothing.
- Undocumented dependencies: **Node ≥ 22.19** (the one on PATH, not the app's embedded one) and, on
  Windows, a **bash**. Both are probed, because a launch without them dies with nothing to act on.
- Project trust lives in `(PI_CODING_AGENT_DIR | ~/.pi/agent)/trust.json`: a JSON object mapping canonical
  project paths to `true` / `false`. Lookup walks parents, so trusting a parent folder trusts its children
  unless a child records an explicit `false`. Switchboard exposes this through Pi's `projectTrust` hook.
- Resource discovery is read-only through Pi's `listResources({projectPath})` hook. It surfaces global and
  project `settings.json`, configured packages/resources, and auto-discovered extensions, skills, prompt
  templates and themes as neutral rows. Switchboard only displays, copies or opens discovered paths;
  installing, updating or executing Pi packages/extensions is deliberately out of scope (#411).
- **Trap:** a stored `pi /login` OAuth session takes **priority over env vars**, so an injected key can be
  silently shadowed. The descriptor surfaces that in Settings.

## agy (Antigravity CLI) — file, per-conversation SQLite (reconned from a real install, v1.1.1)

Google **retired the Gemini CLI in June 2026**; its successor is the Antigravity CLI, binary **`agy`** — a
single Go binary. On this machine it is at `%LOCALAPPDATA%\agy\bin\agy.exe`, and the app it belongs to
(Antigravity, a VS Code fork) is a separate install. It signs in with a Google account and imports an
existing `~/.gemini` config on first run — which is why its data lives **under `~/.gemini`, not `~/.agy`**.

**The desk survey was wrong about the store, exactly as the standing rule predicts.** The old Gemini CLI's
`~/.gemini/tmp/<hash>/chats/` paths are **not** what agy uses; those directories still exist from the
retired CLI and are a decoy. agy's own store is elsewhere.

```
~/.gemini/antigravity-cli/conversations/<conversation-id>.db     one SQLite DB per conversation (written on the FIRST PROMPT)
~/.gemini/antigravity-cli/cache/last_conversations.json          { "<cwd>": "<conversation-id>" }  (latest per cwd)
~/.gemini/antigravity-cli/history.jsonl                          one line per prompt: {display, timestamp(ms), workspace}
~/.gemini/antigravity-cli/conversation_summaries.db              a separate summaries store (WAL)
~/.gemini/antigravity-cli/settings.json                          { trustedWorkspaces: [...] }  (the trust surface)
```

- **One transcript is one SQLite `.db` file per conversation** — so it is a **file-mode** backend and composes
  `src/backends/file-store.js` (walk `conversations/*.db`, `refSuffix(id) = '<id>.db'`). But the *content* is a
  database, not text, so it reads like Hermes: reuse the dual driver (`better-sqlite3` in Electron, fall back
  to `node:sqlite` so the parser is testable under plain `node --test` — see Hermes' `loadDriver`). Read-only,
  `query_only`, short-lived.
- **The `.db` filename IS the conversation id** — the same id `agy --conversation <id>` resumes. So identity
  needs no header parse: `sessionId` = the file's basename.
- **The content is protobuf blobs in a `steps` table** (agy calls a conversation a *trajectory*). Tables:
  `steps` (one row per turn: `step_type`, `status`, `step_payload` BLOB, `metadata` BLOB, `step_format`),
  `trajectory_meta`, `trajectory_metadata_blob` (`id='main'`, the conversation-level metadata), plus
  `gen_metadata`, `executor_metadata`, `battle_mode_infos`, `parent_references`. There is no schema shipped,
  so the parser reads what it needs by **extracting the embedded strings** from the blobs rather than decoding
  the full protobuf — with one exception, the cwd:
  - **cwd** — `trajectory_metadata_blob.data` carries the workspace as a `file://` URI inside a nested
    message: `file:///C:/proj` → `C:\proj`. This is the authoritative cwd; do not trust
    `last_conversations.json` (it only holds the *latest* conversation per cwd, not all).
    This one is **walked as wire format**, not scraped. A string scan recovers it or not depending on bytes
    that have nothing to do with it — a conversation whose first metadata field is under 128 bytes puts a
    `0a` where the scan reads a length, and the URI is swallowed as `%file:///C`. A conversation with no cwd
    is never paired with the CLI running it, so its session shows "Running" for its whole life (#508).
  - **step roles** — `step_type` 14 = the user prompt, 15 = a model message, 9 = a tool call/result, others
    (23, 98) are lifecycle/title steps. Turn/message count derives from the 14/15 rows.
  - **busy/idle** — `steps.status` on the LAST step: **8 while it is running, 3 once it is done**. That is
    the whole signal, and it is the only one: agy inserts the model row when a turn *starts* and fills it
    in as the answer streams, so the last message step is 15 from the first moment and the role order says
    nothing about whether a turn is in progress (#510). Only 8 means running — a store census found 3
    everywhere at rest and a 7 on some lifecycle steps, and 8 never at rest.
  - **title** — agy generates one ("Fix the build" in the sample); it appears in a step. Fall
    back to the first user prompt (step 14, or `history.jsonl`'s `display` for that workspace) when absent.
  - **model** — recorded as a display string in the blobs (`Gemini 3.5 Flash (Medium)`, also ids like
    `gemini-3.5-flash-low`); the LAST one used wins. Best-effort string extraction — treat a miss as unknown,
    never as an error.
- **No timestamp lives in the DB blobs** (scanned; none in the 2026 epoch-ms range). So the change marker is
  the **`.db` file mtime** (the file-store default), and `history.jsonl`'s `timestamp` (epoch **ms**) gives a
  birth/first-prompt time per workspace if a first-seen date is wanted.
- **State**: read from the `steps.status` column above, not inferred from the turn's role — the role order says
  nothing here, because the model row exists from the moment a turn starts. The safeguards around it are Pi's:
  the terminal-liveness signal, which can only KEEP a turn busy and never declare one, under a ceiling that
  heals a session left with a step marked running. agy does **not** own an OSC title heuristic (that is
  Claude-only, keyed on the binary).
- **Transcript**: agy declares **`transcriptAccess: 'export'`** with a `readMessages`, exactly like Hermes — the
  `.db` is a *binary* SQLite/protobuf file, so the message viewer and the handoff read the **exported turns**,
  never the raw file (handing that path to the JSONL reader, or to a fresh agent, would yield garbage). It is
  still *discovered* as a file (the file store scans/watches/reconciles it); only the read goes through the
  exporter. `readMessages` walks the `steps` (14 = user, 15 = model; tool/lifecycle steps skipped) and pulls
  each turn's prose out of the protobuf blob with a shallow wire-format walk — a model reply is one
  length-delimited field whose value carries newlines and markdown, so a naive byte scan would split it.
- Resource discovery is read-only through agy's `listResources()` hook. It surfaces safe Gemini and
  Antigravity settings, `GEMINI.md`, builtin/implicit resource directories, knowledge directories and project
  `GEMINI.md`. It deliberately excludes OAuth/account files, logs, crashes, caches, history, scratch/tmp data
  and conversation databases.
- **Resume** is `agy --conversation <id>`; `--continue`/`-c` reopens the most recent. **Fork** has no flag —
  `supportsFork: false` (offering it would launch an unrelated session).
- **`agy --help` / the argv** (v1.1.1+): `--model`, `--effort`, `--project` / `--new-project`, `--add-dir`
  (repeatable), `--agent`, `--mode {accept-edits,plan}`, `--sandbox`, `--dangerously-skip-permissions`,
  `--print`/`-p`/`--prompt` (non-interactive), `--prompt-interactive`/`-i`, `--conversation`,
  `--continue`/`-c`. Subcommands: `models`, `agents`, `changelog`, `install`, `plugin`, `update`.
  **`agy models`** lists the launchable model ids — multi-provider, which is why its quota is per-model.
  Switchboard uses that command for backend-owned model suggestions instead of pinning a stale choice list.
  **Its output shape changed** (#539, measured on 1.1.26): each line is now `<id><TAB><human label>`
  (`gemini-3.8-flash-high⇥Gemini 3.8 Flash (High)`), where 1.1.1 printed the id alone. The parser reads
  both, because an older install is still an install. The progress line ("Fetching available models…")
  goes to stderr — today; the parser does not rely on that and still refuses a line whose id would contain
  a space. On Windows `agy` on PATH is a
  real `.exe`, not a `.cmd` shim.

**Usage (#191, #509).** Current agy owns its OAuth token in the OS keyring and exposes the data behind
`/usage` through a loopback HTTPS service. Switchboard prefers a running AGY process — first the sessions
it spawned itself, then any other `agy` process on the machine, found by image name through `tasklist` or
`ps` — discovers only the ports owned by that process, and calls `RetrieveUserQuotaSummary`, then
`GetUserStatus` and `GetCommandModelConfigs` as compatibility fallbacks. With no running process and no
durable cached reading, it starts one bounded PTY probe and shuts it down after the fetch. A probe that
does not return a reading backs off — five minutes, doubling to an hour — and its answer is re-served
while the wait runs, so an install that is present but not signed in is not respawned once a minute for
the app's whole lifetime. On a machine with several users signed in, the process list is not private:
a discovered `agy` can belong to another account, and if its loopback service answers, the figure shown
is that account's. The summary can carry grouped Weekly/5-hour
limits; older/local fallbacks carry per-model fractions and reset times. All map into the same usage buckets.
When `SWITCHBOARD_STORE_AGY` marks an isolated demo/sandbox, Switchboard never starts that probe: the
override moves only Switchboard's scanner, not agy's own home, so launching it would escape the sandbox.
The legacy remote request is skipped there as well, and AGY reports neutral limits-unavailable.

The #201 remote workaround remains best-effort: it refreshes the imported Gemini CLI
`~/.gemini/oauth_creds.json` in memory and calls
`POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`. Current AGY releases authenticate
with their own OAuth client, so that legacy source may return 403. A denial is rendered neutrally as limits
unavailable; it never means that a personal account is unmetered or that AGY sessions cannot run. Both the
loopback service and the remote endpoint are internal interfaces and can change without notice — the honest
cost of agy exposing no stable quota command or local quota file for machine consumers.

---

## What each CLI lets the app edit and create (#441)

Declared on the descriptor (`resourceEditing`, `resourceScaffolds`), because the layouts differ and the
core must not know one backend from another. Nothing executable appears here on purpose: an editor over
something that RUNS is a different feature with a different conversation.

| Backend | Editable | Creates | Scaffold |
|---|---|---|---|
| Claude | `.md`, `.markdown`, `.json` | skill, command, agent | skill = a directory with `SKILL.md` and frontmatter; command and agent = one `.md` |
| Codex | `.md`, `.markdown`, `.toml`, `.json` | skill, rule | skill = directory with `SKILL.md`; rule = one `.md` |
| Hermes | `.md`, `.markdown`, `.yaml`, `.yml`, `.json` | skill | directory with `SKILL.md`. Its hooks and skill bundles are not offered |
| Pi | `.md`, `.markdown`, `.json` | skill, prompt template | skill = directory with `SKILL.md`, even though pi also reads a bare `.md` — the directory is the shape that stays right when the skill grows. Its `.ts`/`.js` extensions are not offered |
| agy | `.md`, `.markdown`, `.json` | — | lists no skills, rules, commands or agents directory of its own; an empty declaration is the answer |

A settings file is editable (that is what the TOML and YAML validation is for) and never deletable: it
is a file the CLI owns, and this app edits it rather than deciding whether it should exist.

## Terminal page-key ownership

Bare PageUp/PageDown are not generic terminal-scroll shortcuts when a full-screen TUI owns the visible
history — and they are dead keys when a TUI ignores them. Each descriptor declares `pageKeyTarget`, so
the renderer dispatches a per-backend answer instead of one branch for everyone.

**Each row below was measured in a running session** — key pressed, PTY traffic and viewport watched.
Do not fill this table from a CLI's keymap documentation: that was done twice and was wrong both times,
in opposite directions.

**A row says what the CLI does with the key, never which buffer it is on.** That second question is
answered live at the key press (`buffer.active.type`), because a CLI can have more than one renderer and
pick between them without anyone touching a setting: Claude switches itself to its classic renderer after
two fullscreen sessions fail to start, and records that on the machine until it is updated or told
otherwise. A `viewport` row therefore means "page, when the conversation is in OUR scrollback"; on the
alternate screen it is the CLI's, and the key goes there whatever the row says.

| Backend | Target | What the measurement showed |
|---|---|---|
| Claude | `viewport` | Re-measured against 2.1.261 (#558). It has **two renderers**: *classic* draws inline on the normal buffer, so the conversation is xterm's scrollback and the bare keys land on the input line (`ESC[5~`/`ESC[6~` go to the start and end of the CURRENT line); *fullscreen* draws on the alternate screen, where the conversation is the CLI's and those same keys are its own documented half-screen scroll. Measured on one machine on one afternoon: four long-running sessions on `normal` with 226-2470 lines of scrollback, a fresh one on `alternate` with `baseY: 0`. So the row says what we do when the conversation is in OUR scrollback, and the routing asks the live buffer which renderer is up. Cost, classic only: the CLI ignores `ESC[H`, so PageUp was the only key reaching the start of a line. |
| Codex | `viewport` | Sends `ESC[5~` and nothing happens: the prompt ignores it. Runs on the normal buffer, so xterm holds the history and pages it. |
| Pi | `viewport` | Same: `ESC[5~` reaches it and is ignored, normal buffer, xterm holds the history. |
| Hermes | `viewport` | The bare keys do nothing; the transcript pages only under **Shift**, which is xterm's own scrollback. So the TUI is not using them and xterm holds the history. |
| agy | `viewport` | The same, measured against the **real** store: agy declares no store variable (`cliHomeEnv()` → null), so it cannot be driven from an isolated instance. |

`'viewport'` is what makes Switchboard swallow the bare key and call xterm's `scrollPages()`; anything
else — including an unknown or missing value — leaves the key to the application. Modifier chords keep
xterm's existing behaviour everywhere, so Shift+PageUp still scrolls a scrollback where one exists.

**The per-backend answer is pinned in `test/terminal-page-scroll.test.js` (`PAGE_KEY_TARGETS`).** That
table exists because a change aimed at one backend twice moved backends that were not in its scope. A
backend that already works is the regression control; changing its answer has to be a deliberate edit
that fails the suite by name until someone makes it.

## The newline chord

Shift+Enter — and Ctrl+Enter off macOS, which follows the PowerShell convention — has to insert a
newline in the CLI's composer instead of submitting the prompt. Switchboard answers the chord itself
and writes bytes to the PTY, so **which** bytes is the CLI's answer. Until #493 one sequence was sent
to everyone: Claude's, which made the chord a dead key in every CLI that does not read it.

Each row below was measured the same way: the CLI spawned in a real pty, text typed on either side of
the candidate sequence, and the rendered screen read back to see whether the composer grew a second
row.

| Backend | `newlineKeySequence` | What the measurement showed |
|---|---|---|
| Claude | `ESC [ 1 3 ; 2 u` | Reads the kitty keyboard protocol, so this IS a Shift+Enter to it. The one backend the old hardcoded sequence was right for. |
| Codex | `ESC CR` | Ignores the kitty sequence **and** a bare LF — the cursor does not move for either. `ESC CR` inserts the newline. This is the backend #493 was about. |
| Pi | `ESC [ 1 3 ; 2 u` | Inserts a newline; the chord already worked. |
| Hermes | `ESC [ 1 3 ; 2 u` | Inserts a newline; the chord already worked. |
| agy | `ESC [ 1 3 ; 2 u` | Inserts a newline; the chord already worked. |

A backend that declares no sequence gets an **inert** chord: the key is swallowed and nothing is sent.
That is the opposite default from the page keys above, on purpose — there, letting the key through only
risks a failure to scroll, while here it would let xterm send CR and the CLI would submit a half-written
prompt, which nobody gets back.

**The per-backend answer is pinned in `test/terminal-newline-key.test.js` (`NEWLINE_KEY_SEQUENCES`)**,
for the same reason the page-key table is pinned.

### Hardware cursor updates — attempted and reverted

Codex and Pi briefly declared a `cursorUpdatePolicy: 'settle'` that had the renderer bracket every PTY
chunk with a cursor-hide and restore visibility on a timer. **It is gone, and it must not come back in
that form.** A PTY chunk may end MID-SEQUENCE, with the remainder in the next chunk, so bracketing
chunks tore escape sequences in half and the terminal rendered as garbage. The timer half was wrong on
its own too: 80 ms after the burst the cursor sits wherever the last redraw parked it, so restoring
visibility put it in the wrong column.

The renderer writes what the backend sent, unchanged. A cursor artefact is cosmetic; a corrupted
stream is not.

## What each CLI accepts on its command line (#160)

Read off each binary's **own `--help`** on a real install. The Settings page and the Configure dialog are
**generated** from `configFields`, so this list *is* the configuration surface — an option missing here
is an option the user cannot set at all. Until #160, Pi and Hermes declared **one** field each (model),
which meant they were, in practice, not configurable from Switchboard.

| Backend | Declared | Deliberately left out, and why |
|---|---|---|
| **Claude** | `permissionMode`, `model`, `worktree` (+`worktreeName`), `chrome`, `addDirs`, `restricted`, `autocompact`, `mcpEmulation`, `afkTimeoutSec` | `--permission-prompts` (print mode only — the flag #537 opened with), `--cloud` / `--environment` / `--teleport` (a session with no local transcript, so the scan cannot find, adopt or resume it), `--system-prompt-snapshot` (unmeasured), `--append-system-prompt` (#562 — `buildLaunch` honoured it with no field declaring it, left over from the schedule creator #246 removed; passing it turns `--system-prompt-snapshot` off, which is the flag right above it on this list, so declaring it would have shipped that unmeasured interaction through a text field. Pi's option of the same name is a different CLI with no snapshot to disturb). **`restricted` carries a warning that its label cannot**: it also ignores your settings files, which turns off Switchboard's attention hook, and it refuses `permissionMode: bypassPermissions` — that combination dies at spawn. |
| **Codex** | `model`, `approvalMode`, `sandbox`, `profile` (Codex' *own* config profile), `search`, `oss`, `localProvider`, `addDirs`, `configOverrides` (`-c key=value`) | `--dangerously-bypass-approvals-and-sandbox` and `--dangerously-bypass-hook-trust` — their own help marks them dangerous. `sandbox: danger-full-access` already lets a user drop the sandbox on purpose; a single toggle that removes approvals *and* the sandbox is a different thing. `-C/--cd` (we own the cwd), `--remote*` / app-server wiring, `--no-alt-screen` (Switchboard owns the PTY), `--approve-for-me` (#537 — unmeasured: nobody here has watched what its automatic review approves). |
| **Hermes** | `model`, `provider`, `toolsets`, `skills`, `worktree`, `safeMode`, `acceptHooks`, `yolo`, `passSessionId`, `ignoreUserConfig`, `ignoreRules` | `--cli`/`--tui` (we run it in a PTY — interactive is the point), `-z`/`--oneshot` and `--usage-file` (non-interactive), `--continue` (picker/name rather than Switchboard's recorded id), `--no-restore-cwd` (resume semantics, not a launch default), `--dev`, anything that moves its session store or writes/manages resources. **`--reasoning`** is the interesting refusal (#537): it is a real flag, argparse accepts it, and the modern TUI then drops it — `_CHAT_PASSTHROUGH` in hermes' own `main.py` does not carry it, so `_launch_tui` never sees it. Its help omits the "Applies to -z/--oneshot and --tui" sentence that `--model`, `--provider` and `--toolsets` all carry, and that absence is the tell rather than a licence. `--in` is left out for a narrower reason than it looks: on a NEW session the cwd is already Switchboard's, but on a RESUME hermes restores the session's own recorded cwd unless told otherwise. **`checkpoints` was declared here and should not have been** (#548): `--checkpoints` is a flag of the `chat` subcommand, and bare `hermes` — what this app spawns — answers "unrecognized arguments", so every session launched with that toggle on died before the TUI started. `npm run hermes:help-check` now asks the CLI about every flag the descriptor can emit, so the next one fails there. |
| **Pi** | `model` (with model discovery), `provider`, `thinking`, `name`, `models`, `tools`, `excludeTools`, `noTools`, `noBuiltinTools`, `approval`, `offline`, `appendSystemPrompt`, `useTheme`, `noContextFiles` | **`--api-key`** — it would put a raw key on the COMMAND LINE, readable in any process listing. Pi reads its key from the environment; a template's `$VAR` env bundle (resolved at spawn, never on disk) is the only route we offer. Also `--mode json/rpc` and `--print` (non-interactive), `--session-dir`/`--no-session` (they move or suppress the store we watch), arbitrary `--extension` paths (Switchboard owns only its generated live-binding extension), and `--tui-mode` (#537 — `fullscreen` changes how the TUI drives the PTY Switchboard owns, and nobody has watched what that does to scrollback, resize and selection). Note `tools` **overrides Pi's own `defaultTools` setting**, which is what Pi falls back to when no `--tools` is given. |
| **agy** | `model` (with model discovery), `mode`, `effort`, `sandbox`, `addDirs` | `--dangerously-skip-permissions` (removes all tool approvals), `--project` / `--new-project` / `--agent` (agy's own project/agent selection, orthogonal to Switchboard's cwd), `--print` / `--prompt` and `--prompt-interactive` (non-standard launch modes), `--log-file` (diagnostic output path), `--continue` (latest conversation rather than Switchboard's recorded id), `--input-format` (#537 — print mode only, and it needs `--output-format stream-json` besides). |

**Some options belong to Switchboard, not to a CLI**, and the registry adds those to *every* backend
(`src/backends/agy/index.js`, `UNIVERSAL_FIELDS`) rather than letting four descriptors carry four copies that
drift apart. Today that is **`preLaunchCmd`** — a raw shell prefix (`nvm use 20 &&`, `aws-vault exec
profile --`) with nothing Claude-specific about it. It *was* Claude's, for a reason nobody wrote down and
which turned out to be about the **spawn mode**: Claude starts through a shell (there is a command line to
prefix), the Axis-B backends start argv (no shell — Windows shell quoting mangles their arguments). So the
option is universal now, and setting one drops **that session** to the shell path; argv stays the default
for everyone who sets nothing.

**A field's `default` is documentation, not a value we send.** It is what the control shows when nobody
has said otherwise — i.e. what the CLI would do on its own. It must never reach the argv: the launch used
to seed every non-empty default, so a plain Codex session carried `-a on-request -s workspace-write`
although the user had chosen neither, overruling their own `config.toml` without telling them. Only what
somebody actually chose is sent (a stored setting, or a value moved in the Configure dialog). So write a
default that **matches what the CLI already does** — it is a description of that CLI, not a wish.

Two markers a field may carry, because two honest exceptions exist and both must be **declared** rather
than discovered by a puzzled reader:

- **`appliesAt: 'spawn'`** — the option is real, but it is not in the argv `buildLaunch` returns. `src/app/terminal/spawn.js`
  applies it at the spawn site: Claude's `preLaunchCmd` *prefixes* the command line, `mcpEmulation`
  starts the MCP bridge and appends `--ide`, `afkTimeoutSec` becomes an env var.
- **`requires: '<otherOption>'`** — the option only means anything while another one is on (a worktree's
  branch name).

`test/backend-config-fields.test.js` enforces the contract: **every declared option must change the
command line**, unless it declares one of those two reasons — and a `spawn`-applied one must actually be
read by `src/app/terminal/spawn.js` (it was main.js until #213 split it out). A control that does nothing is
the exact bug this file exists to prevent.

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
