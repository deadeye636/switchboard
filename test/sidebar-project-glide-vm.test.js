// Gliding re-ordered projects into place (#868): the decision in lib/project-sort.js
// (`shouldGlideProjects`) and the FLIP in shell/sidebar-sort.js (`beginProjectGlide`).
//
// Geometry and `Element.animate` are stubbed (jsdom has no layout and no Web Animations), so this pins when a
// glide plays and from where; the click test in the demo instance pins how it looks.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { projectOrderChanged, shouldGlideProjects } = require('../src/renderer/lib/project-sort.js');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const base = { mode: 'activity', reducedMotion: false, hidden: false };

test('glide decision: a swapped pair glides', () => {
  assert.equal(shouldGlideProjects({ ...base, prevIds: ['a', 'b', 'c'], nextIds: ['b', 'a', 'c'] }), true);
});

test('glide decision: an unchanged order, or an added or removed project alone, does not', () => {
  assert.equal(shouldGlideProjects({ ...base, prevIds: ['a', 'b'], nextIds: ['a', 'b'] }), false);
  assert.equal(shouldGlideProjects({ ...base, prevIds: ['a', 'b'], nextIds: ['n', 'a', 'b'] }), false);
  assert.equal(shouldGlideProjects({ ...base, prevIds: ['a', 'b', 'c'], nextIds: ['a', 'c'] }), false);
  assert.equal(projectOrderChanged([], ['a']), false);
});

test('glide decision: reduced motion, a hidden window and the other sort modes never glide', () => {
  const swap = { prevIds: ['a', 'b'], nextIds: ['b', 'a'] };
  assert.equal(shouldGlideProjects({ ...base, ...swap, reducedMotion: true }), false);
  assert.equal(shouldGlideProjects({ ...base, ...swap, hidden: true }), false);
  assert.equal(shouldGlideProjects({ ...base, ...swap, mode: 'alpha' }), false);
  assert.equal(shouldGlideProjects({ ...base, ...swap, mode: 'manual' }), false);
});

function setup({ reduced = false } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="sidebar-content"></div><button id="r"></button></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  const content = window.document.getElementById('sidebar-content');
  window.matchMedia = (q) => ({ matches: reduced && q.includes('reduce') });
  const played = [];
  window.Element.prototype.animate = function (frames, opts) { played.push({ id: this.id, frames, opts }); };
  const tops = new Map();
  window.Element.prototype.getBoundingClientRect = function () { const t = tops.get(this.id) || 0; return { top: t, bottom: t + 10, height: 10 }; };
  Object.assign(window, { sidebarContent: content, resortBtn: window.document.getElementById('r'), projectSortMode: 'activity', shouldGlideProjects });
  vm.runInContext(fs.readFileSync(path.join(REN, 'shell/sidebar-sort.js'), 'utf8'), ctx, { filename: 'shell/sidebar-sort.js' });
  const group = (id) => { const g = window.document.createElement('div'); g.className = 'project-group'; g.id = id; return g; };
  const fill = (el, ids) => { el.replaceChildren(...ids.map(group)); };
  return { window, content, played, tops, fill, begin: (next) => vm.runInContext('beginProjectGlide', ctx)(next), destroy: () => window.close() };
}

test('#868: a moved project plays a transform from its old place, the unmoved ones play nothing', () => {
  const h = setup();
  try {
    h.fill(h.content, ['a', 'b', 'c']);
    h.tops.set('a', 0); h.tops.set('b', 100); h.tops.set('c', 200);
    const next = h.window.document.createElement('div');
    h.fill(next, ['b', 'a', 'c']);
    const after = h.begin(next);
    assert.equal(typeof after, 'function');
    // morphdom moved the elements: b is now first, a second.
    h.fill(h.content, ['b', 'a', 'c']);
    h.tops.set('b', 0); h.tops.set('a', 100); h.tops.set('c', 200);
    after();
    assert.deepEqual(h.played.map(p => p.id).sort(), ['a', 'b']);
    const b = h.played.find(p => p.id === 'b');
    assert.equal(b.frames[0].transform, 'translateY(100px)');
    assert.ok(b.opts.duration <= 200);
  } finally { h.destroy(); }
});

test('#868: a glide still running is cancelled before the old places are measured', () => {
  const h = setup();
  try {
    h.fill(h.content, ['a', 'b']);
    const cancelled = [];
    for (const el of h.content.children) el.getAnimations = () => [{ cancel: () => cancelled.push(el.id) }];
    const next = h.window.document.createElement('div');
    h.fill(next, ['b', 'a']);
    assert.equal(typeof h.begin(next), 'function');
    assert.deepEqual(cancelled.sort(), ['a', 'b']);
    // an unchanged order leaves a running glide alone
    cancelled.length = 0;
    const same = h.window.document.createElement('div');
    h.fill(same, ['a', 'b']);
    assert.equal(h.begin(same), null);
    assert.deepEqual(cancelled, []);
  } finally { h.destroy(); }
});

test('#868: no glide function when the order is unchanged or reduced motion is on', () => {
  const h = setup();
  try {
    h.fill(h.content, ['a', 'b']);
    const same = h.window.document.createElement('div');
    h.fill(same, ['a', 'b']);
    assert.equal(h.begin(same), null);
  } finally { h.destroy(); }
  const r = setup({ reduced: true });
  try {
    r.fill(r.content, ['a', 'b']);
    const swapped = r.window.document.createElement('div');
    r.fill(swapped, ['b', 'a']);
    assert.equal(r.begin(swapped), null);
  } finally { r.destroy(); }
});
