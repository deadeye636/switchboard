---
paths:
  - "docs/**"
  - "README.md"
---

# Where a document goes

| Kind | Home |
|---|---|
| **Design record** for a feature ("why is it like this", decisions, as-built + known gaps) | `docs/specs/NN-<feature>.md` + a row in `docs/specs/README.md` |
| **User-facing guide** ("how do I use it") | `docs/<feature>.md`, linked from the README's "What this fork adds" |
| **Reference** (formats, build gotchas, colors) | `docs/<topic>.md` (e.g. `backend-formats.md`, `build-windows.md`, `settings-reference.md`) |
| **Agent-facing procedure** (release, porting, running, driving) | `docs/ai/<topic>.md` + a row in the CLAUDE.md router |
| **Fork feature list** | `README.md` "What this fork adds" **and** `docs/fork-features.md` (Wave 4) — a new fork feature goes in **both** |
| **Backlog** | GitHub Issues. `docs/BACKLOG.md` / `.jsonl` are **generated** (`node scripts/build-backlog.js`) — never hand-edit |
| **Planning scaffolding** (task lists, state trackers, agent prompts, mockups) | **stays local / gitignored** — once the work lands, its lasting parts belong in a spec; the rest is noise, and stale plan text next to a correct spec is worse than no plan text |

## A setting changed → `docs/settings-reference.md`

A setting added, renamed, re-scoped or given a different default. That page lists every key with its
**real code default**, which scope it lives in, and what a backend's `configFields` default means. A
change that leaves it stale is worse than no page: the whole point is that it beats reading the
settings screen, which shows what the UI falls back to rather than what applies.

Same for a new `SWITCHBOARD_*` env var or a new script — they are on that page too. When a documented
conflict is decided (#237, #239), the entry **moves** from "known conflict" to the table with the
decision, rather than being deleted.

## New fork feature → document it

A feature unique to this fork (not inherited from upstream) goes in the **README "What this fork
adds"** list **and** in `docs/fork-features.md`. Terse, matched to the existing style.

## Language & privacy

- All docs, code comments and user-facing UI text are **English**. Commit messages too.
- **No personal or local identifiers.** Never write absolute paths, local machine references
  (`C:\Users\<name>`, drive letters, home dirs), or personal names/emails into issues, commit
  messages, code, or docs — use generic placeholders (`~`, `<project>`, `<user>`). This repo is
  public: issues, issue **edit history**, and git history are all world-readable.
