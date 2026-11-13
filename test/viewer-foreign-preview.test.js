'use strict';
// #874: a text with no file behind it (an issue from a public forge) is previewed with every address that is not a
// web link or an inline image dropped while it is sanitized, so a `//host/share` image never becomes a network path in
// the app's `file:` document. Runs the real hook from viewer-panel.js with the DOMPurify the renderer loads.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'file:///app/index.html', runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'node_modules', 'dompurify', 'dist', 'purify.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'views', 'viewer-panel.js'), 'utf8'), ctx);
  return dom;
}

test('the foreign-text hook keeps web links and inline images and drops every other address', () => {
  const dom = setup();
  const w = dom.window;
  const html = [
    '<img src="//host/share/x.png">', '<img src="file://host/share/y.png">', '<img src="https://example.com/z.png">',
    '<img src="data:image/png;base64,AAAA">', '<img srcset="//host/a.png 1x">',
    '<a href="//host/share">unc</a>', '<a href="file:///c:/x">file</a>', '<a href="https://example.com/i/1">web</a>', '<a href="#top">anchor</a>',
  ].join('');
  w.DOMPurify.addHook('uponSanitizeAttribute', vm.runInContext('dropForeignAddress', dom.getInternalVMContext()));
  const out = w.DOMPurify.sanitize(html);
  w.DOMPurify.removeHook('uponSanitizeAttribute');
  const holder = w.document.createElement('div');
  // A template's content is inert: nothing here would load even if a source had slipped through.
  const tpl = w.document.createElement('template');
  tpl.innerHTML = out;
  holder.appendChild(tpl.content.cloneNode(true));
  const srcs = [...holder.querySelectorAll('img')].map((i) => i.getAttribute('src'));
  assert.deepStrictEqual(srcs, [null, null, null, 'data:image/png;base64,AAAA', null]);
  assert.equal(holder.querySelector('img[srcset]'), null);
  const hrefs = [...holder.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  assert.deepStrictEqual(hrefs, [null, null, 'https://example.com/i/1', '#top']);
  // The hook is off again: an ordinary file's preview keeps its relative images.
  assert.match(w.DOMPurify.sanitize('<img src="./pic.png">'), /src="\.\/pic\.png"/);
  w.close();
});

test('the preview turns the hook on only for a text with no file behind it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'views', 'viewer-panel.js'), 'utf8');
  assert.match(src, /const foreign = this\.virtual === true;\s*\n\s*if \(foreign\) DOMPurify\.addHook\('uponSanitizeAttribute', dropForeignAddress\);/);
  assert.match(src, /finally \{\s*\n\s*if \(foreign\) DOMPurify\.removeHook\('uponSanitizeAttribute'\);/);
});
