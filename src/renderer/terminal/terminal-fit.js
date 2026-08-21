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

  // Does the visible screen run off the end of the buffer (#361)?
  //
  // xterm maps screen row `r` to buffer line `baseY + r`, so the last visible row is line
  // `baseY + rows - 1` and the buffer must hold at least `baseY + rows` lines. Growing a
  // terminal on Windows can break that: the row count rises while `baseY` stays where it
  // was, and the bottom rows then address lines that do not exist. What the user sees is
  // the screen sitting `baseY` rows low with a stale fragment of the previous frame above
  // it — the CLI's prompt box ends up over its own transcript.
  //
  // A non-zero `baseY` is NOT the defect and must not be treated as one: it is the ordinary
  // state of a buffer with anything scrolled off the top, on the alternate screen as much as
  // the normal one (measured: rows 59, baseY 4, length 63 — perfectly healthy). Only the
  // arithmetic decides. Reading `baseY > 0` as the fault repairs healthy terminals, which is
  // exactly what it did before this was measured properly.
  // `baseY > 0` is a REQUIRED part of the condition, not a shortcut for the common case. A buffer
  // that has not been filled yet legitimately holds fewer lines than the terminal has rows — xterm
  // skips the whole adjustment block in `Buffer.resize` while `lines.length` is 0, and
  // `fillViewportRows` only fills an empty one — so `baseY 0, length < rows` is what a terminal looks
  // like before its first paint, not a fault. Without this half, the repair fires during startup, on
  // a buffer that is merely young. Nothing has scrolled off the top yet, so the screen cannot have
  // been left behind by a scroll: that is what makes the case safe to skip rather than merely
  // convenient.
  function screenOutsideBuffer(rows, baseY, length) {
    if (!(rows > 0) || !(baseY > 0)) return false;
    return baseY + rows > length;
  }

  // Bring the screen back inside the buffer by resizing, and say whether it worked.
  //
  // Shrinking the row count and growing back restores the arithmetic; it is xterm's own bookkeeping
  // that does the work, which is why this goes through the public `resize` rather than writing
  // `ybase`. Traced through `Buffer.resize` for the alternate buffer, where the defect was measured:
  // the regrow overshoots the line cap and the trim that follows lowers `baseY` by what it removed.
  // The normal buffer reaches the same end state by a different route, so this claims the OUTCOME
  // for both and the mechanism only for the one it was traced on.
  //
  // A loop, not a single correction: one pass cannot shrink below one row, so a drift wider than the
  // screen needs several. The bound is a backstop against a terminal that never converges — better a
  // screen that is still wrong than a resize loop nobody can interrupt. Takes the terminal as an
  // argument so `node --test` can drive it without a DOM; the caller owns the re-entrancy guard.
  const REPAIR_PASSES = 8;
  function repairScreenPastBuffer(terminal) {
    for (let pass = 0; pass < REPAIR_PASSES; pass++) {
      const buffer = terminal.buffer && terminal.buffer.active;
      if (!buffer) return false;
      const rows = terminal.rows;
      if (!screenOutsideBuffer(rows, buffer.baseY, buffer.length)) return true;
      if (rows < 2) return false; // nothing to shrink into
      const over = buffer.baseY + rows - buffer.length;
      terminal.resize(terminal.cols, rows - Math.min(over, rows - 1));
      terminal.resize(terminal.cols, rows);
    }
    return false;
  }

  // Does a resize invalidate the selection that was made before it (#459)?
  //
  // A selection is a range of buffer CELLS, not of text. Change the column count and xterm re-wraps
  // the buffer, so the same cells afterwards hold different characters — a copy then returns lines
  // the user never selected. Measured with a CLI writing lines wider than the terminal: five copied
  // lines came back as four, one of them 191 characters with two rejoined halves and the padding of
  // the seam in the middle.
  //
  // Only a COLUMN change does that. Rows do not re-wrap anything, and neither does a repaint or a
  // pure devicePixelRatio change — and clearing on those would take the selection away on every
  // unrelated refit, which is most of them. So the column count is the whole condition.
  function resizeInvalidatesSelection(colsBefore, colsAfter) {
    if (!(colsBefore > 0) || !(colsAfter > 0)) return false; // unmeasured — nothing to compare
    return colsBefore !== colsAfter;
  }

  // Drop a selection that a re-wrap has just made meaningless, and say whether it dropped one.
  // Takes the terminal as an argument so `node --test` can drive it without a DOM, like
  // repairScreenPastBuffer above. Callers capture `terminal.cols` before their fit and pass it here
  // after. Clearing goes through the public `clearSelection`, so xterm fires `onSelectionChange` and
  // the selection action bar (#88) closes with it.
  function clearSelectionAfterReflow(terminal, colsBefore) {
    if (!terminal) return false;
    if (!resizeInvalidatesSelection(colsBefore, terminal.cols)) return false;
    if (typeof terminal.hasSelection !== 'function' || !terminal.hasSelection()) return false;
    if (typeof terminal.clearSelection !== 'function') return false;
    terminal.clearSelection();
    return true;
  }

  return {
    clampRowsToContentBox, bottomRowClipped, screenOutsideBuffer, repairScreenPastBuffer,
    resizeInvalidatesSelection, clearSelectionAfterReflow,
  };
});
