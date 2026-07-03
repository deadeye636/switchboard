// Pure geometry helpers for xterm bottom-row-clip avoidance (#59).
// UMD-wrapped like grid-layout.js so `node --test` can require the pure math
// without a DOM, while the browser gets them as globals (loaded before
// terminal-manager.js, which calls them).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Clamp proposed rows to floor((clientHeight − verticalPadding) / cellHeight).
  // clientHeight is the padding-box height (excludes borders only), so subtracting
  // the vertical padding gives the true content-box height. Math.min ensures we only
  // ever shrink an overshoot, never add rows. Returns proposedRows unchanged when
  // cellHeight ≤ 0 (unmeasured state — no reliable metric yet).
  function clampRowsToContentBox(proposedRows, clientHeight, verticalPadding, cellHeight) {
    if (cellHeight <= 0) return proposedRows;
    const maxRows = Math.max(1, Math.floor((clientHeight - verticalPadding) / cellHeight));
    return Math.min(proposedRows, maxRows);
  }

  // Does the rendered grid overshoot its container's content box — i.e. is the
  // bottom row clipped by overflow:hidden? True only for a real overshoot beyond a
  // 1px slack (sub-pixel rounding). Returns false when unmeasured (cellHeight ≤ 0)
  // so a not-yet-painted terminal never raises a false alarm.
  function bottomRowClipped(rows, cellHeight, clientHeight, verticalPadding) {
    if (cellHeight <= 0 || rows <= 0) return false;
    const contentHeight = clientHeight - verticalPadding;
    return (rows * cellHeight) - contentHeight > 1;
  }

  return { clampRowsToContentBox, bottomRowClipped };
});
