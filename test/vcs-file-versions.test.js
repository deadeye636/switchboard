'use strict';

// The diff-window's working-copy read (#287) reads a file from disk, so it carries the same guards as
// readUntrackedDiff: containment, symlink rejection, size cap, binary detection — plus it returns raw
// text (not a `+`-prefixed diff) and treats a missing file as an empty side. `readWorkingFile` is pure
// (no Electron), so it runs under plain `node --test`.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readWorkingFile, fileVersions } = require('../src/app/vcs');

const mkRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-fv-'));

test('normal file → raw text, no + prefix', () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2\n');
    const r = readWorkingFile(repo, 'a.txt');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, 'line1\nline2\n');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('missing file (a deletion) → empty side, not an error', () => {
  const repo = mkRepo();
  try {
    const r = readWorkingFile(repo, 'gone.txt');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, '');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('path traversal (..) is blocked', () => {
  const repo = mkRepo();
  try {
    const r = readWorkingFile(repo, '../escape.txt');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /outside/i);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('directory → note, not a read', () => {
  const repo = mkRepo();
  try {
    fs.mkdirSync(path.join(repo, 'sub'));
    const r = readWorkingFile(repo, 'sub');
    assert.strictEqual(r.ok, true);
    assert.match(r.note, /directory/i);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('binary file (NUL byte) → note, not mojibake', () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
    const r = readWorkingFile(repo, 'bin');
    assert.strictEqual(r.ok, true);
    assert.match(r.note, /binary/i);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('over-size file → note, never fully read', () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, 'big'), Buffer.alloc(2 * 1024 * 1024 + 16, 0x41));
    const r = readWorkingFile(repo, 'big');
    assert.strictEqual(r.ok, true);
    assert.match(r.note, /too large/i);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('symlink → note, never followed (skipped if unprivileged)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-fv-link-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(base, 'secret.txt'), 'SECRET');
  try {
    let made = false;
    try { fs.symlinkSync(path.join(base, 'secret.txt'), path.join(repo, 'link.txt')); made = true; }
    catch { made = false; }   // Windows without the symlink privilege — skip the assertion
    if (made) {
      const r = readWorkingFile(repo, 'link.txt');
      assert.strictEqual(r.ok, true);
      assert.match(r.note, /symlink/i);
      assert.ok(!('text' in r), 'must not read the link target');
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// --- fileVersions() branch logic ---------------------------------------------------------------
// The three branches must mirror the inline diff exactly, or the expanded window would show a
// different change than the pane it was opened from: untracked → old empty / new working copy;
// staged → old HEAD / new index (`git diff --cached`); otherwise → old index / new working (`git diff`).
// These stand up a real temp repo, so they need git — skipped where it is not on PATH.

let HAVE_GIT = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { HAVE_GIT = false; }

function mkGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-fv-git-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 'test');    // git does not validate this; keep it non-email-shaped
  run('config', 'user.name', 'test');
  run('config', 'core.autocrlf', 'false');   // pin line endings, or the assertions differ on Windows
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  run('add', 'seed.txt');
  run('commit', '-qm', 'seed');
  return { dir, run };
}

test('fileVersions: unstaged → old is the index, new is the working copy', { skip: !HAVE_GIT }, async () => {
  const { dir, run } = mkGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old\n');
    run('add', 'a.txt');
    run('commit', '-qm', 'add a');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'new\n');          // modified, not staged
    const r = await fileVersions(dir, 'a.txt', 'unstaged', false);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.old, 'old\n');
    assert.strictEqual(r.new, 'new\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fileVersions: staged → old is HEAD, new is the index', { skip: !HAVE_GIT }, async () => {
  const { dir, run } = mkGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old\n');
    run('add', 'a.txt');
    run('commit', '-qm', 'add a');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
    run('add', 'a.txt');                                          // staged
    fs.writeFileSync(path.join(dir, 'a.txt'), 'working\n');        // and modified again on top
    const r = await fileVersions(dir, 'a.txt', 'staged', true);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.old, 'old\n', 'staged side compares against HEAD');
    assert.strictEqual(r.new, 'staged\n', 'staged side shows the INDEX, not the working copy');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fileVersions: untracked → old empty, new is the file', { skip: !HAVE_GIT }, async () => {
  const { dir } = mkGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'u.txt'), 'brand new\n');
    const r = await fileVersions(dir, 'u.txt', 'untracked', false);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.old, '');
    assert.strictEqual(r.new, 'brand new\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fileVersions: a staged ADD has no HEAD version → empty old side, not an error', { skip: !HAVE_GIT }, async () => {
  const { dir, run } = mkGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'b.txt'), 'added\n');
    run('add', 'b.txt');
    const r = await fileVersions(dir, 'b.txt', 'staged', true);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.old, '');
    assert.strictEqual(r.new, 'added\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fileVersions: a working-tree deletion → old is the index, new empty', { skip: !HAVE_GIT }, async () => {
  const { dir, run } = mkGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'doomed\n');
    run('add', 'a.txt');
    run('commit', '-qm', 'add a');
    fs.rmSync(path.join(dir, 'a.txt'));
    const r = await fileVersions(dir, 'a.txt', 'unstaged', false);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.old, 'doomed\n');
    assert.strictEqual(r.new, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fileVersions: a non-repo directory is refused', async () => {
  const dir = mkRepo();
  try {
    const r = await fileVersions(dir, 'a.txt', 'unstaged', false);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /no diff support/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
