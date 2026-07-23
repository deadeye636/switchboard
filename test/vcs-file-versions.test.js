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
const { readWorkingFile } = require('../src/app/vcs');

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
