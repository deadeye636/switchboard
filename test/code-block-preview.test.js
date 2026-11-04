'use strict';
// #811: a fenced ```html block in rendered text offers a Preview that opens the document viewer with the block's
// text. Drawn through the real `renderJsonlText` and `addCodePreviews` in src/renderer/jsonl/jsonl-viewer.js, with
// the marked and DOMPurify builds index.html loads, because the language class comes out of marked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function setup() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.api = new Proxy({}, { get: () => () => {} });
  const ctx = dom.getInternalVMContext();
  vm.runInContext(read('node_modules/dompurify/dist/purify.min.js'), ctx);
  vm.runInContext(read('node_modules/marked/lib/marked.umd.js'), ctx);
  vm.runInContext(read('src/shared/partial-args.js'), ctx);
  vm.runInContext(read('src/renderer/session/subagent-live.js'), ctx);
  vm.runInContext(`
    function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
    var __opened = [];
    function openDocumentViewer(opts) { __opened.push(opts); return {}; }
  `, ctx);
  vm.runInContext(read('src/renderer/jsonl/jsonl-viewer.js'), ctx);
  return (text, drawCtx) => {
    ctx.__text = text;
    ctx.__drawCtx = drawCtx || null;
    const el = w.document.createElement('div');
    el.innerHTML = vm.runInContext('renderJsonlText(__text)', ctx);
    ctx.__el = el;
    vm.runInContext('addCodePreviews(__el, __drawCtx)', ctx);
    return { el, opened: () => vm.runInContext('__opened', ctx) };
  };
}

test('an html block gets one Preview, and nothing opens until it is clicked', () => {
  const host = {};
  const { el, opened } = setup()('Draft:\n\n```html\n<h1>Hi</h1>\n```', { host });
  const btns = el.querySelectorAll('.jsonl-code-actions > button');
  assert.equal(btns.length, 1);
  assert.match(btns[0].className, /\btask-notice-output\b/);
  // Copy and search read text nodes; the button must add none.
  assert.equal(el.querySelector('.jsonl-code-actions').textContent, '');
  assert.equal(el.querySelector('iframe'), null);
  assert.equal(opened().length, 0);
  btns[0].click();
  assert.equal(opened().length, 1);
  const o = opened()[0];
  assert.equal(o.host, host);
  assert.equal(o.content.kind, 'html');
  assert.equal(o.content.text.trim(), '<h1>Hi</h1>');
});

test('the source stays in place beside the button', () => {
  const { el } = setup()('```html\n<p>x</p>\n```');
  assert.equal(el.querySelector('pre code').textContent.trim(), '<p>x</p>');
  assert.equal(el.querySelector('.jsonl-code-actions').nextElementSibling.tagName, 'PRE');
});

test('a markdown or md block opens the viewer as Markdown', () => {
  for (const lang of ['markdown', 'md']) {
    const { el, opened } = setup()('```' + lang + '\n# Title\n\n- item\n```');
    const btn = el.querySelector('.jsonl-code-actions > button');
    assert.equal(btn.title, 'Show this Markdown rendered');
    btn.click();
    const o = opened()[0];
    assert.equal(o.content.kind, 'markdown');
    assert.equal(o.name, 'Markdown preview');
    assert.equal(o.content.text.trim(), '# Title\n\n- item');
  }
});

test('htm counts, other languages and untagged blocks get no button', () => {
  const draw = setup();
  assert.equal(draw('```HTM\n<p>x</p>\n```').el.querySelectorAll('.jsonl-code-actions').length, 1);
  assert.equal(draw('```js\nconst a = 1;\n```').el.querySelectorAll('.jsonl-code-actions').length, 0);
  assert.equal(draw('```\n<p>x</p>\n```').el.querySelectorAll('.jsonl-code-actions').length, 0);
});
