'use strict';
// #474 — containment is decided on the REAL path, not on how it was spelled.
//
// WHY THIS EXISTS:
//   Several places decide whether a path is inside a project before reading, writing or deleting there:
//   the plan directories, the handoff directories, and the folder someone picks after a refused handoff
//   write. All of them used to compare strings — resolve, then `startsWith` — which answers whether a
//   path is SPELLED inside the project. A directory that is itself a junction or a symbolic link passes
//   that check while its contents sit somewhere else entirely.
//
//   On Windows this is ordinary: a `subst` drive, a redirected folder, a linked `node_modules`. So the
//   escape is tested with a real junction on disk rather than with a mocked filesystem — a string-compare
//   implementation passes every mock of this and fails the moment a link exists.
//
//   The other half is just as easy to get wrong in the other direction: a project reached THROUGH a link
//   is a legitimate layout and must keep working, and a write target that does not exist yet is normal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isInside, isAtOrInside, realPathish } = require('../src/app/path-containment');

const WIN = process.platform === 'win32';
const LINK_TYPE = WIN ? 'junction' : 'dir';

// One temp root for the whole file, removed at the end. Resolved with `realpathSync.native` first, for two
// reasons the temp directory itself supplies: macOS hands out `/var/...` for a directory whose real path is
// `/private/var/...`, and Windows hands out a path with 8.3 short names in it. Both would otherwise turn
// every comparison in this file into a test of the normalisation rather than of the containment.
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-contain-')));
const PROJECT = path.join(ROOT, 'project');
const OUTSIDE = path.join(ROOT, 'elsewhere');

fs.mkdirSync(path.join(PROJECT, 'docs'), { recursive: true });
fs.mkdirSync(path.join(OUTSIDE, 'secrets'), { recursive: true });

test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

// A link that could not be created (a platform or a policy that refuses one) must not read as a pass:
// the test says so out loud instead.
function link(from, to) {
  try { fs.symlinkSync(to, from, LINK_TYPE); return true; } catch { return false; }
}

test('an ordinary directory inside the project is inside it', () => {
  assert.equal(isInside(path.join(PROJECT, 'docs'), PROJECT), true);
  assert.equal(isInside(path.join(PROJECT, 'docs', 'handoffs'), PROJECT), true,
    'a write target that does not exist yet is the normal case, not an error');
});

test('a sibling whose name merely starts the same way is not inside', () => {
  assert.equal(isInside(PROJECT + '-other', PROJECT), false,
    'the separator is what makes it a child; "project-other" is a different project');
});

test('the project root is at-or-inside itself, and strictly inside nothing', () => {
  assert.equal(isAtOrInside(PROJECT, PROJECT), true);
  assert.equal(isInside(PROJECT, PROJECT), false);
});

test('a path that climbs out with .. is refused', () => {
  assert.equal(isInside(path.join(PROJECT, '..', 'elsewhere'), PROJECT), false);
});

test('a junction pointing out of the project does NOT count as inside it', () => {
  const escape = path.join(PROJECT, 'linked');
  if (!link(escape, path.join(OUTSIDE, 'secrets'))) {
    assert.fail('could not create a link — this is the case the whole issue is about');
  }
  assert.equal(escape.startsWith(PROJECT + path.sep), true, 'it IS spelled inside — that was the bug');
  assert.equal(isInside(escape, PROJECT), false, 'and it is not actually inside');
  assert.equal(isAtOrInside(escape, PROJECT), false);
  assert.equal(isInside(path.join(escape, 'key.txt'), PROJECT), false,
    'a file under the link escapes with it, existing or not');
});

test('a project reached THROUGH a link still works — this refuses an escape, not a layout', () => {
  const viaLink = path.join(ROOT, 'project-link');
  if (!link(viaLink, PROJECT)) assert.fail('could not create a link');
  // The project addressed through the link, its contents addressed directly: both resolve to the same
  // real directory, so the answer is yes from either side.
  assert.equal(isInside(path.join(PROJECT, 'docs'), viaLink), true);
  assert.equal(isInside(path.join(viaLink, 'docs'), PROJECT), true);
  assert.equal(isAtOrInside(viaLink, PROJECT), true);
});

test('a link that stays inside the project is still inside it', () => {
  const inner = path.join(PROJECT, 'shortcut');
  if (!link(inner, path.join(PROJECT, 'docs'))) assert.fail('could not create a link');
  assert.equal(isInside(inner, PROJECT), true);
});

test('trailing separators do not change the answer', () => {
  assert.equal(isInside(path.join(PROJECT, 'docs') + path.sep, PROJECT + path.sep), true);
  assert.equal(isAtOrInside(PROJECT + path.sep, PROJECT), true);
});

test('an empty side is refused rather than resolved to the working directory', () => {
  // `path.resolve('')` is the process's CWD, so an unguarded empty parent would quietly mean "is this
  // inside wherever the app is running from" — and answer yes for anything under it.
  assert.equal(isInside('', PROJECT), false);
  assert.equal(isInside(null, PROJECT), false);
  assert.equal(isAtOrInside(PROJECT, ''), false, 'an empty parent contains nothing');
  assert.equal(isAtOrInside(PROJECT, null), false);
  assert.equal(isAtOrInside(PROJECT, '   '), false, 'nor does a parent of whitespace');
  // The one that would have passed by coincidence before: a child genuinely under the CWD.
  assert.equal(isAtOrInside(path.join(process.cwd(), 'anything'), ''), false);
  assert.equal(isInside(path.join(process.cwd(), 'anything'), ''), false);
});

test('realPathish keeps the part that does not exist and resolves the part that does', () => {
  const deep = path.join(PROJECT, 'docs', 'not', 'there', 'yet.md');
  assert.equal(realPathish(deep), deep);
  assert.equal(realPathish(path.join(PROJECT, 'docs')), path.join(PROJECT, 'docs'));
});

test('on Windows, case does not change the answer', { skip: !WIN }, () => {
  assert.equal(isInside(path.join(PROJECT, 'docs').toUpperCase(), PROJECT.toLowerCase()), true);
  assert.equal(isAtOrInside(PROJECT.toUpperCase(), PROJECT.toLowerCase()), true);
});

test('on Windows, a forward slash is the same separator', { skip: !WIN }, () => {
  assert.equal(isInside(PROJECT.split('\\').join('/') + '/docs', PROJECT), true);
});
