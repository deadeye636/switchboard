'use strict';
// #464 — copy on selection, wired to a real container and a real mouseup.
//
// The pure resolver is covered next door; what this file guards is the half that only exists in the
// DOM. `setupTerminalContextMenu` hangs three listeners on the same container, one of them for the
// selection action bar in the mode beside this one, and a copy that fires in the wrong mode — or in
// every mode — is invisible until someone loses their clipboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src', 'renderer', 'terminal', 'terminal-context-menu.js');

/**
 * Load the module into a jsdom window and wire one container to a fake terminal.
 *
 * The terminal is a stub because xterm needs a canvas and a PTY, and neither is what this asks about:
 * the question is what the container's mouseup does with whatever `getSelection()` returns.
 */
function setup({ mode, selection = '' }) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="t"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const clipboard = [];
  const terminal = {
    hasSelection: () => !!selection,
    getSelection: () => selection,
    clearSelection: () => { selection = ''; },
    focus: () => {},
    onSelectionChange: () => {},
  };
  Object.assign(window, {
    api: {
      writeClipboard: (text) => { clipboard.push(text); return Promise.resolve(); },
      readClipboard: () => Promise.resolve('pasted'),
    },
    openFileInPanel: () => {},
  });
  const ctx = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'terminal-context-menu.js' });
  // The mode is a top-level `let` in that file — in the renderer app.js rebinds it through
  // window._applyTerminalRightClick, and here the shared lexical scope is reached the same way.
  vm.runInContext(`terminalRightClickMode = ${JSON.stringify(mode)};`, ctx);
  const container = window.document.getElementById('t');
  window.setupTerminalContextMenu(container, terminal, () => 'session-1', () => null);
  const release = (button = 0) => {
    const ev = new window.MouseEvent('mouseup', { button, bubbles: true, clientX: 10, clientY: 10 });
    container.dispatchEvent(ev);
  };
  // The handler defers a tick, because xterm finalises the selection after the event.
  const settled = () => new Promise(resolve => window.setTimeout(resolve, 5));
  return { window, dom, clipboard, release, settled };
}

test('finishing a selection copies it', async () => {
  const g = setup({ mode: 'copy-on-select', selection: 'npm run build' });
  try {
    g.release();
    await g.settled();
    assert.deepEqual(g.clipboard, ['npm run build']);
  } finally { g.dom.window.close(); }
});

test('the selection is left on screen — it is the only thing saying what was copied', async () => {
  const g = setup({ mode: 'copy-on-select', selection: 'still here' });
  try {
    g.release();
    await g.settled();
    // A clear here would also fight the action bar in the mode next door, which reads the same
    // selection right after this handler runs.
    assert.equal(g.clipboard.length, 1);
  } finally { g.dom.window.close(); }
});

test('a whitespace-only selection is a stray drag, not a copy', async () => {
  const g = setup({ mode: 'copy-on-select', selection: '   \n  ' });
  try {
    g.release();
    await g.settled();
    // Overwriting the clipboard here would lose whatever the user was about to paste.
    assert.deepEqual(g.clipboard, []);
  } finally { g.dom.window.close(); }
});

test('only the LEFT button copies', async () => {
  const g = setup({ mode: 'copy-on-select', selection: 'text' });
  try {
    g.release(2);   // the right button is the paste half of this mode
    await g.settled();
    assert.deepEqual(g.clipboard, []);
  } finally { g.dom.window.close(); }
});

test('no other mode copies on selection', async () => {
  for (const mode of ['menu', 'copy-paste', 'action-bar', 'paste', 'default', 'none']) {
    const g = setup({ mode, selection: 'text' });
    try {
      g.release();
      await g.settled();
      assert.deepEqual(g.clipboard, [], `${mode} must not copy on selection`);
    } finally { g.dom.window.close(); }
  }
});
