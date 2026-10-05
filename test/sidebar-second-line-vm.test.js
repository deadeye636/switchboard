// vm.runInContext tests for the project second line (#741) in shell/sidebar.js.
//
// WHY THIS EXISTS:
//   The line is opt-in, main projects only, and must not leave an empty row under a project that has
//   nothing to show. Those three rules decide whether a user sees a row at all, and none of them is
//   visible to the rest of the suite. This loads the REAL sidebar.js into a jsdom vm context (the same
//   way sidebar-ordering-vm.test.js does) and asks `buildProjectSecondLine` directly.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

function setup(g = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  Object.assign(window, {
    sidebarProjectSecondLine: true,
    projectTagDisplayMap: new Map(),
    bookmarksTags: { pickColor: () => '#123456' },
  }, g);
  vm.runInContext(fs.readFileSync(path.join(REN, 'lib/a11y-utils.js'), 'utf8'), ctx, { filename: 'lib/a11y-utils.js' });
  vm.runInContext(fs.readFileSync(path.join(REN, 'lib/project-name.js'), 'utf8'), ctx, { filename: 'lib/project-name.js' });
  vm.runInContext(fs.readFileSync(path.join(REN, 'shell/sidebar.js'), 'utf8'), ctx, { filename: 'shell/sidebar.js' });
  const call = (name, ...args) => vm.runInContext(name, ctx)(...args);
  return { window, call, destroy: () => window.close() };
}

test('#741: a tagged project gets one dot per tag, in its colour, named on hover', () => {
  const h = setup({
    projectTagDisplayMap: new Map([['/p', [{ tag: 'work', color: '#ff0000' }, { tag: 'later', color: '' }]]]),
  });
  try {
    const line = h.call('buildProjectSecondLine', '/p');
    assert.ok(line, 'the line is built');
    assert.equal(line.className, 'project-second-line');
    const dots = [...line.querySelectorAll('.project-tag-dot')];
    assert.deepEqual(dots.map(d => d.title), ['work', 'later'], 'every tag, in order, named by its tooltip');
    assert.ok(dots.every(d => d.classList.contains('session-tag-dot')), 'the dots reuse the shared tag swatch');
    assert.equal(dots[0].style.background, 'rgb(255, 0, 0)', 'the tag colour');
    assert.equal(dots[1].style.background, 'rgb(18, 52, 86)', 'a tag without a colour gets the picker colour');
  } finally { h.destroy(); }
});

test('#741: no line when the setting is off', () => {
  const h = setup({
    sidebarProjectSecondLine: false,
    projectTagDisplayMap: new Map([['/p', [{ tag: 'work', color: '#ff0000' }]]]),
  });
  try {
    assert.equal(h.call('buildProjectSecondLine', '/p'), null);
  } finally { h.destroy(); }
});

test('#741: no empty row for a project with nothing to show', () => {
  const h = setup();
  try {
    assert.equal(h.call('buildProjectSecondLine', '/untagged'), null);
  } finally { h.destroy(); }
});
