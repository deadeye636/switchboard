'use strict';

// The untracked-file "diff" read (#285) is the one security-sensitive path in the diff feature — it
// reads a file from disk. These pin the guards: containment, symlink rejection, size cap, binary
// detection. `readUntrackedDiff` is pure (no Electron), so it runs under plain `node --test`.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { readUntrackedDiff } = require('../src/app/vcs');

const mkRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-diff-'));

test('normal untracked file → all-added diff', () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2\n');
    const r = readUntrackedDiff(repo, 'a.txt');
    assert.strictEqual(r.ok, true);
    assert.ok(r.text.includes('+line1') && r.text.includes('+line2'));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('path traversal (..) is blocked', () => {
  const repo = mkRepo();
  try {
    const r = readUntrackedDiff(repo, '../escape.txt');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /outside/i);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('sibling-prefix path is blocked (repo vs repo-evil)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-sib-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(base, 'repo-evil'));
  fs.writeFileSync(path.join(base, 'repo-evil', 'x.txt'), 'nope');
  try {
    const r = readUntrackedDiff(repo, path.join('..', 'repo-evil', 'x.txt'));
    assert.strictEqual(r.ok, false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('directory → note, not a read', () => {
  const repo = mkRepo();
  try {
    fs.mkdirSync(path.join(repo, 'sub'));
    const r = readUntrackedDiff(repo, 'sub');
    assert.strictEqual(r.ok, true);
    assert.match(r.note, /directory/i);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('binary file (NUL byte) → note, not mojibake', () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
    const r = readUntrackedDiff(repo, 'bin');
    assert.strictEqual(r.ok, true);
    assert.match(r.note, /binary/i);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('over-size file → note, never fully read', () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, 'big'), Buffer.alloc(2 * 1024 * 1024 + 16, 0x41));
    const r = readUntrackedDiff(repo, 'big');
    assert.strictEqual(r.ok, true);
    assert.match(r.note, /too large/i);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('symlink escaping the repo is rejected (skipped if unprivileged)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-link-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(base, 'secret.txt'), 'SECRET');
  try {
    let made = false;
    try { fs.symlinkSync(path.join(base, 'secret.txt'), path.join(repo, 'link.txt')); made = true; }
    catch { made = false; }   // Windows without the symlink privilege — skip the assertion
    if (made) {
      const r = readUntrackedDiff(repo, 'link.txt');
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /symlink/i);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
