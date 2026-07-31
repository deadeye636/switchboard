'use strict';
// The Sessions tab's pixel icon (#383). What is worth testing here is the half that has no DOM: the
// grid → `d` conversion, and the frames themselves. Artwork does not have a right answer, but a frame
// that is not square, or has drifted to 19 columns after an edit, silently shifts the whole picture —
// the viewBox is 0 0 20 20 and nothing else would say so.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PIXEL_ICON_FRAMES, pixelGridToPath } = require('../src/renderer/shell/pixel-icon.js');

const GRID = 20;

test('every frame is a 20x20 grid of known cells', () => {
  for (const [name, rows] of Object.entries(PIXEL_ICON_FRAMES)) {
    assert.equal(rows.length, GRID, `${name} has ${rows.length} rows, not ${GRID}`);
    rows.forEach((row, y) => {
      assert.equal(row.length, GRID, `${name} row ${y} is ${row.length} cells wide, not ${GRID}`);
      assert.match(row, /^[#.]+$/, `${name} row ${y} has a cell that is neither '#' nor '.'`);
    });
  }
});

test('every frame draws something, and stays inside the viewBox', () => {
  for (const [name, rows] of Object.entries(PIXEL_ICON_FRAMES)) {
    const d = pixelGridToPath(rows);
    assert.ok(d.length > 0, `${name} is empty`);
    for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      assert.ok(Number(x) + Number(w) <= GRID, `${name} draws past the right edge at row ${y}`);
      assert.ok(Number(y) < GRID, `${name} draws below the bottom edge`);
    }
  }
});

test('cells next to each other in a row become one run, not two rectangles', () => {
  // The merge is the whole reason the path is built rather than written: two abutting <rect>s leave a
  // hairline seam between them at fractional device-pixel scales.
  assert.equal(pixelGridToPath(['###']), 'M0 0h3v1h-3z');
  assert.equal(pixelGridToPath(['#.#']), 'M0 0h1v1h-1zM2 0h1v1h-1z');
  assert.equal(pixelGridToPath(['...']), '');
  assert.equal(pixelGridToPath(['.#.', '.#.']), 'M1 0h1v1h-1zM1 1h1v1h-1z');
});

test('the two frames of a pair differ — an animation needs two pictures', () => {
  for (const [a, b] of [['idle', 'idleBlink'], ['work', 'workAlt']]) {
    assert.notDeepEqual(PIXEL_ICON_FRAMES[a], PIXEL_ICON_FRAMES[b],
      `${a} and ${b} are identical — the animation would look frozen`);
  }
});

test('every step of the walk is its own picture', () => {
  // The walk is played forwards and backwards off one set of art. Two steps that matched, or a step
  // that matched the state it leads to, would read as a stutter rather than a transition.
  const walk = ['idle', 'walk1', 'walk2', 'work'];
  for (let i = 0; i < walk.length - 1; i++) {
    assert.notDeepEqual(PIXEL_ICON_FRAMES[walk[i]], PIXEL_ICON_FRAMES[walk[i + 1]],
      `${walk[i]} and ${walk[i + 1]} are identical — that step of the walk would not show`);
  }
});
