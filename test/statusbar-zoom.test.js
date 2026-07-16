const test = require('node:test');
const assert = require('node:assert/strict');

const { clampZoomLevel, zoomToPercent, xtermLabel, electronLabel } = require('../src/renderer/shell/statusbar-zoom');

test('clampZoomLevel: clamps to [-3, 3]', () => {
  assert.equal(clampZoomLevel(0), 0);
  assert.equal(clampZoomLevel(2.5), 2.5);
  assert.equal(clampZoomLevel(5), 3);
  assert.equal(clampZoomLevel(-9), -3);
});

test('clampZoomLevel: non-finite -> 0', () => {
  assert.equal(clampZoomLevel('x'), 0);
  assert.equal(clampZoomLevel(NaN), 0);
  assert.equal(clampZoomLevel(undefined), 0);
});

test('zoomToPercent: factor = 1.2 ** level', () => {
  assert.equal(zoomToPercent(0), 100);
  assert.equal(zoomToPercent(1), 120);
  assert.equal(zoomToPercent(-1), 83);   // round(100/1.2)
  assert.equal(zoomToPercent(2), 144);
});

test('zoomToPercent: non-finite -> 100', () => {
  assert.equal(zoomToPercent('x'), 100);
  assert.equal(zoomToPercent(NaN), 100);
});

test('xtermLabel: rounds and prefixes', () => {
  assert.equal(xtermLabel(12), 'A 12');
  assert.equal(xtermLabel(14.4), 'A 14');
  assert.equal(xtermLabel(undefined), 'A 0');
});

test('electronLabel: percent suffix', () => {
  assert.equal(electronLabel(0), '100%');
  assert.equal(electronLabel(1), '120%');
});
