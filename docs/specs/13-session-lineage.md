# Spec 13 — Session lineage (provenance + /clear re-key)

> Read `docs/specs/README.md` first.

**Status:** Implemented (#223 + #193) · **Independent:** builds on the multi-LLM descriptor (Spec 09)

## Problem

Many sessions are not fresh starts — they continued another session's work — but the sidebar showed them as
unrelated rows, and one case broke worse than cosmetics:

- **#223 (bug):** a Claude `/clear` re-uses the PTY but mints a **new** session id and writes a fresh
  transcript. Switchboard re-keys the live session onto the new id — but it **bailed** whenever more than
  one Claude session was live in the same project folder (the normal case for parallel work). The source
  then kept its PTY and read as `running`, the `/clear` child was scanned as a second independent row, and
  the open tab stayed attached to the dead id.
- **#193 (feature):** provenance was invisible. A session that continued another's work should read as one.

Both need the same answer — *which session did this one come from* — so it is built once.

## The lineage source, per backend (no island)

A session's parent rides in `session_cache.lineageParentId` (+ `lineageKind`), separate from
`parentSessionId`, which is reserved for Claude **subagents** (reusing it would render a continuation as a
subagent). The core reads each backend's own field — no `if (backendId === …)`:

| Backend | Source | `lineageKind` |
|---|---|---|
| Hermes | `parent_session_id` (store column) → `parse.js` remap | `parent` (hard) |
| Claude fork | `forkedFrom` in the head, read by the scanner (`session-reader.js`) | `fork` (hard) |
| Claude `/clear` | the mtime-freeze heuristic, recorded at the live re-key | `clear` (soft) |
| Pi / Codex / compaction | not yet wired (signals unverified against real transcripts) | — |

`PARSER_SCHEMA_VERSION` (Claude) bumped 4→5 so existing rows re-derive fork lineage on the next scan.

## The `/clear` heuristic (`src/session/session-lineage.js`)

A `/clear` records no back-link, so the parent is inferred. The signal is the **mtime freeze**: the PTY now
writes to the NEW file, so the parent's transcript stops the instant the child is born. Among the folder's
live sessions the parent is the lone one whose last write sits in a tight window just **before** the child's
birth; an unrelated session is either idle (far older) or still writing past the birth (excluded).
`resolveClearParent` returns `{ parentId, confidence: high|low|none }`.

- **#223 re-key** (`session-transitions.js`) acts ONLY on `high` — a wrong guess collapses two tabs onto one
  id, worse than the bail — and otherwise keeps the deliberate bail. The re-key is also the authoritative
  source of the `/clear` lineage: the scanner cannot correlate it (the parent's file is unchanged and
  skipped), so the re-key persists the child's link via `setSessionLineage` (kind `clear`). `COALESCE` keeps
  a hard link from being overwritten by a soft guess and lets the later full scan fill the rest.
- **#193 display** shows `low`/soft as a labelled guess; genuine ambiguity shows nothing.

Tie-in with #219: the `SessionStart` hook (the strongest live signal) is off in dev builds, so the mtime
correlation is the floor that works everywhere; the hook is the confirmation that lifts certainty.

## Sidebar rendering — Model A (`src/renderer/shell/sidebar-lineage.js`)

Lineage is a **tree**: resuming an ancestor and clearing it again branches it. So each live/leaf session is
the face row and walks its OWN path UP the `lineageParentId` chain; **idle** ancestors fold under it (a
"▸ N earlier in thread" toggle), a **live** ancestor stays its own row. Nothing groups by root, so a shared
ancestor may legitimately appear under more than one head. A row that continued another's work carries a
"↳ continued from …" caption — plain for a hard link, marked as a guess for a soft `/clear`. Ancestor rows
open their read-only transcript. The toggle and ancestor clicks are delegated (#218 opt6).

## As built / tests

- `test/session-lineage.test.js` — the heuristic, with teeth (high only when unambiguous).
- `test/clear-rekey.test.js` — the real `detectSessionTransitions`: the frozen session re-keys, the parallel
  one is untouched, two-frozen stays ambiguous, the `/clear` link is recorded.
- `test/read-session-file.test.js` — the scanner records fork lineage.
- `test/sidebar-lineage-vm.test.js` — the chain walk, the idle-ancestor fold, the caption (hard/soft), the
  collapsed thread. Live-verified in the app (caption, fold, toggle, ancestor open; console silent).
- DB layer verified with `scripts` probe against a copied real DB and an empty one.

## Known gaps

- Pi (`parentSession`), Codex/Claude **compaction** lineage are not wired — their on-disk signals were not
  verified against real transcripts. The mechanism (columns, resolver, rendering) is in place; a backend
  that records a parent only has to set `lineageParentId`/`lineageKind`, no core change.
- A very long `/clear` chain is not capped in the expander (all ancestors listed).
