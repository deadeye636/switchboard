'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  previewKindForExt,
  mimeForExt,
  extOf,
  fileDirUrl,
  htmlWithBase,
} = require('../src/shared/preview-kind.js');

test('previewKindForExt classifies images', () => {
  for (const e of ['png', 'JPG', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']) {
    assert.equal(previewKindForExt(e), 'image', e);
  }
});

test('previewKindForExt classifies html, markdown, and text', () => {
  assert.equal(previewKindForExt('html'), 'html');
  assert.equal(previewKindForExt('htm'), 'html');
  assert.equal(previewKindForExt('md'), 'markdown');
  assert.equal(previewKindForExt('mdx'), 'markdown');
  assert.equal(previewKindForExt('txt'), 'text');
  assert.equal(previewKindForExt('js'), 'text');
  assert.equal(previewKindForExt(''), 'text');
});

// #465 — a PDF used to classify as text, so its bytes were read as UTF-8 and handed to the source
// editor, Save button and all. Its own kind is what makes the viewer open a view instead.
test('previewKindForExt classifies a pdf as its own kind, not as text', () => {
  assert.equal(previewKindForExt('pdf'), 'pdf');
  assert.equal(previewKindForExt('PDF'), 'pdf');
});

test('the readers that must not decode a pdf as text ask for the kind', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/views/file-panel.js'), 'utf8');
  // The panel picks the reader: a binary kind goes through readFileDataUrl, everything else through the
  // text read. A pdf missing from that branch is the whole of this bug, and it is one word.
  assert.match(panel, /binaryKind === 'image' \|\| binaryKind === 'pdf'/);
  const viewer = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/views/viewer-panel.js'), 'utf8');
  assert.match(viewer, /_previewKind === 'pdf'/, 'the viewer must route a pdf away from the editor');
});

test('mimeForExt maps known types, null otherwise', () => {
  assert.equal(mimeForExt('png'), 'image/png');
  assert.equal(mimeForExt('JPG'), 'image/jpeg');
  assert.equal(mimeForExt('svg'), 'image/svg+xml');
  assert.equal(mimeForExt('html'), 'text/html');
  // Without this the data-url reader hands the PDF over as application/octet-stream, which Chromium
  // downloads rather than displays.
  assert.equal(mimeForExt('pdf'), 'application/pdf');
  assert.equal(mimeForExt('xyz'), null);
});

test('extOf extracts lowercased extension', () => {
  assert.equal(extOf('a/b/C.PNG'), 'png');
  assert.equal(extOf('D:\\x\\Note.MD'), 'md');
  assert.equal(extOf('no-extension'), '');
  assert.equal(extOf('.dotfile'), '');
});

test('fileDirUrl builds a trailing-slash file URL (POSIX + Windows)', () => {
  assert.equal(fileDirUrl('/home/u/site/index.html'), 'file:///home/u/site/');
  assert.equal(fileDirUrl('D:/Example/site/x.html'), 'file:///D:/Example/site/');
  assert.equal(fileDirUrl('D:\\Example\\site\\x.html'), 'file:///D:/Example/site/');
  assert.equal(fileDirUrl('C:/a b/x.html'), 'file:///C:/a%20b/');
  assert.equal(fileDirUrl(''), '');
});

test('htmlWithBase injects <base> into head, html, or the front', () => {
  assert.ok(htmlWithBase('<head></head>', 'file:///d/').startsWith('<head><base href="file:///d/">'));
  assert.match(htmlWithBase('<html><body>x</body></html>', 'file:///d/'), /<html><base href="file:\/\/\/d\/">/);
  assert.ok(htmlWithBase('<p>hi</p>', 'file:///d/').startsWith('<base href="file:///d/"><p>hi</p>'));
  assert.equal(htmlWithBase('<p>hi</p>', ''), '<p>hi</p>');
});
