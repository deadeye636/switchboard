const { test } = require('node:test');
const assert = require('node:assert');
const { projectDisplayLabel } = require('../public/project-name.js');

test('custom displayName wins over shortName', () => {
  assert.strictEqual(projectDisplayLabel('Mein Projekt', 'dev/foo'), 'Mein Projekt');
});

test('empty / whitespace displayName falls back to shortName', () => {
  assert.strictEqual(projectDisplayLabel('', 'dev/foo'), 'dev/foo');
  assert.strictEqual(projectDisplayLabel('   ', 'dev/foo'), 'dev/foo');
  assert.strictEqual(projectDisplayLabel(undefined, 'dev/foo'), 'dev/foo');
  assert.strictEqual(projectDisplayLabel(null, 'dev/foo'), 'dev/foo');
});

test('displayName is trimmed', () => {
  assert.strictEqual(projectDisplayLabel('  Name  ', 'dev/foo'), 'Name');
});
