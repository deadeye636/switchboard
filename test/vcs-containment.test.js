'use strict';
// #476 — the two working-copy readers decide containment on the REAL path, not on how it was spelled.
//
// WHY THIS EXISTS:
//   Both readers checked the prefix and then rejected the result if `lstat` said it was a symbolic link.
//   `lstat` only inspects the FINAL component of a path — every component before it has already been
//   followed by the operating system. So a relative path whose directory is a junction pointing out of
//   the repository, with an ordinary file at the target, passed the prefix check, passed the symlink
//   check, and was read.
//
//   Both functions take their cwd and their relative path from renderer IPC, and nothing verifies the
//   path came from a `git status` listing.
//
//   The escape is therefore built with a real link on disk: a string-compare implementation passes every
//   mock of this and fails the moment one exists. And the two directions that must NOT change are pinned
//   beside it — a repository legitimately reached through a link still works, and a leaf that is itself a
//   link is still refused with the wording it already had.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { readUntrackedDiff, readWorkingFile, fileVersions } = require('../src/app/vcs');

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

// `realpathSync.native` on the temp root: macOS answers `/var/...` for a directory whose real path is
// `/private/var/...`, and Windows hands back 8.3 short names. Either would make this a test of the
// normalisation rather than of the containment.
function scratch() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-contain-')));
}

function link(from, to) {
  try { fs.symlinkSync(to, from, LINK_TYPE); return true; } catch { return false; }
}

test('a junctioned DIRECTORY under the repo does not smuggle its file in', () => {
  const root = scratch();
  try {
    const repo = path.join(root, 'repo');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours\n');
    if (!link(path.join(repo, 'linked'), outside)) {
      assert.fail('could not create a link — this is the case the whole issue is about');
    }

    // Spelled inside, and `lstat` on the leaf sees an ordinary file: both of the old guards said yes.
    const abs = path.resolve(repo, 'linked/secret.txt');
    assert.ok(abs.startsWith(repo + path.sep), 'it IS spelled inside — that was the bug');
    assert.strictEqual(fs.lstatSync(abs).isSymbolicLink(), false, 'and the leaf is not a link');

    const untracked = readUntrackedDiff(repo, 'linked/secret.txt');
    assert.strictEqual(untracked.ok, false);
    assert.strictEqual(untracked.error, 'Path outside repository');
    assert.strictEqual(untracked.text, undefined, 'nothing was read');

    const working = readWorkingFile(repo, 'linked/secret.txt');
    assert.strictEqual(working.ok, false);
    assert.strictEqual(working.error, 'Path outside repository');
    assert.strictEqual(working.text, undefined, 'nothing was read');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a MISSING file behind a junction is refused, not answered as a deletion', async () => {
  // The narrower half of the same hole. `readWorkingFile` answers a missing file with an empty side —
  // that is how a deletion renders — so a check that ran after the stat would never see a path that
  // escaped the repository and had nothing at the end of it. It would come back indistinguishable from
  // a file legitimately deleted inside the project.
  const root = scratch();
  try {
    const repo = path.join(root, 'repo');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    if (!link(path.join(repo, 'linked'), outside)) assert.fail('could not create a link');

    const working = readWorkingFile(repo, 'linked/never-existed.txt');
    assert.strictEqual(working.ok, false);
    assert.strictEqual(working.error, 'Path outside repository');
    assert.strictEqual(working.text, undefined, 'not an empty side');

    const versions = await fileVersions(repo, 'linked/never-existed.txt', 'untracked', false);
    assert.strictEqual(versions.ok, false);
    assert.strictEqual(versions.error, 'Path outside repository');

    // And the case it must not be confused with: a file that is simply gone from inside the project.
    assert.deepStrictEqual(readWorkingFile(repo, 'deleted.txt'), { ok: true, text: '' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a link that stays inside the repository is still read', () => {
  const root = scratch();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'hello\n');
    if (!link(path.join(repo, 'shortcut'), path.join(repo, 'src'))) assert.fail('could not create a link');

    const r = readWorkingFile(repo, 'shortcut/a.txt');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, 'hello\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a repository reached THROUGH a link still works — this refuses an escape, not a layout', () => {
  const root = scratch();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    const viaLink = path.join(root, 'repo-link');
    if (!link(viaLink, repo)) assert.fail('could not create a link');

    const r = readWorkingFile(viaLink, 'a.txt');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, 'hello\n');
    assert.strictEqual(readUntrackedDiff(viaLink, 'a.txt').ok, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a leaf that IS a link keeps the answer it already gave', (t) => {
  const root = scratch();
  try {
    const repo = path.join(root, 'repo');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours\n');
    let made = false;
    try { fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'leaf.txt'), 'file'); made = true; }
    catch { made = false; }
    // A file symlink needs a privilege the junction above does not. Said out loud rather than returned
    // quietly: a test that skips itself in silence reads as a pass on the machine where it matters.
    if (!made) { t.skip('this machine may not create a file symlink'); return; }

    // The wording is the point: a link is something the user can see and fix, and calling it "outside"
    // would describe the wrong problem.
    assert.strictEqual(readUntrackedDiff(repo, 'leaf.txt').error, 'Symlink — not previewed.');
    assert.strictEqual(readWorkingFile(repo, 'leaf.txt').note, 'Symlink — not previewed.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an ordinary path is unchanged', () => {
  const root = scratch();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'deep', 'er'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'deep', 'er', 'a.txt'), 'x\ny\n');
    const r = readUntrackedDiff(repo, 'deep/er/a.txt');
    assert.strictEqual(r.ok, true);
    assert.ok(r.text.includes('+x'));
    assert.strictEqual(readWorkingFile(repo, 'deep/er/a.txt').text, 'x\ny\n');
    // A deletion is still an empty side rather than an error.
    assert.deepStrictEqual(readWorkingFile(repo, 'deep/er/gone.txt'), { ok: true, text: '' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the diff window is told a read was refused, not handed an empty side', async () => {
  // The failure this prevents: a refusal rendered as `new: ''` reads as "the file is empty", which is
  // exactly the confusion the `gitShow` path already documents. An ABSENT version — an added file with no
  // HEAD side — carries no wording and still renders as an empty side, so the two stay distinguishable.
  const root = scratch();
  try {
    const repo = path.join(root, 'repo');
    const outside = path.join(root, 'outside');
    // `fileVersions` asks which provider owns the directory before it reads anything, and the git
    // provider answers from a `.git` marker alone — no spawn, so the marker is all this needs.
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours\n');
    if (!link(path.join(repo, 'linked'), outside)) assert.fail('could not create a link');

    const r = await fileVersions(repo, 'linked/secret.txt', 'untracked', false);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'Path outside repository');
    assert.strictEqual(r.new, undefined, 'not an empty side — a refusal');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
