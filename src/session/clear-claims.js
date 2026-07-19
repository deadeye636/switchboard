// Which live terminal just reset its context — the claim registry behind #223.
//
// THE PROBLEM IT SOLVES. A Claude `/clear` mints a NEW session id and writes a NEW transcript while the
// PTY carries on. Switchboard has to move its live state (tab, MCP server, backend overlay) onto that new
// id. With one live session in a project folder that is unambiguous; with two it was not, and the
// detector bailed — leaving a stale "running" row, an orphan child row, and a tab bound to a dead id.
//
// WHAT WAS TRIED AND REJECTED, so nobody rebuilds it:
//   - mtime correlation ("the parent stops writing when the child is born"): measured wrong on a real
//     store in ~95% of cases — the user's think-time sits in that gap, and a bystander that just finished
//     a turn falls INSIDE the window. It would re-key the bystander. Reverted before this file existed.
//   - sniffing the keystrokes for "/clear": the slash-menu path never puts the word on the wire, while a
//     typed-then-aborted "/clear" in ANOTHER terminal does — so the "exactly one match" rule manufactures
//     confidence and mis-keys. It is also a keylogger holding whatever the user pastes.
//
// WHAT THIS DOES INSTEAD. The backend tells us, out of band, that a specific TERMINAL reset a specific
// session. Claude does it through a per-spawn hook settings file whose URL carries the terminal's tag
// (measured: `SessionEnd` fires with `reason: "clear"` and the OLD session id, and the file survives
// repeated clears). The claim is therefore a fact, not an inference: tag -> "this terminal cleared THAT
// session id, at that moment".
//
// The claim names the PARENT, not the child — the child id is not in that event. The detector pairs it
// with the new transcript appearing in the folder. That pairing is only ambiguous if two terminals in ONE
// folder clear within the same window, which is what `claimsFor` reports so the caller can still bail.
//
// Electron-free and state-only on purpose: the transport lives in app/hooks.js, the decision in
// session-transitions.js, and this can be tested without either.
'use strict';

// A claim is worth nothing once the child has been born and matched. Long enough for the transcript to
// appear and the watcher to fire (seconds at worst), short enough that a claim cannot pair with an
// unrelated clear minutes later.
const CLAIM_TTL_MS = 60_000;

// tag -> { tag, sessionId, folder, at }
const _claims = new Map();

/** The terminal `tag` reset `sessionId`. Called from the hook ingest; one claim per terminal at a time. */
function recordClearClaim({ tag, sessionId, folder, now = Date.now() }) {
  if (!tag || !sessionId) return null;
  const claim = { tag, sessionId, folder: folder || null, at: now };
  // A terminal only ever has ONE open claim: a second clear before the first was consumed means the first
  // is stale (its child was already re-keyed, or never appeared), and keeping it would let an old claim
  // win a later pairing.
  _claims.set(tag, claim);
  return claim;
}

function _prune(now) {
  for (const [tag, c] of _claims) if (now - c.at > CLAIM_TTL_MS) _claims.delete(tag);
}

/**
 * The open claims that could explain a child appearing now.
 *
 * `liveTags` is what the caller still owns — a claim from a terminal that has since exited explains
 * nothing and must not keep a row alive. Pass the tags of the sessions currently live in that folder.
 */
function claimsFor({ folder = null, liveTags = null, now = Date.now() } = {}) {
  _prune(now);
  const out = [];
  for (const c of _claims.values()) {
    if (folder && c.folder && c.folder !== folder) continue;
    if (liveTags && !liveTags.includes(c.tag)) continue;
    out.push(c);
  }
  return out;
}

/**
 * The single claim that explains a child, or null when the answer is not unambiguous.
 *
 * TWO claims in one folder inside the window is exactly the case this must NOT guess at: both terminals
 * cleared, both children are appearing, and picking one would put a terminal on another's transcript —
 * the failure the whole issue exists to prevent. The caller bails, as it does today.
 */
function resolveSingleClaim(opts = {}) {
  const candidates = claimsFor(opts);
  return candidates.length === 1 ? candidates[0] : null;
}

/** Consume a claim once it has been paired with a child. */
function releaseClaim(tag) {
  return _claims.delete(tag);
}

/** A terminal is gone: whatever it claimed can never be paired. */
function forgetTag(tag) {
  return _claims.delete(tag);
}

function _resetForTests() {
  _claims.clear();
}

module.exports = {
  CLAIM_TTL_MS,
  recordClearClaim,
  claimsFor,
  resolveSingleClaim,
  releaseClaim,
  forgetTag,
  _resetForTests,
};
