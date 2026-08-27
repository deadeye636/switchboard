const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { conventionDirs } = require('../src/app/convention-dirs');

// The one answer to "where does this project keep handoffs / plans", for the two features that NAME a
// directory rather than read one: the handoff prompt an agent is sent, and an insert template's
// {handoffDir}/{planDir}. A second implementation is how a prompt and a template end up naming different
// directories, and nobody finds out until a packet is missing.

const ROOT = path.resolve('/projects/shop');

test('the defaults come from the settings blob, relative and absolute', () => {
  const dirs = conventionDirs(ROOT, {});
  assert.equal(dirs.handoffDir, '.handoffs');
  assert.equal(dirs.planDir, '.plans');
  assert.equal(dirs.handoffPath, path.join(ROOT, '.handoffs'));
  assert.equal(dirs.planPath, path.join(ROOT, '.plans'));
});

test('a project setting wins, and the absolute path follows it', () => {
  const dirs = conventionDirs(ROOT, { handoffDir: 'docs/handoffs', planDir: 'docs/plans' });
  assert.equal(dirs.handoffDir, 'docs/handoffs');
  assert.equal(dirs.handoffPath, path.join(ROOT, 'docs/handoffs'));
  assert.equal(dirs.planPath, path.join(ROOT, 'docs/plans'));
});

test('whitespace is not a directory — it falls back to the default', () => {
  const dirs = conventionDirs(ROOT, { handoffDir: '   ', planDir: '' });
  assert.equal(dirs.handoffDir, '.handoffs');
  assert.equal(dirs.planDir, '.plans');
});

// A prompt naming a directory outside the project sends an agent to write outside the tree it was opened
// on. The setting is refused here rather than passed on, the same rule the write path applies (#474).
test('a directory that escapes the project is refused, not passed on', () => {
  const dirs = conventionDirs(ROOT, { handoffDir: '../packets', planDir: '..' });
  assert.equal(dirs.handoffDir, '.handoffs');
  assert.equal(dirs.planDir, '.plans');
  assert.equal(dirs.handoffPath, path.join(ROOT, '.handoffs'));
});

test('no project — the names still answer, the paths are empty rather than guessed', () => {
  const dirs = conventionDirs(null, { handoffDir: 'docs/handoffs' });
  assert.equal(dirs.handoffDir, 'docs/handoffs');
  assert.equal(dirs.handoffPath, '');
  assert.equal(dirs.planPath, '');
});

test('settings that are not settings do not throw', () => {
  assert.equal(conventionDirs(ROOT, null).handoffDir, '.handoffs');
  assert.equal(conventionDirs(ROOT, { handoffDir: 42 }).handoffDir, '.handoffs');
});
