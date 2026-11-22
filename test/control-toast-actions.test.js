// `showControlToast` with several buttons and no timeout (#888): the offer of a first message the app will not type
// has Insert, Copy and Dismiss, stays until a button closes it, and Copy leaves it open. The single-button form every
// other caller uses must keep working as it did.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src', 'renderer', 'dialogs', 'control-dialogs.js');

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  window.escapeHtml = (s) => String(s);
  const timers = [];
  window.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  window.clearTimeout = () => {};
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'control-dialogs.js' });
  const toast = (opts) => vm.runInContext('showControlToast', ctx)(opts);
  const buttons = () => [...window.document.querySelectorAll('.control-toast button')];
  return { window, toast, buttons, timers, destroy: () => window.close() };
}

test('several actions: each a button, Copy keeps the toast open, the others close it, and 0 means no timeout', async () => {
  const h = setup();
  const done = [];
  h.toast({
    message: 'ready',
    actions: [
      { label: 'Insert', onAction: () => done.push('insert') },
      { label: 'Copy', keepOpen: true, onAction: () => done.push('copy') },
      { label: 'Dismiss', onAction: () => done.push('dismiss') },
    ],
    timeoutMs: 0,
  });
  assert.deepEqual(h.buttons().map((b) => b.textContent), ['Insert', 'Copy', 'Dismiss']);
  assert.equal(h.timers.length, 0, 'no timeout was set');
  h.buttons()[1].click();
  await Promise.resolve();
  assert.deepEqual(done, ['copy']);
  assert.equal(h.buttons().length, 3, 'Copy leaves the toast open');
  h.buttons()[0].click();
  await Promise.resolve();
  assert.deepEqual(done, ['copy', 'insert']);
  assert.equal(h.buttons().length, 0, 'Insert closes it');
  h.destroy();
});

test('the single-button form and the default timeout are unchanged', async () => {
  const h = setup();
  let hit = 0;
  h.toast({ message: 'x', actionLabel: 'Copy message', onAction: () => { hit += 1; } });
  assert.deepEqual(h.buttons().map((b) => b.textContent), ['Copy message']);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 8000);
  h.buttons()[0].click();
  await Promise.resolve();
  assert.equal(hit, 1);
  assert.equal(h.buttons().length, 0);
  h.destroy();
});
