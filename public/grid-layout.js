(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MIN_GRID_CARD_WIDTH = 620;
  const GRID_GAP = 10;

  function calculateGridColumnCount({ width, cardCount, minCardWidth = MIN_GRID_CARD_WIDTH, gap = GRID_GAP } = {}) {
    const safeWidth = Number(width) || 0;
    const safeCardCount = Math.max(1, Number(cardCount) || 1);
    const safeMinWidth = Math.max(1, Number(minCardWidth) || MIN_GRID_CARD_WIDTH);
    const safeGap = Math.max(0, Number(gap) || 0);
    const fitCols = Math.max(1, Math.floor((safeWidth + safeGap) / (safeMinWidth + safeGap)));
    return Math.max(1, Math.min(fitCols, safeCardCount));
  }

  return {
    MIN_GRID_CARD_WIDTH,
    GRID_GAP,
    calculateGridColumnCount,
  };
});
