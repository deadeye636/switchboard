'use strict';
// #630 — what a `handoffDir`/`planDir` value means with NO project to resolve it against, in `src/shared/`
// because two processes have to answer it the same way.
//
// WHY THIS EXISTS:
//   `src/app/convention-dirs.js` decides containment against the REAL path of both sides, which needs a
//   project and needs the filesystem. Two callers have neither: `conventionDirs(null, eff)`, asked by an
//   insert template for a session with no project, and the welcome tour, which edits the GLOBAL setting
//   before any project exists and redraws its figure synchronously on every keystroke. The tour drew
//   `my-project/ ├─ ../plans/` under a caption promising that is where the next plan goes, while every
//   project would have replaced that value with `.plans` — the tour left as the one surface still claiming
//   a setting applied. That is #623 and #630 one surface over, and the reason the rule is shared rather
//   than written twice.
//
// WHAT THIS DOES NOT COVER:
//   Whether a given PROJECT accepts a name. It is deliberately not a pre-check in front of `isInside`:
//   `../<the project's own name>/.plans` climbs out and lands back in, so a lexical veto would refuse a
//   setting that works on disk. `test/convention-dirs.test.js` owns that half, against the filesystem.

const test = require('node:test');
const assert = require('node:assert/strict');

const { conventionDirNameProblem, unusableConventionDirName } = require('../src/shared/convention-dir-name');

test('a name that climbs out before it enters names something beside the project', () => {
  for (const name of ['..', '../packets', '../../x', '..\\packets', '../a/b']) {
    assert.equal(conventionDirNameProblem(name), 'escapes', name);
  }
});

test('a name that resolves to the project itself is not a directory for either feature', () => {
  // The second group is what a first attempt got wrong: it tested for `..` and called every one of these
  // "outside the project", when each of them lands exactly on the root.
  for (const name of ['.', './', './/.', 'docs/..', 'docs\\..', 'a/b/../..', '..foo/..', 'a/../b/..']) {
    assert.equal(conventionDirNameProblem(name), 'root', name);
  }
});

test('a blank name is not a name', () => {
  for (const name of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(conventionDirNameProblem(name), 'blank', String(name));
  }
});

test('an ordinary relative directory has nothing wrong with it, at any depth', () => {
  for (const name of ['.plans', '.handoffs', 'docs/plans', 'docs\\plans', 'a/b/c', './docs/plans',
    'a/../b', '..foo', 'a..b', '...', 'docs/../plans']) {
    assert.equal(conventionDirNameProblem(name), '', name);
  }
});

// An absolute path pointing inside its project is legal and is spelled back out relative (#623). Whether
// it points inside is a question about a project this module does not have, so it says so rather than
// guessing — and the tour, which has no project either, prints that instead of drawing the path as a
// child of the figure's invented project.
test('an absolute path is reported as unjudgeable, whichever platform spells it', () => {
  for (const name of ['/srv/projects/shop/.plans', '\\\\server\\share\\plans', 'X:/projects/shop/.plans',
    'X:\\projects\\shop\\.plans', 'X:relative']) {
    assert.equal(conventionDirNameProblem(name), 'absolute', name);
  }
});

test('the yes/no wrapper treats an unjudgeable name as usable, and everything else as it reads', () => {
  assert.equal(unusableConventionDirName('/srv/projects/shop/.plans'), false, 'absolute is not a refusal');
  assert.equal(unusableConventionDirName('docs/plans'), false);
  assert.equal(unusableConventionDirName('../packets'), true);
  assert.equal(unusableConventionDirName('docs/..'), true);
  assert.equal(unusableConventionDirName(''), true);
});

// The rule has to be able to fail, or the no-project answer in convention-dirs.js could quietly start
// replacing legal settings. These are the values the defaults and the documented alternatives use.
test('the defaults and the documented alternatives all pass', () => {
  for (const name of ['.plans', '.handoffs', 'docs/handoffs', 'handoffs', '.agent/handoffs', 'docs/plans']) {
    assert.equal(unusableConventionDirName(name), false, name);
  }
});
