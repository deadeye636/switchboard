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
  the open tab stayed attached to the dead id. **Closed:** the CLI now names the terminal that cleared
  (below), so the multi-session case re-keys correctly.
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
`watch/adopt.js`. Which live session it re-keys is decided by the resolver below — a terminal claim first,
the single-live-session rule as fallback.

## The `/clear` resolver (`src/session/session-lineage.js`) — conservative on purpose

A `/clear` records no back-link in the transcript, so the parent has to come from somewhere else.
`resolveClearParent({ candidates, claim })` returns `{ parentId, confidence: 'high' | 'none' }` and re-keys
ONLY on `high`. Two ways to earn it, in this order:

1. **A terminal claim** (#223, the normal case) — the CLI itself reported which terminal cleared which
   session, through a per-spawn hook settings file. A fact, not an inference, so it wins even with several
   live sessions in the folder. See "Known gaps" below for how the signal is obtained and measured.
2. **Exactly one live session in the folder** — that one unambiguously cleared. The pre-#223 rule, still the
   fallback when no claim arrived (no loopback server, a backend that declines the hook, a claim that lost
   the race and has not landed yet).

With neither, it bails — and the file is re-checked once a claim shows up.

**Why not a heuristic across multiple live sessions?** The first cut tried the **mtime freeze** — the PTY now
writes to the new file, so the parent's transcript "stops" at the clear, and the parent should be the lone
session frozen just before the child's birth. A field probe killed it: the parent stops when its last TURN
ends, and the user's think-time before typing `/clear` sits between that and the child's birth — the true
parent's freeze was OUTSIDE any tight window in ~95% of real `/clear` children. Worse, a **bystander** that
finished a turn a second before the clear IS inside the window, so the heuristic would re-key the bystander
onto another session's child — collapsing two tabs onto one id, the exact failure #223 says must never
happen. No folder-local signal (mtime, cwd, gitBranch) distinguishes the true parent from a just-idle
bystander. That is why the multi-session case waited for a signal tying a clear to a specific PTY — which is
what the terminal claim above now is. The reasoning is kept because it is also the reason **not** to
re-attempt a folder-local heuristic if the claim is ever unavailable: bailing is correct, guessing is not.

- **#223 status/re-key:** solved for several live sessions in one folder via the terminal claim, with the
  single-live-session rule as the fallback. Two terminals clearing at the *same moment* still bail (#242).
- **#193 provenance:** on a re-key, the child's link is persisted via `setSessionLineage`
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

- **The multi-session `/clear` tie is CLOSED (#223) — the signal is a per-spawn hook settings file.** The
  gap above said the only way out was to make the hook carry the tie, and that is what shipped: every
  Claude launch gets `--settings <file>` written for that terminal (`backends/claude/live-binding.js`),
  registering one `SessionEnd` hook with matcher `clear` whose URL carries the terminal's tag. The CLI then
  reports "terminal `<tag>` ended session `<id>` by clearing", which `app/hooks.js` turns into a claim
  (`session/clear-claims.js`) and `resolveClearParent` consumes ahead of the single-session rule.

  Measured against the real CLI (v2.1.215), three PTY runs, because each detail decided the design:
  `--settings` does install hooks and survives repeated clears in one process; `SessionEnd` fires with
  `reason: "clear"` carrying the **old** id (reports that it does not fire on `/clear` are stale for this
  version); `SessionStart` did **not** fire from a `--settings` file in any run — not as `http`, not as
  `command`, matcher `clear` or empty — though it does from a project-level `settings.json`. So the CHILD
  id is not available this way, and the core pairs the claim with the new transcript instead. An empty
  matcher means "every reason".

  What that leaves ambiguous, on purpose: two terminals in ONE folder clearing inside the same window. The
  claim lookup returns nothing then and the old bail stands. Nothing is ever guessed.

  This does **not** depend on the attention hook being enabled — the file is ours, passed on argv, and
  never touches the user's `~/.claude/settings.json`, so it also works in a dev build. What #219 blocks is
  writing to that shared file; the loopback server itself now starts in dev too, because this ingest needs
  it.

  Still do NOT re-attempt a folder-local (mtime/cwd) heuristic — tried, mis-keyed, reverted — and do not
  reach for the keystroke stream either: the slash-menu path never puts `/clear` on the wire while a
  typed-then-aborted `/clear` in another terminal does, so "exactly one match" manufactures confidence.

  **Verified live, end to end**, in the installed app with **two Claude sessions in one project folder** —
  the case that used to bail:

  ```
  [clear-bind] terminal=<tag> cleared session=<old id>
  [detect] session=<old id> clear file=<new id> matched by terminal claim
  [session-transition] <old> → <new> (clear)
  ```

  The neighbouring session evaluated the same new transcript and did **not** re-key — one claim, one winner.
  In the sidebar the cleared session kept a single row that moved to the new id, the old one folded into the
  lineage history as `Idle` (no stale "running"), no orphan row appeared, and the MCP bridge reconnected.
  The claim arrived ~2 s before the file event, so the re-key landed on the first pass; when the race goes
  the other way the `ambiguous … will re-check` line is expected and the re-key follows late.

  One cosmetic follow-up this exposed: the re-keyed row takes its title from the child transcript's first
  line, which for a `/clear` is the command text itself.
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
