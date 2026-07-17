// --- Snap layouts: the preset-size popover on a grid card's header (#218) ---
//
// Windows 11-style snap layouts. The card header's snap button opens a popover of preset size tiles,
// each a miniature of the resulting span; clicking one snaps the card. Came out of grid-view.js, which
// held it alongside everything else the grid does.
//
// It is a WIDGET, and the split is what makes that visible: four entry points
// (`toggleSnapLayoutPopover`, `scheduleSnapHoverOpen`, `scheduleSnapHoverClose`,
// `closeSnapLayoutPopover`), four private state variables that nothing outside this file has ever read,
// and two calls back into the grid — `getContainerColumnCount` (how many columns fit) and
// `applyCardSnap` (do it). That surface was always this small; it just could not be seen.
//
// A classic <script>, like the file it came from: its top-level declarations live in the shared global
// lexical scope, not on `window`. It must load BEFORE grid-view.js — not because of the declarations
// (functions resolve at call time, and every call here happens on a click) but because that is the order
// test/fixtures/script-order.json records, and the order is the only place this dependency is written
// down. There is no import graph to check it.
//
// The two-timer hover state machine is the reason this is worth its own file: open-intent and
// close-grace are the sort of thing that reads as noise inside a 1600-line file and as a design here.

let snapPopoverEl = null;
// True when the open popover was opened by hover (auto-closes on pointer-out);
// click-opened popovers keep their click-away / Esc semantics instead.
let snapPopoverHoverOpened = false;
let snapHoverOpenTimer = null;
let snapHoverCloseTimer = null;
// Intent delay before a hover opens the popover; small grace before it closes so
// the pointer can travel from the button into the popover without it vanishing.
const SNAP_HOVER_OPEN_DELAY = 300;
const SNAP_HOVER_CLOSE_DELAY = 180;

// Hover-open only makes sense for fine/hover-capable pointers — never on touch.
function snapHoverEnabled() {
  return typeof window.matchMedia === 'function' &&
    (window.matchMedia('(hover: hover)').matches || window.matchMedia('(pointer: fine)').matches);
}

function clearSnapHoverTimers() {
  if (snapHoverOpenTimer) { clearTimeout(snapHoverOpenTimer); snapHoverOpenTimer = null; }
  if (snapHoverCloseTimer) { clearTimeout(snapHoverCloseTimer); snapHoverCloseTimer = null; }
}

function closeSnapLayoutPopover() {
  clearSnapHoverTimers();
  snapPopoverHoverOpened = false;
  if (snapPopoverEl) {
    snapPopoverEl.remove();
    snapPopoverEl = null;
    document.removeEventListener('pointerdown', onSnapPopoverOutside, true);
    document.removeEventListener('keydown', onSnapPopoverKey, true);
  }
}
function onSnapPopoverOutside(e) {
  if (snapPopoverEl && !snapPopoverEl.contains(e.target) && !e.target.closest('.grid-card-snap-btn')) {
    closeSnapLayoutPopover();
  }
}
function onSnapPopoverKey(e) {
  if (e.key === 'Escape') closeSnapLayoutPopover();
}

// Schedule a hover-open after the intent delay. Cancels any pending close (the
// pointer re-entered the hover region) and no-ops if this card's popover already
// shows. Opening replaces any other card's popover.
function scheduleSnapHoverOpen(sessionId, card, anchor) {
  if (!snapHoverEnabled()) return;
  if (snapHoverCloseTimer) { clearTimeout(snapHoverCloseTimer); snapHoverCloseTimer = null; }
  if (snapPopoverEl && snapPopoverEl.dataset.sessionId === sessionId) return;
  if (snapHoverOpenTimer) clearTimeout(snapHoverOpenTimer);
  snapHoverOpenTimer = setTimeout(() => {
    snapHoverOpenTimer = null;
    openSnapLayoutPopover(sessionId, card, anchor, { hover: true });
  }, SNAP_HOVER_OPEN_DELAY);
}

// Schedule a hover-close after the grace delay. Cancels a pending open, and only
// closes popovers that were opened by hover (click-opened ones persist).
function scheduleSnapHoverClose() {
  if (snapHoverOpenTimer) { clearTimeout(snapHoverOpenTimer); snapHoverOpenTimer = null; }
  if (!snapPopoverHoverOpened) return;
  if (snapHoverCloseTimer) clearTimeout(snapHoverCloseTimer);
  snapHoverCloseTimer = setTimeout(() => {
    snapHoverCloseTimer = null;
    closeSnapLayoutPopover();
  }, SNAP_HOVER_CLOSE_DELAY);
}

// Click-toggle entry point: close if this card's popover is already open,
// otherwise open it (click-opened popovers persist until click-away / Esc /
// selecting a preset).
function toggleSnapLayoutPopover(sessionId, card, anchor) {
  clearSnapHoverTimers();
  if (snapPopoverEl && snapPopoverEl.dataset.sessionId === sessionId) {
    closeSnapLayoutPopover();
    return;
  }
  openSnapLayoutPopover(sessionId, card, anchor, { hover: false });
}

// Windows 11-style snap layouts: a popover of preset size tiles. Each tile is a
// miniature of the resulting span; clicking snaps the card to that size. Opening
// always replaces any other open popover. When `hover` is true the popover
// auto-closes shortly after the pointer leaves the button+popover hover region.
//
// `getContainerColumnCount` and `applyCardSnap` are grid-view.js's — the popover asks the grid what fits
// and tells it what was chosen, and knows nothing else about it.
function openSnapLayoutPopover(sessionId, card, anchor, { hover = false } = {}) {
  closeSnapLayoutPopover();

  const maxCols = Math.max(1, getContainerColumnCount(card.parentElement));
  // Presets clamped to what currently fits: single, wide, tall, large, full-width.
  const presets = [
    { cols: 1, rows: 1, label: 'Single' },
    { cols: 2, rows: 1, label: 'Wide' },
    { cols: 1, rows: 2, label: 'Tall' },
    { cols: 2, rows: 2, label: 'Large' },
    { cols: maxCols, rows: 1, label: 'Full width' },
  ];
  const seen = new Set();
  const usable = presets
    .map(p => ({ ...p, cols: Math.min(p.cols, maxCols) }))
    .filter(p => {
      const key = `${p.cols}x${p.rows}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const pop = document.createElement('div');
  pop.className = 'snap-layout-popover';
  pop.dataset.sessionId = sessionId;
  const curCols = Number(card.dataset.colSpan) || 1;
  const curRows = Number(card.dataset.rowSpan) || 1;

  for (const preset of usable) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'snap-tile';
    if (preset.cols === curCols && preset.rows === curRows) tile.classList.add('active');
    tile.title = `${preset.label} (${preset.cols}×${preset.rows})`;
    const mini = document.createElement('span');
    mini.className = 'snap-tile-mini';
    mini.style.gridTemplateColumns = `repeat(${Math.min(preset.cols, 3)}, 1fr)`;
    mini.style.gridTemplateRows = `repeat(${preset.rows}, 1fr)`;
    const cell = document.createElement('span');
    cell.className = 'snap-tile-cell';
    cell.style.gridColumn = `span ${Math.min(preset.cols, 3)}`;
    cell.style.gridRow = `span ${preset.rows}`;
    mini.appendChild(cell);
    tile.appendChild(mini);
    const label = document.createElement('span');
    label.className = 'snap-tile-label';
    label.textContent = preset.label;
    tile.appendChild(label);
    tile.addEventListener('click', (e) => {
      e.stopPropagation();
      applyCardSnap(sessionId, preset.cols, preset.rows);
      closeSnapLayoutPopover();
    });
    pop.appendChild(tile);
  }

  // Treat the popover as part of the hover region: entering cancels a pending
  // close, leaving schedules one (only effective for hover-opened popovers).
  pop.addEventListener('mouseenter', () => {
    if (snapHoverCloseTimer) { clearTimeout(snapHoverCloseTimer); snapHoverCloseTimer = null; }
  });
  pop.addEventListener('mouseleave', () => scheduleSnapHoverClose());

  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.round(r.bottom + 6)}px`;
  // Keep within the viewport's right edge.
  const left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8);
  pop.style.left = `${Math.round(Math.max(8, left))}px`;
  snapPopoverEl = pop;
  snapPopoverHoverOpened = hover;
  document.addEventListener('pointerdown', onSnapPopoverOutside, true);
  document.addEventListener('keydown', onSnapPopoverKey, true);
}
