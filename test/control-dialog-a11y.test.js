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

test('a disabled confirm is skipped on the way round, and the wrap still fires', async () => {
  const t = setup();
  try {
    t.show({
      title: 'Archive Project Sessions',
      confirmLabel: (checked) => (checked ? 'Archive 1 Session' : 'Archive 0 Sessions'),
      confirmDisabled: (checked) => !checked,
      checkbox: { label: 'Also stop and archive 1 running session', checked: false },
    });
    await t.tick();

    const d = t.dialog();
    const checkbox = d.querySelector('.control-dialog-checkbox input');
    const cancel = d.querySelector('.control-dialog-cancel');
    const confirm = d.querySelector('.control-dialog-confirm');
    assert.equal(t.doc.activeElement, checkbox, 'the dialog opens on what makes it answerable');

    // DOM order inside the dialog is checkbox, cancel, confirm — and the disabled confirm is out of the
    // cycle, so CANCEL is the last focusable. Tab there has to wrap, which is the assertion the trap has
    // to earn rather than a step jsdom would fake for us.
    const forward = t.tab(cancel);
    assert.equal(forward.defaultPrevented, true, 'the wrap is answered by the trap, not by the page');
    assert.equal(t.doc.activeElement, checkbox, 'a button that cannot be pressed is not the end of the cycle');
    assert.notEqual(t.doc.activeElement, confirm);

    // …and once the checkbox makes it pressable, the confirm joins the cycle: cancel stops being the end,
    // because the list is read per press rather than captured when the dialog opened.
    checkbox.click();
    assert.equal(confirm.disabled, false);
    assert.equal(t.tab(cancel).defaultPrevented, false, 'cancel is in the middle now, so the browser has it');
    assert.equal(t.tab(confirm).defaultPrevented, true, 'and the confirm is the new end of the cycle');
    assert.equal(t.doc.activeElement, checkbox);
  } finally { t.destroy(); }
});

test('aria-describedby names the message alone, or the details alone', async () => {
  const t = setup();
  try {
    t.show({ title: 'Message only', message: 'Just a sentence.' });
    await t.tick();
    const messageOnly = t.dialog().getAttribute('aria-describedby').split(' ');
    assert.equal(messageOnly.length, 1);
    assert.equal(t.doc.getElementById(messageOnly[0]).textContent, 'Just a sentence.');
  } finally { t.destroy(); }

  const t2 = setup();
  try {
    t2.show({ title: 'Details only', details: { Session: 'one' } });
    await t2.tick();
    const detailsOnly = t2.dialog().getAttribute('aria-describedby').split(' ');
    assert.equal(detailsOnly.length, 1);
    assert.match(t2.doc.getElementById(detailsOnly[0]).textContent, /Session/);
  } finally { t2.destroy(); }
});

test('closing hands the keyboard back to whoever had it', async () => {
  const t = setup();
  try {
    const behind = t.doc.getElementById('behind');
    behind.focus();

    const done = t.show({ title: 'Archive Session' });
    await t.tick();
    assert.ok(t.dialog().contains(t.doc.activeElement), 'the dialog takes the keyboard while it is open');

    t.doc.querySelector('.control-dialog-cancel').click();
    await done;
    assert.equal(t.doc.activeElement, behind,
      'a dialog that closes onto <body> strands the caret outside everything');
  } finally { t.destroy(); }
});

test('a dialog closing on top of another gives the keyboard back to the one underneath', async () => {
  const t = setup();
  try {
    const first = t.show({ title: 'First question' });
    await t.tick();
    const firstDialog = t.dialog(0);
    const focusedInFirst = t.doc.activeElement;
    assert.ok(firstDialog.contains(focusedInFirst));

    const second = t.show({ title: 'Second question' });
    await t.tick();
    t.doc.querySelectorAll('.control-dialog-cancel')[1].click();
    await second;

    assert.equal(t.doc.activeElement, focusedInFirst, 'the dialog still open owns the keyboard again');
    t.doc.querySelector('.control-dialog-cancel').click();
    await first;
  } finally { t.destroy(); }
});
