const test = require('node:test');
const assert = require('node:assert/strict');

// The popover itself — geometry, the highlight walk, the focus rules — is palette-core.js and is
// covered by test/palette-core.test.js. What is left here is what makes this picker the VARIABLE one.
const {
  filterVariables, displayOrder, variableScopeBadge, variablePickerConfig,
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

// #676: every picker shows ONE list in the manual order from the variables manager, global and project
// mixed, with the scope on each row. The Global/Project headings of #207 are gone — they regrouped the
// order the user set. The arrow keys still walk exactly the list the eye reads, which is now that order.
test('#676: the picker renders flat — no scope headings', () => {
  assert.equal(variablePickerConfig.groups, undefined,
    'a `groups` function would draw Global/Project headings and regroup the manual order');
});

test('#676: the walked order is the order the store handed over, scopes interleaved', () => {
  const manual = [
    V('zeta', { scope: 'project' }),
    V('alpha'),
    V('mid', { scope: 'project' }),
    V('beta'),
  ];
  const shown = variablePickerConfig.filter(manual, '');
  assert.deepEqual(shown.map(v => v.name), ['zeta', 'alpha', 'mid', 'beta']);
  // A filter keeps the survivors in that same order.
  assert.deepEqual(variablePickerConfig.filter(manual, 'a').map(v => v.name), ['zeta', 'alpha', 'beta']);
});

test('#676: displayOrder keeps the order and drops holes', () => {
  const rows = [V('b', { scope: 'project' }), V('a'), V('c')];
  assert.deepEqual(displayOrder(rows), rows);
  assert.deepEqual(displayOrder([null, V('x'), undefined]), [V('x')]);
  assert.deepEqual(displayOrder(null), []);
});

test('#676: each row carries its scope badge beside the secret marker', () => {
  assert.equal(variableScopeBadge(V('g')), 'Global');
  assert.equal(variableScopeBadge(V('p', { scope: 'project' })), 'Project');
  assert.equal(variableScopeBadge({}), 'Global', 'a row with no scope is a global one, as in the store');

  const secretProject = variablePickerConfig.row(V('tok', { scope: 'project', secret: true }));
  assert.equal(secretProject.main, 'tok');
  assert.equal(secretProject.meta, 'secret');
  assert.equal(secretProject.badge, 'Project');
  assert.match(secretProject.badgeClass, /\bva-tag\b/, 'the badge reuses the tag chip styling');

  const plainGlobal = variablePickerConfig.row(V('base'));
  assert.equal(plainGlobal.meta, null);
  assert.equal(plainGlobal.badge, 'Global');
});

test('#676: a project and a global variable of one name both appear, told apart by the badge', () => {
  const rows = [V('token', { id: 'p1', scope: 'project' }), V('token', { id: 'g1' })];
  const shown = variablePickerConfig.filter(rows, 'tok');
  assert.deepEqual(shown.map(v => v.id), ['p1', 'g1']);
  assert.deepEqual(shown.map(v => variablePickerConfig.row(v).badge), ['Project', 'Global']);
});

