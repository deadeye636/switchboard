// Tests for the tag picker's colour conversions (#134).
//
// The round trip is what matters: the picker stores hex, but drags an HSV field.
// If hex → HSV → hex is not stable, a colour drifts every time the popover opens.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeHex,
  hexToRgb,
  rgbToHex,
  rgbToHsv,
  hsvToRgb,
  hexToHsv,
  hsvToHex,
} = require('../public/color-utils');

// --- normalizeHex -----------------------------------------------------------

test('normalizeHex accepts the forms a user can type', () => {
  assert.equal(normalizeHex('#61AFEF'), '#61afef');
  assert.equal(normalizeHex('61afef'), '#61afef');
  assert.equal(normalizeHex('  #61afef  '), '#61afef');
  assert.equal(normalizeHex('#abc'), '#aabbcc', 'shorthand expands');
  assert.equal(normalizeHex('abc'), '#aabbcc');
});

test('normalizeHex rejects anything that is not a colour', () => {
  for (const bad of ['', '#12', '#12345', '#1234567', 'nope', '#ggg', null, undefined, 42, {}]) {
    assert.equal(normalizeHex(bad), null, String(bad));
  }
});

// --- hex ↔ rgb --------------------------------------------------------------

test('hexToRgb and rgbToHex are inverses', () => {
  assert.deepEqual(hexToRgb('#61afef'), { r: 0x61, g: 0xaf, b: 0xef });
  assert.equal(rgbToHex({ r: 0x61, g: 0xaf, b: 0xef }), '#61afef');
  assert.equal(hexToRgb('zzz'), null);
  // 'bad' is three hex digits, so it is a legitimate shorthand — not junk.
  assert.deepEqual(hexToRgb('bad'), { r: 0xbb, g: 0xaa, b: 0xdd });
});

test('rgbToHex clamps and rounds out-of-range channels', () => {
  assert.equal(rgbToHex({ r: -20, g: 300, b: 127.6 }), '#00ff80');
  assert.equal(rgbToHex({}), '#000000');
});

// --- rgb ↔ hsv --------------------------------------------------------------

test('rgbToHsv places the primaries on their hue spokes', () => {
  assert.deepEqual(rgbToHsv({ r: 255, g: 0, b: 0 }), { h: 0, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv({ r: 0, g: 255, b: 0 }), { h: 120, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv({ r: 0, g: 0, b: 255 }), { h: 240, s: 1, v: 1 });
});

test('rgbToHsv reports zero saturation for greys, and black has value 0', () => {
  assert.deepEqual(rgbToHsv({ r: 128, g: 128, b: 128 }), { h: 0, s: 0, v: 128 / 255 });
  assert.deepEqual(rgbToHsv({ r: 0, g: 0, b: 0 }), { h: 0, s: 0, v: 0 });
  assert.deepEqual(rgbToHsv({ r: 255, g: 255, b: 255 }), { h: 0, s: 0, v: 1 });
});

test('hsvToRgb walks all six hue sectors', () => {
  assert.deepEqual(hsvToRgb({ h: 0, s: 1, v: 1 }), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hsvToRgb({ h: 60, s: 1, v: 1 }), { r: 255, g: 255, b: 0 });
  assert.deepEqual(hsvToRgb({ h: 120, s: 1, v: 1 }), { r: 0, g: 255, b: 0 });
  assert.deepEqual(hsvToRgb({ h: 180, s: 1, v: 1 }), { r: 0, g: 255, b: 255 });
  assert.deepEqual(hsvToRgb({ h: 240, s: 1, v: 1 }), { r: 0, g: 0, b: 255 });
  assert.deepEqual(hsvToRgb({ h: 300, s: 1, v: 1 }), { r: 255, g: 0, b: 255 });
});

test('hsvToRgb wraps the hue and clamps s/v', () => {
  assert.deepEqual(hsvToRgb({ h: 360, s: 1, v: 1 }), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hsvToRgb({ h: -120, s: 1, v: 1 }), { r: 0, g: 0, b: 255 }, '-120 ≡ 240');
  assert.deepEqual(hsvToRgb({ h: 480, s: 1, v: 1 }), { r: 0, g: 255, b: 0 }, '480 ≡ 120');
  assert.deepEqual(hsvToRgb({ h: 0, s: 5, v: 5 }), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hsvToRgb({ h: 0, s: -1, v: -1 }), { r: 0, g: 0, b: 0 });
});

// --- The round trip the picker depends on -----------------------------------

test('hex → hsv → hex is stable, so reopening the picker never drifts the colour', () => {
  const colours = [
    '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#d19a66',
    '#000000', '#ffffff', '#808080', '#010203', '#fedcba',
  ];
  for (const hex of colours) {
    assert.equal(hsvToHex(hexToHsv(hex)), hex, hex);
  }
});

test('hexToHsv returns null for junk rather than a bogus colour', () => {
  assert.equal(hexToHsv('nope'), null);
  assert.equal(hexToHsv(''), null);
});
