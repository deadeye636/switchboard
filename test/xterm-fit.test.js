const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clampRowsToContentBox, bottomRowClipped, screenOutsideBuffer, repairScreenPastBuffer,
  resizeInvalidatesSelection, clearSelectionAfterReflow,
} = require('../src/renderer/terminal/terminal-fit');

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

// --- screenOutsideBuffer (#361 repair predicate) ---
//
// The two cases that matter are both measured, from the same session minutes apart, and the pair is
// the whole point: they differ only in the arithmetic, not in whether baseY is zero.

test('screenOutsideBuffer: the measured BROKEN state — the screen runs past the buffer', () => {
  // rows 75, baseY 4, length 75: the last four rows address lines 75..78, which do not exist.
  assert.equal(screenOutsideBuffer(75, 4, 75), true);
});

test('screenOutsideBuffer: the measured HEALTHY state — a non-zero baseY is not a fault', () => {
  // rows 59, baseY 4, length 63: the screen is lines 4..62, all present. Reading baseY > 0 as the
  // defect flagged this and the repair wrecked a perfectly good terminal.
  assert.equal(screenOutsideBuffer(59, 4, 63), false);
});

test('screenOutsideBuffer: a buffer at the origin is never outside itself', () => {
  assert.equal(screenOutsideBuffer(24, 0, 24), false);
});

test('screenOutsideBuffer: ordinary scrollback on the normal buffer is fine', () => {
  assert.equal(screenOutsideBuffer(50, 1000, 1050), false);
});

test('screenOutsideBuffer: one row short still counts', () => {
  assert.equal(screenOutsideBuffer(50, 1000, 1049), true);
});

test('screenOutsideBuffer: a buffer longer than it needs to be is fine', () => {
  assert.equal(screenOutsideBuffer(10, 2, 100), false);
});

test('screenOutsideBuffer: a terminal with no rows yet never alarms', () => {
  assert.equal(screenOutsideBuffer(0, 4, 0), false);
});

// --- repairScreenPastBuffer (#361 repair loop) ---
//
// Driven against a stand-in terminal, so what is pinned here is the LOOP — convergence, the bound,
// and that a healthy buffer is left untouched — not xterm's resize behaviour. The stand-in models the
// one property the repair relies on and that was measured on the real thing: shrinking the row count
// by N lowers `baseY` by N, growing back does not give it back. Anything this file claims about xterm
// itself would be a claim about the model, so it claims none.
function fakeTerminal({ cols = 80, rows, baseY, length, type = 'alternate' }) {
  const t = {
    cols,
    rows,
    resizes: [],
    buffer: { active: { baseY, length, type } },
    resize(c, r) {
      this.resizes.push([c, r]);
      const b = this.buffer.active;
      const shrunkBy = this.rows - r;
      if (shrunkBy > 0) b.baseY = Math.max(0, b.baseY - shrunkBy);
      this.rows = r;
      this.cols = c;
    },
  };
  return t;
}

test('repairScreenPastBuffer: the measured broken state is brought back inside in one pass', () => {
  const t = fakeTerminal({ rows: 75, baseY: 4, length: 75 });
  assert.equal(repairScreenPastBuffer(t), true);
  assert.equal(t.rows, 75, 'it ends at the size it started from');
  assert.equal(t.buffer.active.baseY, 0);
  assert.equal(t.resizes.length, 2, 'one shrink and one regrow — no thrashing');
});

test('repairScreenPastBuffer: a healthy buffer is not touched at all', () => {
  // The state that a wrong predicate wrecked: alternate buffer, baseY 4, and every line present.
  const t = fakeTerminal({ rows: 59, baseY: 4, length: 63 });
  assert.equal(repairScreenPastBuffer(t), true);
  assert.deepEqual(t.resizes, [], 'no resize means no PTY round trip and no repaint');
});

test('repairScreenPastBuffer: an unfilled buffer at startup is not touched', () => {
  const t = fakeTerminal({ rows: 24, baseY: 0, length: 0, type: 'normal' });
  assert.equal(repairScreenPastBuffer(t), true);
  assert.deepEqual(t.resizes, []);
});

test('repairScreenPastBuffer: a drift wider than the screen takes several passes and still converges', () => {
  // baseY 30 on a 20-row screen: one pass cannot shrink below a single row, so it chips away.
  const t = fakeTerminal({ rows: 20, baseY: 30, length: 20 });
  assert.equal(repairScreenPastBuffer(t), true);
  assert.equal(t.rows, 20);
  assert.ok(t.resizes.length > 2, 'more than one pass was needed');
});

test('repairScreenPastBuffer: a terminal too short to shrink into is left alone', () => {
  const t = fakeTerminal({ rows: 1, baseY: 3, length: 1 });
  assert.equal(repairScreenPastBuffer(t), false);
  assert.deepEqual(t.resizes, [], 'better a wrong screen than a resize to zero rows');
});

test('repairScreenPastBuffer: a terminal that never converges gives up instead of looping', () => {
  const stuck = fakeTerminal({ rows: 40, baseY: 5, length: 40 });
  stuck.resize = function (c, r) { this.resizes.push([c, r]); this.rows = r; }; // baseY never moves
  assert.equal(repairScreenPastBuffer(stuck), false);
  assert.ok(stuck.resizes.length <= 16, `bounded, got ${stuck.resizes.length} resizes`);
});

test('repairScreenPastBuffer: a terminal with no buffer yet is not an error', () => {
  assert.equal(repairScreenPastBuffer({ cols: 80, rows: 24, buffer: null }), false);
});

// --- clearSelectionAfterReflow (#459 stale-selection guard) ---
//
// A selection points at buffer cells. A column change re-wraps the buffer, so those cells hold
// different text afterwards and a copy returns lines that were never selected. Row changes,
// repaints and pure devicePixelRatio changes do not re-wrap and must leave the selection alone.

function fakeSelectionTerminal({ cols = 80, selected = true } = {}) {
  return {
    cols,
    selected,
    clears: 0,
    hasSelection() { return this.selected; },
    clearSelection() { this.selected = false; this.clears++; },
  };
}

test('resizeInvalidatesSelection: a column change re-wraps and invalidates', () => {
  assert.equal(resizeInvalidatesSelection(95, 74), true);
  assert.equal(resizeInvalidatesSelection(74, 95), true);
});

test('resizeInvalidatesSelection: the same column count does not', () => {
  assert.equal(resizeInvalidatesSelection(95, 95), false);
});

test('resizeInvalidatesSelection: an unmeasured column count is not a change', () => {
  // A brand-new terminal has no cols yet; treating undefined as "changed" would clear on open.
  assert.equal(resizeInvalidatesSelection(undefined, 95), false);
  assert.equal(resizeInvalidatesSelection(95, undefined), false);
  assert.equal(resizeInvalidatesSelection(0, 95), false);
});

test('clearSelectionAfterReflow: a selection is dropped when the width changed', () => {
  const t = fakeSelectionTerminal({ cols: 74 });
  assert.equal(clearSelectionAfterReflow(t, 95), true);
  assert.equal(t.selected, false);
  assert.equal(t.clears, 1);
});

test('clearSelectionAfterReflow: a selection survives a row-only change', () => {
  // Same cols either side — the fit changed the height, which re-wraps nothing.
  const t = fakeSelectionTerminal({ cols: 95 });
  assert.equal(clearSelectionAfterReflow(t, 95), false);
  assert.equal(t.selected, true);
  assert.equal(t.clears, 0);
});

test('clearSelectionAfterReflow: nothing selected is not an error', () => {
  const t = fakeSelectionTerminal({ cols: 74, selected: false });
  assert.equal(clearSelectionAfterReflow(t, 95), false);
  assert.equal(t.clears, 0);
});

test('clearSelectionAfterReflow: a terminal without the selection API is left alone', () => {
  assert.equal(clearSelectionAfterReflow({ cols: 74 }, 95), false);
  assert.equal(clearSelectionAfterReflow(null, 95), false);
});
