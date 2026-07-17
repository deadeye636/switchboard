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

## The `/clear` resolver (`src/session/session-lineage.js`) — conservative on purpose

A `/clear` records no back-link, so the parent must be inferred. `resolveClearParent({ candidates })` returns
`{ parentId, confidence: 'high' | 'none' }` and re-keys ONLY on `high`, which it gives ONLY when there is
**exactly one** live session in the folder — that one unambiguously cleared. With two or more, it bails.

**Why not a heuristic across multiple live sessions?** The first cut tried the **mtime freeze** — the PTY now
writes to the new file, so the parent's transcript "stops" at the clear, and the parent should be the lone
session frozen just before the child's birth. A field probe killed it: the parent stops when its last TURN
ends, and the user's think-time before typing `/clear` sits between that and the child's birth — the true
parent's freeze was OUTSIDE any tight window in ~95% of real `/clear` children. Worse, a **bystander** that
finished a turn a second before the clear IS inside the window, so the heuristic would re-key the bystander
onto another session's child — collapsing two tabs onto one id, the exact failure #223 says must never
happen. No folder-local signal (mtime, cwd, gitBranch) distinguishes the true parent from a just-idle
bystander. So the multi-session re-key is **not solved** here; it waits for a signal that ties a clear to a
specific PTY (a per-session `SessionStart` hook echo — the hook exists but does not name the parent, so the
correlation is future work).

- **#223 status/re-key:** reliably fixed for a **single** live session in the folder (the source's row folds
  onto the child, the tab follows). Multiple live sessions keep the deliberate bail — safe, unsolved.
- **#193 provenance:** on the single-session re-key, the child's link is persisted via `setSessionLineage`
  (kind `clear`) — the authoritative source, since the scanner cannot correlate a clear (the parent's file
  is unchanged and skipped). `COALESCE` keeps a hard link from being overwritten by a soft guess and lets
  the later full scan fill the rest. An ambiguous clear records nothing — a guess we would not act on is a
  guess we do not make.

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

- **The multi-session `/clear` re-key (#223's headline) is NOT solved.** With two or more live sessions in
  one folder, the source still keeps its row/tab until it exits — the same bail as before. No folder-local
  signal can safely attribute the clear; it needs a PTY→session tie (a per-session `SessionStart` hook echo
  that names the parent). The single-session case IS fixed, and the resolver refuses to guess so nothing is
  ever mis-keyed.
- Pi (`parentSession`), Codex/Claude **compaction** lineage are not wired — their on-disk signals were not
  verified against real transcripts. The mechanism (columns, resolver, rendering) is in place; a backend
  that records a parent only has to set `lineageParentId`/`lineageKind`, no core change.
- A very long `/clear` chain is not capped in the expander (all ancestors listed).
- An expanded lineage thread collapses on the next sidebar re-render (morphdom re-applies `display:none`);
  a live ancestor also still appears inside a descendant's expander (consistent with Model A's shared-ancestor
  stance). Both cosmetic.
