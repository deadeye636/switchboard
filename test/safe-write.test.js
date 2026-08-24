'use strict';
// #441 — the one way this app overwrites a file somebody else also owns.
//
// Each case here is a way a save went wrong before this module existed, or would if it were dropped: a
// CRLF file rewritten line by line, a BOM lost out of a settings file a CLI still reads, a stale editor
// silently winning over an agent's twenty minutes of work, half a config on disk because a rename was a
// write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeTextFile, encodingOf, applyEncoding } = require('../src/app/safe-write');

const BOM = '﻿';

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-write-'));
  const file = path.join(dir, name);
  if (content !== undefined) fs.writeFileSync(file, content, 'utf8');
  return file;
}

const read = (file) => fs.readFileSync(file, 'utf8');

test('a CRLF file keeps its line endings, however the editor hands the text back', () => {
  // CodeMirror normalises to LF, so without this every line of a Windows file changes on the first save
  // — churn in git and in a file the CLI re-reads.
  const file = tmpFile('CLAUDE.md', 'one\r\ntwo\r\nthree\r\n');
  const result = writeTextFile(file, 'one\ntwo\nfour\n');
  assert.equal(result.ok, true);
  assert.equal(read(file), 'one\r\ntwo\r\nfour\r\n');
});

test('an LF file is not given CRLF, whatever the platform', () => {
  const file = tmpFile('notes.md', 'a\nb\n');
  writeTextFile(file, 'a\r\nb\r\nc\r\n');
  assert.equal(read(file), 'a\nb\nc\n');
});

test('a BOM survives the round trip, and one is not invented', () => {
  const withBom = tmpFile('settings.json', BOM + '{\n  "a": 1\n}\n');
  writeTextFile(withBom, '{\n  "a": 2\n}\n');
  assert.equal(read(withBom).startsWith(BOM), true, 'the CLI still reads this file');

  const without = tmpFile('plain.json', '{}\n');
  writeTextFile(without, '{ "a": 1 }\n');
  assert.equal(read(without).startsWith(BOM), false);
});

test('a write is refused when the file no longer holds what the caller last saw', () => {
  const file = tmpFile('skill.md', 'original\n');
  fs.writeFileSync(file, 'somebody else wrote this\n', 'utf8');
  const result = writeTextFile(file, 'my version\n', { expectPrevious: 'original\n' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'stale');
  assert.equal(result.conflict, true);
  assert.equal(result.diskContent, 'somebody else wrote this\n', 'the caller can resolve without reading again');
  assert.equal(read(file), 'somebody else wrote this\n', 'and nothing was overwritten');
});

test('the same content with and without a BOM is not a conflict', () => {
  const file = tmpFile('settings.json', BOM + '{"a":1}\n');
  const result = writeTextFile(file, '{"a":2}\n', { expectPrevious: '{"a":1}\n' });
  assert.equal(result.ok, true, 'a reader that decoded the BOM away must still be able to save');
});

test('no baseline means no staleness check — a caller that has none is not blocked', () => {
  const file = tmpFile('scratch.md', 'whatever\n');
  assert.equal(writeTextFile(file, 'new\n', { expectPrevious: null }).ok, true);
  assert.equal(read(file), 'new\n');
});

test('an edit refuses a file that is not there; a create does not', () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-write-')), 'gone.md');
  assert.equal(writeTextFile(missing, 'x\n').code, 'missing');
  assert.equal(fs.existsSync(missing), false);

  assert.equal(writeTextFile(missing, 'x\n', { mustExist: false }).ok, true);
  assert.equal(read(missing), 'x\n');
});

test('validation runs before anything is written, and its message is kept', () => {
  const file = tmpFile('settings.json', '{"a":1}\n');
  const result = writeTextFile(file, 'not json', {
    validate: (text) => (text.startsWith('{') ? { ok: true } : { ok: false, error: 'Unexpected token at line 1' }),
  });
  assert.equal(result.code, 'invalid');
  assert.match(result.error, /line 1/);
  assert.equal(read(file), '{"a":1}\n', 'the file is untouched');
});

test('a validator that throws refuses the write, without repeating what it threw', () => {
  // An unanswered check is a no. And the thrown text is not passed on: a parser's own message can carry
  // the path it was reading, which is the one thing a message shown in the app must not.
  const file = tmpFile('settings.json', '{}\n');
  const result = writeTextFile(file, 'x', {
    validate: () => { throw new Error('parser exploded on C:/Users/someone/settings.json'); },
  });
  assert.equal(result.code, 'invalid');
  assert.doesNotMatch(result.error, /Users|parser exploded/);
  assert.equal(read(file), '{}\n');
});

test('the write goes through a temp file in the same directory and leaves none behind', () => {
  const file = tmpFile('config.toml', 'a = 1\n');
  const dir = path.dirname(file);
  writeTextFile(file, 'a = 2\n');
  assert.deepEqual(fs.readdirSync(dir), ['config.toml'], 'no .tmp file survives a successful write');
});

test('a locked target is retried, and a save that only just missed still lands', () => {
  const file = tmpFile('busy.md', 'old\n');
  let attempts = 0;
  const result = writeTextFile(file, 'new\n', {
    rename: (from, to) => {
      attempts += 1;
      if (attempts < 3) {                       // the scanner still has the handle
        const err = new Error('EPERM'); err.code = 'EPERM'; throw err;
      }
      fs.renameSync(from, to);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
  assert.equal(read(file), 'new\n');
});

test('a rename that keeps failing gives up, says so, and cleans up its temp file', () => {
  const file = tmpFile('locked.md', 'old\n');
  const dir = path.dirname(file);
  const result = writeTextFile(file, 'new\n', {
    rename: () => { const err = new Error('EPERM'); err.code = 'EPERM'; throw err; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed');
  assert.equal(result.error, undefined, 'the errno text is the caller\'s to word, never a message from here');
  assert.equal(result.cause && result.cause.code, 'EPERM');
  assert.equal(read(file), 'old\n', 'a failed save leaves the old file intact, never half of the new one');
  assert.deepEqual(fs.readdirSync(dir), ['locked.md']);
});

test('an error that is not a lock is not retried', () => {
  const file = tmpFile('x.md', 'old\n');
  let attempts = 0;
  writeTextFile(file, 'new\n', {
    rename: () => { attempts += 1; const err = new Error('ENOSPC'); err.code = 'ENOSPC'; throw err; },
  });
  assert.equal(attempts, 1, 'a full disk does not get better by waiting');
});

test('the encoding helpers answer a mixed file by what it mostly uses', () => {
  assert.deepEqual(encodingOf('a\r\nb\r\nc\n'), { bom: false, eol: '\r\n' });
  assert.deepEqual(encodingOf('a\nb\nc\r\n'), { bom: false, eol: '\n' });
  assert.deepEqual(encodingOf(BOM + 'a\n'), { bom: true, eol: '\n' });
  assert.equal(applyEncoding('a\nb', { bom: true, eol: '\r\n' }), BOM + 'a\r\nb');
  assert.equal(applyEncoding(BOM + 'a\r\nb', { bom: false, eol: '\n' }), 'a\nb');
});

test('the written text is what comes back, so a caller can move its baseline to it', () => {
  const file = tmpFile('CLAUDE.md', 'a\r\n');
  const result = writeTextFile(file, 'a\nb\n');
  assert.equal(result.content, 'a\r\nb\r\n', 'not the text handed in — the text on disk');
  assert.equal(result.content, read(file));
  assert.ok(result.mtimeMs > 0);
});

test('a directory where a file belongs is a failure, not a missing file', () => {
  // The distinction is what the user is told: "no longer there" sends them looking for something that
  // never left. The errno goes back unworded, for the caller to translate.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-write-'));
  const blocked = path.join(dir, 'CLAUDE.md');
  fs.mkdirSync(blocked);
  const result = writeTextFile(blocked, 'text');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed');
  assert.equal(result.cause && result.cause.code, 'EISDIR');
});
