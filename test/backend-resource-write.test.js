'use strict';
// #441 — writing one of a backend's own files from the app.
//
// The read path (#440) decided what is reachable; this is what may additionally be WRITTEN, and every
// guard here is one a renderer must not be able to talk its way past: the listing is re-derived per
// call, containment is checked against what the filesystem says a path really is, the backend says which
// of its files it will let the app edit at all, and the format has to still parse.
//
// The bytes themselves are `safe-write.js`'s problem and are covered in its own file; what this one
// pins is that the guards run, in that order, and that a refusal says which of them refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backendResources = require('../src/app/backend-resources');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-res-write-'));
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const read = (file) => fs.readFileSync(file, 'utf8');

/**
 * A backend that lists one skills directory and one settings file, and declares what it lets the app
 * edit. `editing` is passed through untouched so a test can hand over a backend that declares nothing.
 */
function setup({ editing = { extensions: ['.md', '.json'] }, invalidated = [] } = {}) {
  const home = tmpdir();
  const skillsDir = path.join(home, 'skills');
  const skillFile = write(path.join(skillsDir, 'do-a-thing', 'SKILL.md'), '---\nname: do-a-thing\n---\n\nbody\n');
  const settings = write(path.join(home, 'settings.json'), '{\n  "a": 1\n}\n');
  const secret = write(path.join(home, '.credentials.json'), '{"token":"nope"}\n');

  const backend = {
    id: 'stub',
    resourceEditing: editing,
    listResources: async () => ({
      ok: true,
      resources: [
        { kind: 'skill', scope: 'global', name: 'skills', path: skillsDir, source: 'skills-directory' },
        { kind: 'settings', scope: 'global', name: 'settings.json', path: settings, source: 'settings' },
      ],
    }),
    expandResource: Object.assign(
      async () => ({ ok: true, entries: [{ kind: 'skill', name: 'do-a-thing', path: skillFile }] }),
      { knowsSource: (source) => source === 'skills-directory' },
    ),
  };
  backendResources.init({
    backends: { get: (id) => (id === 'stub' ? backend : null) },
    log: { warn() {}, error() {}, info() {} },
    invalidateFts: (kind) => invalidated.push(kind),
  });
  return { home, skillsDir, skillFile, settings, secret, backend, invalidated };
}

test('a listed file inside a listed directory can be written', async () => {
  const box = setup();
  const res = await backendResources.writeResource('stub', box.skillFile, '---\nname: do-a-thing\n---\n\nnew body\n', null, null);
  assert.equal(res.ok, true);
  assert.match(read(box.skillFile), /new body/);
  assert.deepEqual(box.invalidated, ['memory'], 'the tab\'s search is told, the way a saved instruction file tells it');
});

test('a path that is not a discovered resource is refused', async () => {
  const box = setup();
  const outside = write(path.join(tmpdir(), 'elsewhere.md'), 'x\n');
  const res = await backendResources.writeResource('stub', outside, 'mine\n', null, null);
  assert.equal(res.ok, false);
  assert.match(res.reason, /not a discovered resource/);
  assert.equal(read(outside), 'x\n');
});

test('a file the listing never named is refused even inside the backend\'s own home', async () => {
  // The credentials file sits beside the settings one. It is not listed, and being under a home the
  // backend owns is not what makes something writable.
  const box = setup();
  const res = await backendResources.writeResource('stub', box.secret, '{}\n', null, null);
  assert.equal(res.ok, false);
  assert.match(res.reason, /not a discovered resource/);
  assert.match(read(box.secret), /nope/);
});

test('traversal out of a listed directory is refused, however it is spelled', async () => {
  const box = setup();
  const escape = path.join(box.skillsDir, '..', 'settings.json');
  const viaDots = await backendResources.writeResource('stub', escape, '{"a":99}\n', null, null);
  // It resolves to the settings file, which IS listed — so this must be accepted for the right reason
  // (it is a listed resource) rather than as a child of the skills directory.
  assert.equal(viaDots.ok, true);
  const beyond = path.join(box.skillsDir, '..', '..', 'outside.md');
  write(beyond, 'x\n');
  const res = await backendResources.writeResource('stub', beyond, 'mine\n', null, null);
  assert.equal(res.ok, false);
  assert.equal(read(beyond), 'x\n');
});

test('a backend that declares no editing is read-only, whatever the listing says', async () => {
  const box = setup({ editing: null });
  const res = await backendResources.writeResource('stub', box.skillFile, 'new\n', null, null);
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not edit this kind of file/);
});

test('an extension the backend did not declare is refused — that is how "nothing executable" holds', async () => {
  const box = setup();
  const hook = write(path.join(box.skillsDir, 'do-a-thing', 'run.sh'), 'echo hi\n');
  const res = await backendResources.writeResource('stub', hook, 'rm -rf /\n', null, null);
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not edit this kind of file/);
  assert.equal(read(hook), 'echo hi\n');
});

test('invalid JSON is refused, naming what the parser objected to', async () => {
  const box = setup();
  const res = await backendResources.writeResource('stub', box.settings, '{ "a": 1, }', null, null);
  assert.equal(res.ok, false);
  assert.match(res.reason, /Not valid JSON/);
  assert.equal(read(box.settings), '{\n  "a": 1\n}\n', 'the file the CLI reads is untouched');
});

test('a write built on a stale view is refused, with the current text to resolve against', async () => {
  const box = setup();
  fs.writeFileSync(box.skillFile, '---\nname: do-a-thing\n---\n\nsomebody else\n');
  const res = await backendResources.writeResource('stub', box.skillFile, 'mine\n', null, '---\nname: do-a-thing\n---\n\nbody\n');
  assert.equal(res.ok, false);
  assert.equal(res.conflict, true);
  assert.match(res.diskContent, /somebody else/);
  assert.match(read(box.skillFile), /somebody else/, 'nothing was overwritten');
});

test('the same content the file holds is not stale', async () => {
  const box = setup();
  const current = read(box.skillFile);
  const res = await backendResources.writeResource('stub', box.skillFile, current + 'more\n', null, current);
  assert.equal(res.ok, true);
});

test('a missing file, an unknown backend and a non-string body are answers, not throws', async () => {
  const box = setup();
  assert.equal((await backendResources.writeResource('nope', box.skillFile, 'x', null, null)).ok, false);
  assert.equal((await backendResources.writeResource('stub', box.skillFile, null, null, null)).ok, false);
  fs.rmSync(box.skillFile);
  const gone = await backendResources.writeResource('stub', box.skillFile, 'x\n', null, null);
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /not a discovered resource|no longer there/);
});

test('every ready backend declares what it lets the app edit, and none of it runs', () => {
  // The rule this pins is mechanical rather than a promise: no descriptor may offer an executable
  // extension, and a backend that declares nothing is read-only rather than open.
  const EXECUTABLE = ['.sh', '.bash', '.ps1', '.bat', '.cmd', '.js', '.mjs', '.cjs', '.ts', '.py', '.rb', '.exe'];
  const backends = require('../src/backends').list().filter(b => b.status === 'ready' && !b.isProfile);
  assert.ok(backends.length >= 4);
  for (const backend of backends) {
    const declared = backend.resourceEditing;
    assert.ok(declared && Array.isArray(declared.extensions),
      `${backend.id} declares no resourceEditing — an answer is required, declining included`);
    for (const ext of declared.extensions) {
      assert.equal(ext, ext.toLowerCase(), `${backend.id} declares ${ext} in mixed case; the check is lowercase`);
      assert.ok(!EXECUTABLE.includes(ext), `${backend.id} would let the app edit ${ext}, which RUNS`);
    }
  }
});
