const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateGridColumnCount } = require('../src/renderer/views/grid-layout');

test('calculateGridColumnCount avoids cramped three-column layouts', () => {
  assert.equal(calculateGridColumnCount({ width: 1400, cardCount: 6 }), 2);
  assert.equal(calculateGridColumnCount({ width: 900, cardCount: 6 }), 1);
  assert.equal(calculateGridColumnCount({ width: 1920, cardCount: 6 }), 3);
  assert.equal(calculateGridColumnCount({ width: 1920, cardCount: 2 }), 2);
});
