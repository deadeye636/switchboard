'use strict';
// #477 — revealing a file in the OS file manager asks the same containment question as reading one.
//
// WHY THIS EXISTS:
//   The handler took a path from renderer IPC, resolved it, and handed it to `showItemInFolder`. Nothing
//   said the path belonged to the repository the changes window was showing, or to any project at all —
//   which made it the odd one out on a surface where both readers beside it ask `path-containment.js`.
//
//   It is narrower than those two: it opens a file manager at a location rather than reading anything. So
//   what is pinned here is that the app does not hand the operating system an arbitrary path on a
//   renderer's say-so, and — just as important — that the button still does its job: a file deleted in
//   the working tree is still revealed, because the useful answer there is its folder.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const vcsModule = require('../src/app/vcs');

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

function scratch() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-reveal-')));
}

function link(from, to) {
  try { fs.symlinkSync(to, from, LINK_TYPE); return true; } catch { return false; }
}

// The handler with a shell that records instead of opening anything.
function wire() {
  const revealed = [];
  const handlers = new Map();
  vcsModule.init({
    shell: { showItemInFolder: (p) => revealed.push(p) },
    log: { info() {}, warn() {}, error() {} },
  });
  vcsModule.registerIpc({ on() {}, handle: (channel, fn) => handlers.set(channel, fn) });
  const reveal = (req) => handlers.get('vcs-reveal')(null, req);
  return { reveal, revealed };
}

test('a file in the repository is revealed', () => {
  const root = scratch();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'x');
    const { reveal, revealed } = wire();
    reveal({ cwd: repo, path: 'src/a.txt' });
    assert.deepStrictEqual(revealed, [path.join(repo, 'src', 'a.txt')]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a file deleted in the working tree is still revealed — its folder is the useful answer', () => {
  const root = scratch();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const { reveal, revealed } = wire();
    reveal({ cwd: repo, path: 'src/gone.txt' });
    assert.deepStrictEqual(revealed, [path.join(repo, 'src', 'gone.txt')],
      'refusing this would break what the button does today');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a path outside the working directory is not revealed', () => {
  const root = scratch();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(root, 'secret.txt'), 'not yours');
    const { reveal, revealed } = wire();
    reveal({ cwd: repo, path: '../secret.txt' });
    reveal({ cwd: repo, path: path.join(root, 'secret.txt') });   // an absolute path, the old shape
    assert.deepStrictEqual(revealed, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a junction out of the repository does not smuggle a path past it', () => {
  const root = scratch();
  try {
    const repo = path.join(root, 'repo');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours');
    if (!link(path.join(repo, 'linked'), outside)) assert.fail('could not create a link');
    const { reveal, revealed } = wire();
    reveal({ cwd: repo, path: 'linked/secret.txt' });
    assert.deepStrictEqual(revealed, [], 'spelled inside, and not inside');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a repository reached THROUGH a link still reveals its files', () => {
  const root = scratch();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    const viaLink = path.join(root, 'repo-link');
    if (!link(viaLink, repo)) assert.fail('could not create a link');
    const { reveal, revealed } = wire();
    reveal({ cwd: viaLink, path: 'a.txt' });
    assert.deepStrictEqual(revealed, [path.join(viaLink, 'a.txt')]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a malformed request reveals nothing rather than throwing', () => {
  const { reveal, revealed } = wire();
  reveal(undefined);
  reveal({});
  reveal({ cwd: '', path: 'a.txt' });
  reveal({ cwd: 'C:/x', path: '' });
  reveal({ cwd: 42, path: 'a.txt' });
  assert.deepStrictEqual(revealed, []);
});
