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

## The lineage source, per backend — one neutral seam, no island

A session's parent rides in `session_cache.lineageParentId` (+ `lineageKind`), separate from
`parentSessionId`, which is reserved for Claude **subagents** (reusing it would render a continuation as a
subagent). **The core never reads a backend's format and never branches on a backend id.** There is exactly
ONE place lineage is stamped — the scan sink (`src/index/index-writes.js applyIndexResults`) — and it does
it by calling `backends.get(row.backendId).resolveLineage(row)`. Each backend's descriptor DECLARES that
hook; a backend that records no parent link (or one that cannot be verified against its real format) returns
`null`, and that is an honest gap, not a special case. `test/backend-parity.test.js` requires every backend
to answer the hook.

Each backend's reader exposes only its OWN raw field; the descriptor turns it into the shared shape:

| Backend | Raw field (reader) | `resolveLineage` → | Note |
|---|---|---|---|
| Claude | `forkedFrom` (head) | `{ parent, 'fork' }` | hard. `/clear` records nothing on disk → handled live (below). |
| Hermes | `lineageParentRef` (`parent_session_id` column) | `{ parent, 'parent' }` | hard |
| Codex | — | `null` | `/clear` starts a new rollout with no back-ref; `compacted` is a state, not a parent |
| Pi | — | `null` | `--fork` exists but the session header records no parent (verified) |
| agy | — | `null` | a `parent_references` protobuf blob exists but is unverified |

`PARSER_SCHEMA_VERSION` (Claude) bumped 4→5 so existing rows re-derive fork lineage on the next scan. Adding
a backend to this feature is a descriptor edit (`resolveLineage`) plus its reader exposing a raw field — no
core change, which is the whole point.

**Claude `/clear` (soft) is the one live exception:** it records no on-disk link, so it is written at the
live re-key (`session-transitions.js`, `lineageKind: 'clear'`), not through the scan sink. That path is
Claude-specific by nature — it is Claude's live PTY-id transition; other backends adopt their own ids via
`watch/adopt.js`. It is single-session only (see the resolver note below).

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
the face row and walks its OWN path UP the `lineageParentId` chain; **idle** ancestors fold under it behind
a caret ("▶ N earlier", the same `.sidebar-children-caret` affordance the subagent nesting uses), a **live**
ancestor stays its own row. Nothing groups by root, so a shared ancestor may legitimately appear under more
than one head. Each ancestor renders as a **full session row** (`buildSessionItem`, with a `noLineageThread`
flag so the flat chain does not recurse) — it is a real session, so every normal action (open, transcript,
timeline, tags, fork, archive) works through the delegated sidebar events (#218 opt6), no special case. The
hard-vs-soft distinction lives only in the data (`lineageKind`) for now — no visual marker (a dimmed/italic
row for a `clear` guess is a deliberate, cheap follow-up if it is ever wanted).

## As built / tests

- `test/session-lineage.test.js` — the heuristic, with teeth (high only when unambiguous).
- `test/clear-rekey.test.js` — the real `detectSessionTransitions`: the frozen session re-keys, the parallel
  one is untouched, two-frozen stays ambiguous, the `/clear` link is recorded.
- `test/read-session-file.test.js` — the scanner records fork lineage.
- `test/sidebar-lineage-vm.test.js` — the chain walk, the idle-ancestor fold, the collapsed thread with
  full-session-row ancestors. Live-verified in the app (fold, caret toggle, ancestor is a full row with its
  actions, no recursion; console silent).
- DB layer verified with `scripts` probe against a copied real DB and an empty one.

## Known gaps

- **The multi-session `/clear` re-key (#223's headline) is BLOCKED, not deferred — Claude exposes no signal
  that ties a `/clear` to a specific PTY.** A recon against 54 real `/clear` children on a live install
  confirmed it: the child transcript's `parentUuid` is internal message threading (it resolves to a line in
  the child file itself, never the parent session); the `SessionStart:clear` hook POST carries only the
  CHILD `session_id` + `transcript_path` + `cwd` + `source`, no parent and no PTY id; the OSC title is a
  busy/status string, not the session id; the spawn knows `--session-id X` but nothing maps a new child `Y`
  back to the PTY that was on `X`. So with two or more live sessions in a folder the source keeps its
  row/tab until it exits (the safe bail), and the resolver refuses to guess so nothing is ever mis-keyed.
  The **only** way to close it is to make the hook itself carry the tie: spawn each Claude with a
  per-session hook URL (via `--settings`) whose query names the spawn id, so the `SessionStart:clear` POST
  identifies the parent PTY. That is a real feature contingent on Claude's per-session hook support, and it
  works only where the attention hook is enabled (never in a dev build, #219). Until then, single-session
  is the fixed case — do NOT re-attempt a folder-local (mtime/cwd) heuristic; it was tried, it mis-keyed,
  and it was reverted.
- **Codex / Pi / agy declare `null`** from `resolveLineage` — on purpose, not by omission: Codex records no
  parent on a `/clear` and `compacted` is a state not a reference; Pi's session header carries no parent
  though `--fork` exists; agy's `parent_references` is an unverified protobuf blob. Each is wired to the
  neutral seam and answers the hook; wiring a real link later is a descriptor + reader edit, no core change.
  Same-session **compaction** (Claude `logicalParentUuid`, Codex `compacted`) is deliberately out of scope —
  it is not a cross-session parent, so it is not a lineage row.
- A very long `/clear` chain is not capped in the expander (all ancestors listed).
- An expanded lineage thread collapses on the next sidebar re-render (morphdom re-applies `display:none`);
  a live ancestor also still appears inside a descendant's expander (consistent with Model A's shared-ancestor
  stance). Both cosmetic.
