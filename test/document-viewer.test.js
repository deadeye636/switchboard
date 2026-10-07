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
  return { w, d, open, key, docKeys };
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

test('a second open replaces the first', () => {
  const h = setup();
  h.open(); h.open();
  assert.equal(h.d.querySelectorAll('.document-viewer').length, 1);
});
