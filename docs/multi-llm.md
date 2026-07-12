# Multi-LLM backends

Switchboard was a Claude Code cockpit. It now runs **several coding CLIs** side by side — Claude Code,
Codex, Hermes and Pi — in one sidebar, one search index, one set of stats, with one launch menu.

Claude remains the default and behaves exactly as before. Everything else is off until you turn it on.

---

## Turning a backend on

**Settings → Backends.** Every built-in backend has a row: a toggle to enable it, and a **gear** that
opens its own page with that backend's launch defaults. A backend whose binary is not installed says so
(**not installed**, with the reason — what to install, or which version is too old); it can still be
enabled, but a launch is refused with that same sentence instead of dumping a raw shell error into a
terminal tab.

Only an **enabled** backend appears in the launch menu, and only an enabled backend's session store is
read. A backend that is not built yet shows as *Coming soon* and can never be enabled.

## Starting a session

The **+** button on a project opens the launch menu: one row per enabled backend. Clicking the row
launches with your saved defaults; the **gear** on the row opens a Configure dialog for a one-off
override. That dialog is generated from the backend's own options — Claude's permission mode means
nothing to Codex, so Codex is never shown it.

**Resume** keeps the backend the session was started with. There is no chooser: a Codex session resumes
into Codex, a Claude session into Claude. **Fork** appears only on backends that can actually fork
(Claude and Pi today) — a backend that cannot fork does not offer a button that would silently start an
unrelated empty session instead.

## Reading a mixed sidebar

When more than one backend is in play, each session row carries a small **provider badge** (`C`, `Cx`,
`H`, `Pi`). If you only use Claude, no badges appear at all — the app looks exactly as it did.

Sessions from every backend are grouped into the **same project** when they share a working directory,
and all of them are in the same full-text search. Hermes sessions that genuinely have no working
directory (its gateway/cron chats) collect in a backend-scoped bucket rather than being forced under a
project.

## Cost

Some backends price their own turns. Where they do, **Stats → By backend** shows it:

- `~$1.23` in amber — an **estimate** the backend computed from its own price table (Hermes, Pi).
- `$1.23` in green — an amount the backend states it actually settled.
- `—` — a token-only backend (Claude, Codex): it reports no cost, and we do not invent one.

An estimate is never displayed as a bill, and a *zero* estimate is shown as "no cost reported" rather
than `$0.00` — a backend returning zero usually means it had no price for that model, not that the work
was free.

The charts above that section (heatmap, daily bars, per-model tokens) cover **every** backend. One
caveat, because it is an honest approximation rather than a measurement: Hermes records no tokens per
message — only per session — so its message counts are per day while its token totals land on the day
the session was last active.

## Profiles: Claude Code against another endpoint

A **profile** runs the Claude binary against a different API endpoint (DeepSeek, GLM, OpenRouter, or a
blank one you fill in). Create one from a template in **Settings → Backends → Add from template**. A
profile behaves like its own backend: it has an id, a badge, its own launch defaults (inherited from
Claude, overridable), and its sessions are attributed to it.

**Keys are never stored.** An env value must be a `$VAR` **reference** (e.g. `$DEEPSEEK_API_KEY`), which
is resolved from your environment at launch and never written to disk. Pasting a literal key is refused.
A profile that points at a third-party endpoint while still inheriting your Anthropic key is blocked
outright — that combination would send your key to someone else.

## Handoffs across backends

A **handoff** is a packet that summarises the actual state of the work — written by an agent, reviewed by
you, then either used to seed a fresh lean session or stored in the project's handoff library.

**You choose who writes it**, because that is a real trade-off and not something the app should guess:

- **This session's agent.** It summarises what it is already holding, so the content is as good as it
  gets. If the session is not running it is **resumed for a single turn** and closed again — which costs
  tokens, so it is confirmed first, in those words.
- **A new session.** A fresh agent **reads this session's transcript** and writes the packet itself.
  Nothing is resumed and the old session costs nothing; the new one does the reading.

Both routes work on every backend. A backend declares how its transcript can be reached
(`transcriptAccess`): most have a file, and Hermes — whose history lives in SQLite — has it **exported**
for the reader. Any future database-backed backend declares the same and works the same.

There is also a **starter prompt** you can copy to the clipboard. It is *not* a handoff: it holds no
summary, only instructions telling a fresh session to work the state out for itself. It is named for what
it is, and it never enters the library.

**Resuming a saved handoff asks which backend should run it** — and that is not an inconsistency with
"resume keeps its backend". Resuming a *session* continues it, so it must stay on its own binary.
Resuming a *handoff* starts a **new** session seeded with context, so it is free to run anywhere; the
picker defaults to the backend that produced it. If that backend is no longer available, the row says so
instead of quietly running the packet somewhere else.

**The prompts.** There are two, because there are two routes: a *summarise* prompt (asked of this
session's agent) and a *read* prompt (given to the new one, with `{transcript}` pointing at what it should
open). Both have a built-in default, both can be changed globally in *Sessions & CLI → Handoff*, and both
can be overridden per backend on that backend's page — so a CLI with its own skill or wording gets exactly
what you write for it. A slash command is that CLI's own; point a backend at a command it has.

If the agent answers nothing at all, you are asked before its **previous** message is offered to you as
the packet — a handoff that silently describes the wrong state is worse than no handoff.

## Turning a backend off

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

## Adding a backend, or changing a parser

The contract, the design decisions and the traps live in the spec:
**[`specs/09-multi-llm.md`](specs/09-multi-llm.md)**.

What each backend actually writes on disk (taken from real installs — the published docs were wrong in
three places): **[`backend-formats.md`](backend-formats.md)**.
