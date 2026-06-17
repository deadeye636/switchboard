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

  return {
    MIN_GRID_CARD_WIDTH,
    GRID_GAP,
    MAX_GRID_ROWS,
    calculateGridColumnCount,
    normalizeSpan,
    applyLayout,
    reorder,
  };
});
