# Spec 08 — Flexible grid layout (resize / drag)

> Read `docs/specs/README.md` first.

**Status:** Ready after Spec 07 · **Roadmap:** Opportunity #7b (Phase 5B) · **Depends on:** Spec 07 (groups) for grouped layout; can ship standalone for ungrouped if 07 isn't ready.

## Problem & goal

The grid is a **uniform auto-grid** — equal-size cards, column count derived from width, order fixed to the sidebar. When watching many agents you can't make the important one bigger or arrange them to match how you work.

**Goal:** Let users **resize** grid cards (span more columns/rows) and **drag to reorder** them, with the layout persisting across restarts. Recommended approach is **snap-to-grid spans + drag-to-reorder**, not a free-form absolute canvas (keeps the CSS-grid architecture and clean terminal fit).

## Current state (grounded)

- Layout math: `calculateGridColumnCount({width, cardCount, minCardWidth, gap})` (`public/grid-layout.js`), `MIN_GRID_CARD_WIDTH=620`, `GRID_GAP=10`.
- Applied in `updateGridColumns` (`grid-view.js:274`): sets `terminalsEl.style.gridTemplateColumns = repeat(cols, 1fr)`; `grid-few-cards`/`grid-single-card` classes for small counts.
- Cards: `wrapInGridCard` (`grid-view.js:71`), placed into `#terminals` in sidebar order in `showGridView`. Each terminal must be re-fit after any size change via `fitAndScroll(entry)` (`terminal-manager.js`) — already called after layout in `showGridView` (~263) and on resize via a `ResizeObserver` (`initGridObservers`, ~285).
- Persisted grid prefs precedent: `gridViewActive`, `gridStatusFilter` in `localStorage`.

## Scope

**In:** per-card column/row span (snap to grid, e.g. 1×1 / 2×1 / 2×2) via a corner drag handle; drag-to-reorder cards (and into/out of groups if Spec 07 present); persistence of span + order; "reset layout".
**Out (stretch, separate spike):** fully free-form absolute-positioned canvas with arbitrary x/y/w/h.

## Design

### Layout model: extend `public/grid-layout.js` (pure, tested)
```js
// normalizeSpan({cols, rows}, maxCols) -> clamped {cols, rows} (cols in 1..maxCols, rows in 1..MAX_ROWS)
// applyLayout(orderedSessionIds, layoutMap, maxCols)
//   -> [{ sessionId, order, colSpan, rowSpan }]  // resolves persisted layout against current cols
// reorder(orderedIds, fromId, toId) -> newOrderedIds
// Keep all geometry decisions here so they're unit-tested without the DOM.
```
Cards use CSS grid item spans: `grid-column: span N; grid-row: span M;` on the card wrapper. Column track count still comes from `calculateGridColumnCount` (a card's `colSpan` is clamped to available cols).

### Persistence
- Store a `gridLayout` blob: `{ [sessionId]: { order, colSpan, rowSpan } }`. Use `localStorage` (consistent with `gridViewActive`) or the settings blob. Restore in `showGridView` and apply via `applyLayout`.

### Resize (`grid-view.js`)
- Add a corner resize handle to each card (visible on focus/hover). On drag, compute the nearest snap span from pointer delta vs card/track size; update the card's `grid-column`/`grid-row` span and the layout map; **debounce `fitAndScroll`** for that card so the xterm reflows once the drag settles.
- After any span change, call `updateGridColumns` so track count stays consistent.

### Drag-to-reorder (`grid-view.js`)
- Make cards draggable by their header (the header is already the focus handle, `wrapInGridCard` ~156). On drop over another card, `reorder(...)` the id list, re-append cards in new order, persist. If Spec 07 is present, dropping into a different group region also calls `assignSession(...)` (groups-model) — coordinate the drop targets.
- Reuse the same drag interaction Spec 07 uses for assigning sessions to groups (single drag system, not two).
- Respect `prefers-reduced-motion`: no fly animations when reduced.

### Reset
- A "Reset layout" button in the grid header clears `gridLayout` and re-renders uniform.

## Files to touch
- **New:** `test/grid-layout.test.js` (extend existing module's tests).
- **Modified:** `public/grid-layout.js` (span/order/reorder helpers), `public/grid-view.js` (resize handles, drag-reorder, apply persisted layout in `showGridView`/`updateGridColumns`, reset button), `public/index.html` (no new script — `grid-layout.js` already loaded ~141), `public/style.css` (resize handle, drag affordances, span behavior).

## Tests (`test/grid-layout.test.js`)
- `normalizeSpan` clamps cols to `[1, maxCols]` and rows to `[1, MAX_ROWS]`.
- `applyLayout` resolves persisted spans against fewer available columns (clamps) and preserves order.
- `reorder` moves an id before/after a target correctly; no-ops on unknown ids.
- Existing `calculateGridColumnCount` tests still pass.

## Acceptance criteria
- A card can be resized to span 2 columns and/or 2 rows; the terminal inside re-fits cleanly (no clipped/garbled output).
- Cards can be dragged into a new order (and into another group region when Spec 07 is present); layout persists across restart.
- "Reset layout" restores the uniform grid.
- Keyboard grid navigation (`navigateGrid`) still works with mixed-size cards.
- `prefers-reduced-motion` honored.
- `npm test`, `ReadLints`, Electron smoke run with several live terminals pass.

## Risks / notes
- Terminal fit on resize is the main correctness risk — debounce and always `fitAndScroll` after the span settles; verify scrollback survives.
- Snap-to-grid (not free-form) is deliberate to preserve `fitAndScroll` simplicity; only pursue the free-form canvas as a separate spike if real use proves spans too rigid.
- Single drag system shared with Spec 07 — don't build two; coordinate if both in flight.
