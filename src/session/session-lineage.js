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
// So: re-key ONLY when there is exactly one live session in the folder (it is unambiguously the one that
// cleared — the pre-existing safe case). With two or more, bail — the caller keeps both rows rather than
// guess. #223's multi-session re-key is therefore NOT solved here; it waits for a reliable PTY→session
// signal. See spec 13.
//
// Pure and Electron-free: the caller passes the folder's live candidates; this returns { parentId,
// confidence: 'high' | 'none' }. ('low' is intentionally never returned — a guess we would not act on is a
// guess we do not make.)

// candidates: [{ id }] — the active, non-terminal sessions in the folder.
// Returns { parentId, confidence }.
function resolveClearParent({ candidates } = {}) {
  if (!Array.isArray(candidates) || candidates.length !== 1) {
    return { parentId: null, confidence: 'none' };
  }
  const only = candidates[0];
  return only && only.id ? { parentId: only.id, confidence: 'high' } : { parentId: null, confidence: 'none' };
}

module.exports = { resolveClearParent };
