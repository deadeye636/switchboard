// --- Grid cards: the pointer gestures (drag-to-reorder, corner resize) (#218) ---
//
// Everything the mouse does to a card, and the geometry it needs: hit-testing the card under the
// cursor, the FLIP animation that slides the siblings out of the way, the placeholder that shows where
// the card will land, and the corner handle that resizes a span one track at a time. Came out of
// grid-view.js, which held it next to the card lifecycle it is not part of.
//
// The keyboard counterpart lives in grid-view.js (enterGridMoveMode & co) and shares nothing with this
// file but the DOM it moves — deliberately: the pointer path measures pixels, the keyboard path counts
// slots, and the two have never been the same code. `views/grid-layout.js` is where their common pure
// logic already lives (reorder, normalizeSpan, moveIndex, resizeSpan), and it IS require()-able and
// tested. This file is the DOM half, and it is not.
//
// A classic <script>, like the file it came from: same shared global lexical scope, so the identifiers
// below and the ones it reaches for resolve exactly as they did when they sat in one file.
//
// THE ONE THING TO KNOW — this file WRITES a variable it does not own:
//
//   `gridInteracting` is declared in grid-view.js, and beginDrag/onUp/startCardResize set it. It is the
//   flag that stops a status tick from tearing the grid down mid-gesture — refreshGridView() bails out
//   while it is true, because rebuilding would detach the card the user is physically holding.
//
// That works because classic scripts share one global lexical scope: the binding is the same binding,
// and every write here is seen by the read there. It is also the seam that would break silently if this
// file were ever wrapped as a require()-able module — the factory would get its own scope, the write
// would land on nothing, and a drag would start deleting its own card on the next status tick, with the
// suite green. If you make this file testable, `gridInteracting` is the thing to hand in, not to hope for.
//
// The rest of what it reaches for is called, not assigned, and therefore only needs to EXIST by the time
// a pointer touches a card: gridCards, writeCardSpan, snapshotGridCardBoxes, refitResizedGridCards,
// persistGridOrder, getContainerColumnCount, updateGridColumns (grid-view.js), terminalsEl, openSessions
// (app.js), fitAndScroll (terminal-manager.js), GRID_GAP, normalizeSpan, reorder (grid-layout.js).

const gridFitTimers = new Map(); // sessionId → debounce timer for fitAndScroll

function gridReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Debounce xterm reflow so a card only re-fits once a resize drag settles.
function debouncedFit(sessionId) {
  const existing = gridFitTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  gridFitTimers.set(sessionId, setTimeout(() => {
    gridFitTimers.delete(sessionId);
    const entry = openSessions.get(sessionId);
    if (entry) fitAndScroll(entry);
  }, 90));
}

function clearGridDropTargets() {
  terminalsEl.querySelectorAll('.grid-card.drop-before, .grid-card.drop-after')
    .forEach(c => c.classList.remove('drop-before', 'drop-after'));
}

function getGridDropInfo(card, x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const targetCard = el.closest('.grid-card');
  return {
    targetCard: targetCard && targetCard !== card ? targetCard : null,
  };
}

function updateGridDropTarget(card, x, y) {
  clearGridDropTargets();
  const info = getGridDropInfo(card, x, y);
  if (!info) return;
  if (info.targetCard) {
    const r = info.targetCard.getBoundingClientRect();
    const after = (x - r.left) > r.width / 2;
    info.targetCard.classList.add(after ? 'drop-after' : 'drop-before');
  }
}

// True layout box of a grid card with any in-flight FLIP transform removed, so
// insertion math stays stable while siblings are mid-animation. Hit-testing and
// getBoundingClientRect both include transforms; subtracting the live translate
// recovers the settled position and prevents the "cards jump around" feedback
// loop (where reading transformed positions kept re-moving the placeholder).
function gridCardLayoutRect(el) {
  const r = el.getBoundingClientRect();
  const t = getComputedStyle(el).transform;
  if (t && t !== 'none') {
    try {
      const m = new DOMMatrixReadOnly(t);
      return { left: r.left - m.m41, top: r.top - m.m42, width: r.width, height: r.height };
    } catch { /* fall through to raw rect */ }
  }
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

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

// FLIP-animate a container's sibling cards as the drop placeholder is moved into
// `refNode`'s slot: record visual positions, move, then invert + transition to
// identity so the surrounding tiles visibly slide to preview the new
// arrangement. Reads are batched before writes; LAST is read transform-free so
// overlapping animations continue smoothly. `exclude` is the lifted card.
function flipMovePlaceholder(container, placeholder, refNode, exclude) {
  const sibs = [...container.children].filter(
    n => n.classList && n.classList.contains('grid-card') && n !== exclude
  );
  // READ (batched): current visual rects (include any in-flight transform).
  const first = sibs.map(c => c.getBoundingClientRect());
  // WRITE: move the placeholder slot.
  container.insertBefore(placeholder, refNode);
  // READ (batched): settled post-move layout rects (transform-free).
  const last = sibs.map(c => gridCardLayoutRect(c));
  // WRITE: invert each card to its old visual spot (or settle if at rest).
  const moved = [];
  for (let i = 0; i < sibs.length; i++) {
    const c = sibs[i];
    const dx = first[i].left - last[i].left;
    const dy = first[i].top - last[i].top;
    c.style.transition = 'none';
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      c.style.transform = `translate(${dx}px, ${dy}px)`;
      moved.push(c);
    } else {
      c.style.transform = '';
    }
  }
  // PLAY: next frame, restore the CSS transition and animate to identity.
  requestAnimationFrame(() => {
    for (const c of sibs) {
      c.style.transition = '';
      if (moved.includes(c)) c.style.transform = '';
    }
  });
}

// Dragging a card's header reorders it, with a live FLIP preview of the
// surrounding tiles. Honors prefers-reduced-motion by falling back to the static
// drop indicators.
function startCardDrag(sessionId, card, e) {
  if (e.button !== 0) return;
  if (e.target.closest('button, .grid-card-resize-handle')) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const reduced = gridReducedMotion();
  let dragging = false;
  let placeholder = null;
  let rafId = 0;
  let lastX = startX;
  let lastY = startY;
  // The placeholder's current insertion index among the container's real
  // siblings; used to dedup FLIPs (only animate when the index actually changes).
  let currentIdx = 0;

  const beginDrag = () => {
    dragging = true;
    gridInteracting = true;
    card.classList.add('dragging');
    document.body.classList.add('grid-dragging');
    card.style.pointerEvents = 'none';
    if (reduced) return; // static-indicator path only
    card.style.zIndex = '1000';
    const startRect = card.getBoundingClientRect();
    // Placeholder holds the dragged card's slot (same span) so siblings reflow
    // around it; the real card is lifted out of grid flow to follow the cursor.
    // Both the placeholder and the lifted card are pointer-events:none so neither
    // is ever returned by hit-testing.
    placeholder = document.createElement('div');
    placeholder.className = 'grid-card-placeholder';
    placeholder.style.pointerEvents = 'none';
    placeholder.style.gridColumn = card.style.gridColumn || `span ${card.dataset.colSpan || 1}`;
    placeholder.style.gridRow = card.style.gridRow || `span ${card.dataset.rowSpan || 1}`;
    card.parentElement.insertBefore(placeholder, card);
    card.style.position = 'fixed';
    card.style.margin = '0';
    card.style.width = `${startRect.width}px`;
    card.style.height = `${startRect.height}px`;
    card.style.left = `${startRect.left}px`;
    card.style.top = `${startRect.top}px`;
    // Seed the dedup index from the placeholder's origin slot so the first
    // recompute doesn't spuriously re-flip the origin.
    currentIdx = placeholderSlotIndex(card.parentElement, placeholder, card);
  };

  // Recompute the projected insertion slot and reflect it live (throttled to one
  // pass per animation frame). Insertion is computed from transform-free
  // geometry (not elementFromPoint on animating cards) so it never oscillates,
  // and only an actual integer index change triggers a FLIP.
  const updatePreview = () => {
    rafId = 0;
    if (!dragging || !placeholder) return;
    clearGridDropTargets();
    const container = placeholder.parentElement;
    if (!container) return;

    // Only reorder while the cursor is within the active container's box.
    const cRect = container.getBoundingClientRect();
    if (lastX < cRect.left || lastX > cRect.right || lastY < cRect.top || lastY > cRect.bottom) return;

    const sibs = [...container.children].filter(
      n => n.classList && n.classList.contains('grid-card') && n !== card && n !== placeholder
    );
    const rects = sibs.map(gridCardLayoutRect);
    const idx = Math.max(0, Math.min(cursorInsertionIndex(rects, lastX, lastY), sibs.length));
    if (idx === currentIdx) return; // slot unchanged — skip the FLIP (no flip-flop)
    currentIdx = idx;
    flipMovePlaceholder(container, placeholder, sibs[idx] || null, card);
  };

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragging) {
      if (Math.hypot(dx, dy) < 6) return;
      beginDrag();
    }
    lastX = ev.clientX;
    lastY = ev.clientY;
    if (reduced) {
      updateGridDropTarget(card, ev.clientX, ev.clientY);
      return;
    }
    card.style.transform = `translate(${dx}px, ${dy}px)`;
    if (!rafId) rafId = requestAnimationFrame(updatePreview);
  };

  const endDrag = () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    card.classList.remove('dragging');
    document.body.classList.remove('grid-dragging');
    card.style.pointerEvents = '';
    card.style.transform = '';
    card.style.zIndex = '';
    card.style.position = '';
    card.style.left = '';
    card.style.top = '';
    card.style.width = '';
    card.style.height = '';
    card.style.margin = '';
    if (placeholder && placeholder.parentElement) placeholder.remove();
    placeholder = null;
    clearGridDropTargets();
    // Drop any lingering FLIP transforms so nothing is left mid-animation.
    for (const c of terminalsEl.querySelectorAll('.grid-card')) {
      c.style.transition = '';
      c.style.transform = '';
    }
  };

  const onUp = (ev) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (dragging) {
      commitCardDrag(sessionId, card, placeholder, reduced, ev.clientX, ev.clientY);
      endDrag();
      gridInteracting = false;
    }
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

// Commit a finished drag: land the card in the previewed slot (the placeholder
// position). Falls back to the original before/after reorder when reduced-motion
// left no placeholder.
function commitCardDrag(sessionId, card, placeholder, reduced, x, y) {
  const info = getGridDropInfo(card, x, y);

  // Live-preview path: land the card exactly where the placeholder previewed.
  if (!reduced && placeholder && placeholder.parentElement) {
    placeholder.parentElement.insertBefore(card, placeholder);
    persistGridOrder();
    debouncedFit(sessionId);
    return;
  }

  // Reduced-motion fallback: original before/after reorder within the container.
  if (info && info.targetCard && info.targetCard.parentElement === card.parentElement) {
    const container = card.parentElement;
    const r = info.targetCard.getBoundingClientRect();
    const after = (x - r.left) > r.width / 2;
    const ids = [...container.querySelectorAll('.grid-card')].map(c => c.dataset.sessionId);
    const targetId = info.targetCard.dataset.sessionId;
    let newIds = reorder(ids, sessionId, targetId);
    if (after) {
      newIds = ids.filter(id => id !== sessionId);
      newIds.splice(newIds.indexOf(targetId) + 1, 0, sessionId);
    }
    for (const id of newIds) {
      const c = gridCards.get(id);
      if (c) container.appendChild(c);
    }
    persistGridOrder();
    debouncedFit(sessionId);
  }
}

// Corner-handle resize: snap to whole column/row spans, debounce the terminal fit.
function startCardResize(sessionId, card, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  // Capture the pointer on the handle so drag events keep flowing even when the
  // cursor passes over the card's xterm canvas (which would otherwise swallow
  // them), making the corner resize reliable.
  const handle = e.currentTarget;
  if (handle && typeof handle.setPointerCapture === 'function') {
    try { handle.setPointerCapture(e.pointerId); } catch { /* capture best-effort */ }
  }
  const container = card.parentElement;
  const startRect = card.getBoundingClientRect();
  const startColSpan = Math.max(1, Number(card.dataset.colSpan) || 1);
  const startRowSpan = Math.max(1, Number(card.dataset.rowSpan) || 1);
  // Captured before the first live span write, so the end-of-drag comparison sees
  // the geometry the drag started from.
  const boxesAtDragStart = snapshotGridCardBoxes();
  const colUnit = (startRect.width + GRID_GAP) / startColSpan;
  const rowUnit = (startRect.height + GRID_GAP) / startRowSpan;
  const maxCols = getContainerColumnCount(container);
  card.classList.add('resizing');
  document.body.classList.add('grid-dragging');
  gridInteracting = true;

  const onMove = (ev) => {
    const dx = ev.clientX - e.clientX;
    const dy = ev.clientY - e.clientY;
    const rawCols = Math.round((startRect.width + dx + GRID_GAP) / colUnit);
    const rawRows = Math.round((startRect.height + dy + GRID_GAP) / rowUnit);
    const span = normalizeSpan({ cols: rawCols, rows: rawRows }, maxCols);
    if (Number(card.dataset.colSpan) === span.cols && Number(card.dataset.rowSpan) === span.rows) return;
    writeCardSpan(sessionId, card, span);
    debouncedFit(sessionId);
  };

  const onUp = (ev) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (handle && typeof handle.releasePointerCapture === 'function') {
      try { handle.releasePointerCapture(ev.pointerId); } catch { /* best-effort */ }
    }
    card.classList.remove('resizing');
    document.body.classList.remove('grid-dragging');
    gridInteracting = false;
    persistGridOrder();
    updateGridColumns();
    // The drag already moved the boxes, so measure against the span it started
    // from rather than the (already current) live geometry.
    refitResizedGridCards(boxesAtDragStart);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}
