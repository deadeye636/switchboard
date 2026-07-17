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
  resume of a provenance-less session says *why* it cannot start, the scheduler refuses instead of quietly
  spawning a disabled binary, and Claude's own store stops being scanned. *Disable is not delete* — the
  sessions stay visible and searchable.

  **This section used to end "and every Claude fallback that assumed it could not fail is gone". It was not
  true, and it stayed here for eleven issues.** #212 counted them: **23** `|| 'claude'` fallbacks in the
  renderer alone, plus id branches the word "fallback" does not even cover — the profile editor gated its
  ANTHROPIC_* fields on `baseId === 'claude'`, and the settings list kept the five backend blurbs in a table
  keyed by id. #162 moved the *gate* into the model and nothing checked the rest. #212 fixed the three
  files its acceptance named and left a **test** rather than a claim (`test/backend-integrations.test.js`:
  an id-comparison guard, a literal counter, and a no-table-keyed-by-id guard, all mutation-tested);
  **#225** carries the eight remaining renderer files. So: the rule holds where a guard enforces it, and
  #225 is the honest list of where it does not yet. Do not restore the sentence — extend the guard.

## Architecture

### The descriptor (the whole contract)

| Field / hook | Purpose |
|---|---|
| `id`, `label`, `monogram`, `colour` | identity + badge |
| `description` | the one-line blurb the Backends settings list shows under the label. It says what the CLI **is** — never what it is to this install ("the default", "always available"): the list already shows that, and both of those stopped being true once Claude became disablable (#162). |
| `icon` | which artwork `backend-icons.js` draws, by slug. Declare one and the backend gets a real logo everywhere; declare none — the normal case — and it gets a monogram badge. Anthropic's mark used to be a raw SVG string in `dialogs.js`, emitted only when the id read `claude` (#212). |
| `status` | `ready` \| `planned` (a "Coming soon" dummy that can never launch or be scanned) |
| `axis` | `'B'` = own binary + own store. Claude is the default (`axis: null`); a profile is Axis-A and declares no schema of its own (it runs Claude's binary, so it uses Claude's). |
| `configFields` | this CLI's launch options. **The Settings page and the Configure dialog are generated from it.** A field may declare `appliesAt: 'spawn'` (applied by `app/terminal/spawn.js`, not part of the argv) or `requires: '<other>'` (meaningless on its own). Options that belong to **Switchboard** rather than to a CLI — today `preLaunchCmd` — are added to every backend by the registry (`UNIVERSAL_FIELDS`), not copied into each descriptor. |
| `supportsFork` | whether Fork is offered for its sessions |
| `startupHint`, `caveat` | a slow first paint (Hermes ≈ 12 s); a standing gotcha shown in Settings |
| `endpointEnv` | which env-var family this CLI reads its endpoint from (`'anthropic'`), or nothing. The profile editor offers its Endpoint fields **only** on a base that declares one — on a Codex template they would be two boxes writing variables Codex never reads. Also what an Axis-A preset binds to: a preset IS a bundle of `ANTHROPIC_*` variables, so it needs whichever base declares it reads them (#212). |
| `integrations` | backend-owned extras that are **not** launch options — they reach no argv and no env, so they are not `configFields`, yet they are not generic app settings either. Claude's attention hook patches Claude's **own** `~/.claude/settings.json` and applies to every Claude session, including ones Switchboard never started. Declared → the gear page renders the section; not declared → nothing there (#212). Details below. |
| `buildLaunch({cwd, resume, sessionId, forkFrom, options})` | → `{command, args, env, cwd, spawnMode}`. `env` values are `$VAR` refs, resolved at spawn. |
| `probe()` | → `{ok, reason}` — is the binary (and what it needs) there? |
| `discoverSessions()` | → handles: `{kind:'file', path}` **or** `{kind:'db', ref, sessionId, marker}` |
| `parseSession(handle)` | → the normalised row (id, cwd, title, timestamps, tokens, optional cost) |
| `parseSessionIncremental` + `PARSER_SCHEMA_VERSION` | resume a parse from a byte offset + tail fingerprint |
| `watchTargets()` | store-level addresses — also how the app knows the store **exists** |
| `matchLiveSession` / `liveRefFor` / `liveState` | the identity + state seam (below) |

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

### Busy/idle: what each backend actually tells us

| Backend | Signal | Failure mode to respect |
|---|---|---|
| Claude | **states** it in the terminal (OSC title: spinner = busy, `✳` = idle) | — |
| Codex | **states** it in its transcript (`task_started` / `task_complete`) | a busy turn out-writes a fixed tail window long before it completes → the window must **grow** |
| Hermes | the **last message row**: a trailing user prompt = a turn is running; an assistant row whose `finish_reason` is not a tool one = it is answered | `ended_at` is **never written** — it reads null on every session, answered or not, so a rule built on it says "working" for three minutes after every reply (#165) |
| Pi | states nothing; inferred from which line exists (a trailing user prompt = a turn is running) | same, plus: one message is one JSONL line, and a large answer can fill the whole window |

For the inferred ones, terminal output is used as a **liveness** signal (`ctx.lastOutputMs`): it may keep
a running-but-silent turn out of idle, and may **never** declare one busy. Activity is a bad state signal
(a spinner frame is activity, so is an echoed keystroke) and a fine liveness signal.

**When the store says nothing at all, the app says so** (`src/app/terminal/live-record-notice.js`, #151). A store-derived
backend can only report a state once the live session is paired with its store record. Hermes has a
degraded mode — it writes sessions as JSON when it cannot open its own database, and our reader *is* that
database — so a session running in front of the user may have no record we can see. The tab then shows no
state, forever, with nothing to explain it. A session left unpaired past a grace window (60 s; Hermes alone
needs ~12 s just to paint) raises a one-time notice naming the backend.

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
   (defaulting to the one that wrote it, recorded in `project_handoffs.backendId`). A backend with no
   transcript file supplies its messages through `readMessages()`, which is what lets a handoff be
   produced from it at all — without it the review dialog comes up empty and the user retypes what the
   agent just wrote.
8. **Argv spawn is honoured only when the command is a real executable.** On Windows `CreateProcess`
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
  fetch: async () => ({ … }),        // stays in main; only `live` crosses IPC
}
```

Every capability returns the **same shape** (`src/backends/usage-format.js` documents it): a list of buckets
(`key, label, percent, reset, tier, bar`) plus an optional credit pool. `src/main.js` iterates
`backends.list().filter(b => b.enabled && b.usage)`, stamps each result with the descriptor's identity, and
caches it **per backend** (`usage:lastSuccessful:<id>`).

Three things this got wrong before, and now does not:

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
  the provider may change it; Google Antigravity reports no time window at all (its quotas are per
  **model**). A tier of `short` / `long` carries all three; `5h` / `7d` carries exactly one.

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

## As built — known gaps

Filed as issues rather than silently carried:

- ~~**#149** `backendDefaults` cascades as a whole block, not per option.~~ **Fixed** — the cascade is
  per option (`mergeBackendDefaults` in `src/app/settings.js`, moved there from `main.js` by #213).
  `test/settings-cascade.test.js` runs it for real now, rather than scraping it out of main.js's source
  with `new Function`, which is what it had to do while it lived in an Electron-bound file.
- **#150/#151** Hermes: probe scope, no busy/idle fallback when its DB is unreadable.
- **#153** leftovers vs. the plan (Tier-2 registration path, a launch-time `$VAR` warning, picker cosmetics).
- **#155** hot-path cost (Hermes re-parses a session per watcher flush; store walks per flush).
- **#156** this contract needs a shared file-store helper — Codex and Pi duplicate ~60 lines of walk /
  watch / match / lookup boilerplate that the next file backend would copy a third time.

Closed since: **#154** (every backend feeds the charts), **#152** + **#159** (below), **#188** (the core
now reads Claude through its descriptor — the format modules moved into `backends/claude/`
(`session-reader.js` / `folder-reader.js`) and `src/index/session-cache.js` pulls its readers off the descriptor,
so the folder is no longer half a lie; the Electron-free scan worker imports the reader by path).

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
