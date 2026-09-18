'use strict';
// src/app/path-completion.js (#643, A3): what an `@` in a session's input completes to. Against a real
// directory tree, because the answers are about readdir and real paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { completePaths } = require('../src/app/path-completion');

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'path-completion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), ''); };
  file('src/renderer/session/conversation-view.js');
  file('src/renderer/style.css');
  file('src/app/agent-rpc.js');
  file('README.md');
  file('node_modules/conversation-lib/index.js');
  file('.git/conversation-config');
  file('.env');
  file('docs/my notes.md');
  return root;
}

const values = async (root, prefix, opts) => (await completePaths(root, prefix, opts)).map(e => e.value);

test('with a directory named, it lists that directory like a shell does, directories first', async (t) => {
  const root = tree(t);
  assert.deepEqual(await completePaths(root, 'src/'), [{ value: 'src/app/', dir: true }, { value: 'src/renderer/', dir: true }]);
  assert.deepEqual(await completePaths(root, 'src/renderer/s'), [
    { value: 'src/renderer/session/', dir: true }, { value: 'src/renderer/style.css', dir: false },
  ]);
  assert.deepEqual(await completePaths(root, 'src\\app\\a'), [{ value: 'src/app/agent-rpc.js', dir: false }], 'a backslash is read as a separator');
});

test('without one, a name anywhere in the project, but never inside a dependency or a VCS store', async (t) => {
  const root = tree(t);
  assert.deepEqual(await values(root, 'conver'), ['src/renderer/session/conversation-view.js']);
  assert.deepEqual(await values(root, 'READ'), ['README.md'], 'the top level first');
  assert.ok(!(await values(root, '')).some(v => v.startsWith('.')), 'hidden entries only when asked for');
  assert.deepEqual(await values(root, '.en'), ['.env']);
  assert.deepEqual(await values(root, 'my'), ['docs/my notes.md']);
});

test('it never names anything outside the project, and never opens an archive', async (t) => {
  const root = tree(t);
  assert.deepEqual(await completePaths(root, '../'), []);
  assert.deepEqual(await completePaths(root, 'src/../../'), []);
  assert.deepEqual(await completePaths(root, '/'), []);
  assert.deepEqual(await completePaths(root, 'Z:/'), []);
  assert.deepEqual(await completePaths('', 'src/'), []);
  fs.mkdirSync(path.join(root, 'dist', 'app.asar'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'app.asar', 'inside.js'), '');
  assert.deepEqual(await completePaths(root, 'dist/app.asar/'), [], 'a prefix through an .asar is refused before it is resolved');
  assert.deepEqual(await values(root, 'dist/'), [], 'and an .asar is never listed');
});

test('a link is offered as a directory but never walked into, so the walk cannot leave the project', async (t) => {
  const root = tree(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'path-completion-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret-outside.txt'), '');
  try { fs.symlinkSync(outside, path.join(root, 'linked'), 'junction'); } catch { t.skip('no permission to create a link here'); return; }
  assert.deepEqual(await completePaths(root, 'lin'), [{ value: 'linked/', dir: true }]);
  assert.deepEqual(await values(root, 'secret'), [], 'the walk does not follow it');
  assert.deepEqual(await completePaths(root, 'linked/'), [], 'and a prefix through it points outside');
});

test('a walk is reused while typing, and a new one is made once it is old', async (t) => {
  const root = tree(t);
  assert.equal((await completePaths(root, 'agent', { now: 1000 })).length, 1);
  fs.writeFileSync(path.join(root, 'src', 'app', 'agent-two.js'), '');
  assert.equal((await completePaths(root, 'agent', { now: 2000 })).length, 1, 'the same walk');
  assert.equal((await completePaths(root, 'agent', { now: 60000 })).length, 2, 'a fresh one');
});

test('keystrokes that ask while a walk is running share it', async (t) => {
  const root = tree(t);
  const [a, b, c] = await Promise.all([completePaths(root, 'agen', { now: 500000 }), completePaths(root, 'agent', { now: 500001 }), completePaths(root, 'conv', { now: 500002 })]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(c.length, 1);
});
