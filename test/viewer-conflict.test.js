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
  // The real one is CodeMirror's merge view, out of reach here. What the panel needs from it is that it
  // exists and paints something into the host it is handed — which is enough to tell an open
  // side-by-side view from a closed one.
  // The real one returns a CodeMirror MergeView — two EditorViews with observers on each — and the
  // panel is obliged to destroy it before taking its DOM away. So the stub returns something with a
  // `destroy`, and counts the calls: a leak has no visible symptom, and this is the only place that can
  // see one.
  const merges = { made: 0, destroyed: 0, live: () => merges.made - merges.destroyed };
  window.createMergeViewer = (host, theirs, mine) => {
    host.dataset.theirs = theirs;
    host.dataset.mine = mine;
    const pane = host.ownerDocument.createElement('div');
    pane.className = 'merge-stub';
    host.appendChild(pane);
    merges.made += 1;
    return { destroy() { merges.destroyed += 1; } };
  };

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
    merges,
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

// --- the side-by-side view is a view OF the conflict ---------------------------
//
// It shipped alongside the baseline fix with no test behind it, which is the shape the renderer rules
// warn about: it looks right read, and reading is not the standard. What it must not do is outlive the
// question it was opened to answer — two versions side by side, one of which the app has since applied
// or discarded, is a worse lie than not showing the diff at all.

const diffOpen = (panel) => !!panel._conflictDiffEl;

async function raiseConflict(ctx, panel) {
  type(panel, 'mine\n');
  ctx.write('theirs\n');
  ctx.fire(panel._watchedPath);
  await settle();
}

test('Show changes puts both versions on screen, theirs first', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    await raiseConflict(ctx, panel);

    panel.conflictBar.showBtn.click();

    assert.equal(diffOpen(panel), true);
    const host = panel._conflictDiffEl.querySelector('.viewer-conflict-diff-body');
    assert.equal(host.dataset.theirs, 'theirs\n', 'the disk version is the left side');
    assert.equal(host.dataset.mine, 'mine\n', 'and the panel version the right');
  } finally { ctx.destroy(); }
});

test('answering the bar takes the side-by-side view with it', async () => {
  for (const answer of ['keepBtn', 'reloadBtn']) {
    const ctx = setupPanelDom();
    try {
      const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
      await raiseConflict(ctx, panel);
      panel.conflictBar.showBtn.click();
      assert.equal(diffOpen(panel), true);

      panel.conflictBar[answer].click();

      assert.equal(diffOpen(panel), false, `${answer} left a diff of a conflict that no longer exists`);
      assert.equal(ctx.window.document.querySelectorAll('.viewer-conflict-diff').length, 0,
        'and left nothing of it in the DOM');
    } finally { ctx.destroy(); }
  }
});

test('a save that resolves the conflict closes the view too', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    await raiseConflict(ctx, panel);
    panel.conflictBar.showBtn.click();
    assert.equal(diffOpen(panel), true);

    // Someone else saves exactly what this panel holds — the two are back in step, so there is no
    // conflict left for the view to be about, and nobody pressed a button to say so.
    ctx.write('mine\n');
    await panel._save();
    await settle();

    assert.equal(conflictShown(panel), false);
    assert.equal(diffOpen(panel), false);
  } finally { ctx.destroy(); }
});

test('opening another file carries no diff over from the last one', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    await raiseConflict(ctx, panel);
    panel.conflictBar.showBtn.click();
    assert.equal(diffOpen(panel), true);

    ctx.write('a different document\n');
    panel.open('B', '/tmp/b.md', 'a different document\n');
    await settle();

    assert.equal(diffOpen(panel), false, 'a new document starts with no argument about the last one');
    assert.equal(conflictShown(panel), false);
  } finally { ctx.destroy(); }
});

test('Show changes toggles rather than stacking overlays', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    await raiseConflict(ctx, panel);

    panel.conflictBar.showBtn.click();
    panel.conflictBar.showBtn.click();
    assert.equal(diffOpen(panel), false, 'the second press closes it');

    panel.conflictBar.showBtn.click();
    assert.equal(ctx.window.document.querySelectorAll('.viewer-conflict-diff').length, 1,
      'and reopening leaves exactly one');
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

// --- the file moves again while the user is deciding (#456) --------------------
//
// The panel is the one surface where a document is read while an agent rewrites it, so a second write
// arriving mid-decision is the expected case. The view used to keep showing the FIRST disk version while
// the bar had already moved on to the second — so the user compared their edits against something that
// was no longer there, and "Reload" then applied content that had never been on screen.

const diffNote = (panel) => panel._conflictDiffEl.querySelector('.viewer-conflict-diff-head span').textContent;
const diffTheirs = (panel) => panel._conflictDiffEl.querySelector('.viewer-conflict-diff-body').dataset.theirs;

test('a second write repaints the open view instead of leaving it stale', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    await raiseConflict(ctx, panel);
    panel.conflictBar.showBtn.click();
    assert.equal(diffTheirs(panel), 'theirs\n');

    ctx.write('theirs, second thoughts\n');
    ctx.fire(panel._watchedPath);
    await settle();

    assert.equal(diffTheirs(panel), 'theirs, second thoughts\n', 'the left side is what is on disk now');
    assert.equal(panel.getContent(), 'mine\n', 'and the edits are still untouched');
  } finally { ctx.destroy(); }
});

test('the second write is announced rather than swapped in silently', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    await raiseConflict(ctx, panel);
    panel.conflictBar.showBtn.click();
    const firstNote = diffNote(panel);
    assert.match(panel.conflictBar.msg.textContent, /changed on disk while you were editing/);

    ctx.write('theirs, second thoughts\n');
    ctx.fire(panel._watchedPath);
    await settle();

    assert.match(panel.conflictBar.msg.textContent, /changed on disk again/,
      'the bar says the question is not the one it was');
    assert.notEqual(diffNote(panel), firstNote, 'and the view says which side moved');
  } finally { ctx.destroy(); }
});

test('Reload after a mid-read change applies what the view was showing', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    await raiseConflict(ctx, panel);
    panel.conflictBar.showBtn.click();

    ctx.write('theirs, second thoughts\n');
    ctx.fire(panel._watchedPath);
    await settle();
    const shown = diffTheirs(panel);

    panel.conflictBar.reloadBtn.click();

    assert.equal(panel.getContent(), shown, 'the button applied the version on screen, not an older one');
    assert.equal(diffOpen(panel), false);
  } finally { ctx.destroy(); }
});

test('the announcement tells a real second write from an empty one', async () => {
  // Both halves in one test on purpose. Asserting only "nothing changed" passes against code that can
  // never change anything, which is exactly the pre-fix behaviour it is meant to guard against.
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    await raiseConflict(ctx, panel);
    panel.conflictBar.showBtn.click();
    const firstNote = diffNote(panel);

    // A watcher fires on a touch as readily as on a rewrite. Announcing "it changed again" for a write
    // that changed nothing would train the reader to ignore the line that matters.
    ctx.fire(panel._watchedPath);
    await settle();
    assert.equal(diffNote(panel), firstNote, 'no announcement for a write with nothing in it');
    assert.match(panel.conflictBar.msg.textContent, /while you were editing/);

    // ...and the same panel, one real write later, must move. Without this half the assertion above is
    // true of a panel that cannot announce anything at all.
    ctx.write('genuinely different\n');
    ctx.fire(panel._watchedPath);
    await settle();
    assert.notEqual(diffNote(panel), firstNote, 'a real second write is announced');
    assert.match(panel.conflictBar.msg.textContent, /changed on disk again/);
  } finally { ctx.destroy(); }
});

// --- the merge editors are given back ------------------------------------------

test('a repaint destroys the view it replaces', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    await raiseConflict(ctx, panel);
    panel.conflictBar.showBtn.click();
    assert.equal(ctx.merges.live(), 1);

    for (const text of ['second\n', 'third\n', 'fourth\n']) {
      ctx.write(text);
      ctx.fire(panel._watchedPath);
      await settle();
    }

    assert.equal(ctx.merges.made, 4, 'one view per version shown');
    assert.equal(ctx.merges.live(), 1, 'and only ever one of them alive');
  } finally { ctx.destroy(); }
});

test('closing the view gives the last one back too', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    await raiseConflict(ctx, panel);

    panel.conflictBar.showBtn.click();
    panel.conflictBar.keepBtn.click();
    assert.equal(ctx.merges.live(), 0, 'answering the bar took the editors with the overlay');

    // ...and the Back button, by the same route.
    ctx.write('again\n');
    ctx.fire(panel._watchedPath);
    await settle();
    panel.conflictBar.showBtn.click();
    assert.equal(ctx.merges.live(), 1);
    panel._conflictDiffEl.querySelector('.viewer-conflict-diff-head button').click();
    assert.equal(ctx.merges.live(), 0);
  } finally { ctx.destroy(); }
});

test('the bar still says the file moved when the merge viewer refuses', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    await raiseConflict(ctx, panel);
    panel.conflictBar.showBtn.click();

    // The one step in here that runs someone else's code. If it throws, what must survive is the part
    // the user acts on: the panel still says the file moved, and the buttons still work.
    ctx.window.createMergeViewer = () => { throw new Error('merge view unavailable'); };
    ctx.write('second\n');
    // No try here on purpose: this runs on the reload path, so an escaping throw would surface as an
    // unhandled rejection and take the refresh with it. The panel has to swallow it, not the test.
    ctx.fire(panel._watchedPath);
    await settle();

    assert.match(panel.conflictBar.msg.textContent, /changed on disk again/);
    assert.equal(panel.conflictBar.el.style.display !== 'none', true);
    assert.equal(panel._conflict.diskContent, 'second\n');
    assert.equal(!!panel._conflictDiffEl, false, 'the view that failed is gone, not left half-drawn');
    // And the bar still answers — a broken diff must not cost the user the decision.
    panel.conflictBar.reloadBtn.click();
    assert.equal(panel.getContent(), 'second\n');
  } finally { ctx.destroy(); }
});

test('a second write with the view closed still moves the question', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'original\n');
    await raiseConflict(ctx, panel);

    ctx.write('theirs, second thoughts\n');
    ctx.fire(panel._watchedPath);
    await settle();

    // Nothing to repaint, but the bar is about a different version now and has to say so — the user may
    // open the view at any point, and it must not be the only place that knows.
    assert.match(panel.conflictBar.msg.textContent, /changed on disk again/);
    panel.conflictBar.showBtn.click();
    assert.equal(diffTheirs(panel), 'theirs, second thoughts\n');
  } finally { ctx.destroy(); }
});
