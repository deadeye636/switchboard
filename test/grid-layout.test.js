const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_GRID_ROWS,
  calculateGridColumnCount,
  normalizeSpan,
  applyLayout,
  reorder,
  cursorInsertionIndex,
  placeholderSlotIndex,
  pickGridNeighbor,
} = require('../src/renderer/views/grid-layout');

test('calculateGridColumnCount still derives sane column counts', () => {
  assert.equal(calculateGridColumnCount({ width: 1400, cardCount: 6 }), 2);
  assert.equal(calculateGridColumnCount({ width: 900, cardCount: 6 }), 1);
  assert.equal(calculateGridColumnCount({ width: 1920, cardCount: 6 }), 3);
  assert.equal(calculateGridColumnCount({ width: 1920, cardCount: 2 }), 2);
});

test('normalizeSpan clamps cols to [1, maxCols]', () => {
  assert.deepEqual(normalizeSpan({ cols: 3, rows: 1 }, 2), { cols: 2, rows: 1 });
  assert.deepEqual(normalizeSpan({ cols: 0, rows: 1 }, 4), { cols: 1, rows: 1 });
  assert.deepEqual(normalizeSpan({ cols: -5, rows: 1 }, 4), { cols: 1, rows: 1 });
  assert.deepEqual(normalizeSpan({ cols: 2, rows: 1 }, 4), { cols: 2, rows: 1 });
});

test('normalizeSpan clamps rows to [1, MAX_GRID_ROWS]', () => {
  assert.equal(normalizeSpan({ cols: 1, rows: MAX_GRID_ROWS + 5 }, 4).rows, MAX_GRID_ROWS);
  assert.equal(normalizeSpan({ cols: 1, rows: 0 }, 4).rows, 1);
});

test('normalizeSpan defaults missing/garbage values to 1', () => {
  assert.deepEqual(normalizeSpan(undefined, 4), { cols: 1, rows: 1 });
  assert.deepEqual(normalizeSpan({}, 4), { cols: 1, rows: 1 });
  assert.deepEqual(normalizeSpan({ cols: 'x', rows: null }, 4), { cols: 1, rows: 1 });
});

test('applyLayout returns 1x1 spans and input order when no layout stored', () => {
  const result = applyLayout(['a', 'b', 'c'], {}, 3);
  assert.deepEqual(result, [
    { sessionId: 'a', order: 0, colSpan: 1, rowSpan: 1 },
    { sessionId: 'b', order: 1, colSpan: 1, rowSpan: 1 },
    { sessionId: 'c', order: 2, colSpan: 1, rowSpan: 1 },
  ]);
});

test('applyLayout clamps persisted spans against fewer available columns', () => {
  const layout = {
    a: { order: 0, colSpan: 3, rowSpan: 2 },
    b: { order: 1, colSpan: 2, rowSpan: 1 },
  };
  const result = applyLayout(['a', 'b'], layout, 2);
  assert.equal(result[0].colSpan, 2); // clamped from 3 to maxCols=2
  assert.equal(result[0].rowSpan, 2);
  assert.equal(result[1].colSpan, 2);
});

test('applyLayout sorts by persisted order and preserves it', () => {
  const layout = {
    a: { order: 2 },
    b: { order: 0 },
    c: { order: 1 },
  };
  const result = applyLayout(['a', 'b', 'c'], layout, 3);
  assert.deepEqual(result.map(r => r.sessionId), ['b', 'c', 'a']);
  assert.deepEqual(result.map(r => r.order), [0, 1, 2]);
});

test('applyLayout falls back to input order for sessions without persisted order', () => {
  const layout = { c: { order: 5 } };
  const result = applyLayout(['a', 'b', 'c'], layout, 3);
  // a/b use their input index (0/1); c's persisted order (5) sorts it last.
  assert.deepEqual(result.map(r => r.sessionId), ['a', 'b', 'c']);

  // A small persisted order pulls a session ahead of unpinned ones.
  const layout2 = { c: { order: -1 } };
  const result2 = applyLayout(['a', 'b', 'c'], layout2, 3);
  assert.deepEqual(result2.map(r => r.sessionId), ['c', 'a', 'b']);
});

test('reorder moves an id before its target', () => {
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(reorder(['a', 'b', 'c'], 'a', 'c'), ['b', 'a', 'c']);
});

test('reorder is a no-op for unknown ids or identical ids', () => {
  assert.deepEqual(reorder(['a', 'b', 'c'], 'x', 'b'), ['a', 'b', 'c']);
  assert.deepEqual(reorder(['a', 'b', 'c'], 'a', 'z'), ['a', 'b', 'c']);
  assert.deepEqual(reorder(['a', 'b', 'c'], 'b', 'b'), ['a', 'b', 'c']);
});

test('reorder does not mutate the input array', () => {
  const input = ['a', 'b', 'c'];
  const out = reorder(input, 'c', 'a');
  assert.deepEqual(input, ['a', 'b', 'c']);
  assert.deepEqual(out, ['c', 'a', 'b']);
});

// A 2x2 grid of 100x100 cards at (0,0),(100,0),(0,100),(100,100).
const GRID_2X2 = [
  { left: 0, top: 0, width: 100, height: 100 },     // 0: top-left
  { left: 100, top: 0, width: 100, height: 100 },   // 1: top-right
  { left: 0, top: 100, width: 100, height: 100 },   // 2: bottom-left
  { left: 100, top: 100, width: 100, height: 100 }, // 3: bottom-right
];

test('cursorInsertionIndex counts siblings that sort before the cursor', () => {
  // Before the first card (upper-left corner) → slot 0.
  assert.equal(cursorInsertionIndex(GRID_2X2, -10, -10), 0);
  // Past the last card (lower-right) → slot 4 (append).
  assert.equal(cursorInsertionIndex(GRID_2X2, 300, 300), GRID_2X2.length);
  // Cursor over the second card's right half sits after cards 0 and 1 → slot 2.
  assert.equal(cursorInsertionIndex(GRID_2X2, 190, 50), 2);
});

test('cursorInsertionIndex compares to row band before card center', () => {
  // A lower row is always "before" every upper-row card (row-major).
  assert.equal(cursorInsertionIndex(GRID_2X2, 0, 150), 2);
  // Same row, left of a card's center → not counted as before it.
  assert.equal(cursorInsertionIndex(GRID_2X2, 10, 50), 0);
});

// Minimal DOM stub: a container whose children answer classList.contains.
function fakeCard(isCard = true) {
  return { classList: { contains: (c) => isCard && c === 'grid-card' } };
}

test('placeholderSlotIndex counts real cards before the placeholder', () => {
  const a = fakeCard(), b = fakeCard(), ph = {}, c = fakeCard();
  const container = { children: [a, b, ph, c] };
  assert.equal(placeholderSlotIndex(container, ph), 2);
});

test('placeholderSlotIndex skips the excluded (lifted) card and non-cards', () => {
  const lifted = fakeCard(), notCard = fakeCard(false), b = fakeCard(), ph = {};
  const container = { children: [lifted, notCard, b, ph] };
  // lifted is excluded, notCard is not a grid-card → only b counts.
  assert.equal(placeholderSlotIndex(container, ph, lifted), 1);
});

test('pickGridNeighbor picks the adjacent card in each direction', () => {
  // From the top-left card (index 0): right → 1, down → 2.
  assert.equal(pickGridNeighbor(GRID_2X2, 0, 'right'), 1);
  assert.equal(pickGridNeighbor(GRID_2X2, 0, 'down'), 2);
  // From the bottom-right card (index 3): left → 2, up → 1.
  assert.equal(pickGridNeighbor(GRID_2X2, 3, 'left'), 2);
  assert.equal(pickGridNeighbor(GRID_2X2, 3, 'up'), 1);
});

test('pickGridNeighbor returns -1 when nothing lies that way', () => {
  // Top-left has no card to its left or above it.
  assert.equal(pickGridNeighbor(GRID_2X2, 0, 'left'), -1);
  assert.equal(pickGridNeighbor(GRID_2X2, 0, 'up'), -1);
  assert.equal(pickGridNeighbor(GRID_2X2, 5, 'right'), -1); // out-of-range fromIndex
});

test('pickGridNeighbor weights the cross axis so the same row/column wins ties', () => {
  // Moving right from top-left: same-row card (1) beats the diagonal (3).
  assert.equal(pickGridNeighbor(GRID_2X2, 0, 'right'), 1);
  // Moving down from top-left: same-column card (2) beats the diagonal (3).
  assert.equal(pickGridNeighbor(GRID_2X2, 0, 'down'), 2);
});

test('pickGridNeighbor honours the dead zone on the primary axis', () => {
  // Two cards overlapping on x, one 5px lower — below the default 10px dead zone.
  const rects = [
    { left: 0, top: 0, width: 100, height: 100 },
    { left: 0, top: 5, width: 100, height: 100 },
  ];
  assert.equal(pickGridNeighbor(rects, 0, 'down'), -1);
  // A smaller dead zone lets the same candidate qualify.
  assert.equal(pickGridNeighbor(rects, 0, 'down', 1), 1);
});
