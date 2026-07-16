// Tests for the grid's keyboard move mode (#45): the chord gate, the step/edge
// semantics of a move, and the one-track resize.
//
// The gate is the load-bearing part: while move mode runs, `isMoveModeChord`
// decides which keys are kept away from the focused xterm. A false negative sends
// the key to the PTY; a false positive makes the terminal's arrows go dead.
//
// Only the keyboard path is covered here (the pointer path stays as it was).

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  MAX_GRID_ROWS,
  MOVE_MODE_DIRECTIONS,
  isMoveModeChord,
  moveIndex,
  resizeSpan,
} = require('../src/renderer/views/grid-layout');

// A keydown event as the renderer sees it; every modifier defaults to off.
function keyEvent(key, mods = {}) {
  return {
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  };
}

// --- The gate ---------------------------------------------------------------

test('isMoveModeChord accepts bare arrows, Escape and Enter', () => {
  for (const key of Object.keys(MOVE_MODE_DIRECTIONS)) {
    assert.equal(isMoveModeChord(keyEvent(key), false), true, key);
  }
  assert.equal(isMoveModeChord(keyEvent('Escape'), false), true);
  assert.equal(isMoveModeChord(keyEvent('Enter'), false), true);
});

test('isMoveModeChord accepts Shift+arrow (the resize chord)', () => {
  assert.equal(isMoveModeChord(keyEvent('ArrowRight', { shift: true }), false), true);
  assert.equal(isMoveModeChord(keyEvent('ArrowUp', { shift: true }), false), true);
});

test('isMoveModeChord rejects chords carrying primary or alt', () => {
  // Ctrl/Cmd+Shift+Arrow stays session navigation even inside move mode, so the
  // user can still leave the card by navigating away.
  assert.equal(isMoveModeChord(keyEvent('ArrowLeft', { ctrl: true, shift: true }), false), false);
  assert.equal(isMoveModeChord(keyEvent('ArrowLeft', { meta: true, shift: true }), true), false);
  assert.equal(isMoveModeChord(keyEvent('ArrowLeft', { alt: true }), false), false);
  // Cross-modifier (Meta on Windows / Ctrl on macOS) is never part of a binding.
  assert.equal(isMoveModeChord(keyEvent('ArrowLeft', { meta: true }), false), false);
  assert.equal(isMoveModeChord(keyEvent('ArrowLeft', { ctrl: true }), true), false);
});

test('isMoveModeChord rejects ordinary typing, so the PTY keeps it', () => {
  for (const key of ['a', 'Z', ' ', 'Tab', 'Backspace', 'F5', 'Home']) {
    assert.equal(isMoveModeChord(keyEvent(key), false), false, key);
  }
});

test('isMoveModeChord tolerates a missing event', () => {
  assert.equal(isMoveModeChord(null, false), false);
  assert.equal(isMoveModeChord(undefined, true), false);
});

// --- Move step / edges ------------------------------------------------------

test('moveIndex steps back for left/up and forward for right/down', () => {
  assert.equal(moveIndex(2, 5, 'left'), 1);
  assert.equal(moveIndex(2, 5, 'up'), 1);
  assert.equal(moveIndex(2, 5, 'right'), 3);
  assert.equal(moveIndex(2, 5, 'down'), 3);
});

test('moveIndex returns null at the edges rather than wrapping', () => {
  assert.equal(moveIndex(0, 3, 'left'), null);
  assert.equal(moveIndex(0, 3, 'up'), null);
  assert.equal(moveIndex(2, 3, 'right'), null);
  assert.equal(moveIndex(2, 3, 'down'), null);
  // A single card has nowhere to go in either direction.
  assert.equal(moveIndex(0, 1, 'left'), null);
  assert.equal(moveIndex(0, 1, 'right'), null);
});

test('moveIndex rejects an index outside the list', () => {
  assert.equal(moveIndex(-1, 3, 'right'), null);
  assert.equal(moveIndex(3, 3, 'left'), null);
  assert.equal(moveIndex('x', 3, 'left'), null);
  assert.equal(moveIndex(0, 0, 'right'), null);
});

// --- Resize -----------------------------------------------------------------

test('resizeSpan grows on right/down and shrinks on left/up', () => {
  assert.deepEqual(resizeSpan({ cols: 1, rows: 1 }, 'right', 3), { cols: 2, rows: 1 });
  assert.deepEqual(resizeSpan({ cols: 2, rows: 1 }, 'left', 3), { cols: 1, rows: 1 });
  assert.deepEqual(resizeSpan({ cols: 1, rows: 1 }, 'down', 3), { cols: 1, rows: 2 });
  assert.deepEqual(resizeSpan({ cols: 1, rows: 2 }, 'up', 3), { cols: 1, rows: 1 });
});

test('resizeSpan clamps at the container width and MAX_GRID_ROWS', () => {
  assert.deepEqual(resizeSpan({ cols: 2, rows: 1 }, 'right', 2), { cols: 2, rows: 1 });
  assert.equal(resizeSpan({ cols: 1, rows: MAX_GRID_ROWS }, 'down', 3).rows, MAX_GRID_ROWS);
});

test('resizeSpan never shrinks below a single track', () => {
  assert.deepEqual(resizeSpan({ cols: 1, rows: 1 }, 'left', 3), { cols: 1, rows: 1 });
  assert.deepEqual(resizeSpan({ cols: 1, rows: 1 }, 'up', 3), { cols: 1, rows: 1 });
});

test('resizeSpan clamps an already-oversized persisted span on the way through', () => {
  // A card persisted at 4 columns, reopened in a 2-column grid, then grown:
  // it must not grow from the stale 4, it clamps to the current max first.
  assert.deepEqual(resizeSpan({ cols: 4, rows: 1 }, 'right', 2), { cols: 2, rows: 1 });
});

// --- DOM reorder ------------------------------------------------------------
// gridMoveModeReorder() in public/grid-view.js does exactly this insertBefore
// against moveIndex()'s result; grid-view.js is a classic script full of renderer
// globals and can't be require()d, so the node move is exercised directly.

function buildGrid(ids) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="cards"></div></body></html>');
  const container = dom.window.document.getElementById('cards');
  for (const id of ids) {
    const card = dom.window.document.createElement('div');
    card.className = 'grid-card';
    card.dataset.sessionId = id;
    container.appendChild(card);
  }
  return { dom, container };
}

function cardOrder(container) {
  return [...container.children].map(c => c.dataset.sessionId);
}

// Mirrors gridMoveModeReorder's node move (grid-view.js).
function moveCard(container, sessionId, direction) {
  const sibs = [...container.children].filter(n => n.classList.contains('grid-card'));
  const idx = sibs.findIndex(c => c.dataset.sessionId === sessionId);
  const next = moveIndex(idx, sibs.length, direction);
  if (next === null) return false;
  container.insertBefore(sibs[idx], next > idx ? sibs[next].nextSibling : sibs[next]);
  return true;
}

test('moving a card forward swaps it past its next neighbour', () => {
  const { container } = buildGrid(['a', 'b', 'c']);
  assert.equal(moveCard(container, 'a', 'right'), true);
  assert.deepEqual(cardOrder(container), ['b', 'a', 'c']);
});

test('moving a card backward swaps it past its previous neighbour', () => {
  const { container } = buildGrid(['a', 'b', 'c']);
  assert.equal(moveCard(container, 'c', 'left'), true);
  assert.deepEqual(cardOrder(container), ['a', 'c', 'b']);
});

test('moving at the edge leaves the order untouched', () => {
  const { container } = buildGrid(['a', 'b', 'c']);
  assert.equal(moveCard(container, 'a', 'left'), false);
  assert.equal(moveCard(container, 'c', 'right'), false);
  assert.deepEqual(cardOrder(container), ['a', 'b', 'c']);
});

test('a card walked to the far end passes every neighbour exactly once', () => {
  const { container } = buildGrid(['a', 'b', 'c', 'd']);
  assert.equal(moveCard(container, 'a', 'right'), true);
  assert.equal(moveCard(container, 'a', 'right'), true);
  assert.equal(moveCard(container, 'a', 'right'), true);
  assert.deepEqual(cardOrder(container), ['b', 'c', 'd', 'a']);
  assert.equal(moveCard(container, 'a', 'right'), false);
});
