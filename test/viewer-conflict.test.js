'use strict';
// #442 — what the viewer does when the file moves underneath an edit.
//
// The panel used to reload on every `file-changed` and say nothing, so an agent rewriting an
// instruction file took the user's half-typed paragraph with it. #452 built the machinery — a baseline,
// a dirty test, a bar with three answers — and this file pins the behaviour that machinery has to have,
// including the half that only shows up one step later: after "Keep mine", the next save must actually
// write, not hand the user the same bar again.
//
// Same jsdom strategy as viewer-view-modes.test.js: evaluate the renderer's classic scripts in a
// window, stub what they read, drive ViewerPanel directly. The editor is a fake with a real document
// string, because what is being tested is which string ends up where.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');

const INDEX_HTML = `<!DOCTYPE html>
<html><head></head><body><div id="panel-container"></div></body></html>`;

function evalInWindow(dom, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext(), { filename: file });
}

/**
 * A window with the panel's scripts in it, plus a one-file "disk" it can read back.
 *
 * `disk.write()` is what something else rewriting the file looks like; `disk.fire()` is the
 * `file-changed` the main process would send afterwards. They are separate on purpose — a test that
 * writes without firing is the case where the panel has not been told yet.
 */
function setupPanelDom() {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  const disk = { content: '', writes: [] };
  let fileChangedListener = null;

  window.api = {
    onFileChanged: (fn) => { fileChangedListener = fn; return () => { fileChangedListener = null; }; },
    watchFile: () => {},
    unwatchFile: () => {},
    isFileReadOnly: () => Promise.resolve(false),
    readFileForPanel: async () => ({ ok: true, content: disk.content }),
  };

  const store = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
  });

  window.syncTitleToAriaLabel = () => {};
  window.appGlobalSettings = {};
  window.DOMPurify = { sanitize: (html) => html };
  window.marked = { parse: (text) => text };
  window.showControlMessage = () => {};
  window.showControlToast = () => {};
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);

  window.previewKindForExt = (ext) => (ext === 'md' ? 'markdown' : 'text');
  window.extOf = (filePath) => (filePath.split('.').pop() || '').toLowerCase();

  // Resolve the injected bundle <script> immediately — no network, no bundle.
  const realCreateElement = window.document.createElement.bind(window.document);
  window.document.createElement = function (tag, ...args) {
    const el = realCreateElement(tag, ...args);
    if (String(tag).toLowerCase() === 'script') {
      const origHeadAppend = window.document.head.appendChild.bind(window.document.head);
      window.document.head.appendChild = function (child) {
        const result = origHeadAppend(child);
        if (child === el && typeof el.onload === 'function') Promise.resolve().then(() => el.onload());
        return result;
      };
    }
    return el;
  };

  const makeEditor = (el, content = '') => {
    let doc = content;
    return {
      dispatch: (spec) => {
        if (spec && spec.changes) {
          const { from, to, insert } = spec.changes;
          doc = doc.slice(0, from) + (insert || '') + doc.slice(to);
        }
      },
      state: { doc: { toString: () => doc, get length() { return doc.length; } }, selection: { main: { from: 0, to: 0, anchor: 0, head: 0 } } },
      focus: () => {},
      destroy: () => {},
      _wrapCompartment: null,
      _type: (text) => { doc = text; },
    };
  };
  window.createEditableViewer = (el, content) => makeEditor(el, content);
  window.createPlanEditor = (el) => makeEditor(el, '');
  window.CMEditorView = { lineWrapping: [] };

  // text-sync.js carries textSyncChange / mapPosition / isPinnedToBottom, which _applyDiskContent uses.
  for (const file of ['text-sync.js', 'format-commands.js', 'format-toolbar.js', 'viewer-toolbar.js', 'viewer-panel.js']) {
    evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'views', file));
  }

  const container = window.document.getElementById('panel-container');
  return {
    window,
    container,
    disk,
    write: (text) => { disk.content = text; },
    fire: (p) => { if (fileChangedListener) fileChangedListener(p); },
    destroy: () => window.close(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openPanel(ctx, filePath, content) {
  ctx.write(content);
  const panel = new ctx.window.ViewerPanel(ctx.container, {
    language: 'auto',
    storageKey: 'viewer-conflict',
    onSave: async (p, text) => { ctx.disk.writes.push(text); ctx.write(text); return { ok: true }; },
  });
  panel.open('File', filePath, content);
  await settle();
  return panel;
}

/** What the user typing looks like from outside the editor. */
function type(panel, text) { panel.editorView._type(text); }

const conflictShown = (panel) => panel.conflictBar.el.style.display !== 'none';

// --- an external write against unsaved edits ---------------------------------

test('typing survives an external write, and the panel says so', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    type(panel, 'original\nmy half-typed paragraph\n');

    ctx.write('rewritten by something else\n');
    ctx.fire(panel._watchedPath);
    await settle();

    assert.equal(panel.getContent(), 'original\nmy half-typed paragraph\n', 'the edit is still there');
    assert.equal(conflictShown(panel), true, 'and the user is told the file moved');
  } finally { ctx.destroy(); }
});

test('a clean panel still refreshes by itself', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');

    ctx.write('rewritten by something else\n');
    ctx.fire(panel._watchedPath);
    await settle();

    assert.equal(panel.getContent(), 'rewritten by something else\n');
    assert.equal(conflictShown(panel), false, 'nothing was at stake, so nothing is asked');
  } finally { ctx.destroy(); }
});

// --- answering the bar --------------------------------------------------------

test('Reload takes the disk version and clears the notice', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    type(panel, 'mine\n');
    ctx.write('theirs\n');
    ctx.fire(panel._watchedPath);
    await settle();
    assert.equal(conflictShown(panel), true);

    panel.conflictBar.reloadBtn.click();

    assert.equal(panel.getContent(), 'theirs\n');
    assert.equal(conflictShown(panel), false);
  } finally { ctx.destroy(); }
});

test('Keep mine leaves the edit AND lets the next save write it', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    type(panel, 'mine\n');
    ctx.write('theirs\n');
    ctx.fire(panel._watchedPath);
    await settle();

    panel.conflictBar.keepBtn.click();
    assert.equal(panel.getContent(), 'mine\n', 'the edit is what "keep" means');
    assert.equal(conflictShown(panel), false, 'the question was answered');

    // The half that only shows one step later. `_save` re-reads the file and refuses when it no longer
    // matches the baseline — so unless "keep" moved the baseline too, this press raises the SAME bar
    // again and the panel can never write at all.
    await panel._save();
    await settle();

    assert.deepEqual(ctx.disk.writes, ['mine\n'], 'the save went through');
    assert.equal(ctx.disk.content, 'mine\n', 'and it overwrote the other version, as the button promised');
    assert.equal(conflictShown(panel), false);
  } finally { ctx.destroy(); }
});

test('after Keep mine a LATER external write raises the notice again', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    type(panel, 'mine\n');
    ctx.write('theirs\n');
    ctx.fire(panel._watchedPath);
    await settle();
    panel.conflictBar.keepBtn.click();
    assert.equal(conflictShown(panel), false);

    ctx.write('theirs, again\n');
    ctx.fire(panel._watchedPath);
    await settle();

    assert.equal(conflictShown(panel), true, 'keeping one version is not a standing waiver');
    assert.equal(panel.getContent(), 'mine\n');
  } finally { ctx.destroy(); }
});

// --- the other direction: a save over work the panel never saw ----------------

test('a save is refused when the file moved past the baseline', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    type(panel, 'mine\n');
    // No `file-changed` — the panel has not been told, which is exactly the reflexive-Ctrl+S case.
    ctx.write('twenty minutes of agent work\n');

    await panel._save();
    await settle();

    assert.deepEqual(ctx.disk.writes, [], 'nothing was written over it');
    assert.equal(conflictShown(panel), true, 'the same bar, from the other direction');
  } finally { ctx.destroy(); }
});

test('a save whose file already matches the editor just re-syncs', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    type(panel, 'same\n');
    ctx.write('same\n');   // someone saved exactly what this panel holds

    await panel._save();
    await settle();

    assert.deepEqual(ctx.disk.writes, [], 'there was nothing to write');
    assert.equal(conflictShown(panel), false, 'and nothing to ask about');
  } finally { ctx.destroy(); }
});
