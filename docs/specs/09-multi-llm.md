# Spec 09 — Multi-LLM backends

> Read `docs/specs/README.md` (shared architecture, IPC, conventions, validation gate) before starting.

**Status:** Implemented · **Issue:** #142 (closed) · **Independent:** No — it touches the spawn, scan and
settings hot paths

User-facing guide: [`docs/multi-llm.md`](../multi-llm.md). Session formats of each backend:
[`docs/backend-formats.md`](../backend-formats.md).

## Problem & goal

Switchboard was a **Claude Code** cockpit: `src/main.js` spawned `claude`, the scanner read
`~/.claude/projects/**/*.jsonl`, the sidebar assumed one binary and one transcript format. Meanwhile the
same person runs Codex, Hermes or Pi in a second terminal, with no session list, no search, no attention
signals, no stats — the entire reason Switchboard exists, missing for half their work.

**Goal:** run several coding CLIs side by side in one app — one sidebar, one full-text index, one launch
menu, one stats view — **without changing anything for a Claude-only user**, and without a per-provider
special case anywhere outside that provider's own folder.

## Target state

- **A backend is a folder** under `backends/` exporting one descriptor. Adding one changes no other file.
- **Two axes.** *Axis A* = a **template**: a named set of defaults that runs **another backend's** binary
  — data only, no per-provider code. *Axis B* = its own binary with its own session store (Codex, Hermes,
  Pi; `agy` planned).

  A template names the backend it runs on (#161). It used to be Claude, always, hardcoded in three
  places — and the editor never said so, which is why the feature read as arbitrary. "Codex with model X
  and this sandbox" and "Claude Code against DeepSeek" are now the same mechanism. A template has **no
  store of its own**: it shares its base's entirely, which is why the scanner skips it and its sessions
  take their provenance from the launch overlay. The shipped presets (DeepSeek/GLM/OpenRouter) are
  `ANTHROPIC_*` bundles and therefore belong to the **Claude** base; they mean nothing on another one.
- **Every backend is a first-class citizen**: its sessions are cached, grouped, searchable, badged, and
  its state (busy/idle) is live — not just "we can launch it".
- **Claude stays the default**, byte-identical command line, and a Claude-only user sees no new UI at all.
  It is the **default**, not a fixture: Claude can be switched off like any other backend (#162). The
  "always enabled" rule only ever existed as one line of renderer code — `isEnabled()` had no carve-out,
  so a hand-edited blob or a settings import could already set the flag, and the app would half-break on
  it. The gate is in the model now: the default launch target resolves to something actually launchable, a
  resume of a provenance-less session says *why* it cannot start, a headless run refuses instead of quietly
  spawning a disabled binary, and Claude's own store stops being scanned. *Disable is not delete* — the
  sessions stay visible and searchable.

  **This section used to end "and every Claude fallback that assumed it could not fail is gone". It was not
  true, and it stayed here for eleven issues.** #212 counted them: **23** `|| 'claude'` fallbacks in the
  renderer alone, plus id branches the word "fallback" does not even cover — the profile editor gated its
  ANTHROPIC_* fields on `baseId === 'claude'`, and the settings list kept the five backend blurbs in a table
  keyed by id. #162 moved the *gate* into the model and nothing checked the rest.

  It is true now, for the renderer, and the reason is worth more than the fact: **#225 fixed it in one
  place, not sixteen.** `_defaultBackendId` was `stored || 'claude'` — and the stored value is what the
  user PICKED, not what is possible now. Every surface inherited that and added its own `|| 'claude'` on
  top, which is exactly how "the fallbacks are gone" could be written and be wrong. The registry now
  resolves it once (the stored target while still launchable, else the first launchable, else `''`), so
  the invariant carries the rest: **`_defaultBackendId` is always either launchable or empty, and a caller
  never needs to second-guess it.** If you find yourself writing `_defaultBackendId || <anything>`, the
  `<anything>` is the bug.

  What replaced the sentence is a **guard**, not a better sentence: `test/backend-integrations.test.js`
  holds an id-comparison check (either order, either quote style), a literal counter, and a
  no-table-keyed-by-backend-id check, over every file listed in `ALLOWED_BINDINGS`, each mutation-tested
  — **read the count there**: this paragraph said "eleven renderer files" while the map held 45. Two named
  bindings survive because they are migrations rather than guesses — `LEGACY_TEMPLATE_BASE` (a template
  from before #161) and `LEGACY_SESSION_BACKEND` (a session row indexed before provenance existed).
  The same migration main-side, in `src/projects/projects.js`, closed with **#211** (below). Do not
  restore the sentence — extend the guard.

## Architecture

### The descriptor (the shape of the contract)

| Field / hook | Purpose |
|---|---|
| `id`, `label`, `monogram`, `colour` | identity + badge |
| `description` | the one-line blurb the Backends settings list shows under the label. It says what the CLI **is** — never what it is to this install ("the default", "always available"): the list already shows that, and both of those stopped being true once Claude became disablable (#162). |
| `icon` | which artwork `backend-icons.js` draws, by slug. Declare one and the backend gets a real logo everywhere; declare none — the normal case — and it gets a monogram badge. Anthropic's mark used to be a raw SVG string in `dialogs.js`, emitted only when the id read `claude` (#212). |
| `status` | `ready` \| `planned` (a "Coming soon" dummy that can never launch or be scanned) |
| `axis` | `'B'` = own binary + own store. Claude is the default (`axis: null`); a profile is Axis-A and declares no schema of its own (it runs Claude's binary, so it uses Claude's). |
| `configFields` | this CLI's launch options. **The Settings page and the Configure dialog are generated from it.** A field may declare `appliesAt: 'spawn'` (applied by `app/terminal/spawn.js`, not part of the argv) or `requires: '<other>'` (meaningless on its own). Options that belong to **Switchboard** rather than to a CLI — today `preLaunchCmd` — are added to every backend by the registry (`UNIVERSAL_FIELDS`), not copied into each descriptor. |
| `supportsFork` | whether Fork is offered for its sessions |
| `pageKeyTarget` | `'pty'` when bare PageUp/PageDown are application keys the backend TUI handles, `'viewport'` when its TUI ignores them and the session history lives in xterm's scrollback. **All five answer `'viewport'` today** — Claude was the last `'pty'` and moved under #558, when a re-measurement showed its CLI treats the keys as Home/End rather than paging its own history. The declaration says what to do with the key, **not which buffer the CLI is on**: that is asked live at the press, because Claude was measured on BOTH buffers on one machine on one version. On the alternate screen there is no scrollback to move, so the key goes to the application whatever the descriptor says. An unknown or missing value also falls through to the PTY: swallowing a key a TUI needs is the destructive default, so a NEW backend is `'pty'` until someone has pressed the key. The renderer never branches on a backend id — and the per-backend answer is **measured in a live session and pinned** in `test/terminal-page-scroll.test.js`, because a change aimed at one backend twice moved backends that were not in its scope. |
| `newlineKeySequence` | the bytes Shift+Enter (and Ctrl+Enter off macOS) must send for THIS CLI's composer to insert a newline rather than submit (#493). Claude reads the kitty keyboard protocol's `CSI 13;2u`; Codex ignores it and takes `ESC CR`. A backend that declares none gets an inert chord — never a fall-through, which would submit a half-written prompt. Measured in a live session and pinned in `test/terminal-newline-key.test.js`, like `pageKeyTarget`. |
| `supportsSubagents` | whether this backend has subagents (#230). Only Claude does today; the sidebar's subagent settings (show/hide + row layout, #231) gate on it, so a backend without subagents shows none. Declared like `supportsFork`, crosses the `backends-list` IPC projection, asserted by `backend-parity`. |
| `listSubagents(parentId, {folderPath})` | → `[{agentId, mtimeMs}]`, `[]`, or **`null`** — the subagents that exist for a session right now (#235). The two empty answers differ and the core acts on it: `null` = "nothing to watch here yet" (Claude: no `subagents/` directory), `[]` = "watched, currently empty", and only the second starts the bootstrap bookkeeping that makes the NEXT file a real spawn instead of a silently-recorded leftover (#122). The core owns the lifecycle STATE MACHINE (mtime stability, reopen, GC — `session/session-transitions.js`); the hook only reports. |
| `subagentMeta(parentId, agentId, {folderPath})` | → `{subagentType, description}` \| `null`. Claude reads its `<transcript>.meta.json` sidecar; the core knows neither the sidecar nor its name (#235). |
| `subagentSessionId(parentId, agentId)` | → the row id this backend's subagents are cached under. `sub:<parent>:<agent>` is **Claude's** shape — the core used to concatenate it inline, which quietly made it everyone's. Must be deterministic and distinct per pair (`backend-parity`). |
| `supportsLiveRebinding` | whether this backend can tell us, **mid-flight**, that a running terminal moved to a new session id (#223). Claude's `/clear` mints a new id while the PTY keeps running; Codex's `/new` is the same shape. Declared, so the core asks instead of assuming — and a backend that declines keeps the conservative single-live-session rule. |
| `buildLiveBinding({dir, tag, url, sessionUrl, log})` | → `{args, cleanup}` \| `null`. The spawn path hands the terminal's **tag** (stable across every re-key — the session id is not), a clear URL (`url`) and a current-session URL (`sessionUrl`); the backend answers with what its launch needs. Claude writes a per-spawn `--settings` file registering hooks. Pi writes a per-spawn `--extension` file that posts `ctx.sessionManager.getSessionId()` plus optional neutral lifecycle edges — `busy`/`idle`, and `waiting` with a `prompt_kind` when the CLI is blocked on its own prompt (#529) — and whether a prompt is still queued (`pending`, #530). Returning `null` is always allowed and means "no binding" — the launch proceeds and the core falls back. |
| `releaseLiveBinding(cleanup, log)` | undo whatever `buildLiveBinding` created, when the terminal exits. Must tolerate being called with nothing (`backend-parity` asserts both halves, and that a backend which declines carries neither function). |
| `startupHint`, `caveat` | a slow first paint (Hermes ≈ 12 s); a standing gotcha shown in Settings |
| `endpointEnv` | which env-var family this CLI reads its endpoint from (`'anthropic'`), or nothing. The profile editor offers its Endpoint fields **only** on a base that declares one — on a Codex template they would be two boxes writing variables Codex never reads. Also what an Axis-A preset binds to: a preset IS a bundle of `ANTHROPIC_*` variables, so it needs whichever base declares it reads them (#212). |
| `integrations` | backend-owned extras that are **not** launch options — they reach no argv and no env, so they are not `configFields`, yet they are not generic app settings either. Claude's attention hook patches Claude's **own** `~/.claude/settings.json` and applies to every Claude session, including ones Switchboard never started. Declared → the gear page renders the section; not declared → nothing there (#212). Details below. |
| `buildLaunch({cwd, resume, sessionId, forkFrom, options})` | → `{command, args, env, cwd, spawnMode}`. `env` values are `$VAR` refs, resolved at spawn. |
| `listModels({search})` | OPTIONAL model discovery capability for launch-configuration controls whose `configFields` entry declares `modelDiscovery: true`. The backend owns the CLI/API call, parsing, caching and failures — the SHELLING OUT goes through `backends/cli-probe.js`, which closes the child's stdin and keeps a path out of the failure message (#532/#540). The renderer only receives `{ok, models:[{id,label}]}` through `backend-list-models`; a backend without the hook keeps a plain text field (#412). Pi backs this with `pi --list-models [search]`; agy backs it with `agy models`. |
| `listResources({projectPath})` | OPTIONAL read-only resource discovery capability. The backend owns its settings/resource format and returns neutral rows (`kind`, `scope`, `name`, `path`, `source`). The renderer only shows/copies/opens discovered paths through `backend-list-resources`/`backend-open-resource`; it never installs, updates or executes resources (#411). Claude reports settings, instructions, commands, agents, plugins, hooks, skills and customization directories, **plus one row per installed plugin's skills tree** (#463). Codex reports config, profiles, instructions, plugins, skills, rules, memories and model catalogs, the same per-plugin rows (#536), and its project scope (`AGENTS.md`, `.codex/`). Pi reports global/project settings, packages, extensions, skills, prompt templates and themes. Hermes reports config, skills, skill bundles, plugins, hooks, memories and model catalogs. agy reports safe Gemini/Antigravity settings, `GEMINI.md`, its plugins, builtin/implicit resources and knowledge directories. **Each backend's own file is the list** — this sentence had understated four of them at once, and it will drift again. |
| `probe()` | → `{ok, reason}` — is the binary (and what it needs) there? A probe that shells out reads through `backends/cli-probe.js`: it closes the child's stdin (a CLI that reads standard input otherwise hangs to the timeout) and words a failure without the path the errno carries. **A probe that FAILED has measured nothing** (#546): only a spawn that could not find the binary (`ENOENT`) proves an absence, and a timeout, a kill, a permission error, a non-zero exit or unparseable output all mean "could not be answered" — the probe keeps today's behaviour there rather than asserting a fact, which is the same rule Decision 4 below states about a false negative. Do not narrow that to a match on `ETIMEDOUT`: it names the one failure someone observed and keeps asserting absence for every other one. A cache is for an ANSWER, so an unanswered probe is held for seconds rather than the minutes an answer gets — long enough that the scan path does not shell out on every pass (#155), short enough that one unlucky exec does not decide the next five minutes. |
| `readTurnQueue(ref, sinceMs)` | → `{queued, turnStarted}` \| **`null`** — does this session still owe a turn (#495/#530)? `null` is "cannot tell", which is NOT "nothing is queued". |
| *(and more)* | **This table is not the whole contract.** `src/backends/capabilities.js` names every hook a capability row declares (`deleteSessions`, `rewriteProjectPath`, `transcriptAccess`, `liveOwnersCached`, `expandResource`, `resourceEditing`, `resourceScaffolds`, `skillInvocation`, `recordAppearsAt`, …) — read the CATALOG there rather than trusting this list to have kept up. |
| `discoverSessions()` | → handles: `{kind:'file', path}` **or** `{kind:'db', ref, sessionId, marker}` |
| `parseSession(handle)` | → the normalised row (id, cwd, title, timestamps, tokens, optional cost) |
| `parseSessionIncremental` + `PARSER_SCHEMA_VERSION` | resume a parse from a byte offset + tail fingerprint |
| `watchTargets()` | store-level addresses — also how the app knows the store **exists** |
| `matchLiveSession` / `liveRefFor` / `liveState` | the identity + state seam (below) |
| `resolveLineage(row)` | → `{lineageParentId, lineageKind}` \| `null` — which session this one continued (Spec 13). Claude: a fork's `forkedFrom`; Hermes: `parent_session_id`; Pi: a fork's `parentSession` path (only a forked session has one); Codex and agy `null` until a verified on-disk parent field exists. The core stamps it at one sink and never reads a backend's format (#193/#223). |
| `transcriptPathFor(row)` | → the path to this row's transcript, or `null`. A file backend hands back `row.filePath`; Claude reconstructs from folder + session id over its own roots. The Projects admin's remap/delete no longer reconstructs a Claude path inline (#211). |
| `normalizeTranscriptEntries(entries)` | OPTIONAL Message History adapter. A backend whose raw transcript has richer or different entry shapes can return renderer-neutral entries (`message` with text/tool blocks, `custom-title`, `local-command`, `transcript-meta`) before the renderer sees them. Pi uses this to follow the active tree leaf and render `toolCall`/`toolResult`, bash executions, compactions, branch summaries and extension messages without a renderer backend-id branch (#409). |
| `projectTrust` / `projectMeta` | OPTIONAL per-project capabilities. `projectTrust` = the trust gate (Claude's `~/.claude.json`, Codex's config.toml, Pi's `trust.json`). `projectMeta` = a backend's own projects table (Claude's `~/.claude.json`: `getMany` display-ready columns, `knownProjects`, `has`, `rename`, `remove`, `removeLabel`). A backend with none declares none, and the Projects admin shows no columns for it rather than borrowing Claude's (#171/#211/#406). |
| `plansDir(scope)` / `memorySources(scope)` | where a backend keeps its **plans** and its **memory/instruction files**. Both take a scope; `{projectPath: null}` is the backend's own home, a project asks for that project. `plansDir` answers with a directory or `null` — Claude's home store globally, and per project the `plansDirectory` that project set for it (#450); the rest have no plans store at all. `memorySources` returns display-ready `{kind, path, displayPath, source}`: Claude's home + store folders + `CLAUDE.md`/`.claude`; Codex `AGENTS.md`; Pi `AGENTS.md`+`CLAUDE.md`; agy `GEMINI.md`; Hermes `AGENTS.md`/`CLAUDE.md`/`.cursorrules`/`SOUL.md`/`.hermes.md` (#451 — it had declared none while its own launch option offered to skip them). The Plans and Agent Files tabs read these, never a `~/.claude` literal (#227). |
| `planRef(filePath)` / `planDirSetup(scope)` | OPTIONAL, and both belong to a backend that has a plans store. `planRef` turns one of its plan files into the reference its own sessions record, so the core can look up which project a plan belongs to without learning what the string means (#449 — Claude's is the filename stem, which is the slug its transcripts carry). `planDirSetup({projectPath, planDir, shared})` answers with the file that would have to change, its current contents and what they would become, so pointing a CLI at a project's plans directory does not need a `.claude` literal in the core (#450). |
| store root override | each backend's session scan root honours a unified `SWITCHBOARD_STORE_<ID>` env var (ahead of the CLI's own home env), which is what makes a fully isolated demo/sandbox possible — `npm run demo:start` (#227). |
| `cliHomeEnv()` | → `{VAR: path, ...}` \| `null` — the env var(s) this CLI reads for its OWN home/store, pointed at the isolated store (#241/#406). The override above moves where Switchboard **looks**; this is where the CLI **writes**, and without it a session launched from a demo/sandbox instance landed in the user's real store, invisible to the instance that started it. Claude `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`, Hermes `HERMES_HOME`, Pi `PI_CODING_AGENT_SESSION_DIR` plus `PI_CODING_AGENT_DIR` for its config/trust store; agy declines (`null`) because its CLI has none — an honest gap, not a fake read. Returns `null` when its store var is unset, so a normal launch carries nothing. The spawn path merges it **below** the user's and a template's env, so an explicit variable of theirs still wins. |

### Dual-mode discovery — built first, not retrofitted

Hermes keeps its history in **SQLite**, not in files. Because it was the *second* backend, the discovery
seam is dual-mode from Phase 1: a handle is either a file or a database reference. Had the seam been
file-only, Hermes would have forced a rewrite of the scanner. It did not: the DB backend landed without
touching the seam, and the generalized watcher already handled a `{kind:'db'}` target.

### A file backend composes the file half, it does not copy it

Discovery, watching and the two identity lookups are the **same code** for every backend whose history is
one transcript per session under a root — only the root, the filename shape and the parser differ. Codex
and Pi carried that code verbatim, which is precisely the shape of #148–#155: a defect found in one
backend, fixed there, and kept by its twin.

So it lives once, in **`src/backends/file-store.js`**. A file backend declares what is genuinely its own and
gets the rest:

```js
const store = createFileStore({
  root: sessionsRoot,                                    // LAZY — setHome()/tests move it
  matches: (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
  parseSession: parser.parseSession,
  refSuffix: (sessionId) => `-${sessionId}.jsonl`,       // how a filename names a session
});
// -> store.discoverSessions / watchTargets / matchLiveSession / liveRefFor
```

`findOnPath(name)` sits there too (PATHEXT-aware, because the npm CLIs are `.cmd` shims on Windows) and is
used by the db backend as well — PATH resolution is not a file-store concern, but it is not Codex' either.
A db backend composes nothing else: its store has no files.

### The identity seam — three hooks, or a resume bug

Claude accepts `--session-id`, so *we* choose the id. **Codex, Hermes and Pi name their own sessions.**
Unreconciled, that produces two sidebar rows for one session and a resume that targets an id the tool
never had.

- `matchLiveSession({cwd, sinceMs, claimed})` — find the record a **newly spawned** session created; the
  app then adopts that id (re-using Claude's existing temp→real re-key path).
- `liveRefFor(sessionId)` — find the record of a **resumed** session. **Not optional.** A resumed
  session's record predates the spawn, so `matchLiveSession` can never match it — and the stale claim
  would then adopt the *next new session's* record, collapsing two tabs onto one identity.
- `liveState(ref, ctx)` — `'busy' | 'idle' | null`. `null` means *no evidence*; never guess idle.

**A directory and a window are not an identity** (#527). `matchLiveSession` knows where a session runs and
roughly when it started, and nothing in a record says which process wrote it. With two unpaired sessions
of one backend in one project that is not enough: the core asks them in the order they were opened, so the
older one is offered the record the younger one's turn just produced — and takes it. Busy/idle then lands
on the other card, `realSessionId` names a conversation that session is not in, and the session that owns
the record is locked out of it, because it is held by someone else from then on.

So the match carries `bornMs`, and `src/watch/record-claim.js` asks the question the correlation never
did: could this session have written that record? Its window starts at its spawn, or at its first turn
where the backend says its record appears then — a session that has been asked nothing has written
nothing, which is what resolves the ordinary case. Among the sessions that could have written it, **the
oldest one takes it**, matching the order the store offers records in: `matchLiveSession` hands back the
oldest unclaimed record, so walking both lists in the same direction puts each session on its own. A
record the asking session may not have is set aside and the store asked again, so one record it will
never be allowed to take cannot hide the one behind it. A backend that cannot date its record omits
`bornMs` and keeps the behaviour it had.

The rule is deliberately **subtractive**: it can make a session decline a record it could not have
written, and it never re-orders who gets what. An exact tie goes to whoever asked first, which is what
happened before this existed — a window is a fact that never changes, so refusing both would refuse them
for the life of the sessions. And a session with no window at all — a first-turn backend whose turn was
submitted through a path the app does not see — is not held back either. The honest limit is that a
record is protected only while its real writer is live, unpaired, and known to us.

Two things this cost, both worth keeping written down because the tests missed both:

- **The grace window belongs to the ASKING session alone.** A first version let every candidate reach ten
  seconds further back, which made a younger session a possible writer of the older one's record; two
  possible writers meant nobody paired, and permanently. Two sessions started within ten seconds of each
  other lost busy/idle for their whole life, the unclaimed record was then offered to every later session
  in that project, and when one of the two exited the other adopted its id after all.
- **The oldest eligible session wins, not the newest.** A second version awarded the record to the newest,
  reasoning that a session able to write since earlier would already have paired. That is circular — a
  session that HAS paired is not a candidate — and it swapped two sessions' records outright whenever
  both records were born after both sessions started.

Both were invisible to the suite because the fake `matchLiveSession` returned a constant instead of
walking a store. It walks one now.

### Busy/idle: what each backend actually tells us

| Backend | Signal | Failure mode to respect |
|---|---|---|
| Claude | **states** it in the terminal (OSC title: spinner = busy, `✳` = idle) | — |
| Codex | **states** it in its transcript (`task_started`, and one of the turn-END events its backend folder lists) | two, and both bit: a busy turn out-writes a fixed tail window long before it completes → the window must **grow**; and a turn interrupted with Esc ends on `turn_aborted` with no `task_complete` ever following → a reader that knows only the two obvious events holds the session at "Working" until some LATER turn finishes (#511) |
| Hermes | the **last message row**: a trailing user prompt = a turn is running; an assistant row whose `finish_reason` is not a tool one = it is answered | `ended_at` is **never written** — it reads null on every session, answered or not, so a rule built on it says "working" for three minutes after every reply (#165) |
| Pi | launched sessions post neutral extension events; indexed sessions still fall back to transcript-tail inference (a trailing user/tool result, or assistant `toolUse`, = a turn is running) | tree-shaped JSONL means the visible branch is the leaf's parent path, and one message is one JSONL line, so a large answer can fill the whole tail window |

For the inferred ones, terminal output is used as a **liveness** signal (`ctx.lastOutputMs`): it may keep
a running-but-silent turn out of idle, and may **never** declare one busy. Activity is a bad state signal
(a spinner frame is activity, so is an echoed keystroke) and a fine liveness signal.

**When the store says nothing at all, the app says so** (`src/app/terminal/live-record-notice.js`, #151). A store-derived
backend can only report a state once the live session is paired with its store record. Hermes has a
degraded mode — it writes sessions as JSON when it cannot open its own database, and our reader *is* that
database — so a session running in front of the user may have no record we can see. The tab then shows no
state, forever, with nothing to explain it. A session left unpaired past a grace window (60 s; Hermes alone
needs ~12 s just to paint) is marked as one the backend cannot see.

**When the grace window STARTS is the backend's own answer** (`recordAppearsAt`, #512). The rule used to be
"a record appears within seconds of the spawn" for everyone, and for Codex that is measurably wrong: across
29 rollouts on one machine, not one carries a `session_meta` header without a `task_started` beside it, and
the file appears with the first turn rather than with the process. A Codex session launched and left sitting
at its prompt therefore had nothing to pair with, and picked up the muted dot a minute later while it was
alive and usable. **agy is the same** — its conversation database appears with the first prompt, not at
launch. Both answer `'first-turn'`, and such a session, asked nothing, is never reported at all. Hermes and
Pi keep the default `'spawn'`, which is the behaviour that shipped — and it is a DEFAULT, not a
measurement: nothing has watched when either writes its record, and their descriptors say so rather than
claiming otherwise. That direction is the same one this whole area argues for: no notice beats a wrong one.

The turn is read from the INPUT side, never from output — a TUI repaints at rest, and rule 4 below is
exactly about not reading a turn out of activity. Three things that costs:

- **`ESC CR` is not a submit** — it is Codex' "newline, not submit" sequence (#493).
- **Enter alone is not a turn.** A trust gate, an empty composer and a menu all answer to Enter and write
  no record, so something has to have been typed first. Otherwise the clock starts on the "Do you trust
  this directory?" of a fresh project and the muted dot is back a minute later, one dialog downstream of
  the bug this removed.
- **The keyboard is not the only writer.** `src/watch/trigger-watcher.js` writes its command and its Enter
  straight to the PTY, so it says so itself. A session driven only by triggers would otherwise never start
  its clock — and one whose backend genuinely cannot see it could then never be reported, which is the
  opposite failure and the worse one.

**The mark lasts as long as the condition does** (#460). It was a toast at first, and a toast is the wrong
shape for this: it faded after eight seconds while the thing it explained stayed for good, so looking away
left the user with exactly the unexplained blank indicator #151 set out to remove. The fact is held in
`src/app/store-record-notice.js` and published as a list — every window receives it, a window that opens or
reloads asks for it (`store-record-notice:get`), and it is withdrawn the moment the record turns up or the
session exits. The renderer draws it as a **hollow, muted dot** plus a line in the tab's tooltip, on all
three surfaces that show a status dot.

Quiet is a requirement, not a style choice: no attention colour, no badge, no tray count, no chime. Nothing
is waiting for the user. What is being reported is the ABSENCE of a state, and a signal saying otherwise
would be a second lie beside the blank one.

Which means the slow re-check tick must run **while a session is unpaired**, not only while one is busy.
The store-changed watcher cannot fire when the store does not exist, and an unpaired session can never be
busy — so gating the tick on "something is busy" would have left the one case this exists for permanently
silent. It stops counting a session once the notice has gone out: the tick's job was to reach that point,
and `matchLiveSession` walks a file backend's entire store. A record that turns up afterwards is still
claimed — the watcher fires the moment anything is written, which is exactly when it would.

The original plan called for falling back to PTY activity here. That is exactly what rule 4 below forbids,
and it is how "permanently working" shipped twice: a TUI that repaints at rest would read as busy for good.
The state stays **unknown** — and the user is told that it is unknown, and why.

### Settings and launch, end to end

`backendDefaults.<id>.<opt>` (settings blob, global → project cascade) → `get-effective-settings` →
renderer → `sessionOptions` → `buildLaunch` → spawn. Both the per-backend settings page and the Configure
dialog are **generated** from `configFields`, so a new backend needs no UI code.

Env bundles resolve at spawn. Backend-owned default auth refs, such as Codex' `OPENAI_API_KEY` /
`CODEX_API_KEY` and Pi's `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, are optional and may drop quietly when
unset because the CLIs also support their own login stores. Missing refs from user `backendEnv`, templates
or launchers still raise a session notice: those are explicit configuration choices and likely explain an
auth failure.

### Data

`session_cache` gained `backendId` (authoritative provenance), `filePath` (a rollout path cannot be
reconstructed), `changeMarker` (a db session has no mtime), `estimatedCostUsd` / `actualCostUsd` /
`costStatus`, and `lineageParentId` (a backend's own parent link — deliberately *not* `parentSessionId`,
which already means "this row is a Claude subagent").

## Decisions, and why

The ones that will look wrong to someone tidying up later:

1. **`backendId` is the single discriminator.** A "profile" is just a user-created Axis-A backend. No
   parallel profile/backend abstractions.
2. **Every backend's launch options live in `backendDefaults.<id>` — Claude's too.** They used to sit in
   *Sessions & CLI*; that panel now keeps only what is **not** a launch option. One setting, one home.
   The first cut kept Claude out (to avoid two homes) and that "decision" hid a real bug: the cascade
   never carried `backendDefaults` at all, so **every** saved Codex default was silently ignored at
   launch. `test/settings-cascade.test.js` follows a stored default all the way to the argv.
3. **A `false` is a value, not an absence.** An option whose default is ON (Claude's IDE emulation) can
   only be switched off by sending the `false` — dropping it silently restores the default.

   This is why **every scope carries a per-option "is this set?" marker**, and the cascade resolves
   **per option**:

   ```
   backend default (configFields)  →  global  →  project  →  template
   ```

   A scope stores an option only when it explicitly marks it as set; otherwise the option falls through.
   The project scope got this in #149; the **global** scope did not have it until #163, and so it froze
   the shipped defaults into every user's settings the first time they opened a backend's page and saved
   — after which no improved default could ever reach them, and nothing said so, because the frozen value
   still looked right. A template is the top layer for the options it names and falls through for the
   rest, which is what keeps it from becoming a second home for the same setting.

   **And a `configFields` default is never SENT.** It describes what the CLI does anyway — it is what a
   control shows when nobody has said otherwise, not a value to put on the command line. The launch used
   to seed every non-empty default into the options, so a plain Codex session carried
   `-a on-request -s workspace-write` although the user had chosen neither, silently overruling whatever
   they had configured in Codex' own `config.toml`. It hid behind Claude, which has a sentinel its
   `buildLaunch` throws away (`permissionMode: 'default'`) — Codex and Hermes have none, so for them a
   default became a real flag. **Nothing anybody chose, nothing on the argv.**

   The mirror of that rule is **nothing on the argv that no control declares** (#562). Claude's
   `buildLaunch` read an `appendSystemPrompt` option no `configFields` entry named, so no settings page
   offered it, no scope in the cascade stored it and the Configure dialog could not set it: the only way
   to reach the flag was to construct the options object by hand, which the schedule creator did until
   #246 removed the scheduled-tasks feature and left the branch behind. An argv path nobody can reach
   states a capability the app does not have. Such an option is either **declared**, so it cascades and
   appears on the settings screen like every other; or **removed**; or, if some caller other than the
   settings screen really sets it, that caller is named where the option is read — and then it is the
   declaration. Which way Claude's went is recorded with its exclusion in `scripts/check-claude-help.js`:
   the flag turns the CLI's system-prompt snapshot off, and that behaviour is on the audited-out list
   because nobody here has watched what it does.

   The check is the #548 derivation used twice rather than a second list. The flags the launch shapes,
   the live-binding hook and the **declared** fields can produce, subtracted from the flags an options
   object that answers everything can produce, leaves exactly the options nothing declares — with the
   core's `SENT_ELSEWHERE` (a flag added outside the descriptor) as the one door.

   The **Configure dialog** is the fifth place with the same marker, and it means something slightly
   different there: it is a **per-session override that layers ON TOP of the cascade**, not a replacement
   for it.

   ```
   ticked (always the starting state) = use what already applies — your settings, or the CLI's own
   unticked                           = override, for THIS session, with the value shown
   ```

   Opening the dialog and pressing Start changes **nothing**. Two mistakes to avoid, both of which a first
   cut made: do not call it *"use the backend's default"* (the value on display may be one the **user**
   stored), and do not start it unticked for a stored value (it reads as "you changed this", which they
   did not). A line under each control says where the shown value comes from — *"From your settings."* or
   *"Codex decides."*

   An override is sent **even when its value equals our descriptor default**. If a user's `config.toml`
   says `read-only` and our default says `workspace-write`, then *"workspace-write, just this once"* is a
   real instruction — and a rule that compared the value to our default could not express it: it looked
   like "same as the default" and vanished. The marker is the difference between what a value **is** and
   what it **means**.
4. **Availability informs and refuses; it does not hide.** A failed `probe()` shows the reason in Settings
   and refuses the spawn with it. It does **not** filter the backend out of the picker: a probe is a
   heuristic, and a false negative must never make a working backend vanish with no explanation.
5. **An estimate is never a bill.** A cost counts as *settled* only when the backend says so; an unknown
   or missing status degrades to "estimate". A **zero** estimate reads as "no cost reported", not `$0.00`
   — a backend returning zero means it had no price for that model, not that the work was free.
6. **A backend that cannot fork must say so.** Accepting `forkFrom` and ignoring it does not disable the
   button — it launches an unrelated empty session.
7. **Disable is not delete.** A disabled backend leaves the picker, the scan and the badge counting; its
   sessions stay visible and searchable.
8. **A handoff is context, not a continuation — and it is the ONE exception to binary-bound resume.**
   Resuming a *session* reapplies its backend, with no chooser (§5.11). Resuming a *handoff* starts a
   **new** session seeded with a packet, so it may run on any backend and the user is asked which
   (defaulting to the one that wrote it — a column in `project_handoffs` when this was written, and the
   `backend:` line of the packet's own header since #468, which moved handoffs out of the database and
   into the project; spec 25 is that record). A backend with no
   transcript file supplies its messages through `readMessages()`, which is what lets a handoff be
   produced from it at all — without it the review dialog comes up empty and the user retypes what the
   agent just wrote.
8b. **Argv spawn is honoured only when the command is a real executable.** On Windows `CreateProcess`
   cannot run an npm `.cmd` shim (which is what `codex` is), so argv mode falls back to the shell there.

   **...and only when nobody asked for a shell.** A `preLaunchCmd` is a raw shell prefix, so it needs a
   shell and a command line to sit in front of — argv mode has neither. That, and nothing about Claude,
   is why the option used to be Claude's: Claude spawns through a shell, the Axis-B backends spawn argv.
   Setting one now drops **that session** to the shell path; argv stays the default for everyone who sets
   nothing. The MCP bridge (`--ide`) stays Claude-only for a real reason — it is a Claude flag speaking
   Claude's protocol. The two were gated on the same line, which is the only thing they ever had in common.
9. **Cross-backend deletes are scoped.** A project bucket is keyed on the working directory and therefore
   *shared*: refreshing, hiding or removing a Claude project must not take another backend's rows with
   it — their data is still on disk.
10. **Real git worktrees are their own project**, detected by the `.git` *file*; grouping stays on the
    stable head cwd (deriving it per session let one moved session drag its siblings).

## The provider badge (#187)

**A row says which backend it is from the moment it is launched.** `launchNewSession` builds the row for a
session that has no transcript yet, and it did not put the backend on it — though it is the very code that
chose the backend. `sessionBackendId()` then fell through to the launch overlay, which the renderer only
loads at start-up and which has therefore never heard of the session being launched right now, and landed
on the `claude` default: a fresh Codex session sat there badged as Claude until the cache caught up.
Resolution order, unchanged and now actually used: **the row's own column → the launch overlay → Claude**
(a session with no provenance predates the multi-LLM era).

**Whether EVERY row is badged follows the backends that are ENABLED, not the sessions on screen.** Deriving
it from the visible sessions made the badges come and go with the list: someone running Claude and Codex
saw them vanish the moment the Codex rows were filtered out, scrolled past the fold, or simply not started
yet — and the remaining Claude rows then looked like the rows of a single-backend app.

| enabled backends (`ready && enabled`) | badges |
|---|---|
| ≥ 2 | every row, always — you need to tell them apart |
| exactly 1, and it is the default | none — a single-backend user sees an unchanged app |
| exactly 1, and it is **not** the default | badge it: it is not what you would assume |

The sessions are the fallback only for the moment before the backend probes have answered. A session whose
backend is not the default is badged individually regardless, so nothing is ever unlabelled. Rule:
`computeShowAllBadges` (`src/renderer/backends/backend-registry.js`), tested in `test/backend-badges.test.js`.

## The usage capability (#191)

**A backend that can report a quota declares it; the core never learns a backend id.** The status bar
carries one segment per such backend, and Settings offers a tick per such backend — both derived from the
descriptor, which is what lets Antigravity arrive later as a folder and nothing else.

```js
usage: {
  live: true,                        // fetched now (Claude) vs. as of the last run (Codex)
  fetch: async (context) => ({ … }), // stays in main; only `live` crosses IPC
}
```

`context` is what main knows and the backend cannot ask for itself: the pids of the sessions this app is
running for that backend, whether a successful reading is already cached, the clean spawn environment, and
a way to find the CLI on PATH. It exists so a backend that has to TALK to its own running process (agy, #509)
does not reach into main for it, and every field is optional — Claude's and Codex' `fetch` ignore the
argument entirely.

Every capability returns the **same shape** (`src/backends/usage-format.js` documents it): a list of buckets
(`key, label, percent, reset, tier, bar`) plus an optional credit pool, and — when the backend was told why
it ran out — `limitReached` with a `limitReachedMessage` beside the buckets (#494). `src/main.js` iterates
`backends.list().filter(b => b.enabled && b.usage)`, stamps each result with the descriptor's identity, and
caches it **per backend** (`usage:lastSuccessful:<id>`).

Four things this got wrong before, and now does not:

- **A switched-off backend is not fetched.** `get-usage` used to call Claude's fetch unconditionally, so a
  user who disabled Claude and ran only Codex still had the app reading Claude's OAuth credentials and
  calling Anthropic's usage endpoint on a timer. Claude is not exempt from being disabled (#162), so this
  was not hypothetical. **No enabled backend, no fetch** — and disabling one must still not erase the
  *tick* that says you want to see it, or turning Codex off for a day silently forgets that wish.

- **Freshness is not uniform, and the bar must not pretend it is.** Claude's figure is a live API call.
  Codex's is read out of its last rollout — three days without Codex and it is three days old. The
  non-live segment is dimmed past an hour and its tooltip says when it was measured. Two segments styled
  identically, one of them stale, is a bar that lies.

- **The colour thresholds are keyed on how fast a bucket REFILLS, not on a window name.** They used to be
  `5h` and `7d` — *Claude's* windows, hardcoded in the settings page. Codex reports `window_minutes` and
  the provider may change it; Google Antigravity's current local summary can report grouped short/weekly
  limits, while older fallback responses are per **model**. A tier of `short` / `long` carries all three;
  `5h` / `7d` carries exactly one.

- **The last record a store holds is not the last reading, and a reason is not a measurement** (#494).
  Codex ends a session by writing a rate-limit block that has no windows in it, only the reason it stopped.
  Reading the literal last block threw away the good readings sitting earlier in the same file and put the
  bar on "no data yet" — the one answer that tells the user nothing — while the backend had said exactly
  what was wrong. Two things come out of such a store now: the last record that **measures** something,
  and the reason, which rides beside a current reading rather than replacing it. `docs/backend-formats.md`
  carries the captured shape.

Hermes and Pi declare no capability and therefore appear nowhere in this UI — not even as an empty control
that could never show a value. Pi's `usage.cost` is its own *cost estimate*, not a quota.

## The integrations capability (#212)

Some things belong to a backend but are not launch options: they reach no argv and no env, so they cannot
be `configFields` — yet they are not generic app settings either. Claude's attention hook is the case that
forced the shape: it patches Claude's **own** `~/.claude/settings.json` and applies to every Claude
session, including ones Switchboard never started.

It used to be rendered by an `if (backend.id === 'claude')` on the gear page — the last place the settings
surface named a backend, and the one rule this layer otherwise kept perfectly. Now the backend declares it:

```js
integrations: {
  title: 'Integrations',
  fields: [{ id: 'attentionHooks', domId: 'sv-attention-hooks', type: 'toggle', label: '…', description: '…' }],
}
```

- **Only the declaration crosses IPC**, exactly like `usage`. `backends-panel.js` renders whatever arrived
  and knows no backend; a descriptor that declares nothing gets no section at all.
- **Each field is a plain GLOBAL setting keyed by `id`**, not a `backendDefaults` option — these reach no
  argv, so the cascade has nothing to resolve. `settings-panel.js` owns the save path.
- **`domId` is the load-bearing string, and it is the fragile one.** It is shared across two files with no
  import between them, and `settings-panel.js` deliberately falls back to the stored value when the control
  is absent (the gear page is usually not in the DOM). That fallback is what makes a save with the page
  closed safe — and also exactly what would hide a rename: the toggle would keep rendering, keep taking
  clicks, and silently stop saving, with the suite green. `test/backend-integrations.test.js` pins both ends.
- **`toggle` is the only type** the panel renders. An unknown type renders *nothing* rather than falling
  through to a checkbox — a control that stores something other than what it shows is worse than no control.

A template inherits none of this: `profileToDescriptor` builds an explicit field list and carries neither
`integrations` nor `endpointEnv` nor `description`. That is deliberate — a template has no gear page, and
the profile editor asks the **base**, off the built-ins.

## Reading a backend's own configuration (#440)

`listResources` was always a listing; since #440 it is only a listing. A customization directory is one
row, and `expandResource` reads one level into it when the user opens it.

- **The walk is shared, the rules are declared.** `src/backends/resource-expand.js` has three modes —
  a skills tree that stops at whatever folder holds `SKILL.md`, flat files with an optional extension
  filter, and subdirectories. Each backend maps its own directories to a mode, keyed by the `source`
  its listing entries already carry. Five copies of the walk with five filters is the defect this
  avoids by construction.
- **hermes and pi moved into it.** Both enumerated inline, so a settings-panel open ran a recursive
  scan; pi's was uncapped and unguarded, and a single unreadable subdirectory failed the whole listing.
  The cap now belongs to the hook contract rather than to one backend's walk.
- **Junctions are followed.** `Dirent.isDirectory()` is false for one, which is how a junctioned skills
  directory read as empty with nothing to see. `statSync` answers instead.
- **Containment uses `realpath`.** Lexical containment passes a symlink out of the tree, and a skills
  directory is exactly where symlinks live.
- **The Agent Files tab is where this surfaces**, beside the instruction files it already showed — the
  main window, next to the sessions, rather than two windows away in settings. The Backends settings
  page keeps the inventory and its Open / Copy path buttons. What the tab shows is narrower than what a
  backend lists: plan documents have their own tab, and a plugin directory opened in a text editor is a
  dead end.

### How a resource row reports a failure (#444, #445)

Two defects in the same listing, both about what the row says rather than what it lists.

- **A thrown filesystem error is translated, not forwarded.** `EACCES: permission denied, scandir
  '<home>/.pi/skills'` names a home directory, a user name and a layout, and the app used to put that on
  screen verbatim. `readableError` in `src/app/readable-error.js` maps the errno to a sentence and
  **drops the rest of the message** — an error whose code it does not recognise is answered with the
  caller's own sentence and nothing else. Shortening the message or scrubbing the quoted path would be a
  guess about a string that may carry anything. A reason a backend *authored*
  (`{ ok: false, reason: '…' }`) is not an error and passes through untouched. The dropped detail is
  **moved, not lost**: the code and the raw message go to the log, because a failure nobody can explain
  from the screen and nobody can look up either is the worse end of the trade.
- **Reading a resource and writing one are the same surface**, and the first pass fixed only the reading
  half. The Agent Files tab opens a discovered resource through the sanitised path and used to save it
  through one that answered with the errno's own words, in a dialog. `savePlan`, `saveMemory`,
  `deleteWorkFile` and the plan-convention writer in `src/app/plans-memory.js` go through the same helper
  now — which is why it is its own module rather than a private function of the listing. An adversarial
  review found that half; the tests did not, because there were none over those four paths.
- **The failure goes into the row, not into the button.** "Open failed" was written into the label of
  the control that had just said what it does, and it stayed there — so the reason was lost and the
  button was too. The row carries a line of its own; the button keeps its label and flashes only on
  success — and a failure calls a running flash off, so the button never reads "Opened" above a line
  saying it did not open.
- **The project scope has a pill of its own.** It wore the amber `soon` class, which on the same page
  means "not built yet" and "not saved yet" — so a `CLAUDE.md` sitting on disk read as something still to
  come. Alongside it the project section names the project it is showing, rather than leaving that to the
  window title: the settings window has no project registry to ask, so the folder name is the heading and
  the full path is beside the list.

## The capability matrix (#439)

Each backend covers a different part of what the app can do, and until #439 the only way to see that was to
click through five settings pages and notice which controls were missing. The matrix is one table: rows are
capabilities, columns are backends, cells are `yes` / `limited` / `no`.

**The answers are DECLARED, and that is the whole decision.** The obvious implementation reads
`typeof descriptor.someHook === 'function'`, and it produces a table that is wrong. Nearly every hook exists
on every backend — `plansDir`, `memorySources`, `resolveLineage`, `cliHomeEnv`, `transcriptPathFor` and
`listResources` are declared by all five — and several exist *in order to decline*: agy's `cliHomeEnv`
returns null, Codex' `resolveLineage` returns null, Hermes' `plansDir` returns null. Presence says a backend
answered the question, not what it answered. Two backends enumerate their skill files and two stop at the
directory, through the same hook name.

```js
capabilities: {
  fork: 'yes',
  lineage: { state: 'no', note: 'records no parent link on disk' },
}
```

- **`src/backends/capabilities.js` holds the catalog** — the rows, their labels, their groups, and
  `answersFor(descriptor)`. Keyed by capability, never by backend id, so it is the core's and not any one
  backend's. A backend that says nothing about a row answers `unknown`, which is drawn as a visible gap: a
  forgotten row and a deliberate no are different facts and must not look alike.
- **`limited` requires a note.** A half-yes that does not say which half is worse than a plain no.
- **The catalog crosses IPC once per `backends-list` payload**, beside each backend's answers. The renderer
  holds no labels, no ids and no answers — same shape as `usage` and `integrations`.
- **Derivation survives as a CHECK, not as a source.** `test/backend-capabilities.test.js` refuses a `yes`
  whose declaring field is absent, so a declaration cannot drift from the descriptor in silence. On top of
  that sits a pinned table, one entry per backend and per capability, in the shape of `PAGE_KEY_TARGETS`:
  changing any backend's answer fails by name. A loop asserting the same value for every backend would be
  the defect the pinning exists to catch.
- **Templates get no column.** `profileToDescriptor` forwards the base's `capabilities` — a template runs
  the base's binary, so its answers are the base's, and a column would be a copy under another name.
- **A disabled backend keeps its column**, marked. The matrix says what a backend can do, not whether it is
  switched on today.
- **It opens from the global Backends page and from a single backend's page** (#446). It shipped on the
  global header alone, which is not where the question is asked — someone on one backend's page is already
  asking what that one can do. That page opens the FULL matrix rather than its own column: the neighbouring
  column is the answer.
  **The project scope deliberately has no way in.** What a backend can do does not vary per project, so it
  stays with the other global backend controls (enabling one, the default launch target) rather than sitting
  above per-project launch options. `test/backend-capability-entry.test.js` asserts the absence as well as
  the two entries, so the branch cannot drift back untested.
- **A capability the user can SEE missing says why** (#446). Fork was withheld silently on a backend that
  cannot fork — correct (offering it launches an unrelated empty session) and unreadable, because a missing
  control looks the same as a feature the app does not have. The button stays, disabled, and its tooltip
  names the backend and the declared `note` if there is one. The sentence is built from the descriptor's
  answer, so the renderer still holds no per-backend text. A session whose backend is no longer registered
  gets nothing: without a descriptor there is no name and no reason, and inventing one is not an answer.

Adding a row means every backend answers it, declining included. That is the point of the catalog living in
one file: the question cannot be asked of four backends and skipped for the fifth.

## What the seam absorbed

**No gap this spec once listed is still open.** What follows is the record of what moved and why,
because the movement is the design — not a changelog. The gaps that were one line each are described
in the section above that owns them: the per-option cascade (#149) under Decisions 3, Hermes' probe
scope and its unreadable-DB fallback (#150/#151) under *Busy/idle*, the staleness gate and the Stats
filter (#152/#159) under *Metrics*, the plan leftovers (#153), every backend feeding the charts (#154),
the hot paths (#155), and the shared file-store helper (#156) under *A file backend composes the file
half*. `test/settings-cascade.test.js` runs the cascade for real now, rather than scraping it out of
main.js's source with `new Function`, which is what it had to do while it lived in an Electron-bound
file.

**#188** — the core reads Claude through its descriptor. The format modules moved into
`backends/claude/` (`session-reader.js` / `folder-reader.js`) and `src/index/session-cache.js` pulls its
readers off the descriptor, so the folder is no longer half a lie; the Electron-free scan worker
imports the reader by path.

**#211** (the Projects admin no longer knows Claude exists — per-project meta/config is `projectMeta`, the
transcript path is `transcriptPathFor`, and `src/projects/projects.js` requires no backend module and names
no id) and **#227** (the Plans/Memory tabs read `plansDir`/`memorySources` and the register
instead of `~/.claude`, and the nine handlers moved to `src/app/plans-memory.js`; a `SWITCHBOARD_STORE_<ID>`
override per backend makes an isolated demo possible — `npm run demo:start`). `test/backend-path-neutrality.test.js`
now guards hardcoded per-backend PATHS the way `backend-integrations.test.js` guards ids. A real win of #227:
a Codex- or Pi-only project's own `AGENTS.md` finally appears in Memory attributed to that backend, where the
old core read `['CLAUDE.md','GEMINI.md','agents.md']` for every project as if it were Claude's.

**#235** (subagents behind the seam). #230 declared *whether* a backend has subagents; #235 is *how* they are
found, named and described — `listSubagents` / `subagentMeta` / `subagentSessionId` above. What moved out of
the core: `session/session-transitions.js` walked `<folder>/<parent>/subagents/agent-*.jsonl` and read
Claude's `.meta.json` sidecar; `main.js` built the `sub:<parent>:<agent>` row id by hand and resolved the
transcript with a direct import of Claude's `resolveJsonlPath`; `backends/file-store.js` hardcoded
`parentSessionId: null`, so a backend composing the shared walk *structurally could not* have subagents (it
now takes an optional `subagentOf`). The lifecycle state machine — bootstrap quiet, mtime stability, reopen
(#121), GC (#122) — stayed in the core on purpose: it is not backend knowledge, it is what the app does with
the answer. `subagents` is now a Claude path token in `backend-path-neutrality`, so the layout cannot leak
back out.

**#518** added the deadline that state machine was missing. The CLI announces the end of a subagent that
*finished*; a subagent that is cancelled, or that dies with the turn on a usage limit, ends in silence. The
hook edge that closes the entry never arrives, and #121's rule — the mtime heuristic may not retract what
the hook opened — turned that silence into a row that claimed work forever. So the refusal now expires: two
minutes after the completion guess, with the sweep still watching for a reopen throughout, the scan's
verdict outranks the hook edge that was never coming. Being wrong here is survivable in a way the old
behaviour was not — an agent that writes again re-lights itself through the reopen path, while the stuck
indicator healed only on a restart.

Which backend a LIVE session belongs to comes from the launch overlay (`session/session-backends.js`),
injected as `getSessionBackend`. An `activeSessions` entry carries no `backendId` field, so reading one off
it would have looked like dispatch while resolving to the legacy default for every session — the first
draft of #235 did exactly that, and the verifier caught it. **The remaining honest limit on that path:** the
only caller of `detectSessionTransitions` is the fs.watch on *Claude's* store (`src/watch/projects.js`), so
nothing else reaches the detection today regardless. Generalising the watch is its own issue; the dispatch
is real, so the day a second store is watched it asks the right backend.

**The one part with no neutral equivalent, stated rather than left to look like an oversight:** the exact
spawn/stop signal comes from Claude Code's own `SubagentStart` / `SubagentStop` hooks (`src/app/hooks.js`,
`src/shared/attention-source.js`) — a Claude integration, declared as such under `integrations`. Every other
backend falls back to the scan-based heuristic the state machine implements, which is the same fallback
Claude itself uses when the attention hook is off (and always, in a dev build — #219). So a future backend
with subagents gets discovery, identity, metadata, transcript and live tail from the seam, and *approximate*
live status from the heuristic. That is a real difference in precision, not a gap in the seam.

Two deliberate #227 behaviour changes, recorded so they are not mistaken for regressions: (1) the instruction
file is declared with its **canonical** spelling (`AGENTS.md`, `GEMINI.md`), so a project carrying a *lowercase*
`agents.md` on a case-sensitive filesystem is no longer surfaced — uppercase is the convention, and on Windows
it never mattered; (2) the Agent Files project list comes from the **register**, so a store folder whose
project path cannot be derived (an undecodable legacy name with no `cwd` on disk) no longer appears as its own
group — it is not in the sidebar either, which is the whole point of "one visibility rule for every view".

## Metrics: the staleness gate, and what a bucket is (#152, #159)

**A cached row records the parser that wrote it** (`session_cache.parserVersion`), and the scan skips a
session only when its change marker matches **and** that version is the one we would read with now.

This is not a nicety. A parser change does not move a file's mtime or a Hermes session's `ended_at`, so
without the version half of the gate every metrics schema change lands in an empty table and stays there:
that is exactly how the charts came to be silently Claude-only *and* stale for every existing user, until
they happened to find **Settings → Maintenance → Rebuild session cache**. Migration v8's own comment
claimed a cold-start rebuild would backfill it — but a cold start only runs when the cache is **empty**,
which after the first launch it never is. **Bump a parser and its sessions re-read themselves. That is
the contract; do not add a metrics field without bumping.**

**A metrics bucket is `(date, hour, model)`, on the LOCAL clock** (`src/backends/metrics-bucket.js` — one helper, all
four backends). Claude used to slice the ISO string (the UTC day) while Hermes grouped by SQLite's
`localtime`: in a chart that stacked both, the same evening's work sat a column apart. The user's day is
the day their own clock showed.

Each backend can be exact to a different depth, and the difference is stated rather than smoothed over:

| Backend | Tokens | Cost |
|---|---|---|
| Claude | per message, exact | none reported |
| Codex | per token_count report, **delta** (it re-emits a running total) | none reported |
| Pi | per assistant turn, exact | **per turn, exact** — it prices its own turns |
| Hermes | only on the session row → booked on the bucket of its **last activity** | same, and the UI says so |

`hour = -1` means "this backend cannot say when within the day". The hour grid **excludes** those buckets
— placing them at midnight would invent a working habit nobody has — while every per-day chart still
counts them.

**The Stats filter is one control** at the top of the page and scopes every figure below it. It is
resolved in **SQL** (`src/db/stats-queries.js`), not in the renderer, because only aggregates cross the IPC
boundary — there is nothing in the renderer left to filter. `session_metrics` carries no `backendId`: it
JOINs `session_cache`, which owns the authoritative provenance. A `NULL` backendId there means Claude,
and every query folds it in — otherwise a Claude user's entire pre-multi-LLM history vanishes the moment
they click "Claude". The **Rate Limits** panel is deliberately NOT scoped: those are Claude's
subscription limits from Claude's API, and no other CLI has them.

## Validation

- `npm test` — `test/backend-parity.test.js` asserts the properties **every** backend must share (a probe,
  an honest `supportsFork`, all three identity hooks if it names its own sessions, a versioned incremental
  parser). It exists because the same defect was found and fixed in one backend four separate times while
  its siblings quietly kept it.
- `test/stats-queries.test.js` runs the **real SQL** of every Stats aggregate against an in-memory SQLite
  with the real schema. It exists because the queries could not be tested at all before (db.js requires
  Electron), so they were "checked" against a JS re-implementation of themselves — which passes whether
  or not the SQL is right. The first thing the real test found was a `GROUP BY` resolving to the raw
  column instead of the `COALESCE` alias, which dropped every legacy row from the stacked chart.
- `test/file-store.test.js` pins the shared file-mode mechanics against a synthetic backend, so a fix to
  discovery/watching/identity is checked **once** instead of in one backend's suite while the sibling
  quietly misses it.
- Per backend: `test/{codex,hermes,pi}.test.js` (parsers + state against **real** fixtures),
  `test/scan-multi-backend.test.js` (the generic scanner: shared project bucket, cross-backend delete
  isolation, an unreachable store must not reconcile a history away), `test/settings-cascade.test.js`
  (a stored default reaches the argv), `test/scoped-folder-deletes.test.js`.
- Human gate: enable a backend, launch it, confirm the TUI drives, the badge shows, the session is
  searchable and flips busy → idle, and that resume returns to the same binary.
