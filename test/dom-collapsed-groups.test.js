'use strict';
// The collapsed default in the Plans list (#481, #482). The Agent Files cases left with that tab (#823).
//
// WHY A FILE OF ITS OWN, AND WHY IT READS A CSS CLASS. jsdom does not gate `querySelector` or `.click()`
// on a class or on `display`, so the DOM tests that already touch these lists find and click rows inside
// a collapsed group and pass exactly as they did before the default changed — green either way. The only
// way a test can tell is to read `collapsed` itself, which is what every assertion here does.
//
// Strategy: load the view into a jsdom window with
// the globals app.js would have set, hand it a payload, read the DOM back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');

const INDEX_HTML = `<!DOCTYPE html>
<html>
  <body>
    <div id="plans-content"></div>
    <div id="placeholder"></div>
    <div id="plan-viewer"></div>
    <div id="stats-viewer"></div>
    <div id="jsonl-viewer"></div>
    <div id="timeline-viewer"></div>
    <div id="terminal-area"></div>
  </body>
</html>`;

function evalInWindow(dom, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext(), { filename: file });
}

const T = (offset) => new Date(Date.parse('2026-05-22T10:00:00Z') + offset).toISOString();

/** Two projects' worth of plans, so "which projects have plans" is a question the list can answer. */
function plans() {
  return [
    { filename: 'alpha.md', filePath: '/p/one/.plans/alpha.md', title: 'Alpha', projectPath: '/p/one',
      shortName: 'work/one', displayName: 'One', modified: T(0), size: 64 },
    { filename: 'beta.md', filePath: '/p/two/.plans/beta.md', title: 'Beta', projectPath: '/p/two',
      shortName: 'work/two', displayName: 'Two', modified: T(-1000), size: 64 },
  ];
}

function setupDom() {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  if (!window.CSS) {
    Object.defineProperty(window, 'CSS', {
      value: { escape: (str) => str.replace(/([^\w-])/g, '\\$1') },
      writable: true, configurable: true,
    });
  }

  // Every re-run of the live query the view asks for, recorded rather than performed: search-bar.js
  // needs half of app.js to load, and what is under test here is whether the view asks at all.
  const reapplied = [];

  window.api = {
    getPlans: () => Promise.resolve({ plans: plans(), hasStore: true, unfulfilled: [] }),
  };

  const panelStub = { open: () => {}, close: () => {} };
  const stubGlobals = {
    plansContent:   window.document.getElementById('plans-content'),
    placeholder:    window.document.getElementById('placeholder'),
    planViewer:     window.document.getElementById('plan-viewer'),
    statsViewer:    window.document.getElementById('stats-viewer'),
    jsonlViewer:    window.document.getElementById('jsonl-viewer'),
    timelineViewer: window.document.getElementById('timeline-viewer'),
    terminalArea:   window.document.getElementById('terminal-area'),
    planPanel:      panelStub,
    cachedPlans:    [],
    activeTab:      'plans',
    reapplyActiveSearch: () => { reapplied.push(true); },
    routeFileToViewWindow: () => Promise.resolve(false),
  };
  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'lib', 'utils.js'));
  evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'lib', 'icons.js'));
  evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'lib', 'project-name.js'));
  evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'views', 'plan-groups.js'));
  evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'views', 'plans-memory-view.js'));

  const state = (selector) => [...window.document.querySelectorAll(selector)]
    .map(g => g.querySelector('.project-name').textContent
      + (g.classList.contains('collapsed') ? ':collapsed' : ':open'));

  return {
    window,
    document: window.document,
    reapplied,
    planGroups: () => state('#plans-content .plan-group'),
    destroy() { window.close(); },
  };
}

// --- the default -----------------------------------------------------------------------------------

test('a plans project group starts collapsed', async () => {
  const ctx = setupDom();
  try {
    await ctx.window.loadPlans();
    assert.deepEqual(ctx.planGroups(), ['One:collapsed', 'Two:collapsed']);
  } finally { ctx.destroy(); }
});

// --- a filter opens what it found ------------------------------------------------------------------

test('a plans search opens the groups holding its matches', async () => {
  const ctx = setupDom();
  try {
    await ctx.window.loadPlans();
    // What search-bar.js hands over while a query is live: a filtered copy, never `cachedPlans` itself.
    ctx.window.renderPlans(ctx.window.cachedPlans.filter(p => p.title === 'Alpha'));
    assert.deepEqual(ctx.planGroups(), ['One:open']);
  } finally { ctx.destroy(); }
});

// --- what the user opens, stays open ---------------------------------------------------------------

test('a plans group opened by hand is still open after the list rebuilds', async () => {
  const ctx = setupDom();
  try {
    await ctx.window.loadPlans();
    ctx.document.querySelector('#plans-content .plan-group .project-header').click();
    assert.deepEqual(ctx.planGroups(), ['One:open', 'Two:collapsed']);
    await ctx.window.loadPlans();
    assert.deepEqual(ctx.planGroups(), ['One:open', 'Two:collapsed'], 'the reload must not close it again');
  } finally { ctx.destroy(); }
});

// --- a click during a filter decides nothing about the full list ------------------------------------

test('collapsing a plans group during a search does not survive the search', async () => {
  const ctx = setupDom();
  try {
    await ctx.window.loadPlans();
    ctx.document.querySelector('#plans-content .plan-group .project-header').click();   // One: open
    ctx.window.renderPlans(ctx.window.cachedPlans.filter(p => p.title === 'Alpha'));
    ctx.document.querySelector('#plans-content .plan-group .project-header').click();   // shut it, mid-search
    assert.deepEqual(ctx.planGroups(), ['One:collapsed'], 'the click still folds the group on screen');
    ctx.window.renderPlans(ctx.window.cachedPlans);                                     // query gone
    assert.deepEqual(ctx.planGroups(), ['One:open', 'Two:collapsed'],
      'a click on a list of matches must not decide where the group stands for the full list');
  } finally { ctx.destroy(); }
});

// --- a reload puts the live query back --------------------------------------------------------------

test('a plans reload re-runs the live query, and only for the tab on screen', async () => {
  const ctx = setupDom();
  try {
    await ctx.window.loadPlans();
    assert.equal(ctx.reapplied.length, 1, 'the plans tab is the one on screen');
    ctx.window.activeTab = 'sessions';
    await ctx.window.loadPlans();
    assert.equal(ctx.reapplied.length, 1, 'a reload for a tab nobody is looking at must not search');
  } finally { ctx.destroy(); }
});

