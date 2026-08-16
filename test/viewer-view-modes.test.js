// Tests for the viewer's three view modes (#281).
//
// The commands themselves are covered by format-commands.test.js. What is left
// here is everything the panel decides: which mode a file opens in, what gets
// written back to localStorage, and the two rules that are easy to break the
// moment someone touches this — a settings seed must never be persisted (#279),
// and a file that cannot be written is pinned to preview and its forced mode is
// never persisted either, or one unwritable file would set the mode for the rest.
//
// Same jsdom strategy as lazy-codemirror.test.js: evaluate the renderer's classic
// scripts in a window, stub what they read, drive ViewerPanel directly.

'use strict';
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

function setupPanelDom({ settings = {}, stored = null, readOnly = false } = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  window.api = {
    onFileChanged: () => {},
    watchFile: () => {},
    unwatchFile: () => {},
    isFileReadOnly: () => Promise.resolve(readOnly),
  };

  const store = new Map();
  if (stored !== null) store.set('viewer-mode', stored);
  // jsdom exposes localStorage as a getter-only property, so it has to be
  // redefined rather than assigned.
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
  });

  window.syncTitleToAriaLabel = () => {};
  window.appGlobalSettings = settings;
  window.DOMPurify = { sanitize: (html) => html };
  window.marked = { parse: (text) => text };

  window.previewKindForExt = (ext) => (ext === 'html' || ext === 'htm'
    ? 'html'
    : (ext === 'md' || ext === 'mdx' ? 'markdown' : 'text'));
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
      state: { doc: { toString: () => doc, get length() { return doc.length; } }, selection: { main: { from: 0, to: doc.length } } },
      focus: () => {},
      destroy: () => {},
      _wrapCompartment: null,
    };
  };
  window.createEditableViewer = (el, content) => makeEditor(el, content);
  window.createPlanEditor = (el) => makeEditor(el, '');
  window.CMEditorView = { lineWrapping: [] };

  for (const file of ['format-commands.js', 'format-toolbar.js', 'viewer-toolbar.js', 'viewer-panel.js']) {
    evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'views', file));
  }

  const container = window.document.getElementById('panel-container');
  return { window, container, store, destroy: () => window.close() };
}

async function openPanel(ctx, filePath, content = '# hi', opts = {}) {
  const panel = new ctx.window.ViewerPanel(ctx.container, {
    language: 'auto', storageKey: 'viewer-mode', onSave: () => ({ ok: true }), ...opts,
  });
  panel.open('File', filePath, content);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return panel;
}

// --- which mode a file opens in ---------------------------------------------

test('a Markdown file opens in edit with the formatting bar', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    assert.equal(panel.viewMode, 'edit');
    assert.equal(panel.formatBar.el.classList.contains('has-commands'), true);
    assert.ok(panel.formatBar.el.querySelector('[data-command="bold"]'));
  } finally { ctx.destroy(); }
});

test('editorToolbarMode plain opens the same file in text, with no bar', async () => {
  const ctx = setupPanelDom({ settings: { editorToolbarMode: 'plain' } });
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    assert.equal(panel.viewMode, 'text');
    assert.equal(panel.formatBar.el.classList.contains('has-commands'), false);
  } finally { ctx.destroy(); }
});

test('markdownDefaultView preview still wins over both source modes', async () => {
  const ctx = setupPanelDom({ settings: { markdownDefaultView: 'preview', editorToolbarMode: 'plain' } });
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    assert.equal(panel.viewMode, 'preview');
    assert.equal(panel.previewMode, true);
    assert.equal(panel.editorEl.style.display, 'none');
  } finally { ctx.destroy(); }
});

test('an HTML file gets the same three modes and its own command table', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/page.html', '<h1>hi</h1>');
    assert.equal(panel.viewMode, 'edit');
    assert.equal(panel._formatKind, 'html');
    // The HTML table has no task list; the Markdown one does.
    assert.equal(panel.formatBar.el.querySelector('[data-command="task-list"]'), null);
    assert.ok(panel.formatBar.el.querySelector('[data-command="bullet-list"]'));
  } finally { ctx.destroy(); }
});

test('a file with no rendered preview gets no mode control and no bar', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/data.json', '{}');
    assert.equal(panel.toolbar.modeGroup.style.display, 'none');
    assert.equal(panel.formatBar.el.classList.contains('has-commands'), false);
    assert.equal(panel._formatKind, null);
  } finally { ctx.destroy(); }
});

test('editorToolbarHtmlTags off drops the four HTML buttons from a Markdown file', async () => {
  const ctx = setupPanelDom({ settings: { editorToolbarHtmlTags: 'off' } });
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    for (const id of ['underline', 'color', 'highlight', 'align']) {
      assert.equal(panel.formatBar.el.querySelector(`[data-command="${id}"]`), null, `${id} must be gone`);
    }
    assert.ok(panel.formatBar.el.querySelector('[data-command="bold"]'));
  } finally { ctx.destroy(); }
});

test('the switch does not touch an HTML file', async () => {
  const ctx = setupPanelDom({ settings: { editorToolbarHtmlTags: 'off' } });
  try {
    const panel = await openPanel(ctx, '/tmp/page.html', '<p>hi</p>');
    assert.ok(panel.formatBar.el.querySelector('[data-command="underline"]'));
  } finally { ctx.destroy(); }
});

// --- persistence -------------------------------------------------------------

test('a settings seed is never written back to storage', async () => {
  const ctx = setupPanelDom({ settings: { markdownDefaultView: 'preview' } });
  try {
    await openPanel(ctx, '/tmp/a.md');
    assert.equal(ctx.store.has('viewer-mode'), false, 'the seed must not pin itself (#279)');
  } finally { ctx.destroy(); }
});

test('clicking a mode stores it', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    panel.toolbar.modeButtons.text.click();
    assert.equal(panel.viewMode, 'text');
    assert.equal(ctx.store.get('viewer-mode'), 'text');
    panel.toolbar.modeButtons.preview.click();
    assert.equal(ctx.store.get('viewer-mode'), 'preview');
  } finally { ctx.destroy(); }
});

test('a stored mode beats the settings', async () => {
  const ctx = setupPanelDom({ settings: { markdownDefaultView: 'preview' }, stored: 'text' });
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    assert.equal(panel.viewMode, 'text');
  } finally { ctx.destroy(); }
});

test("the legacy 'true' migrates to preview", async () => {
  const ctx = setupPanelDom({ stored: 'true' });
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    assert.equal(panel.viewMode, 'preview');
    assert.equal(ctx.store.get('viewer-mode'), 'preview', 'the boolean must be rewritten as a mode');
  } finally { ctx.destroy(); }
});

test("the legacy 'false' migrates to the source mode the settings name", async () => {
  const ctx = setupPanelDom({ stored: 'false', settings: { editorToolbarMode: 'plain', markdownDefaultView: 'preview' } });
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    // 'false' was an explicit "not preview", so markdownDefaultView must not win.
    assert.equal(panel.viewMode, 'text');
    assert.equal(ctx.store.get('viewer-mode'), 'text');
  } finally { ctx.destroy(); }
});

// --- read-only ---------------------------------------------------------------

test('a file that cannot be written opens in preview and stays there', async () => {
  const ctx = setupPanelDom({ readOnly: true });
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    assert.equal(panel.viewMode, 'preview');
    assert.equal(panel.readOnly, true);
    assert.equal(panel.toolbar.readOnlyBadge.style.display, '');
    assert.equal(panel.toolbar.saveBtn.style.display, 'none');

    assert.equal(panel.toolbar.modeButtons.edit.disabled, true);
    assert.equal(panel.toolbar.modeButtons.text.disabled, true);
    assert.equal(panel.toolbar.modeButtons.preview.disabled, false);

    panel.toolbar.modeButtons.edit.click();
    assert.equal(panel.viewMode, 'preview', 'the pin must hold');
  } finally { ctx.destroy(); }
});

test('the forced preview is never persisted', async () => {
  const ctx = setupPanelDom({ readOnly: true, stored: 'text' });
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    assert.equal(panel.viewMode, 'preview');
    assert.equal(ctx.store.get('viewer-mode'), 'text',
      'one unwritable file must not set the mode for every other one');
  } finally { ctx.destroy(); }
});

test('a read-only file with no preview keeps its editor but loses saving', async () => {
  const ctx = setupPanelDom({ readOnly: true });
  try {
    const panel = await openPanel(ctx, '/tmp/data.json', '{}');
    assert.equal(panel.viewMode, 'edit', 'there is nothing to pin to');
    assert.equal(panel.toolbar.saveBtn.style.display, 'none');
  } finally { ctx.destroy(); }
});

// --- placement and visibility ------------------------------------------------

test('the bar is one wrapping row, not two fixed ones', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    const rows = panel.formatBar.el.querySelectorAll('.viewer-format-row');
    assert.equal(rows.length, 1, 'width decides the break, not the command table');
    assert.ok(rows[0].querySelectorAll('button').length > 12);
  } finally { ctx.destroy(); }
});

test('overlay places the same commands over the editor', async () => {
  const ctx = setupPanelDom({ settings: { editorToolbarPlacement: 'overlay' } });
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    assert.equal(panel.formatBar.el.classList.contains('is-overlay'), true);
    assert.equal(panel.formatBar.el.classList.contains('is-bar'), false);
    assert.ok(panel.formatBar.el.querySelector('[data-command="heading"]'), 'nothing is dropped');
  } finally { ctx.destroy(); }
});

test('the selection popup shows the character commands and hides the block ones behind more', async () => {
  const ctx = setupPanelDom({ settings: { editorToolbarPlacement: 'selection' } });
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    const bar = panel.formatBar.el;
    assert.equal(bar.classList.contains('is-selection'), true);
    assert.ok(bar.querySelector('[data-command="bold"]'), 'character commands stay visible');
    assert.equal(bar.querySelector('[data-command="heading"]'), null, 'block commands move behind the overflow');
    assert.ok(bar.querySelector('[data-command="more"]'), 'and the overflow button exists');
  } finally { ctx.destroy(); }
});

test('the overflow list is flat — a heading level is one entry, not a submenu', async () => {
  const ctx = setupPanelDom({ settings: { editorToolbarPlacement: 'selection' } });
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    panel.formatBar.el.querySelector('[data-command="more"]').click();
    const items = [...panel.formatBar.el.querySelectorAll('.viewer-format-menu-item')].map((n) => n.textContent);
    assert.ok(items.includes('Heading 2'), 'heading levels are spelled out');
    assert.ok(items.includes('Align centre'));
    assert.ok(items.includes('Bullet list'));
    assert.equal(panel.formatBar.el.querySelectorAll('.viewer-format-menu').length, 1, 'one level only');
  } finally { ctx.destroy(); }
});

test('hover visibility marks the panel, and never the selection popup', async () => {
  const ctx = setupPanelDom({ settings: { editorToolbarVisibility: 'hover' } });
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    assert.equal(ctx.container.classList.contains('viewer-panel-hover-toolbar'), true);
  } finally { ctx.destroy(); }

  const popup = setupPanelDom({ settings: { editorToolbarVisibility: 'hover', editorToolbarPlacement: 'selection' } });
  try {
    await openPanel(popup, '/tmp/a.md');
    assert.equal(popup.container.classList.contains('viewer-panel-hover-toolbar'), false,
      'the popup is already conditional — hiding it on hover would hide it twice');
  } finally { popup.destroy(); }
});

// --- the bar drives the editor ----------------------------------------------

test('a toolbar button writes through the editor, not the file', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md', 'word');
    panel.editorView.state.selection.main = { from: 0, to: 4 };
    panel.formatBar.el.querySelector('[data-command="bold"]').click();
    assert.equal(panel.getContent(), '**word**');
  } finally { ctx.destroy(); }
});

test('the bar is gone in preview and in text', async () => {
  const ctx = setupPanelDom();
  try {
    const panel = await openPanel(ctx, '/tmp/a.md');
    panel.toolbar.modeButtons.preview.click();
    assert.equal(panel.formatBar.el.classList.contains('has-commands'), false);
    panel.toolbar.modeButtons.text.click();
    assert.equal(panel.formatBar.el.classList.contains('has-commands'), false);
    panel.toolbar.modeButtons.edit.click();
    assert.equal(panel.formatBar.el.classList.contains('has-commands'), true);
  } finally { ctx.destroy(); }
});
