const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterVariables, nextIndex, groupForList, displayOrder, paletteGeometry,
} = require('../src/renderer/terminal/variable-palette');

const V = (name, extra = {}) => ({ id: 'id-' + name, name, scope: 'global', ...extra });
const ROWS = [
  V('api_base'),
  V('api_token', { secret: true }),
  V('db_dsn', { scope: 'project' }),
  V('WORK_DIR'),
];

test('#207: a blank filter keeps everything, so the palette opens showing the full list', () => {
  assert.deepEqual(filterVariables(ROWS, '').map(v => v.name), ['api_base', 'api_token', 'db_dsn', 'WORK_DIR']);
  assert.equal(filterVariables(ROWS, '   ').length, 4);
  assert.equal(filterVariables(ROWS, null).length, 4);
  assert.equal(filterVariables(ROWS, undefined).length, 4);
});

test('#207: filtering is a case-insensitive substring of the name', () => {
  assert.deepEqual(filterVariables(ROWS, 'api').map(v => v.name), ['api_base', 'api_token']);
  assert.deepEqual(filterVariables(ROWS, 'API').map(v => v.name), ['api_base', 'api_token']);
  assert.deepEqual(filterVariables(ROWS, 'work').map(v => v.name), ['WORK_DIR']);
  // Substring, not prefix — a name is findable by its middle.
  assert.deepEqual(filterVariables(ROWS, 'token').map(v => v.name), ['api_token']);
});

test('#207: a filter matching nothing yields an empty list, not the full one', () => {
  assert.deepEqual(filterVariables(ROWS, 'zzz'), []);
});

test('#207: filterVariables survives a missing or malformed list', () => {
  assert.deepEqual(filterVariables(null, 'api'), []);
  assert.deepEqual(filterVariables(undefined, ''), []);
  assert.deepEqual(filterVariables([null, undefined, V('ok')], ''), [V('ok')]);
  // A row with no name must not throw — it simply never matches.
  assert.deepEqual(filterVariables([{ id: 'x' }], 'a'), []);
});

test('#207: the highlight wraps at both ends', () => {
  assert.equal(nextIndex(0, 3, 1), 1);
  assert.equal(nextIndex(2, 3, 1), 0);   // past the end → first
  assert.equal(nextIndex(0, 3, -1), 2);  // before the start → last
  assert.equal(nextIndex(1, 3, -1), 0);
});

test('#207: an empty list has no highlight, so Enter cannot insert', () => {
  assert.equal(nextIndex(0, 0, 1), -1);
  assert.equal(nextIndex(-1, 0, -1), -1);
});

test('#207: a highlight of -1 moving forward lands on the first row', () => {
  // After a filter emptied the list and a new one refilled it, the index is restored from -1.
  assert.equal(nextIndex(-1, 3, 1), 1);
  assert.equal(nextIndex(-1, 3, -1), 2);
});

test('#207: groups keep Global before Project and drop the empty one', () => {
  assert.deepEqual(groupForList(ROWS).map(g => g.key), ['global', 'project']);
  assert.deepEqual(groupForList([V('only', { scope: 'project' })]).map(g => g.key), ['project']);
  assert.deepEqual(groupForList([V('only')]).map(g => g.key), ['global']);
  assert.deepEqual(groupForList([]), []);
});

// The arrow keys walk the list the eye reads. Rows arrive sorted by name with the scopes interleaved,
// while the groups render global-then-project — so the walked order has to be the FLATTENED group
// order, or the highlight jumps around the screen instead of stepping down it.
test('#207: the walked order is exactly the rendered order', () => {
  // Sorted by name, scopes interleaved — what the store actually hands over.
  const mixed = [
    V('alpha'),
    V('beta', { scope: 'project' }),
    V('gamma'),
    V('delta', { scope: 'project' }),
  ];
  const shown = displayOrder(mixed);
  assert.deepEqual(shown.map(v => v.name), ['alpha', 'gamma', 'beta', 'delta']);
  // The invariant that keeps them in step: re-grouping the walked list must not reorder it.
  assert.deepEqual(groupForList(shown).flatMap(g => g.vars), shown);
});

test('#207: the first row of the walked order is the first row rendered', () => {
  // A project variable sorting first alphabetically must NOT take the initial highlight — the first
  // rendered row is under the Global heading.
  const shown = displayOrder([V('aaa', { scope: 'project' }), V('zzz')]);
  assert.equal(shown[0].name, 'zzz');
});

test('#207: displayOrder keeps a single-scope list untouched', () => {
  const globals = [V('a'), V('b'), V('c')];
  assert.deepEqual(displayOrder(globals), globals);
  const projects = [V('a', { scope: 'project' }), V('b', { scope: 'project' })];
  assert.deepEqual(displayOrder(projects), projects);
  assert.deepEqual(displayOrder([]), []);
});

// --- Where the palette sits (#207) ---
// The anchor is "the lower half of the terminal", but a small grid card makes half of it all chrome
// and no list, and a terminal near the viewport edge must not push the footer off-screen.

const R = (top, height, left = 0, width = 800) => ({ top, height, left, width });

test('#207: a tall terminal gets exactly its lower half', () => {
  const g = paletteGeometry(R(50, 800), 900);
  assert.deepEqual(g, { left: 0, width: 800, top: 450, height: 400 });
});

test('#207: the palette never spills below its own terminal', () => {
  // A card shorter than the minimum height gets covered entirely rather than overhanging the card
  // below it — overhang would put the palette on top of a DIFFERENT session.
  const rect = R(300, 200);
  const g = paletteGeometry(rect, 1000);
  assert.ok(g.top + g.height <= rect.top + rect.height,
    `palette ${g.top}+${g.height} overhangs terminal bottom ${rect.top + rect.height}`);
  // It keeps the usable minimum and sits flush with the card's bottom instead of overhanging it.
  assert.equal(g.height, 190);
  assert.equal(g.top, 310);
});

test('#207: a terminal at the viewport bottom keeps the footer on screen', () => {
  const g = paletteGeometry(R(700, 180), 900);
  assert.ok(g.top + g.height <= 900 - 8, `bottom ${g.top + g.height} is off-screen`);
  assert.ok(g.top >= 8);
});

test('#207: a terminal scrolled above the viewport still lands on screen', () => {
  const g = paletteGeometry(R(-500, 400), 900);
  assert.ok(g.top >= 8);
  assert.ok(g.height >= 1);
});

test('#207: the minimum height applies only where the terminal can carry it', () => {
  // Room to spare → the floor lifts a short-but-not-tiny palette to something usable.
  assert.equal(paletteGeometry(R(0, 300), 900).height, 190);
  // No room → the terminal's own height wins, never more.
  assert.equal(paletteGeometry(R(0, 120), 900).height, 120);
});

test('#207: left and width always track the terminal', () => {
  const g = paletteGeometry(R(0, 600, 137, 421), 900);
  assert.equal(g.left, 137);
  assert.equal(g.width, 421);
});
