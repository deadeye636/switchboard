const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DOCUMENT_KINDS, kindOfPath, documentElement, isDocumentElement } = require('../src/backends/document-ref');

test('kindOfPath: pdf, image, markdown, html, case-insensitive', () => {
  assert.equal(kindOfPath('/p/a.pdf'), 'pdf');
  assert.equal(kindOfPath('/p/a.PNG'), 'image');
  assert.equal(kindOfPath('/p/a.md'), 'markdown');
  assert.equal(kindOfPath('/p/a.htm'), 'html');
});

test('kindOfPath: other kinds, blank and non-string are null', () => {
  assert.equal(kindOfPath('/p/a.js'), null);
  assert.equal(kindOfPath('/p/Makefile'), null);
  assert.equal(kindOfPath('/p/dir.pdf/'), null);
  assert.equal(kindOfPath('/p/dir.pdf\\'), null);
  for (const v of ['', '   ', null, undefined, 42, {}]) assert.equal(kindOfPath(v), null);
});

test('documentElement: shape for each kind, Windows and POSIX spelling', () => {
  assert.deepEqual(documentElement({ path: '/p/x/doc.pdf', pages: 3 }),
    { type: 'document', path: '/p/x/doc.pdf', kind: 'pdf', name: 'doc.pdf', pages: 3 });
  assert.deepEqual(documentElement({ path: 'p\\x\\shot.png', pages: 1 }),
    { type: 'document', path: 'p\\x\\shot.png', kind: 'image', name: 'shot.png', pages: 1 });
  assert.equal(documentElement({ path: '/p/README.md' }).kind, 'markdown');
  assert.equal(documentElement({ path: 'p/x/index.html' }).name, 'index.html');
});

test('documentElement: no path, or no document kind, yields null (no element without a file)', () => {
  assert.equal(documentElement(), null);
  assert.equal(documentElement({}), null);
  assert.equal(documentElement({ pages: 2 }), null);
  assert.equal(documentElement({ path: '', pages: 2 }), null);
  assert.equal(documentElement({ path: '  ', kind: 'image', pages: 1 }), null);
  assert.equal(documentElement({ path: '/p/a.js', pages: 1 }), null);
  assert.equal(documentElement({ path: 42, kind: 'pdf' }), null);
});

test('documentElement: a kind that contradicts the extension is refused, a matching one accepted', () => {
  assert.equal(documentElement({ path: '/p/a.pdf', kind: 'image' }), null);
  assert.equal(documentElement({ path: '/p/a.pdf', kind: 'text' }), null);
  assert.equal(documentElement({ path: '/p/a.pdf', kind: 'pdf' }).kind, 'pdf');
});

test('documentElement: pages is a non-negative integer, else 0', () => {
  assert.equal(documentElement({ path: '/p/a.pdf' }).pages, 0);
  for (const v of [-1, 1.5, NaN, '3', null]) assert.equal(documentElement({ path: '/p/a.pdf', pages: v }).pages, 0);
  assert.equal(documentElement({ path: '/p/a.pdf', pages: 0 }).pages, 0);
});

test('isDocumentElement: accepts what documentElement builds, rejects everything else', () => {
  for (const p of ['/a.pdf', '/a.png', '/a.md', '/a.html']) assert.ok(isDocumentElement(documentElement({ path: p, pages: 1 })));
  assert.equal(isDocumentElement(null), false);
  assert.equal(isDocumentElement('document'), false);
  assert.equal(isDocumentElement({ type: 'image' }), false);
  assert.equal(isDocumentElement({ type: 'document', path: '', kind: 'pdf', name: 'a', pages: 1 }), false);
  assert.equal(isDocumentElement({ type: 'document', path: '/a.pdf', kind: 'text', name: 'a.pdf', pages: 1 }), false);
  assert.equal(isDocumentElement({ type: 'document', path: '/a.pdf', kind: 'pdf', name: 'a.pdf', pages: -1 }), false);
  assert.deepEqual(DOCUMENT_KINDS, ['pdf', 'image', 'markdown', 'html']);
});

test('documentElement: a page range is kept only in its digits-dashes-commas shape', () => {
  assert.equal(documentElement({ path: '/a.pdf', pages: 3, range: '1-3' }).range, '1-3');
  assert.equal(documentElement({ path: '/a.pdf', pages: 2, range: ' 2 , 5 ' }).range, '2,5');
  for (const bad of ['', 'all', '1-3; rm', '<b>', 7]) assert.equal('range' in documentElement({ path: '/a.pdf', range: bad }), false);
  assert.ok(isDocumentElement(documentElement({ path: '/a.pdf', pages: 3, range: '1-3' })));
  assert.equal(isDocumentElement({ type: 'document', path: '/a.pdf', kind: 'pdf', name: 'a.pdf', pages: 1, range: 'x' }), false);
});
