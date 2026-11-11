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

const MAC_FILE_URL = 'electron application/osclipboard;format="public.file-url"';

// A ClipboardItem stand-in: `types` and an async `getType` returning a Blob, as Electron 44+ hands them.
function item(parts) {
  return {
    types: Object.keys(parts),
    getType: async (type) => new Blob([parts[type]]),
  };
}

function setup(t, { items = [], text = '', readFails = false, imagePath = null, onImage } = {}) {
  const calls = { image: 0, text: 0, read: 0 };
  clipboardInsert.init({
    clipboard: {
      read: async () => { calls.read++; if (readFails) throw new Error('clipboard busy'); return items; },
      readText: async () => { calls.text++; return text; },
    },
    saveImageFromItems: async (got) => { calls.image++; calls.items = got; return onImage ? onImage() : imagePath; },
    log: { info() {}, warn() {}, debug() {}, error() {} },
  });
  return calls;
}

const fileUrl = (file) => 'file://' + file.replace(/\\/g, '/').replace(/^([a-z]):/i, '/$1:');

// A real file, so the existence check has something to find. A path to nothing is not a file (see below).
function realFile(t, name = 'copied.txt') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-clip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x');
  return file;
}

// --- the ladder ----------------------------------------------------------------

test('a copied file wins over everything else, read from the uri-list the Windows clipboard carries', async (t) => {
  const file = realFile(t);
  // Measured on Windows 11 / Electron 45: one item with the uri-list and the raw ANSI FileName, no FileNameW.
  const calls = setup(t, {
    items: [item({ 'text/uri-list': fileUrl(file) + '\r\n', 'electron application/osclipboard;format="FileName"': file })],
    text: file,
    imagePath: '/tmp/snapshot.png',
  });

  assert.deepEqual(await clipboardInsert.readClipboardInsert(), { kind: 'file', path: file });
  assert.equal(calls.read, 1, 'the clipboard is read once');
  assert.equal(calls.image, 0, 'a real path beats a snapshot — the bitmap is not even asked for');
  assert.equal(calls.text, 0);
});

test('the uri-list may carry comment lines; the first file:// URL is the answer', async (t) => {
  const file = realFile(t);
  setup(t, { items: [item({ 'text/uri-list': `# comment\r\n${fileUrl(file)}\r\n` })] });
  assert.deepEqual(await clipboardInsert.readClipboardInsert(), { kind: 'file', path: file });
});

test('a macOS file-url is the fallback (format name not measured)', async (t) => {
  const file = realFile(t);
  setup(t, { items: [item({ [MAC_FILE_URL]: fileUrl(file) })] });
  assert.deepEqual(await clipboardInsert.readClipboardInsert(), { kind: 'file', path: file });
});

test('a path to nothing is not a file — a stale entry falls through instead of inserting a dead path', async (t) => {
  const calls = setup(t, {
    // Built at run time, so the source names no drive: a file URL to a path that does not exist.
    items: [item({ 'text/uri-list': require('url').pathToFileURL(path.join(os.tmpdir(), 'sb-clip-gone', 'deleted.txt')).href })],
    text: 'plain text',
  });

  assert.deepEqual(await clipboardInsert.readClipboardInsert(), { kind: 'text', text: 'plain text' });
  assert.equal(calls.image, 1, 'the bitmap is still offered its turn');
});

test('a bitmap with nothing behind it is written to disk and named by its path', async (t) => {
  const png = item({ 'image/png': 'PNGBYTES' });
  const calls = setup(t, { items: [png], imagePath: '/tmp/paste-1.png' });
  assert.deepEqual(await clipboardInsert.readClipboardInsert(), { kind: 'image', path: '/tmp/paste-1.png' });
  assert.deepEqual(calls.items, [png], 'the items already read are handed on, not read again');
  assert.equal(calls.read, 1);
});

test('plain text falls through to readText', async (t) => {
  setup(t, { items: [item({ 'text/plain': 'hello' })], text: 'hello' });
  assert.deepEqual(await clipboardInsert.readClipboardInsert(), { kind: 'text', text: 'hello' });
});

test('an empty clipboard resolves to nothing, not to an error', async (t) => {
  setup(t, { items: [], text: '' });
  // A template usually names {clipboard} beside tokens that do have an answer.
  assert.deepEqual(await clipboardInsert.readClipboardInsert(), { kind: 'text', text: '' });
});

test('an item that is offered but unreadable does not take the whole insert down', async (t) => {
  setup(t, {
    items: [{ types: ['text/uri-list'], getType: async () => { throw new Error('gone'); } }],
    text: 'fallback',
    onImage: () => { throw new Error('no bitmap here'); },
  });
  assert.deepEqual(await clipboardInsert.readClipboardInsert(), { kind: 'text', text: 'fallback' });
});

test('a clipboard that cannot even be read still answers with its text', async (t) => {
  setup(t, { readFails: true, text: 'still here' });
  assert.deepEqual(await clipboardInsert.readClipboardInsert(), { kind: 'text', text: 'still here' });
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
