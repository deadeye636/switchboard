const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateGridColumnCount } = require('../src/renderer/views/grid-layout');

test('calculateGridColumnCount avoids cramped three-column layouts', () => {
  assert.equal(calculateGridColumnCount({ width: 1400, cardCount: 6 }), 2);
  assert.equal(calculateGridColumnCount({ width: 900, cardCount: 6 }), 1);
  assert.equal(calculateGridColumnCount({ width: 1920, cardCount: 6 }), 3);
  assert.equal(calculateGridColumnCount({ width: 1920, cardCount: 2 }), 2);
});

// --- #369: which cards the mosaic draws, and in what order ---
//
// Grid has always ordered by the sidebar. A MODE SWITCH out of panes hands in the order the tabs were
// in, so the cards read the way the tabs did instead of jumping back to sidebar order.

const { resolveGridCardOrder } = require('../src/renderer/views/grid-layout');

const all = () => true;

test('#369: with no preferred order it is the sidebar order, unchanged', () => {
  assert.deepEqual(
    resolveGridCardOrder({ sidebarOrder: ['a', 'b', 'c'], isEligible: all }),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(resolveGridCardOrder({}), []);
});

test('#369: a preferred order leads, and the rest follow in sidebar order', () => {
  assert.deepEqual(
    resolveGridCardOrder({ preferred: ['c', 'a'], sidebarOrder: ['a', 'b', 'c', 'd'], isEligible: all }),
    ['c', 'a', 'b', 'd'],
  );
});

test('#369: a session the switch did not know about is never dropped', () => {
  // Mounted after the order was captured — losing it would lose a live session.
  assert.deepEqual(
    resolveGridCardOrder({ preferred: ['a'], sidebarOrder: ['a', 'b'], isEligible: all }),
    ['a', 'b'],
  );
});

test('#369: eligibility is applied to the preferred list too', () => {
  // A tab for a session that has since closed must not resurrect it as a card.
  const open = new Set(['a', 'b']);
  assert.deepEqual(
    resolveGridCardOrder({
      preferred: ['ghost', 'b'],
      sidebarOrder: ['a', 'b'],
      isEligible: (id) => open.has(id),
    }),
    ['b', 'a'],
  );
});

test('#369: a duplicate in either list is taken once', () => {
  assert.deepEqual(
    resolveGridCardOrder({ preferred: ['a', 'a'], sidebarOrder: ['b', 'a', 'b'], isEligible: all }),
    ['a', 'b'],
  );
});

test('#369: junk inputs answer with what can be ordered rather than throwing', () => {
  assert.deepEqual(resolveGridCardOrder({ preferred: null, sidebarOrder: ['a'], isEligible: all }), ['a']);
  assert.deepEqual(resolveGridCardOrder({ preferred: [null, '', 'a'], sidebarOrder: [], isEligible: all }), ['a']);
});
