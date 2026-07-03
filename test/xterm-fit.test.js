const test = require('node:test');
const assert = require('node:assert/strict');

const { clampRowsToContentBox, bottomRowClipped } = require('../public/terminal-fit');

// --- clampRowsToContentBox (regression guard for the original clip fix) ---

test('clampRowsToContentBox shrinks a row overshoot to the content box', () => {
  // content box fits 10 rows (200px / 20px); a proposed 11 must clamp to 10.
  assert.equal(clampRowsToContentBox(11, 200, 0, 20), 10);
});

test('clampRowsToContentBox leaves a fitting row count unchanged', () => {
  assert.equal(clampRowsToContentBox(8, 200, 0, 20), 8);
});

test('clampRowsToContentBox subtracts vertical padding before dividing', () => {
  // clientHeight 216 minus 16px padding = 200px content → 10 rows.
  assert.equal(clampRowsToContentBox(11, 216, 16, 20), 10);
});

test('clampRowsToContentBox is a no-op when cell height is unmeasured (0)', () => {
  assert.equal(clampRowsToContentBox(11, 200, 0, 0), 11);
});

test('clampRowsToContentBox never returns below 1 row', () => {
  assert.equal(clampRowsToContentBox(5, 10, 0, 20), 1);
});

// --- bottomRowClipped (#59 self-heal predicate) ---

test('bottomRowClipped: content box holds exactly N rows → not clipped', () => {
  assert.equal(bottomRowClipped(10, 20, 200, 0), false);
});

test('bottomRowClipped: rendered grid overshoots the content box → clipped', () => {
  // 10 rows * 20px = 200px rendered, but the content box is only 192px (9.6 rows).
  assert.equal(bottomRowClipped(10, 20, 192, 0), true);
});

test('bottomRowClipped: overshoot within 1px slack is tolerated', () => {
  // 200px rendered vs 199px content → 1px overshoot, not > 1 → false.
  assert.equal(bottomRowClipped(10, 20, 199, 0), false);
});

test('bottomRowClipped: unmeasured cell height (0) never alarms', () => {
  assert.equal(bottomRowClipped(10, 0, 100, 0), false);
});

test('bottomRowClipped: zero rows never alarms', () => {
  assert.equal(bottomRowClipped(0, 20, 200, 0), false);
});

test('bottomRowClipped: accounts for vertical padding', () => {
  // 10 rows * 20px = 200px rendered; clientHeight 210 − 16px padding = 194px box → clipped.
  assert.equal(bottomRowClipped(10, 20, 210, 16), true);
});
