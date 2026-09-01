// What a screen reader and a keyboard get from `showControlDialog` (#503).
//
// This is Switchboard's own dialog, not an OS message box, so everything assistive technology knows
// about it comes from the markup this file builds. Three things were missing and none of them is
// visible on screen, which is why they need a test rather than a look:
//   - the sentence and the detail rows were not referenced, so only the title was announced;
//   - nothing kept Tab inside the dialog, while `aria-modal` had told the reader the page behind it
//     is not there;
//   - the title's id was a constant, so two open dialogs named themselves after the first one.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src', 'renderer', 'dialogs', 'control-dialogs.js');

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><button id="behind">behind the dialog</button></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  window.escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'control-dialogs.js' });

  const doc = window.document;
  const tick = () => new Promise(r => window.setTimeout(r, 0));
  const show = opts => vm.runInContext('showControlDialog', ctx)(opts);
  const dialog = (n = 0) => doc.querySelectorAll('.control-dialog')[n];
  const tab = (target, shift = false) => {
    const event = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  return { window, doc, tick, show, dialog, tab, destroy: () => window.close() };
}

test('the dialog is described by its message and its details, not only named by its title', async () => {
  const t = setup();
  try {
    t.show({ title: 'Archive Session', message: 'Archived sessions are hidden.', details: { Earlier: 2 } });
    await t.tick();

    const d = t.dialog();
    const title = t.doc.getElementById(d.getAttribute('aria-labelledby'));
    assert.equal(title.textContent, 'Archive Session');

    const described = d.getAttribute('aria-describedby').split(' ');
    assert.equal(described.length, 2, 'the sentence and the detail table are both part of the question');
    const text = described.map(id => t.doc.getElementById(id).textContent).join(' ');
    assert.match(text, /Archived sessions are hidden\./);
    assert.match(text, /Earlier/, 'the counts the answer rests on are announced with the dialog');
  } finally { t.destroy(); }
});

test('a dialog with nothing to describe carries no dangling reference', async () => {
  const t = setup();
  try {
    t.show({ title: 'Just a title' });
    await t.tick();
    assert.equal(t.dialog().hasAttribute('aria-describedby'), false,
      'an id pointing at nothing reads as no description at all — worse than none, because it looks handled');
  } finally { t.destroy(); }
});

test('two open dialogs name themselves after their own title', async () => {
  const t = setup();
  try {
    t.show({ title: 'First question' });
    await t.tick();
    t.show({ title: 'Second question' });
    await t.tick();

    const [a, b] = t.doc.querySelectorAll('.control-dialog');
    assert.notEqual(a.getAttribute('aria-labelledby'), b.getAttribute('aria-labelledby'));
    assert.equal(t.doc.getElementById(b.getAttribute('aria-labelledby')).textContent, 'Second question');
  } finally { t.destroy(); }
});

test('Tab cycles inside the dialog instead of walking into the page behind it', async () => {
  const t = setup();
  try {
    t.show({ title: 'Archive Session', confirmLabel: 'All', secondaryLabel: 'Single' });
    await t.tick();

    const d = t.dialog();
    const buttons = [...d.querySelectorAll('button')];
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    const forward = t.tab(last);
    assert.equal(forward.defaultPrevented, true, 'Tab on the last button is answered here, not by the page');
    assert.equal(t.doc.activeElement, first);

    const backward = t.tab(first, true);
    assert.equal(backward.defaultPrevented, true);
    assert.equal(t.doc.activeElement, last);

    // In the middle of the list the browser's own order is right — nothing to correct.
    assert.equal(t.tab(first).defaultPrevented, false);
  } finally { t.destroy(); }
});

test('focus that escaped the dialog is pulled back on the next Tab', async () => {
  const t = setup();
  try {
    t.show({ title: 'Archive Session' });
    await t.tick();
    const behind = t.doc.getElementById('behind');
    behind.focus();

    const event = t.tab(behind);
    assert.equal(event.defaultPrevented, true);
    assert.ok(t.dialog().contains(t.doc.activeElement), 'the modal takes the keyboard back');
  } finally { t.destroy(); }
});

test('a disabled confirm is not a stop on the way round', async () => {
  const t = setup();
  try {
    t.show({
      title: 'Archive Project Sessions',
      confirmLabel: () => 'Archive 0 Sessions',
      confirmDisabled: () => true,
      checkbox: { label: 'Also stop and archive 1 running session', checked: false },
    });
    await t.tick();

    const d = t.dialog();
    const checkbox = d.querySelector('.control-dialog-checkbox input');
    assert.equal(t.doc.activeElement, checkbox, 'the dialog still opens on what makes it answerable');

    // Cancel and the checkbox are the focusable pair while the confirm is disabled, so the cycle wraps
    // between those two and never parks on a button that cannot be pressed.
    t.tab(checkbox);
    assert.ok(d.contains(t.doc.activeElement), 'the wrap stays inside the dialog');
    assert.notEqual(t.doc.activeElement, d.querySelector('.control-dialog-confirm'));
  } finally { t.destroy(); }
});
