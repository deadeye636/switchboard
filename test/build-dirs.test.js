'use strict';
// #483 — the directories nothing walks into, and the dev reloader that has to honour them.
//
// The defect this pins is not a wrong list, it is an ABSENT argument: `electron-reloader` with
// `watchRenderer` hands chokidar the whole repository and excludes only dotfiles, `node_modules` and
// source maps, so it walked `dist/` and statted the packaged `app.asar` sitting there. Electron caches an
// asar archive open for the life of the process, so `electron-builder` could not unlink the file and
// every `npm run build:win` failed while a dev instance of the same checkout ran.
//
// The wiring half is a SOURCE check: `src/main.js` requires Electron at line one, so there is no seam to
// call. It is weaker than a behavioural test and pins exactly one thing — that the option is still passed
// — because the way this comes back is somebody tidying an argument whose reason is not local to it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { BUILD_DIR_NAMES, isBuildDir, isAsarArchive } = require('../src/app/build-dirs');
const { stripComments } = require('./helpers/strip-comments');

test('the list names generated output, fetched dependencies and the VCS stores', () => {
  for (const name of ['dist', 'build', 'out', 'target', 'node_modules', 'coverage', '.git']) {
    assert.equal(isBuildDir(name), true, `${name} is not a place a person writes documents`);
  }
});

test('a directory somebody actually writes in is NOT on the list', () => {
  // The cost of this list is a false positive, so the names that carry a project's documents are the
  // ones worth asserting about.
  for (const name of ['docs', 'src', 'plans', '.plans', '.handoffs', '.work-files', '.claude', 'skills']) {
    assert.equal(isBuildDir(name), false, `${name} holds documents and must stay walkable`);
  }
});

test('the name is matched case-insensitively, and only as a whole name', () => {
  assert.equal(isBuildDir('Dist'), true);
  assert.equal(isBuildDir('DIST'), true);
  assert.equal(isBuildDir('distribution'), false, 'a longer name is a different directory');
  assert.equal(isBuildDir('my-dist'), false);
  assert.equal(isBuildDir(''), false);
  assert.equal(isBuildDir(undefined), false);
});

test('an asar is recognised by name, before anything builds a path to it', () => {
  // Measured on Electron 41: existsSync / statSync / lstatSync / realpathSync / openSync on a path
  // ending in `.asar` all leave the file locked for the life of the process, and even the call that
  // throws ENOENT does. A plain readdir of the parent does not. So the only safe move is not to touch it.
  assert.equal(isAsarArchive('app.asar'), true);
  assert.equal(isAsarArchive('App.ASAR'), true);
  assert.equal(isAsarArchive('app.asar.unpacked'), false, 'that one is an ordinary directory');
  assert.equal(isAsarArchive('notes.md'), false);
  assert.equal(isAsarArchive(null), false);
});

test('main.js hands the list to the dev reloader', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'));
  const call = src.match(/require\('electron-reloader'\)\(module,\s*\{[^}]*\}/);
  assert.ok(call, 'the dev reloader is still wired here');
  assert.match(
    call[0],
    /ignore:\s*BUILD_DIR_NAMES/,
    'without this the watcher walks dist/ and holds the packaged app.asar open, and no build can run '
    + 'while a dev instance does — pass `ignore: BUILD_DIR_NAMES` from src/app/build-dirs.js',
  );
});
