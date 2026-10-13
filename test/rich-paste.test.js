'use strict';
// src/renderer/lib/rich-paste.js (#779) — a pasted mail read as text and pictures in reading order. The
// markup below is shaped like what Outlook and Word put on the clipboard: paragraphs with `&nbsp;` spacers,
// a VML twin of the picture inside a conditional comment, a signature logo, a remote picture.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { richPasteSegments, richPasteImageBytes, MAX_RICH_IMAGES } = require('../src/renderer/lib/rich-paste.js');

const parser = new new JSDOM('').window.DOMParser();
const seg = (html) => richPasteSegments(html, { parser });
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = 'data:image/jpeg;base64,/9j/4AAQ';

test('text and pictures come out in reading order, each picture where it stood', () => {
  const html = `<html><head><style>p{margin:0}</style></head><body><!--StartFragment-->
    <p class=MsoNormal>Hello,<o:p></o:p></p>
    <p class=MsoNormal>&nbsp;<o:p></o:p></p>
    <p class=MsoNormal>see the error:<o:p></o:p></p>
    <p class=MsoNormal><!--[if gte vml 1]><v:shape><v:imagedata src="x.png"/></v:shape><![endif]--><![if !vml]><img width=605 height=337 src="${JPG}"><![endif]><o:p></o:p></p>
    <p class=MsoNormal>and after the retry:<o:p></o:p></p>
    <p class=MsoNormal><img width=400 height=200 src="${PNG}"></p>
    <p class=MsoNormal>Thanks</p>
    <!--EndFragment--></body></html>`;
  const r = seg(html);
  assert.deepEqual(r.segments, [
    { type: 'text', text: 'Hello,\n\nsee the error:\n' },
    { type: 'image', src: JPG },
    { type: 'text', text: '\nand after the retry:\n' },
    { type: 'image', src: PNG },
    { type: 'text', text: '\nThanks' },
  ]);
  assert.equal(r.dropped, 0);
});

test('a signature logo, a remote picture, a cid picture and a network path are not taken', () => {
  const html = `<p>Text</p><img src="${PNG}" width="20" height="20">
    <img src="https://example.com/a.png"><img src="cid:image001.png@01D">
    <img src="file://server/share/a.png"><p>More</p><img src="${JPG}">`;
  const r = seg(html);
  assert.deepEqual(r.segments.filter(s => s.type === 'image').map(s => s.src), [JPG]);
});

test('a local file picture (classic Outlook, Word) is taken; a non-image file is not', () => {
  const html = '<p>See</p><img src="file:///tmp/msohtmlclip1/01/clip_image001.png"><img src="file:///tmp/a.txt">';
  const r = seg(html);
  assert.deepEqual(r.segments.filter(s => s.type === 'image').length, 1);
});

// A plain `..` never gets this far: URL parsing resolves it into an ordinary local path.
test('a network path is refused however it is spelled', async () => {
  for (const src of [
    'file:///%5Cserver%5Cshare%5Cx.png',
    'file:///%2Fserver/share/x.png',
    'file:////server/share/x.png',
    'file:///C:%5C%5Cserver%5Cx.png',
  ]) {
    assert.equal(seg(`<p>Text</p><img src="${src}">`), null, src);
    const asked = [];
    const api = { readFileDataUrl: async (p) => { asked.push(p); return { ok: true, dataUrl: PNG }; } };
    assert.equal(await richPasteImageBytes(src, api, 0), null, src);
    assert.deepEqual(asked, [], `${src} never reaches main`);
  }
});

test('SVG is not a picture here, and a percentage declares no size', () => {
  assert.equal(seg('<p>Text</p><img src="data:image/svg+xml;base64,PHN2Zz4=">'), null);
  const r = seg(`<p>Text</p><img width="10%" src="${PNG}">`);
  assert.equal(r.segments.filter(s => s.type === 'image').length, 1);
});

test('a <pre> that opens the copy keeps its first indentation', () => {
  const r = seg(`<pre>    indented\n  next</pre><img src="${PNG}">`);
  assert.equal(r.segments[0].text, '    indented\n  next\n');
});

test('no picture, or a single picture with no text, keeps the ordinary paste path', () => {
  assert.equal(seg('<p>only text</p>'), null);
  assert.equal(seg(`<img src="${PNG}">`), null);
  assert.equal(seg('<p>text</p><img src="https://example.com/a.png">'), null);
  assert.equal(seg('plain text, no markup'), null);
  assert.ok(seg(`<img src="${PNG}"><img src="${JPG}">`), 'two pictures are a rich paste even without text');
});

test('past the limit the rest is dropped and counted', () => {
  const html = '<p>x</p>' + Array.from({ length: MAX_RICH_IMAGES + 3 }, () => `<img src="${PNG}">`).join('');
  const r = seg(html);
  assert.equal(r.segments.filter(s => s.type === 'image').length, MAX_RICH_IMAGES);
  assert.equal(r.dropped, 3);
});

test('lists, line breaks, table cells and <pre> keep their shape; hidden text is left out', () => {
  const html = `<ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol>
    <div>line<br>break</div><table><tr><td>c1</td><td>c2</td></tr></table>
    <pre>  keep   this</pre><span style="display:none">secret</span><img src="${PNG}">`;
  const text = seg(html).segments.filter(s => s.type === 'text').map(s => s.text).join('');
  assert.equal(text, '- one\n- two\n1. a\n2. b\nline\nbreak\nc1\tc2\n  keep   this\n');
});

test('the bytes of a data picture are decoded, and a file picture is read through main', async () => {
  const a = await richPasteImageBytes(PNG, null, 1024);
  assert.equal(a.mime, 'image/png');
  assert.equal(a.bytes[0], 0x89);
  assert.equal(await richPasteImageBytes(PNG, null, 2), null, 'over the limit, before decoding');
  const asked = [];
  const api = { readFileDataUrl: async (p) => { asked.push(p); return { ok: true, dataUrl: JPG }; } };
  const b = await richPasteImageBytes('file:///tmp/clip%20image.jpg', api, 0);
  assert.equal(b.mime, 'image/jpeg');
  assert.deepEqual(asked, ['/tmp/clip image.jpg']);
  const gone = { readFileDataUrl: async () => ({ ok: false, error: 'missing' }) };
  assert.equal(await richPasteImageBytes('file:///tmp/gone.png', gone, 0), null, 'a file that is gone is skipped');
});
