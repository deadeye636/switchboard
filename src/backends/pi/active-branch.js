'use strict';
// backends/pi/active-branch.js — the walk that picks a Pi session's visible branch (#826 G1).
//
// A Pi transcript is a TREE: each entry names its `parentId`, and the last appended entry is the current leaf.
// The visible conversation is the chain from the leaf back to the root. The parser, the transcript view and the
// session-flow reader all need that chain; this is the one copy of the walk. Pure: no fs.

/**
 * The ids from the root to `leafId`, root first. `parentOf(id)` answers the entry's `parentId` (falsy at the root, or when
 * the parent is unknown). A cycle ends the walk instead of looping.
 */
function activeChain(parentOf, leafId) {
  const out = [];
  const seen = new Set();
  for (let cur = leafId; cur && !seen.has(cur); cur = parentOf(cur)) {
    seen.add(cur);
    out.push(cur);
  }
  return out.reverse();
}

module.exports = { activeChain };
