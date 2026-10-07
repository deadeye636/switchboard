'use strict';
// #755 T8: the overlay a document card opens. jsdom.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'jsonl', 'document-viewer.js'), 'utf8');

function setup() {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div><textarea id="composer"></textarea></body>');
  const w = dom.window;
  const d = w.document;
  const docKeys = [];
  const origAdd = d.addEventListener.bind(d);
  d.addEventListener = (t, ...r) => { if (/^key/.test(t)) docKeys.push(t); return origAdd(t, ...r); };
  const ctx = vm.createContext(w);
  vm.runInContext(src, ctx);
  const open = (count = 3) => {
    ctx.__o = { host: d.getElementById('host'), name: 'a.pdf', count, srcAt: (i) => `data:image/png;base64,P${i}` };
    return vm.runInContext('openDocumentViewer(__o)', ctx);
  };
  const key = (target, k, extra) => {
    const e = new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(e);
    return e;
  };
  const openText = (content) => {
    ctx.__o = { host: d.getElementById('host'), name: 'a.md', content };
    return vm.runInContext('openDocumentViewer(__o)', ctx);
  };
  const openWith = (extra) => {
    ctx.__o = { host: d.getElementById('host'), name: 'a.pdf', count: 2, srcAt: (i) => `data:image/png;base64,P${i}`, ...extra };
    return vm.runInContext('openDocumentViewer(__o)', ctx);
  };
  return { w, d, open, openText, openWith, key, docKeys };
}

test('opens inside the host, shows page 1 of N and takes focus', () => {
  const h = setup();
  h.d.getElementById('composer').focus();
  const v = h.open();
  assert.equal(v.el.parentNode.id, 'host');
  assert.equal(v.el.querySelector('.document-viewer-img').getAttribute('src'), 'data:image/png;base64,P0');
  assert.equal(v.el.querySelector('.document-viewer-counter').textContent, '1 / 3');
  assert.equal(h.d.activeElement, v.el);
});

test('keys page, Home/End jump, bounds hold', () => {
  const h = setup();
  const v = h.open();
  const page = () => v.el.querySelector('.document-viewer-img').getAttribute('src');
  h.key(v.el, 'ArrowRight'); assert.equal(page(), 'data:image/png;base64,P1');
  h.key(v.el, 'End'); assert.equal(page(), 'data:image/png;base64,P2');
  h.key(v.el, 'ArrowRight'); assert.equal(page(), 'data:image/png;base64,P2');
  h.key(v.el, 'Home'); assert.equal(page(), 'data:image/png;base64,P0');
  h.key(v.el, 'ArrowLeft'); assert.equal(page(), 'data:image/png;base64,P0');
  v.el.querySelectorAll('.document-viewer-pager button')[1].click();
  assert.equal(page(), 'data:image/png;base64,P1');
});

test('zoom by keys, buttons and Ctrl+wheel, clamped', () => {
  const h = setup();
  const v = h.open();
  const label = () => v.el.querySelector('.document-viewer-zoom button:nth-child(2)').textContent;
  h.key(v.el, '+'); assert.equal(label(), '125%');
  h.key(v.el, '-'); h.key(v.el, '-'); assert.equal(label(), '75%');
  h.key(v.el, '0'); assert.equal(label(), '100%');
  for (let i = 0; i < 20; i++) h.key(v.el, '+');
  assert.equal(label(), '400%');
  v.el.querySelector('.document-viewer-stage').dispatchEvent(new h.w.WheelEvent('wheel', { ctrlKey: true, deltaY: 100, bubbles: true, cancelable: true }));
  assert.equal(label(), '375%');
  v.el.querySelector('.document-viewer-zoom button:nth-child(2)').click();
  assert.equal(label(), '100%');
});

test('Esc closes, removes the overlay and returns focus', () => {
  const h = setup();
  const composer = h.d.getElementById('composer');
  composer.focus();
  const v = h.open();
  h.key(v.el, 'Escape');
  assert.equal(h.d.querySelector('.document-viewer'), null);
  assert.equal(h.d.activeElement, composer);
});

test('Tab is trapped in the overlay', () => {
  const h = setup();
  const v = h.open();
  const btns = [...v.el.querySelectorAll('button')].filter((b) => !b.disabled);
  btns[btns.length - 1].focus();
  const e = h.key(btns[btns.length - 1], 'Tab');
  assert.ok(e.defaultPrevented);
  assert.equal(h.d.activeElement, btns[0]);
});

test('a single page hides the pager', () => {
  const h = setup();
  const v = h.open(1);
  assert.equal(v.el.querySelector('.document-viewer-pager'), null);
});

test('closed: no document-level key listener, and the composer key is untouched', () => {
  const h = setup();
  const v = h.open();
  h.key(v.el, 'Escape');
  assert.deepEqual(h.docKeys, [], 'the viewer never listens on document');
  assert.equal(h.key(h.d.getElementById('composer'), 'ArrowRight').defaultPrevented, false);
  assert.equal(h.key(h.d.getElementById('composer'), 'Escape').defaultPrevented, false);
});

test('text mode (#764): one rendered block, no pager, arrows left to the scroll, zoom scales the text, Esc closes', () => {
  const h = setup();
  const composer = h.d.getElementById('composer');
  composer.focus();
  const opened = h.openText({ kind: 'markdown', text: '# T' });
  assert.ok(opened.el.querySelector('.document-viewer-text'));
  assert.equal(opened.el.querySelector('.document-viewer-img'), null);
  assert.equal(opened.el.querySelector('.document-viewer-pager'), null);
  assert.equal(h.d.activeElement, opened.el.querySelector('.document-viewer-stage'), 'the stage has the focus, so keys scroll it');
  assert.equal(h.key(opened.el.querySelector('.document-viewer-stage'), 'ArrowDown').defaultPrevented, false);
  assert.equal(h.key(opened.el.querySelector('.document-viewer-stage'), 'End').defaultPrevented, false);
  h.key(opened.el, '+');
  assert.equal(opened.el.querySelector('.document-viewer-text').style.zoom, '1.25');
  h.key(opened.el, 'Escape');
  assert.equal(h.d.querySelector('.document-viewer'), null);
  assert.equal(h.d.activeElement, composer);
});

test('text mode: a click on the stage beside the text closes, a click on the text does not', () => {
  const h = setup();
  const opened = h.openText({ kind: 'markdown', text: '# T' });
  opened.el.querySelector('.document-viewer-text').click();
  assert.ok(h.d.querySelector('.document-viewer'));
  // A selection dragged out of the text: pressed on the text, released on the stage.
  opened.el.querySelector('.document-viewer-text').dispatchEvent(new h.w.MouseEvent('mousedown', { bubbles: true }));
  opened.el.querySelector('.document-viewer-stage').click();
  assert.ok(h.d.querySelector('.document-viewer'), 'a drag out of the text keeps it open');
  opened.el.querySelector('.document-viewer-stage').dispatchEvent(new h.w.MouseEvent('mousedown', { bubbles: true }));
  opened.el.querySelector('.document-viewer-stage').click();
  assert.equal(h.d.querySelector('.document-viewer'), null);
});

test('text mode: the stage is in the Tab cycle, so the keys can scroll again', () => {
  const h = setup();
  const opened = h.openText({ kind: 'markdown', text: '# T' });
  const stage = opened.el.querySelector('.document-viewer-stage');
  h.key(stage, 'Tab');
  assert.notEqual(h.d.activeElement, stage);
  h.key(h.d.activeElement, 'Tab', { shiftKey: true });
  assert.equal(h.d.activeElement, stage);
});

test('actions (#765): shown in the bar, close the viewer first, then run; none without them', () => {
  const h = setup();
  const ran = [];
  assert.equal(h.open().el.querySelector('.document-viewer-actions'), null, 'no actions passed: none drawn');
  const withActs = h.openWith({ actions: [{ label: 'Open in tab', run: () => ran.push(h.d.querySelector('.document-viewer') ? 'open' : 'closed') }] });
  const b = withActs.el.querySelector('.document-viewer-actions button');
  assert.equal(b.textContent, 'Open in tab');
  assert.match(b.className, /new-session-secondary-btn/);
  b.click();
  assert.deepEqual(ran, ['closed']);
});

test('actions are in the Tab trap', () => {
  const h = setup();
  const v = h.openWith({ actions: [{ label: 'Open in default app', run: () => {} }, { label: 'Open in tab', run: () => {} }] });
  const btns = [...v.el.querySelectorAll('button')].filter((b) => !b.disabled);
  const seen = new Set();
  let at = btns[btns.length - 1];
  at.focus();
  for (let i = 0; i < btns.length; i++) { h.key(h.d.activeElement, 'Tab'); seen.add(h.d.activeElement.textContent); }
  assert.ok(seen.has('Open in default app') && seen.has('Open in tab'));
});

test('focus on body at the open goes to the fallback on close (#766)', () => {
  const h = setup();
  h.d.activeElement.blur();
  let fell = 0;
  const v = h.openWith({ focusFallback: () => { fell++; } });
  h.key(v.el, 'Escape');
  assert.equal(fell, 1);
});

test('a second open replaces the first', () => {
  const h = setup();
  h.open(); h.open();
  assert.equal(h.d.querySelectorAll('.document-viewer').length, 1);
});
