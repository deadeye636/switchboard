// Every overlay that wears the control-dialog look owes the keyboard the same thing (#505).
//
// `showControlDialog` is not the only dialog with these classes: the remove-project confirm and the
// backend capability matrix build their own markup, because neither a list of per-backend checkboxes nor
// a table is a shape that API has. They still share the class — and the trap's "only the TOPMOST overlay
// pulls stray focus back" rule is only true while EVERY overlay traps. One that does not is a hole in the
// others' promise, not only in its own, and nothing on screen shows it.
//
// So this reads the sources: whoever creates a `.control-dialog-overlay` has to name itself, describe
// itself, and arm the shared trap.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

// Every .js under src/renderer that mentions the overlay class, found rather than listed — a fourth
// dialog must not be able to appear without this test seeing it.
function overlayFiles(dir = REN, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { overlayFiles(full, out); continue; }
    if (!entry.name.endsWith('.js') || entry.name.endsWith('-bundle.js')) continue;
    const src = fs.readFileSync(full, 'utf8');
    if (src.includes('control-dialog-overlay')) out.push({ rel: path.relative(REN, full).replace(/\\/g, '/'), src });
  }
  return out;
}

test('the overlay class is used by more than one file, so the shared rules below have a subject', () => {
  assert.ok(overlayFiles().length >= 2,
    'if only control-dialogs.js is left, fold these guards into its own tests rather than deleting them');
});

test('every dialog overlay arms the shared focus trap', () => {
  const untrapped = overlayFiles()
    .filter(({ src }) => !src.includes('trapControlDialogFocus'))
    .map(({ rel }) => rel);
  assert.deepEqual(untrapped, [],
    'call trapControlDialogFocus(overlay, dialog) once it is in the document, and its release when it comes out');
});

test('every dialog overlay names and describes itself', () => {
  const unnamed = overlayFiles().filter(({ src }) => !src.includes('aria-labelledby')).map(({ rel }) => rel);
  const undescribed = overlayFiles().filter(({ src }) => !src.includes('aria-describedby')).map(({ rel }) => rel);
  assert.deepEqual(unnamed, [], 'a dialog with no accessible name announces itself as "dialog" and nothing else');
  assert.deepEqual(undescribed, [], 'the sentence and the details are the question — reference them');
});

// The helper itself, driven outside showControlDialog, because that is how the other two use it.
test('trapControlDialogFocus cycles a hand-built dialog and hands the keyboard back', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><button id="opener">open</button></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  window.escapeHtml = s => String(s);
  vm.runInContext(fs.readFileSync(path.join(REN, 'dialogs', 'control-dialogs.js'), 'utf8'), ctx,
    { filename: 'control-dialogs.js' });

  try {
    const doc = window.document;
    const opener = doc.getElementById('opener');
    opener.focus();

    const overlay = doc.createElement('div');
    overlay.className = 'control-dialog-overlay';
    const dialog = doc.createElement('div');
    dialog.className = 'control-dialog';
    dialog.innerHTML = '<button class="a">A</button><button class="b">B</button>';
    overlay.appendChild(dialog);
    doc.body.appendChild(overlay);

    const release = vm.runInContext('trapControlDialogFocus', ctx)(overlay, dialog);
    const a = dialog.querySelector('.a');
    const b = dialog.querySelector('.b');
    b.focus();

    const tab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    b.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true, 'the last button wraps');
    assert.equal(doc.activeElement, a);

    overlay.remove();
    release();
    assert.equal(doc.activeElement, opener, 'the caret goes back to whoever opened the dialog');

    // Released means released: a later Tab is nobody's business any more.
    const after = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    opener.dispatchEvent(after);
    assert.equal(after.defaultPrevented, false);
  } finally { window.close(); }
});

// The helpers are reached as bare globals from another classic script, which is how the renderer has
// always been wired — and which is only safe while the page that loads the CALLER also loads the file
// that DEFINES them. Nothing about a missing definition shows on screen until someone opens the dialog,
// so the page lists are checked here instead.
test('every page that loads a dialog file also loads control-dialogs.js', () => {
  const order = require('./fixtures/script-order.json');
  const definer = 'dialogs/control-dialogs.js';
  const callers = overlayFiles().map(({ rel }) => rel).filter(rel => rel !== definer);

  for (const [page, scripts] of Object.entries(order)) {
    const listed = callers.filter(rel => scripts.some(src => src.endsWith(rel) || src === rel.split('/').pop()));
    if (!listed.length) continue;
    const hasDefiner = scripts.some(src => src.endsWith('control-dialogs.js'));
    assert.ok(hasDefiner,
      `${page} loads ${listed.join(', ')} but not control-dialogs.js — the dialog would throw on open`);
  }
});
