'use strict';
// Heuristic parent resolution for a Claude `/clear` — the one lineage case no backend records on disk
// (#223 / #193). A `/clear` mints a brand-new session id and writes NO back-link; the only on-disk marker
// is the `SessionStart:clear` attachment at the head of the child file. So "which session did this child
// come from" can only be inferred.
//
// THE SIGNAL is the mtime freeze. A `/clear` re-uses the same PTY, but the PTY now writes to the NEW file
// — so the parent's transcript STOPS at the instant the child's first bytes land. At detection time:
//   - the parent's file mtime is frozen just BEFORE the child's birth  → `childBirth - mtime` small positive
//   - an unrelated IDLE session's file mtime is much older             → large positive
//   - an unrelated ACTIVE session keeps writing PAST the child's birth → negative (mtime > childBirth)
// so the parent is the lone candidate whose last write sits in a tight window just before the birth. The
// negative case is what cleanly excludes a second session that happens to be working at the same moment.
//
// Confidence is deliberately conservative: #223 re-keys LIVE state (PTY, MCP, tab) and a wrong guess
// collapses two tabs onto one id — worse than doing nothing — so it acts ONLY on `high`. #193 is read-only
// provenance and may show `low` as a labelled guess. Genuine ambiguity is `none`: show/​do nothing.
//
// Pure and Electron-free: the caller (session-transitions.js) gathers the file stats and passes plain
// numbers, so this is unit-testable in `node --test`.

const DEFAULT_TIGHT_MS = 5000; // how long before the child's birth the parent's last write may sit
const SKEW_MS = 1000;          // tolerance for clock / filesystem-granularity skew around the birth

// candidates: [{ id, mtimeMs }] — the active sessions in the folder and their transcript's last-write time.
// childBirthMs: the /clear child file's creation time.
// Returns { parentId, confidence: 'high' | 'low' | 'none' }.
function resolveClearParent({ childBirthMs, candidates, tightMs = DEFAULT_TIGHT_MS } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return { parentId: null, confidence: 'none' };

  // The lone active session in the folder is the one that cleared — the safe single-session case that
  // already worked before this heuristic existed.
  if (candidates.length === 1) {
    const only = candidates[0];
    return { parentId: only && only.id ? only.id : null, confidence: only && only.id ? 'high' : 'none' };
  }

  if (!Number.isFinite(childBirthMs)) return { parentId: null, confidence: 'none' };

  // signed = childBirth - lastWrite: small positive means "wrote just before the child was born and then
  // stopped" (the handoff); negative means "still writing after the birth" (an unrelated live session).
  const scored = candidates
    .filter((c) => c && typeof c.id === 'string' && Number.isFinite(c.mtimeMs))
    .map((c) => ({ id: c.id, signed: childBirthMs - c.mtimeMs }))
    .filter((s) => s.signed >= -SKEW_MS && s.signed <= tightMs)
    .sort((a, b) => Math.abs(a.signed) - Math.abs(b.signed));

  if (scored.length === 0) return { parentId: null, confidence: 'none' };
  if (scored.length === 1) return { parentId: scored[0].id, confidence: 'high' };
  // More than one candidate froze in the window — genuinely ambiguous. Best guess for display only.
  return { parentId: scored[0].id, confidence: 'low' };
}

module.exports = { resolveClearParent, DEFAULT_TIGHT_MS, SKEW_MS };
