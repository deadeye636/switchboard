'use strict';
// #755 T7: the document card drawn for a tool result that carries a `document` element, and the history
// viewer's variant without actions. jsdom, drawn through the real renderJsonlEntry.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));

function setup(settings, { observer = false } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const w = dom.window;
  const calls = { open: [], panel: [], editor: [], read: [] };
  let answer = { ok: true, action: 'default' };
  let readAnswer = { ok: true, kind: 'markdown', text: '# Title\n\nbody' };
  w.api = new Proxy({}, { get: (_t, k) => {
    if (k === 'openDocument') return async (...a) => { calls.open.push(a); return answer; };
    if (k === 'readDocument') return async (...a) => { calls.read.push(a); return readAnswer; };
    if (k === 'openInEditor') return (p) => calls.editor.push(p);
    return () => {};
  } });
  const observers = [];
  if (observer) {
    w.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; observers.push(this); this.els = []; }
      observe(el) { this.els.push(el); }
      unobserve() {}
      fire() { this.cb(this.els.map((target) => ({ target, isIntersecting: true }))); }
    };
  }
  const ctx = vm.createContext(w);
  ctx.__panel = (...a) => calls.panel.push(a);
  vm.runInContext(read('src/shared/partial-args.js'), ctx);
  vm.runInContext(read('src/renderer/session/subagent-live.js'), ctx);
  vm.runInContext(`
    function escapeHtml(s) { return String(s); }
    function openFileInPanel(...a) { __panel(...a); }
  `, ctx);
  ctx.__settings = settings;
  vm.runInContext('var appGlobalSettings = __settings;', ctx);
  for (const f of ['jsonl/jsonl-viewer.js', 'jsonl/document-card.js', 'jsonl/document-viewer.js']) {
    vm.runInContext(read('src/renderer/' + f), ctx);
  }
  const draw = (content, actx) => {
    ctx.__content = content; ctx.__actx = actx;
    const el = vm.runInContext(`renderJsonlEntry(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x' } }] } },
      new Map([['t1', __content]]), __actx)`, ctx);
    w.document.body.appendChild(el);
    return el;
  };
  return { w, draw, calls, observers, setAnswer: (a) => { answer = a; }, setRead: (a) => { readAnswer = a; } };
}

const el = (over) => ({ type: 'document', path: '/d/report.pdf', kind: 'pdf', name: 'report.pdf', pages: 2, ...over });
const img = (n = 8) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(n) } });
const ACT = { sessionId: 's1', host: null };

test('a stamped result draws one card, outside the collapsible body, and no inline image', () => {
  const h = setup({});
  const root = h.draw([el(), img(), img()], { ...ACT, host: h.w.document.body });
  const card = root.querySelector('.document-card');
  assert.ok(card);
  assert.equal(card.parentNode, root.querySelector('.jsonl-tool-block'), 'a sibling of the body, so a collapsed call keeps it');
  assert.equal(root.querySelectorAll('.jsonl-tool-screenshot').length, 0);
  assert.equal(card.querySelector('.document-card-name').textContent, 'report.pdf');
  assert.equal(card.querySelector('.document-card-sub').textContent, '2 pages');
});

test('no element, or documentPreview: inline, draws today', () => {
  const h = setup({});
  assert.equal(h.draw([img()], ACT).querySelector('.document-card'), null);
  assert.equal(h.draw([img()], ACT).querySelectorAll('.jsonl-tool-screenshot').length, 1);
  const i = setup({ documentPreview: 'inline' });
  const root = i.draw([el(), img()], ACT);
  assert.equal(root.querySelector('.document-card'), null);
  assert.equal(root.querySelectorAll('.jsonl-tool-screenshot').length, 1);
});

test('an element that fails the shape check is not a document', () => {
  const h = setup({});
  for (const bad of [el({ kind: 'exe' }), el({ pages: -1 }), el({ name: 3 }), el({ path: '' })]) {
    assert.equal(h.draw([bad, img()], ACT).querySelector('.document-card'), null);
  }
});

test('the thumbnail gets its src only when the observer fires', () => {
  const h = setup({}, { observer: true });
  const root = h.draw([el(), img()], ACT);
  const thumb = root.querySelector('.document-card-img');
  assert.equal(thumb.getAttribute('src'), null);
  h.observers[0].fire();
  assert.match(thumb.getAttribute('src'), /^data:image\/jpeg;base64,/);
});

test('no thumbnail above the size bound or without page images', () => {
  const big = setup({ documentPreviewMaxKB: 64 });
  assert.equal(big.draw([el(), img(65 * 1024)], ACT).querySelector('.document-card-img'), null);
  const none = setup({});
  const root = none.draw([el({ pages: 0 })], ACT);
  assert.equal(root.querySelector('.document-card-img'), null);
  assert.equal(root.querySelector('.document-card-sub').textContent, 'PDF');
});

test('subtitle: range wins, then pages, then the kind', () => {
  const h = setup({});
  assert.equal(h.draw([el({ range: '1-3' }), img()], ACT).querySelector('.document-card-sub').textContent, 'pages 1-3');
  assert.equal(h.draw([el({ kind: 'markdown', name: 'a.md', pages: 0 })], ACT).querySelector('.document-card-sub').textContent, 'Markdown');
});

test('buttons only with actions; the history viewer passes none', () => {
  const h = setup({});
  assert.equal(h.draw([el(), img()], ACT).querySelectorAll('.document-card-btn').length, 2);
  const root = h.draw([el(), img()], undefined);
  assert.ok(root.querySelector('.document-card'));
  assert.equal(root.querySelectorAll('.document-card-btn').length, 0);
  assert.equal(h.draw([el({ kind: 'markdown', pages: 0 })], undefined).querySelector('.document-card'), null, 'no pages and no actions: today');
});

test('markdown: card above the collapsed text', () => {
  const h = setup({});
  const root = h.draw([el({ kind: 'markdown', name: 'a.md', path: '/d/a.md', pages: 0 }), { type: 'text', text: 'hello' }], ACT);
  const kids = [...root.querySelector('.jsonl-tool-block').children];
  assert.ok(kids.indexOf(root.querySelector('.document-card')) < kids.indexOf(root.querySelector('.jsonl-tool-content')));
  assert.match(root.querySelector('.jsonl-tool-content').textContent, /hello/);
  assert.equal(root.querySelector('.jsonl-tool-content .jsonl-tool-body').style.display, 'none');
});

test('open buttons go through openDocument; tab finishes only on the answer', async () => {
  const h = setup({});
  const root = h.draw([el(), img()], ACT);
  const [def, tab] = root.querySelectorAll('.document-card-btn');
  def.click(); await flush();
  assert.deepEqual(h.calls.open[0], ['s1', '/d/report.pdf', 'default', false]);
  assert.equal(h.calls.panel.length, 0);
  h.setAnswer({ ok: true, action: 'tab', path: '/real/report.pdf' });
  tab.click(); await flush();
  assert.deepEqual(h.calls.open[1], ['s1', '/d/report.pdf', 'tab', false]);
  assert.deepEqual(h.calls.panel[0], ['s1', '/real/report.pdf']);
  h.setAnswer({ ok: false, error: 'no' });
  tab.click(); await flush();
  assert.equal(h.calls.panel.length, 1);
});

test('card click: pages open the viewer; a whole pdf follows openDocument, Ctrl/Cmd inverting it', async () => {
  const h = setup({});
  const withPages = h.draw([el(), img()], { ...ACT, host: h.w.document.body });
  withPages.querySelector('.document-card').click();
  assert.ok(h.w.document.querySelector('.document-viewer'));
  assert.equal(h.calls.open.length, 0);
  h.w.document.querySelector('.document-viewer')._close();

  const pdf = h.draw([el({ pages: 0 })], ACT);
  h.setAnswer({ ok: true, action: 'tab', path: '/d/report.pdf' });
  pdf.querySelector('.document-card').click(); await flush();
  assert.deepEqual(h.calls.open[0], ['s1', '/d/report.pdf', 'click', false]);
  pdf.querySelector('.document-card').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  await flush();
  assert.equal(h.calls.open[1][3], true);
  assert.equal(h.calls.read.length, 0);
});

test('markdown click reads the file only then and shows it rendered; Ctrl/Cmd keeps the old open (#764)', async () => {
  const h = setup({});
  const md = h.draw([el({ kind: 'markdown', pages: 0, path: '/d/a.md', name: 'a.md' })], { ...ACT, host: h.w.document.body });
  assert.equal(h.calls.read.length, 0, 'nothing is read before the click');
  md.querySelector('.document-card').click(); await flush();
  assert.deepEqual(h.calls.read[0], ['s1', '/d/a.md']);
  assert.equal(h.calls.open.length, 0);
  const viewer = h.w.document.querySelector('.document-viewer');
  assert.ok(viewer);
  assert.ok(viewer.querySelector('.document-viewer-text'), 'the text block, not a page image');
  assert.equal(viewer.querySelector('.document-viewer-img'), null);
  assert.equal(viewer.querySelector('.document-viewer-pager'), null);
  viewer._close();

  h.setAnswer({ ok: true, action: 'editor', path: '/d/a.md' });
  md.querySelector('.document-card').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  await flush();
  assert.deepEqual(h.calls.open[0], ['s1', '/d/a.md', 'click', false], 'not inverted: what a plain click did before');
  assert.deepEqual(h.calls.editor, ['/d/a.md']);
  assert.equal(h.calls.read.length, 1);
});

test('html click opens a sandboxed frame without scripts', async () => {
  const h = setup({});
  h.setRead({ ok: true, kind: 'html', text: '<p>hi</p>' });
  const page = h.draw([el({ kind: 'html', pages: 0, path: '/d/a.html', name: 'a.html' })], { ...ACT, host: h.w.document.body });
  page.querySelector('.document-card').click(); await flush();
  const frame = h.w.document.querySelector('.document-viewer iframe.document-viewer-frame');
  assert.ok(frame);
  assert.equal(frame.getAttribute('sandbox'), 'allow-same-origin');
});

test('a refused read shows no viewer', async () => {
  const h = setup({});
  h.setRead({ ok: false, error: 'This document is too large to show here. Open it in a tab instead.' });
  const md = h.draw([el({ kind: 'markdown', pages: 0, path: '/d/a.md', name: 'a.md' })], { ...ACT, host: h.w.document.body });
  md.querySelector('.document-card').click(); await flush();
  assert.equal(h.w.document.querySelector('.document-viewer'), null);
});
