'use strict';
// Parent resolution for a Claude `/clear` — the one lineage case no backend records on disk (#223 / #193).
// A `/clear` mints a new session id and writes NO back-link; the only on-disk marker is the
// `SessionStart:clear` attachment at the head of the child file. So the parent must be inferred.
//
// WHY THIS IS DELIBERATELY CONSERVATIVE — a mis-key is worse than doing nothing:
//
// The first cut tried the "mtime freeze": a `/clear` re-uses the PTY but writes to the NEW file, so the
// parent's transcript "stops" at the clear, and among the folder's live sessions the parent should be the
// one frozen just before the child's birth. Field data killed this: the parent stops when its last TURN
// ends, and the user's think-time before typing `/clear` sits between that and the child's birth — across
// real installs the true parent's freeze was OUTSIDE any tight window in ~95% of clears. Worse, a BYSTANDER
// session that happened to finish a turn a second before the clear IS in the window, so the window would
// re-key the bystander onto another session's child — collapsing two tabs onto one id, the exact failure
// #223 says must never happen. No folder-local signal (mtime, cwd, gitBranch) can tell the true parent from
// a just-idle bystander; only a signal that ties the clear to a specific PTY (a per-session SessionStart
// hook echo) could, and we do not have one.
//
// THE SIGNAL THAT WAS MISSING NOW EXISTS (#223). A backend that can re-identify a live session tells us
// out of band which TERMINAL cleared which session: Claude does it through a per-spawn hook settings file
// (`--settings`) whose URL carries the terminal's tag, and `SessionEnd` fires with `reason: "clear"` and
// the OLD session id. That is a fact reported by the CLI, not an inference from the file system — so when
// a claim names one of the folder's live sessions, the parent is KNOWN and the number of live sessions no
// longer matters.
//
// The order below is therefore: a claim wins; without one, the pre-existing single-live-session rule; with
// neither, bail. Two claims in one folder inside the window is the one case that is still ambiguous (both
// terminals cleared at once) — the caller's claim lookup returns nothing then, and we fall through to the
// count rule, which also declines. Nothing is ever guessed.
//
// Pure and Electron-free: the caller passes the folder's live candidates and (if any) the claim; this
// returns { parentId, confidence: 'high' | 'none' }. ('low' is intentionally never returned — a guess we
// would not act on is a guess we do not make.)

// candidates: [{ id, tag }] — the active, non-terminal sessions in the folder.
// claim: { tag, sessionId } | null — a backend-reported "this terminal cleared that session".
// Returns { parentId, confidence, via }.
function resolveClearParent({ candidates, claim } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];

  // 1. A reported claim. Matched against the LIVE candidates by terminal tag, so a claim from a terminal
  //    that has since exited (or belongs to another folder) cannot resurrect a dead row. The claim's own
  //    sessionId is the parent Switchboard should re-key — it is what the CLI said it ended.
  if (claim && claim.tag && claim.sessionId) {
    const owner = list.find(c => c && c.tag && c.tag === claim.tag);
    if (owner) return { parentId: claim.sessionId, confidence: 'high', via: 'claim' };
  }

  // 2. The pre-existing safe case: exactly one live session in the folder is unambiguously the one that
  //    cleared, claim or no claim.
  if (list.length !== 1) return { parentId: null, confidence: 'none', via: null };
  const only = list[0];
  return only && only.id
    ? { parentId: only.id, confidence: 'high', via: 'single-session' }
    : { parentId: null, confidence: 'none', via: null };
}

module.exports = { resolveClearParent };
