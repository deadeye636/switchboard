(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MIN_GRID_CARD_WIDTH = 620;
  const GRID_GAP = 10;
  // Snap-to-grid spans are deliberately bounded (spec 08): a card may span up to
  // the available column count and up to MAX_GRID_ROWS rows.
  const MAX_GRID_ROWS = 3;

  function calculateGridColumnCount({ width, cardCount, minCardWidth = MIN_GRID_CARD_WIDTH, gap = GRID_GAP } = {}) {
    const safeWidth = Number(width) || 0;
    const safeCardCount = Math.max(1, Number(cardCount) || 1);
    const safeMinWidth = Math.max(1, Number(minCardWidth) || MIN_GRID_CARD_WIDTH);
    const safeGap = Math.max(0, Number(gap) || 0);
    const fitCols = Math.max(1, Math.floor((safeWidth + safeGap) / (safeMinWidth + safeGap)));
    return Math.max(1, Math.min(fitCols, safeCardCount));
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(n, max));
  }

  // Clamp a requested {cols, rows} span to the legal range for the current grid:
  // cols in [1, maxCols], rows in [1, MAX_GRID_ROWS].
  function normalizeSpan({ cols, rows } = {}, maxCols = 1) {
    const maxColsSafe = Math.max(1, Math.floor(Number(maxCols) || 1));
    return {
      cols: clampInt(cols, 1, maxColsSafe, 1),
      rows: clampInt(rows, 1, MAX_GRID_ROWS, 1),
    };
  }

  // Resolve a persisted layout map against the current ordered session ids and
  // available column count. Returns entries sorted by persisted order (stable on
  // the input order for ties), with spans clamped to what currently fits and a
  // freshly sequential `order` for rendering.
  function applyLayout(orderedSessionIds, layoutMap = {}, maxCols = 1) {
    const ids = Array.isArray(orderedSessionIds) ? orderedSessionIds : [];
    const map = layoutMap && typeof layoutMap === 'object' ? layoutMap : {};
    const decorated = ids.map((sessionId, index) => {
      const entry = map[sessionId] || {};
      const order = Number.isFinite(entry.order) ? entry.order : index;
      const span = normalizeSpan({ cols: entry.colSpan, rows: entry.rowSpan }, maxCols);
      return { sessionId, order, index, colSpan: span.cols, rowSpan: span.rows };
    });
    decorated.sort((a, b) => (a.order - b.order) || (a.index - b.index));
    return decorated.map((item, position) => ({
      sessionId: item.sessionId,
      order: position,
      colSpan: item.colSpan,
      rowSpan: item.rowSpan,
    }));
  }

  // Move `fromId` to sit immediately before `toId` in the ordered list. Returns a
  // new array; no-ops (returns a copy of the input) when either id is unknown or
  // the two ids are identical.
  function reorder(orderedIds, fromId, toId) {
    const ids = Array.isArray(orderedIds) ? [...orderedIds] : [];
    if (fromId === toId) return ids;
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(toId);
    if (fromIdx === -1 || toIdx === -1) return ids;
    ids.splice(fromIdx, 1);
    const insertIdx = ids.indexOf(toId);
    ids.splice(insertIdx, 0, fromId);
    return ids;
  }

  // --- Pointer drag geometry ---
  // Pure geometry the drag-to-reorder gesture needs; the DOM half that drives it
  // lives in views/grid-gestures.js. Kept here so it is require()-able and tested.

  // Reading-order insertion index for the cursor among sibling layout rects: the
  // count of siblings that sort before the cursor (row-major). Result is in
  // [0, rects.length] and can address every slot — including the dragged card's
  // origin — so the user can always return to the start position.
  function cursorInsertionIndex(rects, x, y) {
    let idx = 0;
    for (const r of rects) {
      const cx = r.left + r.width / 2;
      let before;
      if (y > r.top + r.height) before = true;       // cursor in a lower row
      else if (y < r.top) before = false;            // cursor in an upper row
      else before = x > cx;                           // same row → compare to center
      if (before) idx++;
    }
    return idx;
  }

  // Index of the placeholder among the container's real sibling cards (excluding
  // the lifted dragged card) — used to seed/dedup the live insertion index.
  function placeholderSlotIndex(container, placeholder, exclude) {
    let idx = 0;
    for (const n of container.children) {
      if (n === placeholder) break;
      if (n.classList && n.classList.contains('grid-card') && n !== exclude) idx++;
    }
    return idx;
  }

  // --- Keyboard move mode ---
  // The arrow keys the mode acts on. Bare = reorder, Shift = resize.
  const MOVE_MODE_DIRECTIONS = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
  };

  // Does this keyboard event belong to move mode? Only bare (or Shift-only)
  // arrows / Escape / Enter qualify: a chord carrying primary or alt stays with
  // its normal shortcut, so session navigation still works inside the mode.
  function isMoveModeChord(e, isMac) {
    if (!e) return false;
    const primary = isMac ? e.metaKey : e.ctrlKey;
    const secondary = isMac ? e.ctrlKey : e.metaKey;
    if (primary || secondary || e.altKey) return false;
    if (MOVE_MODE_DIRECTIONS[e.key]) return true;
    return e.key === 'Escape' || e.key === 'Enter';
  }

  // Target slot when moving a card one step. Movement is linear over the
  // container's card order, not 2D: left/up step back, right/down step forward.
  // Returns null at the edges (caller announces "edge of grid" and stays put).
  function moveIndex(index, total, direction) {
    const i = Math.floor(Number(index));
    const n = Math.floor(Number(total));
    if (!Number.isFinite(i) || !Number.isFinite(n) || i < 0 || i >= n) return null;
    const back = direction === 'left' || direction === 'up';
    const next = back ? i - 1 : i + 1;
    if (next < 0 || next >= n) return null;
    return next;
  }

  // Span after growing/shrinking by one track in `direction`, clamped to what the
  // grid allows. right/down grow, left/up shrink.
  function resizeSpan({ cols, rows } = {}, direction, maxCols = 1) {
    const base = normalizeSpan({ cols, rows }, maxCols);
    const delta = (direction === 'right' || direction === 'down') ? 1 : -1;
    const horizontal = direction === 'left' || direction === 'right';
    return normalizeSpan(
      horizontal
        ? { cols: base.cols + delta, rows: base.rows }
        : { cols: base.cols, rows: base.rows + delta },
      maxCols,
    );
  }

  // --- 2D grid navigation ---
  // Half-cell dead zone on the primary axis: a candidate must clear the current
  // card by more than this (px) on the direction's axis to count as "that way",
  // so a card merely adjacent on the cross axis is not picked.
  const GRID_NAV_DEADZONE = 10;

  // Pick the nearest neighbour card in `direction` from a laid-out set of rects.
  // Movement is spatial, not index-based: `rects` are {left,top,width,height} in
  // screen space, `fromIndex` is the focused card. A candidate qualifies only if
  // its centre clears the focused centre by more than the dead zone on the
  // direction's axis; among those, the cross-axis distance is weighted 3× so the
  // same row (for left/right) or column (for up/down) wins ties. Returns the
  // winning index, or -1 when nothing lies that way.
  function pickGridNeighbor(rects, fromIndex, direction, deadzone = GRID_NAV_DEADZONE) {
    const cur = rects[fromIndex];
    if (!cur) return -1;
    const curCx = cur.left + cur.width / 2;
    const curCy = cur.top + cur.height / 2;
    const dz = Number.isFinite(deadzone) ? deadzone : GRID_NAV_DEADZONE;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < rects.length; i++) {
      if (i === fromIndex) continue;
      const r = rects[i];
      const dx = (r.left + r.width / 2) - curCx;
      const dy = (r.top + r.height / 2) - curCy;
      let valid = false;
      switch (direction) {
        case 'left':  valid = dx < -dz; break;
        case 'right': valid = dx > dz; break;
        case 'up':    valid = dy < -dz; break;
        case 'down':  valid = dy > dz; break;
      }
      if (!valid) continue;
      // left/right prefer the same row (small dy); up/down prefer the same column.
      const dist = (direction === 'left' || direction === 'right')
        ? Math.abs(dy) * 3 + Math.abs(dx)
        : Math.abs(dx) * 3 + Math.abs(dy);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  return {
    MIN_GRID_CARD_WIDTH,
    GRID_GAP,
    GRID_NAV_DEADZONE,
    MAX_GRID_ROWS,
    MOVE_MODE_DIRECTIONS,
    calculateGridColumnCount,
    normalizeSpan,
    applyLayout,
    reorder,
    cursorInsertionIndex,
    placeholderSlotIndex,
    pickGridNeighbor,
    isMoveModeChord,
    moveIndex,
    resizeSpan,
  };
});
