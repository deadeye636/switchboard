'use strict';
// #464 — what the right-click setting offers and what the terminal implements, held together.
//
// The defect this guards against is the one the issue was filed for: the settings list offered a mode
// that could not do anything useful, while two implemented modes were not in the list at all. Neither
// half could see the other, so nothing failed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveRightClickMode, RIGHT_CLICK_MODES } = require('../src/renderer/terminal/terminal-context-menu');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('a stored copy lands on the mode it now means', () => {
  // The old mode copied the selection and, with nothing selected, did nothing — while switching the
  // menu off. Nothing rewrites the settings blob, so this function IS the migration.
  assert.equal(resolveRightClickMode('copy'), 'copy-on-select');
});

test('every mode the terminal implements resolves to itself', () => {
  for (const mode of RIGHT_CLICK_MODES) {
    assert.equal(resolveRightClickMode(mode), mode, `${mode} must survive a round trip`);
  }
});

test('an unknown or missing value falls to the menu, not to whatever is first', () => {
  assert.equal(resolveRightClickMode(undefined), 'menu');
  assert.equal(resolveRightClickMode(null), 'menu');
  assert.equal(resolveRightClickMode(''), 'menu');
  assert.equal(resolveRightClickMode('Copy'), 'menu', 'the wrong case is not the stored spelling');
  assert.equal(resolveRightClickMode('nonsense'), 'menu');
});

// --- the settings list against the implementation ---

function optionValues() {
  const html = read('src/renderer/panels/settings-global-html.js');
  const select = /id="sv-right-click">([\s\S]*?)<\/select>/.exec(html);
  assert.ok(select, 'the right-click select must be in the global settings markup');
  return [...select[1].matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
}

test('every option in the settings list is a mode the terminal implements', () => {
  for (const value of optionValues()) {
    assert.ok(RIGHT_CLICK_MODES.includes(value), `the settings offer "${value}", which nothing implements`);
  }
});

// `paste` and `none` stay out on purpose: `none` is a mode whose whole behaviour is "nothing happens",
// and `paste` is the half of `copy-on-select` that nobody asked for separately. They remain implemented
// so a stored value does not become an unknown one — which is exactly why this list is written out
// rather than derived, and why adding a mode has to say which side of the line it is on.
const NOT_OFFERED = ['paste', 'none'];

test('the modes deliberately kept out of the settings list are still the same two', () => {
  const offered = optionValues();
  for (const mode of RIGHT_CLICK_MODES) {
    if (NOT_OFFERED.includes(mode)) {
      assert.ok(!offered.includes(mode), `${mode} is offered but this test says it should not be`);
    } else {
      assert.ok(offered.includes(mode), `${mode} is implemented and not offered — say so here or list it`);
    }
  }
});

test('the retired value is gone from the settings list', () => {
  assert.ok(!optionValues().includes('copy'), 'Copy only was replaced by copy-on-select');
});

// The settings window does not load terminal-context-menu.js, so the panel carries the migration a
// second time to pick the right option. Two rules that agree until one is edited is the shape #237 had
// to be dug out of — this is what stops it.
test('the settings panel migrates the stored value the same way the terminal does', () => {
  const panel = read('src/renderer/panels/settings-panel.js');
  const m = /rightClickStored === '([^']+)' \? '([^']+)'/.exec(panel);
  assert.ok(m, 'the panel must map the retired stored value to the option it now means');
  assert.equal(resolveRightClickMode(m[1]), m[2], 'the panel and the terminal disagree about the migration');
});

test('the settings reference names the values the app actually offers', () => {
  const doc = read('docs/settings-reference.md');
  const row = doc.split('\n').find(l => l.includes('`terminalRightClick`'));
  assert.ok(row, 'terminalRightClick must be in the settings reference');
  for (const value of optionValues()) {
    assert.ok(row.includes('`' + value + '`'), `the reference does not name ${value}`);
  }
  assert.ok(!/`copy`/.test(row), 'the reference still names the retired value');
});
