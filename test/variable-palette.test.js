const test = require('node:test');
const assert = require('node:assert/strict');

// The popover itself — geometry, the highlight walk, the focus rules — is palette-core.js and is
// covered by test/palette-core.test.js. What is left here is what makes this picker the VARIABLE one.
const {
  filterVariables, groupForList, displayOrder,
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
  assert.deepEqual(groupForList(shown).flatMap(g => g.rows), shown);
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
