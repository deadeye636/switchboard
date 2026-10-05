'use strict';
// The tag refresh asks for a sidebar render only when the project second line needs one (#741).
//
// WHY THIS EXISTS:
//   The second line draws project tags from `projectTagDisplayMap`, which `_refreshProjectTagFilter`
//   fills asynchronously — after the first paint and after every tag edit. Without a render then, the dots
//   stay missing until something unrelated rebuilds the sidebar. With a render on EVERY refresh, each
//   settings broadcast would cost a rebuild for nothing. This loads the real shell/sidebar-filters.js into a
//   jsdom vm context, with app.js's globals stubbed, and counts the renders it asks for.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

function setup({ secondLine = true, rows = [] } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  const doc = window.document;
  const renders = { n: 0 };
  const state = { rows };
  Object.assign(window, {
    // app.js's state and DOM handles, as sidebar-filters.js reaches for them at parse and call time.
    projectTagFilters: null,
    archiveToggle: doc.createElement('button'),
    starToggle: doc.createElement('button'),
    runningToggle: doc.createElement('button'),
    todayToggle: doc.createElement('button'),
    favoriteToggle: null,
    ICONS: { archive: () => '<svg></svg>' },
    activeProjectTagFilter: new Set(),
    activeSessionTagFilter: new Set(),
    projectTagMap: new Map(),
    sessionTagMap: new Map(),
    projectTagDisplayMap: new Map(),
    sidebarProjectSecondLine: secondLine,
    buildSessionTagMap: () => new Map(),
    escapeHtml: (s) => String(s),
    refreshSidebar: () => { renders.n++; },
  });
  window.api = {
    projectTagsAll: async () => state.rows,
    sessionTagsAll: async () => [],
  };
  vm.runInContext(fs.readFileSync(path.join(REN, 'bookmarks/project-tags-filter.js'), 'utf8'), ctx, { filename: 'project-tags-filter.js' });
  vm.runInContext(fs.readFileSync(path.join(REN, 'shell/sidebar-filters.js'), 'utf8'), ctx, { filename: 'sidebar-filters.js' });
  return {
    window, renders, state,
    refresh: () => window._refreshProjectTagFilter(),
    destroy: () => window.close(),
  };
}

const TAGGED = [{ projectPath: '/p', tag: 'work', color: '#ff0000' }];

test('#741: new tag rows with the second line on ask for one render and fill the display map', async () => {
  const h = setup({ rows: TAGGED });
  try {
    await h.refresh();
    assert.equal(h.renders.n, 1, 'the dots need a render to appear');
    assert.deepEqual(JSON.parse(JSON.stringify(h.window.projectTagDisplayMap.get('/p'))), [{ tag: 'work', color: '#ff0000' }]);
  } finally { h.destroy(); }
});

test('#741: an unchanged tag set asks for no second render', async () => {
  const h = setup({ rows: TAGGED });
  try {
    await h.refresh();
    await h.refresh();
    assert.equal(h.renders.n, 1, 'a settings broadcast that moved nothing costs no rebuild');
  } finally { h.destroy(); }
});

test('#741: a changed tag set asks for a render again', async () => {
  const h = setup({ rows: TAGGED });
  try {
    await h.refresh();
    h.state.rows = [...TAGGED, { projectPath: '/p', tag: 'later', color: '#00ff00' }];
    await h.refresh();
    assert.equal(h.renders.n, 2);
  } finally { h.destroy(); }
});

test('#741: with the second line off a tag change asks for no render, but the map is still kept', async () => {
  const h = setup({ secondLine: false, rows: TAGGED });
  try {
    await h.refresh();
    assert.equal(h.renders.n, 0, 'nothing on screen reads the map');
    assert.equal(h.window.projectTagDisplayMap.get('/p').length, 1, 'turning the line on later finds it filled');
  } finally { h.destroy(); }
});
