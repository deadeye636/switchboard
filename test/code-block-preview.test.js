'use strict';
// #811: a fenced ```html block in rendered text offers a Preview that opens the document viewer with the block's
// text; #838: every code block offers Copy. Drawn through the real `renderJsonlText` and `addCodeActions` in
// src/renderer/jsonl/jsonl-viewer.js, with the marked and DOMPurify builds index.html loads, because the language
// class comes out of marked.
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
  const copied = [];
  let clipboardFails = false;
  w.api = new Proxy({}, { get: (_t, k) => (k === 'writeClipboard'
    ? (t) => (clipboardFails ? Promise.reject(new Error('denied')) : (copied.push(t), Promise.resolve()))
    : () => {}) });
  const ctx = dom.getInternalVMContext();
  vm.runInContext(read('node_modules/dompurify/dist/purify.min.js'), ctx);
  vm.runInContext(read('node_modules/marked/lib/marked.umd.js'), ctx);
  vm.runInContext(read('src/shared/partial-args.js'), ctx);
  vm.runInContext(read('src/renderer/session/subagent-live.js'), ctx);
  vm.runInContext(`
    function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
    var __opened = [];
    var __messages = [];
    function openDocumentViewer(opts) { __opened.push(opts); return {}; }
    function showControlMessage(m) { __messages.push(m.title); }
  `, ctx);
  vm.runInContext(read('src/renderer/jsonl/jsonl-viewer.js'), ctx);
  const draw = (text, drawCtx) => {
    ctx.__text = text;
    ctx.__drawCtx = drawCtx || null;
    const el = w.document.createElement('div');
    el.innerHTML = vm.runInContext('renderJsonlText(__text)', ctx);
    ctx.__el = el;
    vm.runInContext('addCodeActions(__el, __drawCtx)', ctx);
    return { el, opened: () => vm.runInContext('__opened', ctx) };
  };
  draw.copied = copied;
  draw.failClipboard = () => { clipboardFails = true; };
  draw.messages = () => JSON.parse(vm.runInContext('JSON.stringify(__messages)', ctx));
  return draw;
}
const preview = (el) => el.querySelector('.jsonl-code-preview');
const copyBtn = (el) => el.querySelector('.jsonl-code-copy');

test('an html block gets one Preview, and nothing opens until it is clicked', () => {
  const host = {};
  const { el, opened } = setup()('Draft:\n\n```html\n<h1>Hi</h1>\n```', { host });
  const btns = el.querySelectorAll('.jsonl-code-actions > .jsonl-code-preview');
  assert.equal(btns.length, 1);
  assert.match(btns[0].className, /\btask-notice-output\b/);
  assert.deepEqual([...el.querySelectorAll('.jsonl-code-actions > button')].map((b) => b.getAttribute('aria-label')), ['Preview', 'Copy']);
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
    const btn = preview(el);
    assert.equal(btn.title, 'Show this Markdown rendered');
    btn.click();
    const o = opened()[0];
    assert.equal(o.content.kind, 'markdown');
    assert.equal(o.name, 'Markdown preview');
    assert.equal(o.content.text.trim(), '# Title\n\n- item');
  }
});

test('htm counts for Preview; other languages and untagged blocks get Copy only', () => {
  const draw = setup();
  assert.ok(preview(draw('```HTM\n<p>x</p>\n```').el));
  for (const text of ['```js\nconst a = 1;\n```', '```\n<p>x</p>\n```']) {
    const { el } = draw(text);
    assert.equal(preview(el), null);
    assert.ok(copyBtn(el));
  }
});

// #838: Copy on every code block.
test('Copy puts the block\'s text on the clipboard as written, and says Copied for a moment', async () => {
  const draw = setup();
  const { el } = draw('Run this:\n\n```powershell\nStart-Process -FilePath \'C:\\x.exe\' -ArgumentList \'a\',"b"\nWrite-Host done\n```');
  const btn = copyBtn(el);
  assert.equal(btn.getAttribute('aria-label'), 'Copy');
  assert.equal(el.querySelector('.jsonl-code-actions').textContent, '', 'the word is CSS, so copying the entry leaves it out');
  btn.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(draw.copied, ['Start-Process -FilePath \'C:\\x.exe\' -ArgumentList \'a\',"b"\nWrite-Host done']);
  assert.equal(btn.dataset.copied, '1');
  assert.equal(btn.getAttribute('aria-label'), 'Copied');
});

test('every block gets its own Copy, inline code none; a refused clipboard says so', async () => {
  const draw = setup();
  const { el } = draw('Use `npm test` or:\n\n```\none\n```\n\n```bash\ntwo\n```');
  const btns = el.querySelectorAll('.jsonl-code-copy');
  assert.equal(btns.length, 2);
  btns[1].click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(draw.copied, ['two']);
  draw.failClipboard();
  btns[0].click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(draw.messages(), ['Cannot copy']);
});
