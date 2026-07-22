'use strict';
// #282 lever 1: the cheap change-signal that gates a live-state store read (backends/livestate-cache.js).
// It must move when the db file OR its `-wal` sibling moves (WAL commits land in `-wal` without touching the
// main file's mtime), and it must be a pure stat — never open or read the file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fileSig, dbSignature } = require('../src/backends/livestate-cache');

test('fileSig: a missing file is a stable sentinel, never a throw', () => {
  assert.equal(fileSig(path.join(os.tmpdir(), 'does-not-exist-' + Date.now())), '0:0');
});

test('dbSignature moves when the main file changes, and again when the -wal sibling changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
  const db = path.join(dir, 'store.db');
  try {
    fs.writeFileSync(db, 'a');
    const s0 = dbSignature(db);

    // Same bytes, later mtime -> the signature moves (a write that kept the size still counts).
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(db, later, later);
    const s1 = dbSignature(db);
    assert.notEqual(s1, s0, 'a changed mtime on the main file changes the signature');

    // A WAL commit that does NOT touch the main file: only the -wal moves. The signature must still change.
    fs.writeFileSync(db + '-wal', 'wal-1');
    const s2 = dbSignature(db);
    assert.notEqual(s2, s1, 'a -wal that appeared/grew changes the signature (WAL commits hide from the main file)');

    // Nothing changed -> identical signature (the gate skips the open).
    assert.equal(dbSignature(db), s2, 'no change -> identical signature');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
