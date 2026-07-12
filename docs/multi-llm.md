# Multi-LLM backends

Switchboard was a Claude Code cockpit. It now runs **several coding CLIs** side by side — Claude Code,
Codex, Hermes and Pi — in one sidebar, one search index, one set of stats, with one launch menu.

Claude remains the default and behaves exactly as before. Everything else is off until you turn it on.

---

## For users

### Turning a backend on

**Settings → Backends.** Every built-in backend has a row: a toggle to enable it, and a **gear** that
opens its own page with that backend's launch defaults. A backend whose binary is not installed says so
(**not installed**, with the reason — what to install, or which version is too old); it can still be
enabled, but a launch is refused with that same sentence instead of dumping a raw shell error into a
terminal tab.

Only an **enabled** backend appears in the launch menu, and only an enabled backend's session store is
read. A backend that is not built yet shows as *Coming soon* and can never be enabled.

### Starting a session

The **+** button on a project opens the launch menu: one row per enabled backend. Clicking the row
launches with your saved defaults; the **gear** on the row opens a Configure dialog for a one-off
override. That dialog is generated from the backend's own options — Claude's permission mode means
nothing to Codex, so Codex is never shown it.

**Resume** keeps the backend the session was started with. There is no chooser: a Codex session resumes
into Codex, a Claude session into Claude. **Fork** appears only on backends that can actually fork
(Claude and Pi today) — a backend that cannot fork does not offer a button that would silently start an
unrelated empty session instead.

### Reading a mixed sidebar

When more than one backend is in play, each session row carries a small **provider badge** (`C`, `Cx`,
`H`, `Pi`). If you only use Claude, no badges appear at all — the app looks exactly as it did.

Sessions from every backend are grouped into the **same project** when they share a working directory,
and all of them are in the same full-text search. Hermes sessions that genuinely have no working
directory (its gateway/cron chats) collect in a backend-scoped bucket rather than being forced under a
project.

### Cost

Some backends price their own turns. Where they do, **Stats → By backend** shows it:

- `~$1.23` in amber — an **estimate** the backend computed from its own price table (Hermes, Pi).
- `$1.23` in green — an amount the backend states it actually settled.
- `—` — a token-only backend (Claude, Codex): it reports no cost, and we do not invent one.

An estimate is never displayed as a bill, and a *zero* estimate is shown as "no cost reported" rather
than `$0.00` — a backend returning zero usually means it had no price for that model, not that the work
was free.

Note: the charts above that section (heatmap, daily bars, per-model tokens) currently cover **Claude
sessions only** — the other backends' parsers do not yet emit per-day metrics. The per-backend cards do
include everyone.

### Profiles: Claude Code against another endpoint

A **profile** runs the Claude binary against a different API endpoint (DeepSeek, GLM, OpenRouter, or a
blank one you fill in). Create one from a template in **Settings → Backends → Add from template**. A
profile behaves like its own backend: it has an id, a badge, its own launch defaults (inherited from
Claude, overridable), and its sessions are attributed to it.

**Keys are never stored.** An env value must be a `$VAR` **reference** (e.g. `$DEEPSEEK_API_KEY`), which
is resolved from your environment at launch and never written to disk. Pasting a literal key is refused.
A profile that points at a third-party endpoint while still inheriting your Anthropic key is blocked
outright — that combination would send your key to someone else.

### Turning a backend off

Disabling a backend removes it from the launch menu, stops scanning its store, and stops it counting
toward the mixed-mode badges. It does **not** erase anything: its sessions stay visible and searchable.

---

## Guarantees

These hold across the whole system, not per backend:

1. **Claude is unchanged.** Same command line, same environment, same discovery. A Claude-only user sees
   the app they had.
2. **One backend per session, fixed at start.** A session's backend is recorded in the session cache and
   is authoritative; resume reapplies it.
3. **Secrets are `$VAR` references, resolved at spawn, never on disk** — in profiles and in custom
   launchers alike. An unresolved reference is dropped, not defaulted.
4. **Disable is not delete.**
5. **Backends cannot damage each other's data.** Refreshing, hiding or deleting a project only ever
   touches the rows of the backend whose files actually went away.
6. **Project grouping is central and backend-agnostic** — by working directory, for every backend.

---

## For developers: adding a backend

A backend is a folder under `backends/` exporting one descriptor object. Nothing else in the app needs to
change: the registry, the scanner, the watcher, the launch menu, the settings page, the Configure dialog,
the badge, search, stats and resume all pick it up from the descriptor.

### The descriptor

**Identity + presentation**

| Field | Meaning |
|---|---|
| `id`, `label`, `monogram`, `colour` | who it is, and how the badge renders |
| `status` | `'ready'` (built) or `'planned'` (a "Coming soon" dummy that can never launch or be scanned) |
| `axis` | `'B'` = its own binary and its own session store. Claude is the default (`axis: null`); a user profile is Axis-A — the Claude binary against another endpoint, so it declares no schema of its own. |
| `configFields` | this CLI's launch options. The Settings page and the Configure dialog are both **generated** from this; values are stored per backend and cascade global → project. |
| `supportsFork` | whether Fork is offered for its sessions. Say `false` rather than accept `forkFrom` and ignore it — that launches an unrelated empty session. |
| `startupHint` | printed into the tab at launch, for a CLI that takes a while to paint (Hermes needs ~12 s). |
| `caveat` | a standing gotcha shown on its settings page (Pi: a stored `pi /login` silently beats an injected key). |

**Launching**

- `buildLaunch({cwd, resume, sessionId, forkFrom, options}) -> {command, args, env, cwd, spawnMode}`
  builds the argv and declares how to spawn. `env` values are `$VAR` refs, resolved at spawn.
  `spawnMode: 'argv'` avoids shell quoting — but on Windows it is honoured **only** when the command
  resolves to a real `.exe`: `CreateProcess` cannot execute an npm `.cmd` shim, so a shim falls back to
  the shell automatically.
- `probe() -> {ok, reason}` — is the binary (and whatever it needs) actually there? The reason is shown
  in Settings and is what a refused launch says. Required: without it, an uninstalled backend fails with
  a raw shell error and no hint.

**Discovery — dual-mode**

- `discoverSessions() -> [handle]` where a handle is `{kind:'file', path}` **or** `{kind:'db', ref, sessionId, marker}`.
  Hermes keeps its history in SQLite, which is why this is not a file-only seam.
- `parseSession(handle) -> row` — the normalised row (id, cwd, title, timestamps, tokens, optionally
  cost). The **cwd comes from the transcript**, never from a directory name.
- `parseSessionIncremental(handle, opts, prev)` + `PARSER_SCHEMA_VERSION` — resume a parse from a byte
  offset with a tail fingerprint; the version invalidates any cached parse state when the parser changes.
- `watchTargets() -> [{kind:'dir', path, recursive}]` or `[{kind:'db', path}]` — store-level addresses.
  These are also how the app knows the store *exists*: an unreachable root must not be read as "the user
  deleted their sessions".

**Live sessions — all three hooks, or none**

Claude accepts `--session-id`, so we choose the id. **Codex, Hermes and Pi name their own sessions**, so
the id we launched under is not the id they record. A backend like that needs:

- `matchLiveSession({cwd, sinceMs, claimed})` — find the record a *newly spawned* session created, so we
  can adopt its id.
- `liveRefFor(sessionId)` — find the record of a **resumed** session. This is not optional: a resumed
  session's record predates the spawn, so `matchLiveSession` can never match it — and the stale claim
  would then adopt the *next new session's* record and collapse two tabs onto one identity.
- `liveState(ref, ctx) -> 'busy' | 'idle' | null` — the session's state. Return `null` for "no
  evidence"; never guess idle.

**Deriving busy/idle honestly.** Claude states its state in the terminal (OSC sequences). Codex states it
in its transcript (`task_started` / `task_complete`). Hermes and Pi state only *completion*, so their
busy state is inferred — and inference has two failure modes worth knowing:

- Read the transcript **tail** with a **growing window**. One message is one line, and a large answer can
  exceed a fixed window entirely, leaving no complete line in view — which reads as "no change" and
  freezes the session on its last edge.
- A turn can run for minutes **without writing anything**. `ctx.lastOutputMs` (when the PTY last
  produced output) exists for exactly this: it may keep a running turn out of idle, and may **never**
  declare one busy. Terminal *activity* is a bad state signal — a spinner frame is activity, so is an
  echoed keystroke — but it is a fine liveness signal.

### What you get for free

Session scanning and reconciliation, change gating, the SQLite cache and its columns (backend, file path,
change marker, cost, lineage), full-text indexing, project grouping (including real git worktrees), the
live watcher, identity adoption, spawn routing, the enable/availability gates, the launch-menu row, the
generated Configure dialog, the per-backend settings page with its cascade, the provider badge, the stats
cards and cost handling, resume routing, and backend-scoped deletes.

### Tests that will hold you to it

`test/backend-parity.test.js` asserts the properties every backend must share — an availability probe, an
honest `supportsFork`, all three identity hooks if it names its own sessions, a versioned incremental
parser. It exists because the same defect was found and fixed in one backend four separate times while
its siblings quietly kept it.
