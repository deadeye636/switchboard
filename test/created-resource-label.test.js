// The label a newly created resource's tab gets (#564).
//
// `createResourceInGroup` opens what main just wrote, and the tab is labelled with the file's name.
// That name used to be derived by splitting the returned path on forward slashes only — so on Windows,
// where `path.join` produces backslashes, the split found nothing to cut and the tab carried the whole
// path. The read itself was never affected; only the label was.
//
// Every path here is BUILT from segments and joined with the separator under test, never written as a
// literal, so both cases are exercised on both platforms instead of whichever one the runner happens to
// use.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');

// An invented location — no real path belongs in a fixture.
const SEGMENTS = ['srv', 'invented', 'workspace', '.claude', 'skills', 'review', 'SKILL.md'];
const withSeparator = (sep) => sep + SEGMENTS.join(sep);

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
  vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext(), { filename: file });
}

/** The renderer's own scope, with the free globals `plans-memory-view.js` reads from its neighbours. */
function setupDom() {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  if (!window.CSS) {
    Object.defineProperty(window, 'CSS', {
      value: { escape: (str) => str.replace(/([^\w-])/g, '\\$1') },
      writable: true, configurable: true,
    });
  }

  const viewerStub = () => ({ open: () => {}, close: () => {} });
  const stubGlobals = {
    plansContent:    window.document.getElementById('plans-content'),
    memoryContent:   window.document.getElementById('memory-content'),
    placeholder:     window.document.getElementById('placeholder'),
    planViewer:      window.document.getElementById('plan-viewer'),
    memoryViewer:    window.document.getElementById('memory-viewer'),
    workFilesViewer: window.document.getElementById('work-files-viewer'),
    statsViewer:     window.document.getElementById('stats-viewer'),
    jsonlViewer:     window.document.getElementById('jsonl-viewer'),
    timelineViewer:  window.document.getElementById('timeline-viewer'),
    terminalArea:    window.document.getElementById('terminal-area'),
    planPanel:       viewerStub(),
    memoryPanel:     viewerStub(),
    workFilesPanel:  viewerStub(),
    cachedPlans:     [],
    cachedMemoryData: { global: { files: [], groups: [] }, projects: [] },
    routeFileToViewWindow: () => Promise.resolve(false),
  };
  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  for (const rel of [
    ['lib', 'utils.js'],
    ['lib', 'icons.js'],
    ['lib', 'project-name.js'],
    ['views', 'agent-file-filter.js'],
    ['views', 'plans-memory-view.js'],
  ]) evalInWindow(dom, path.join(SRC_DIR, 'renderer', ...rel));

  return { dom, window, destroy() { window.close(); } };
}

/**
 * Run the create flow against a path main "returned", and report the label the viewer was handed.
 *
 * `openMemory` is a top-level function declaration, so it lands on the VM's global and a stub can take
 * its place — which is the only place the derived label is observable.
 */
async function labelForCreatedPath(createdPath) {
  const { window, destroy } = setupDom();
  try {
    let opened = null;
    window.showControlDialog = async () => 'review';
    window.showControlMessage = () => {};
    window.showControlToast = () => {};
    window.openMemory = async (file) => { opened = file; };
    window.api = {
      getMemories: () => Promise.resolve({ global: { files: [], groups: [] }, projects: [] }),
      backends: { createResource: async () => ({ ok: true, path: createdPath }) },
    };

    await window.createResourceInGroup(
      { backendId: 'claude', label: 'Skills', path: '/srv/invented/workspace/.claude/skills', creatableKinds: ['skill'] },
      null,
    );
    assert.ok(opened, 'the created resource was not opened');
    return opened;
  } finally {
    destroy();
  }
}

test('a created resource whose path uses backslashes is labelled with its file name', async () => {
  const created = withSeparator('\\');
  const opened = await labelForCreatedPath(created);
  assert.equal(opened.filename, 'SKILL.md');
  // The read is unchanged: the viewer still gets the path exactly as main returned it.
  assert.equal(opened.filePath, created);
});

test('a created resource whose path uses forward slashes is still labelled with its file name', async () => {
  const created = withSeparator('/');
  const opened = await labelForCreatedPath(created);
  assert.equal(opened.filename, 'SKILL.md');
  assert.equal(opened.filePath, created);
});

test('a created resource whose path this platform built is labelled with its file name', async () => {
  const created = path.join(path.sep, ...SEGMENTS);
  const opened = await labelForCreatedPath(created);
  assert.equal(opened.filename, 'SKILL.md');
});

test('pathBasename cuts at either separator, and says nothing rather than guessing', () => {
  const { window, destroy } = setupDom();
  try {
    const { pathBasename } = window;
    assert.equal(pathBasename(withSeparator('\\')), 'SKILL.md');
    assert.equal(pathBasename(withSeparator('/')), 'SKILL.md');
    assert.equal(pathBasename(path.join(path.sep, ...SEGMENTS)), 'SKILL.md');
    // A directory named with a trailing separator is still that directory.
    assert.equal(pathBasename(withSeparator('/') + '/'), 'SKILL.md');
    // Mixed separators happen when a native path is appended to a stored one.
    assert.equal(pathBasename('/srv/invented\\workspace\\notes.md'), 'notes.md');
    assert.equal(pathBasename(''), '');
    assert.equal(pathBasename(null), '');
    assert.equal(pathBasename(undefined), '');
    assert.equal(pathBasename('/'), '');
    // No separator at all is the whole string.
    assert.equal(pathBasename('SKILL.md'), 'SKILL.md');
  } finally {
    destroy();
  }
});
