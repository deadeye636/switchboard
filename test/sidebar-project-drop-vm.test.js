// vm.runInContext tests for where a manually sorted project lands (#772) in shell/sidebar-events.js.
//
// WHY THIS EXISTS:
//   The drop target used to be the `.project-group` under the pointer, split at half its height. A drop in
//   the 4 px gap between two groups found nothing and was discarded, and placing a project after an expanded
//   one meant dragging deep into its session list. `pickProjectDropTarget` answers from the pointer's height
//   against the HEADERS instead. Geometry is stubbed — jsdom has no layout — so this pins the decision, and
//   the click test in the demo instance pins the real drag.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="c"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(path.join(REN, 'shell/sidebar-events.js'), 'utf8'), ctx, { filename: 'shell/sidebar-events.js' });
  const pick = (candidates, y) => vm.runInContext('pickProjectDropTarget', ctx)(candidates, y);
  // A group whose header spans [top, top + 30) and whose whole box spans [top, bottom).
  const group = (name, top, bottom) => {
    const g = window.document.createElement('div');
    g.className = 'project-group';
    g.dataset.name = name;
    const h = window.document.createElement('div');
    h.className = 'project-header';
    g.appendChild(h);
    g.getBoundingClientRect = () => ({ top, bottom, height: bottom - top });
    h.getBoundingClientRect = () => ({ top, bottom: top + 30, height: 30 });
    window.document.getElementById('c').appendChild(g);
    return g;
  };
  return { window, pick, group, destroy: () => window.close() };
}

const describe = (hit) => hit && `${hit.el.dataset.name}:${hit.cls}`;

test('#772: the upper half of a header drops before it, the lower half before the next one', () => {
  const h = setup();
  try {
    const a = h.group('a', 0, 30), b = h.group('b', 34, 64), c = h.group('c', 68, 98);
    assert.equal(describe(h.pick([a, b, c], 40)), 'b:drop-target-before');
    assert.equal(describe(h.pick([a, b, c], 55)), 'c:drop-target-before');
  } finally { h.destroy(); }
});

test('#772: the gap between two groups, the space above the first and below the last all have a target', () => {
  const h = setup();
  try {
    const a = h.group('a', 10, 40), b = h.group('b', 44, 74);
    assert.equal(describe(h.pick([a, b], 42)), 'b:drop-target-before', 'the 4 px gap');
    assert.equal(describe(h.pick([a, b], -50)), 'a:drop-target-before', 'above the first group');
    assert.equal(describe(h.pick([a, b], 500)), 'b:drop-target-after', 'below the last group');
  } finally { h.destroy(); }
});

test('#772: an expanded group is measured by its header, so its session list already means "after it"', () => {
  const h = setup();
  try {
    // `a` is expanded: a 30 px header over a 1000 px session list. Under the old half-height split the
    // pointer had to pass y = 500 before the drop moved past it.
    const a = h.group('a', 0, 1030), b = h.group('b', 1034, 1064);
    assert.equal(describe(h.pick([a, b], 80)), 'b:drop-target-before');
  } finally { h.destroy(); }
});

test('#772: no candidates, no target', () => {
  const h = setup();
  try {
    assert.equal(h.pick([], 10), null);
  } finally { h.destroy(); }
});
