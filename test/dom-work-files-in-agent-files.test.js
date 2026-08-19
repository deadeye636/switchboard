// Work files inside the Agent Files list (#448).
//
// This file used to test a tab of its own. The tab is gone: work files arrive with `get-memories` as
// one group per project, and the Agent Files renderer draws them. What has to keep working is the part
// the merge could quietly drop — the path that tells two `notes.md` apart, the badge that admits the
// cap, and the viewer that can delete opening for a work file and for nothing else.
//
// Strategy: load the renderer into a jsdom window with the globals app.js would have set, hand it a
// payload, and read the DOM back.

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
    <div id="sidebar-content"></div>
    <div id="plans-content"></div>
    <div id="agent-file-type-filters"></div>
    <div id="memory-content"></div>
    <div id="placeholder"></div>
    <div id="plan-viewer"></div>
    <div id="memory-viewer"></div>
    <div id="work-files-viewer"></div>
    <div id="stats-viewer"></div>
    <div id="jsonl-viewer"></div>
    <div id="timeline-viewer"></div>
    <div id="terminal-area"></div>
  </body>
</html>`;

function evalInWindow(dom, file) {
  const src = fs.readFileSync(file, 'utf8');
  vm.runInContext(src, dom.getInternalVMContext(), { filename: file });
}

/** A ViewerPanel stub that records what it was asked to show — which panel opened is the assertion. */
function makeViewerPanelStub() {
  const opened = [];
  return { opened, open: (title, filePath, content) => opened.push({ title, filePath, content }), close: () => {} };
}

function setupDom() {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  // jsdom has no CSS.escape, and the open paths use it to find the row they just drew.
  if (!window.CSS) {
    Object.defineProperty(window, 'CSS', {
      value: { escape: (str) => str.replace(/([^\w-])/g, '\\$1') },
      writable: true, configurable: true,
    });
  }

  window.api = {
    getMemories: () => Promise.resolve({ global: { files: [], groups: [] }, projects: [] }),
    readWorkFile: () => Promise.resolve(''),
    readMemory: () => Promise.resolve(''),
  };

  const panels = { plan: makeViewerPanelStub(), memory: makeViewerPanelStub(), workFiles: makeViewerPanelStub() };
  const stubGlobals = {
    plansContent:   window.document.getElementById('plans-content'),
    memoryContent:  window.document.getElementById('memory-content'),
    placeholder:    window.document.getElementById('placeholder'),
    planViewer:     window.document.getElementById('plan-viewer'),
    memoryViewer:   window.document.getElementById('memory-viewer'),
    workFilesViewer: window.document.getElementById('work-files-viewer'),
    statsViewer:    window.document.getElementById('stats-viewer'),
    jsonlViewer:    window.document.getElementById('jsonl-viewer'),
    timelineViewer: window.document.getElementById('timeline-viewer'),
    terminalArea:   window.document.getElementById('terminal-area'),
    planPanel:      panels.plan,
    memoryPanel:    panels.memory,
    workFilesPanel: panels.workFiles,
    cachedPlans:    [],
    cachedMemoryData: { global: { files: [], groups: [] }, projects: [] },
    // A row only routes to another window when one is open; here nothing is, so every click opens in place.
    routeFileToViewWindow: () => Promise.resolve(false),
  };
  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'lib', 'utils.js'));
  evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'lib', 'icons.js'));
  evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'lib', 'project-name.js'));
  evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'views', 'agent-file-filter.js'));
  evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'views', 'plans-memory-view.js'));

  return {
    window,
    document: window.document,
    panels,
    async loadWith(data) {
      window.api.getMemories = () => Promise.resolve(data);
      await window.loadMemories();
    },
    destroy() { window.close(); },
  };
}

const T = (offset) => new Date(Date.parse('2026-05-22T10:00:00Z') + offset).toISOString();

/** A work file in the shape `workFilesGroup` in src/app/plans-memory.js produces. */
function workFile(relativePath, offset = 0) {
  return {
    filename: path.posix.basename(relativePath),
    filePath: '/p/one/.work-files/' + relativePath,
    relativePath,
    displayPath: relativePath,
    kind: 'work-file',
    backendIds: [],
    modified: T(offset),
    size: 128,
  };
}

function payload({ total = 3, files = null } = {}) {
  const wf = files || [workFile('plan.md'), workFile('citadel/notes.md', -1000), workFile('notes.md', -2000)];
  return {
    global: { files: [], groups: [] },
    projects: [{
      folder: 'f-one', projectPath: '/p/one', shortName: 'work/one', displayName: '',
      files: [{
        filename: 'CLAUDE.md', filePath: '/p/one/CLAUDE.md', displayPath: 'CLAUDE.md',
        kind: 'instructions', backendIds: ['claude'], modified: T(-100), size: 64,
      }],
      groups: [{
        id: 'work-files:/p/one', backendId: null, backendLabel: null, label: '.work-files',
        kind: 'work-file', path: '/p/one/.work-files', total, files: wf,
      }],
    }],
    types: [
      { id: 'work-file', label: 'Work files', count: wf.length },
      { id: 'instructions', label: 'Instructions', count: 1 },
    ],
    backends: [{ id: 'claude', label: 'Claude', count: 1 }],
  };
}

// ---- the list ----

test('work files render as a group under their project, beside the instruction files', async () => {
  const ctx = setupDom();
  try {
    await ctx.loadWith(payload());
    const group = ctx.document.querySelector('#memory-content .memory-resource-group');
    assert.ok(group, 'the work files must render as a resource group');
    assert.equal(group.querySelector('.project-name').textContent, '.work-files');
    assert.equal(group.querySelectorAll('.memory-item').length, 3, 'every work file is a row');
    // The project's own instruction file is still there — the group is beside it, not instead of it.
    assert.equal(ctx.document.querySelectorAll('#memory-content .memory-item').length, 4);
  } finally { ctx.destroy(); }
});

test('a work file row shows the path inside .work-files, not the bare filename', async () => {
  const ctx = setupDom();
  try {
    await ctx.loadWith(payload());
    const rows = [...ctx.document.querySelectorAll('#memory-content .memory-resource-group .memory-item')];
    const nested = rows.find(r => r.dataset.filepath.endsWith('citadel/notes.md'));
    assert.ok(nested, 'the nested file must be listed');
    // Two notes.md in one tree are told apart by this and by nothing else.
    assert.equal(nested.querySelector('.session-summary').textContent, 'notes.md');
    assert.equal(nested.querySelector('.session-id').textContent, 'citadel/notes.md');
  } finally { ctx.destroy(); }
});

test('the group header admits the cap: shown/total when the list is truncated', async () => {
  const ctx = setupDom();
  try {
    await ctx.loadWith(payload({ total: 500 }));
    const badge = ctx.document.querySelector('#memory-content .memory-resource-group .memory-file-count');
    assert.equal(badge.textContent, '3/500', 'a capped project must not look complete');
  } finally { ctx.destroy(); }
});

test('an uncapped group shows a plain count', async () => {
  const ctx = setupDom();
  try {
    await ctx.loadWith(payload({ total: 3 }));
    const badge = ctx.document.querySelector('#memory-content .memory-resource-group .memory-file-count');
    assert.equal(badge.textContent, '3');
  } finally { ctx.destroy(); }
});

test('the group names no backend, because no CLI owns .work-files/', async () => {
  const ctx = setupDom();
  try {
    await ctx.loadWith(payload());
    const header = ctx.document.querySelector('#memory-content .memory-resource-header');
    assert.equal(header.querySelector('.memory-backend-badge'), null, 'no monogram may be invented');
    assert.ok(header.querySelector('.work-file-icon'), 'the empty badge slot carries the folder glyph');
  } finally { ctx.destroy(); }
});

// ---- the filter ----

test('filtering to Work files keeps them and drops the instruction files', async () => {
  const ctx = setupDom();
  try {
    await ctx.loadWith(payload());
    const chip = ctx.document.querySelector('#agent-file-type-filters .project-tag-chip[data-value="work-file"]');
    assert.ok(chip, 'the type filter must offer a Work files chip');
    chip.click();

    const rows = [...ctx.document.querySelectorAll('#memory-content .memory-item')];
    assert.equal(rows.length, 3, 'only the work files survive');
    assert.ok(rows.every(r => r.dataset.filepath.includes('.work-files')));
  } finally { ctx.destroy(); }
});

test('filtering to another type drops the work-files group entirely', async () => {
  const ctx = setupDom();
  try {
    await ctx.loadWith(payload());
    ctx.document.querySelector('#agent-file-type-filters .project-tag-chip[data-value="instructions"]').click();
    assert.equal(ctx.document.querySelector('#memory-content .memory-resource-group'), null,
      'a group with no surviving file must not render as an empty folder');
    assert.equal(ctx.document.querySelectorAll('#memory-content .memory-item').length, 1);
  } finally { ctx.destroy(); }
});

// ---- opening and deleting ----

test('a work file opens in the viewer that can delete, not in the memory viewer', async () => {
  const ctx = setupDom();
  try {
    ctx.window.api.readWorkFile = () => Promise.resolve('# notes');
    await ctx.loadWith(payload());

    const row = [...ctx.document.querySelectorAll('#memory-content .memory-item')]
      .find(r => r.dataset.filepath.endsWith('.work-files/plan.md'));
    row.click();
    await new Promise(r => setTimeout(r, 0));

    assert.equal(ctx.panels.workFiles.opened.length, 1, 'the delete-capable panel opens it');
    assert.equal(ctx.panels.memory.opened.length, 0, 'the memory panel must not');
    assert.equal(ctx.document.getElementById('work-files-viewer').style.display, 'flex');
    assert.equal(ctx.document.getElementById('terminal-area').style.display, 'none');
    assert.ok(ctx.document.querySelector('#memory-content .memory-item.active'), 'the row marks itself');
  } finally { ctx.destroy(); }
});

test('an instruction file still opens in the memory viewer', async () => {
  const ctx = setupDom();
  try {
    await ctx.loadWith(payload());
    const row = [...ctx.document.querySelectorAll('#memory-content .memory-item')]
      .find(r => r.dataset.filepath === '/p/one/CLAUDE.md');
    row.click();
    await new Promise(r => setTimeout(r, 0));

    assert.equal(ctx.panels.memory.opened.length, 1);
    assert.equal(ctx.panels.workFiles.opened.length, 0, 'no other type may reach the delete-capable panel');
  } finally { ctx.destroy(); }
});

test('a deleted work file leaves the list and the total counts down with it', async () => {
  const ctx = setupDom();
  try {
    await ctx.loadWith(payload({ total: 500 }));
    ctx.window.removeWorkFileFromCache('/p/one/.work-files/plan.md');

    const rows = [...ctx.document.querySelectorAll('#memory-content .memory-resource-group .memory-item')];
    assert.equal(rows.length, 2);
    assert.equal(rows.find(r => r.dataset.filepath.endsWith('/plan.md')), undefined);
    // 499, not 500: the header would otherwise go on claiming a file that is gone.
    assert.equal(
      ctx.document.querySelector('#memory-content .memory-resource-group .memory-file-count').textContent,
      '2/499');
  } finally { ctx.destroy(); }
});

test('deleting the last work file takes the group with it', async () => {
  const ctx = setupDom();
  try {
    await ctx.loadWith(payload({ total: 1, files: [workFile('only.md')] }));
    ctx.window.removeWorkFileFromCache('/p/one/.work-files/only.md');
    assert.equal(ctx.document.querySelector('#memory-content .memory-resource-group'), null,
      'an empty folder is not a thing to show');
  } finally { ctx.destroy(); }
});
