'use strict';
// What the system clipboard hands a `{clipboard}` insert (#491) — src/app/clipboard-insert.js.
//
// The module answers one question with three possible answers, and they are not interchangeable: a copied
// FILE has a path and nothing else, a screenshot has bytes and no path, and text is text. Getting the order
// or the reading wrong is silent — the insert still lands, it just carries the wrong thing.
//
// It stays Electron-free (the clipboard and the image writer come in through `init`), which is the only
// reason any of this is reachable from `node --test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const clipboardInsert = require('../src/app/clipboard-insert');

function setup(t, { formats = [], reads = {}, buffers = {}, text = '', image = null, onImage } = {}) {
  const calls = { image: 0, text: 0, read: [], buffer: [] };
  clipboardInsert.init({
    clipboard: {
      availableFormats: () => formats,
      read: (fmt) => { calls.read.push(fmt); return reads[fmt] ?? ''; },
      readBuffer: (fmt) => { calls.buffer.push(fmt); return buffers[fmt] ?? Buffer.alloc(0); },
      readText: () => { calls.text++; return text; },
    },
    saveClipboardImage: () => { calls.image++; return onImage ? onImage() : image; },
    log: { info() {}, warn() {}, debug() {}, error() {} },
  });
  return calls;
}

// A real file, so the existence check has something to find. A path to nothing is not a file (see below).
function realFile(t, name = 'copied.txt') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-clip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x');
  return file;
}

// --- the ladder ----------------------------------------------------------------

test('a copied file wins over everything else, and is read from the Windows format', (t) => {
  const file = realFile(t);
  const calls = setup(t, {
    formats: ['FileNameW', 'text/plain'],
    // FileNameW is UTF-16 and NUL-terminated: read as text it comes back with the NULs in it, and a path
    // with a NUL in it opens nothing.
    buffers: { FileNameW: Buffer.from(file + '\u0000\u0000', 'ucs2') },
    text: file,
    image: '/tmp/snapshot.png',
  });

  assert.deepEqual(clipboardInsert.readClipboardInsert(), { kind: 'file', path: file });
  assert.equal(calls.image, 0, 'a real path beats a snapshot — the bitmap is not even asked for');
  assert.equal(calls.text, 0);
});

test('a macOS file-url and a Linux uri-list name the same thing', (t) => {
  const file = realFile(t);
  const asUrl = 'file://' + file.replace(/\\/g, '/').replace(/^([a-z]):/i, '/$1:');

  setup(t, { formats: ['public.file-url'], reads: { 'public.file-url': asUrl } });
  assert.deepEqual(clipboardInsert.readClipboardInsert(), { kind: 'file', path: file });

  // A uri-list is line-separated and may carry comment lines; the first file:// URL is the answer.
  setup(t, { formats: ['text/uri-list'], reads: { 'text/uri-list': `# comment\n${asUrl}\n` } });
  assert.deepEqual(clipboardInsert.readClipboardInsert(), { kind: 'file', path: file });
});

test('a path to nothing is not a file — a stale entry falls through instead of inserting a dead path', (t) => {
  const calls = setup(t, {
    formats: ['FileNameW'],
    buffers: { FileNameW: Buffer.from('C:\\gone\\deleted.txt\u0000', 'ucs2') },
    text: 'plain text',
  });

  assert.deepEqual(clipboardInsert.readClipboardInsert(), { kind: 'text', text: 'plain text' });
  assert.equal(calls.image, 1, 'the bitmap is still offered its turn');
});

test('a bitmap with nothing behind it is written to disk and named by its path', (t) => {
  setup(t, { formats: ['image/png'], image: '/tmp/paste-1.png' });
  assert.deepEqual(clipboardInsert.readClipboardInsert(), { kind: 'image', path: '/tmp/paste-1.png' });
});

test('an empty clipboard resolves to nothing, not to an error', (t) => {
  setup(t, { formats: [], text: '' });
  // A template usually names {clipboard} beside tokens that do have an answer.
  assert.deepEqual(clipboardInsert.readClipboardInsert(), { kind: 'text', text: '' });
});

test('a format that is offered but unreadable does not take the whole insert down', (t) => {
  setup(t, {
    formats: ['FileNameW'],
    text: 'fallback',
    onImage: () => { throw new Error('no bitmap here'); },
  });
  // readBuffer returns an empty buffer → no path; the image reader throws → both are stepped over.
  assert.deepEqual(clipboardInsert.readClipboardInsert(), { kind: 'text', text: 'fallback' });
});

test('a clipboard that cannot even be asked what it holds still answers', (t) => {
  clipboardInsert.init({
    clipboard: {
      availableFormats: () => { throw new Error('clipboard busy'); },
      readText: () => 'still here',
    },
    saveClipboardImage: () => null,
    log: { info() {}, warn() {}, debug() {}, error() {} },
  });
  assert.deepEqual(clipboardInsert.readClipboardInsert(), { kind: 'text', text: 'still here' });
});

// --- fileUrlToPath -------------------------------------------------------------

test('fileUrlToPath: the three shapes a file URL comes in', () => {
  const f = clipboardInsert.fileUrlToPath;
  // A Windows drive arrives as /C:/x — the leading slash belongs to the URL, not to the path.
  assert.equal(f('file:///C:/Users/x/a%20file.txt'), 'C:\\Users\\x\\a file.txt');
  assert.equal(f('file:///home/someone/notes.md'), '/home/someone/notes.md');
  assert.equal(f('file://localhost/home/someone/notes.md'), '/home/someone/notes.md');
  // A host that is not this machine names a share, and a share is only reachable as a UNC path.
  assert.equal(f('file://server/share/report.pdf'), '\\\\server\\share\\report.pdf');
});

test('fileUrlToPath: anything that is not a file URL is not a file', () => {
  const f = clipboardInsert.fileUrlToPath;
  for (const notAFile of ['https://example.com/x', 'C:\\Users\\x', '', null, undefined, 'file://', 'mailto:a@b']) {
    assert.equal(f(notAFile), null, String(notAFile));
  }
  // A malformed percent-escape must not throw out of the reader.
  assert.equal(f('file:///tmp/%E0%A4%A'), null);
});
