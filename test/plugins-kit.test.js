'use strict';
// #803 T6 — the Plugins manager's list-to-detail kit (spec 40 D1, D2, D7), in jsdom.
//
// What is pinned is the information architecture the owner made binding: one line per row (a name and one
// meta text, no description node), sections inside one container, a detail page that replaces the list,
// Back that restores the list, the filter text and the focus, and the keyboard map. Text stays text.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const kit = require('../src/renderer/panels/plugins-kit');

function host() {
  const dom = new JSDOM('<!doctype html><html><body><div id="h"></div></body></html>');
  return { doc: dom.window.document, host: dom.window.document.getElementById('h'), window: dom.window };
}

function view(extra = {}) {
  return {
    title: 'MCPs',
    subtitle: 'Manage MCP servers',
    filterPlaceholder: 'Search MCP servers',
    sections: [
      { title: 'Servers', rows: [{ id: 'a', name: 'alpha', meta: 'stdio' }, { id: 'b', name: 'beta', meta: 'http' }] },
      { title: 'From plugins', rows: [{ id: 'c', name: 'gamma', meta: 'plugin' }] },
    ],
    rowKey: r => r.id,
    rowLabel: r => r.name,
    rowMeta: r => r.meta,
    renderDetail: (r, c) => { c.textContent = 'detail of ' + r.name; },
    ...extra,
  };
}

function key(win, target, k) {
  target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
}

test('rows are one line each, in labelled sections, inside list containers', () => {
  const { host: h } = host();
  kit.mountView(h, view());
  const sections = [...h.querySelectorAll('.plugins-section')];
  assert.deepEqual(sections.map(s => s.querySelector('.plugins-section-title').textContent), ['Servers', 'From plugins']);
  const rows = [...h.querySelectorAll('.plugins-row')];
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.getAttribute('role'), 'listitem');
    assert.ok(r.classList.contains('settings-field'), 'the settings search sees the row');
    assert.equal(r.querySelectorAll('.plugins-row-name').length, 1);
    assert.equal(r.querySelectorAll('.plugins-row-meta').length, 1);
    assert.equal(r.querySelector('.plugins-row-open').tagName, 'BUTTON');
    assert.equal(r.querySelector('.settings-description:not(.plugins-row-meta)'), null, 'no description node in a row');
  }
  for (const list of h.querySelectorAll('.plugins-rows')) assert.equal(list.getAttribute('role'), 'list');
  assert.equal(h.querySelector('.plugins-count').textContent, '3');
  assert.equal(h.querySelector('.plugins-title').textContent, 'MCPs');
});

test('the filter narrows the rows and the count, and hides an emptied section', () => {
  const { host: h, window: win } = host();
  kit.mountView(h, view());
  const f = h.querySelector('.plugins-filter');
  f.value = 'GAM';
  f.dispatchEvent(new win.Event('input'));
  assert.deepEqual([...h.querySelectorAll('.plugins-row-name')].map(n => n.textContent), ['gamma']);
  assert.equal(h.querySelector('.plugins-count').textContent, '1 of 3');
  assert.equal(h.querySelectorAll('.plugins-section').length, 1);
  f.value = 'nothing';
  f.dispatchEvent(new win.Event('input'));
  assert.equal(h.querySelector('.plugins-empty').textContent, 'Nothing matches the filter.');
});

test('a click on the row or its icon opens the detail page; Back restores list, filter and focus', () => {
  const { host: h, doc, window: win } = host();
  kit.mountView(h, view());
  const f = h.querySelector('.plugins-filter');
  f.value = 'beta';
  f.dispatchEvent(new win.Event('input'));
  h.querySelector('.plugins-row-open').click();
  assert.equal(h.querySelector('.plugins-list-page').hidden, true);
  assert.equal(h.querySelector('.plugins-detail').textContent, 'detail of beta');
  assert.equal(doc.activeElement.textContent, 'Back');
  h.querySelector('.plugins-back').click();
  assert.equal(h.querySelector('.plugins-list-page').hidden, false);
  assert.equal(h.querySelector('.plugins-filter').value, 'beta');
  assert.equal(doc.activeElement.dataset.key, 'b');

  h.querySelector('.plugins-row-gear').click();
  assert.equal(h.querySelector('.plugins-detail').textContent, 'detail of beta');
});

test('keyboard: arrows move between rows across sections, Escape and Backspace go back, Backspace in a field does not', () => {
  const { host: h, doc, window: win } = host();
  kit.mountView(h, view({
    renderDetail: (r, c) => { const i = doc.createElement('input'); i.className = 'probe'; c.appendChild(i); },
  }));
  const buttons = () => [...h.querySelectorAll('.plugins-row-open')];
  buttons()[0].focus();
  key(win, buttons()[0], 'ArrowDown');
  assert.equal(doc.activeElement.dataset.key, 'b');
  key(win, doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement.dataset.key, 'c');
  key(win, doc.activeElement, 'Home');
  assert.equal(doc.activeElement.dataset.key, 'a');
  key(win, doc.activeElement, 'End');
  assert.equal(doc.activeElement.dataset.key, 'c');

  doc.activeElement.click();
  const probe = h.querySelector('.probe');
  key(win, probe, 'Backspace');
  assert.equal(h.querySelector('.plugins-detail-page').hidden, false, 'Backspace in a text field edits the field');
  key(win, probe, 'Escape');
  assert.equal(h.querySelector('.plugins-detail-page').hidden, false, 'Escape in a text field belongs to the field');
  key(win, h.querySelector('.plugins-back'), 'Escape');
  assert.equal(h.querySelector('.plugins-detail-page').hidden, true);
  assert.equal(doc.activeElement.dataset.key, 'c');

  doc.activeElement.click();
  key(win, h.querySelector('.plugins-back'), 'Backspace');
  assert.equal(h.querySelector('.plugins-detail-page').hidden, true);
});

test('Escape inside an editor on the detail page stays with the editor', () => {
  const { host: h, doc, window: win } = host();
  kit.mountView(h, view({
    renderDetail: (r, c) => {
      const ed = doc.createElement('div');
      ed.className = 'cm-editor';
      const content = doc.createElement('div');
      content.className = 'cm-content';
      content.tabIndex = 0;
      ed.appendChild(content);
      c.appendChild(ed);
    },
  }));
  h.querySelector('.plugins-row-open').click();
  key(win, h.querySelector('.cm-content'), 'Escape');
  assert.equal(h.querySelector('.plugins-detail-page').hidden, false);
});

test('a view holding unsaved work can refuse Back, Escape and Backspace', () => {
  const { host: h, window: win } = host();
  let dirty = true;
  kit.mountView(h, view({ canLeave: () => !dirty }));
  h.querySelector('.plugins-row-open').click();
  h.querySelector('.plugins-back').click();
  key(win, h.querySelector('.plugins-back'), 'Escape');
  key(win, h.querySelector('.plugins-back'), 'Backspace');
  assert.equal(h.querySelector('.plugins-detail-page').hidden, false);
  dirty = false;
  h.querySelector('.plugins-back').click();
  assert.equal(h.querySelector('.plugins-detail-page').hidden, true);
});

test('Enter on a row opens it: the open target stays a native button', () => {
  const { host: h } = host();
  kit.mountView(h, view());
  const open = h.querySelector('.plugins-row-open');
  assert.equal(open.tagName, 'BUTTON');
  assert.equal(open.type, 'button');
  open.click();   // what a native button does on Enter
  assert.equal(h.querySelector('.plugins-detail').textContent, 'detail of alpha');
});

test('a refresh on the list keeps the filter, its text and its focus', () => {
  const { host: h, doc, window: win } = host();
  const v = kit.mountView(h, view());
  h.querySelector('.plugins-row-open').click();
  h.querySelector('.plugins-back').click();
  const f = h.querySelector('.plugins-filter');
  f.focus();
  f.value = 'al';
  f.dispatchEvent(new win.Event('input'));
  v.refresh(view());
  assert.equal(doc.activeElement, f);
  assert.equal(f.value, 'al');
  assert.deepEqual([...h.querySelectorAll('.plugins-row-name')].map(n => n.textContent), ['alpha']);
});

test('a refresh keeps focus on the row switch that caused it', () => {
  const { host: h, doc, window: win } = host();
  let v = null;
  const make = (on) => view({ rowSwitch: r => ({ checked: on.has(r.id), label: 'Enable ' + r.name, onChange: (val) => { if (val) on.add(r.id); else on.delete(r.id); v.refresh(make(on)); } }) });
  v = kit.mountView(h, make(new Set()));
  const sw = h.querySelectorAll('.plugins-row-switch input')[1];
  sw.focus();
  sw.checked = true;
  sw.dispatchEvent(new win.Event('change'));
  const now = h.querySelectorAll('.plugins-row-switch input')[1];
  assert.notEqual(now, sw, 'the list was redrawn');
  assert.equal(doc.activeElement, now);
  assert.equal(now.checked, true);
});

test('a refresh whose row is gone keeps a detail page that holds unsaved work', () => {
  const { host: h } = host();
  const v = kit.mountView(h, view({ canLeave: () => false }));
  v.openDetail('b');
  v.refresh(view({ canLeave: () => false, sections: [{ title: '', rows: [{ id: 'a', name: 'alpha' }] }] }));
  assert.equal(h.querySelector('.plugins-detail-page').hidden, false);
});

test('showList on the list moves no focus', () => {
  const { host: h, doc } = host();
  const v = kit.mountView(h, view());
  h.querySelector('.plugins-row-open').click();
  h.querySelector('.plugins-back').click();
  const f = h.querySelector('.plugins-filter');
  f.focus();
  v.showList();
  assert.equal(doc.activeElement, f);
});

test('two rows with one key: the first is the one a click opens', () => {
  const { host: h } = host();
  kit.mountView(h, view({ sections: [{ title: '', rows: [{ id: 'x', name: 'first' }, { id: 'x', name: 'second' }] }] }));
  h.querySelectorAll('.plugins-row-open')[1].click();
  assert.equal(h.querySelector('.plugins-detail').textContent, 'detail of first');
});

test('the switch is a separate labelled checkbox and reports changes; a disabled row says why', () => {
  const { host: h, window: win } = host();
  const changes = [];
  kit.mountView(h, view({
    rowSwitch: r => ({ checked: r.id === 'a', label: 'Enable ' + r.name, onChange: v => changes.push([r.id, v]) }),
    rowDisabled: r => (r.id === 'c' ? 'Command not found' : null),
  }));
  const inputs = [...h.querySelectorAll('.plugins-row-switch input')];
  assert.deepEqual(inputs.map(i => [i.checked, i.disabled, i.getAttribute('aria-label')]),
    [[true, false, 'Enable alpha'], [false, false, 'Enable beta'], [false, true, 'Enable gamma']]);
  inputs[1].checked = true;
  inputs[1].dispatchEvent(new win.Event('change'));
  assert.deepEqual(changes, [['b', true]]);
  const disabled = h.querySelector('.plugins-row-disabled');
  assert.equal(disabled.querySelector('.plugins-row-meta').textContent, 'Command not found');
  assert.equal(disabled.querySelector('.plugins-row-open').title, 'Command not found');
});

test('a name holding markup stays text', () => {
  const { host: h } = host();
  kit.mountView(h, view({ sections: [{ title: '<b>x</b>', rows: [{ id: 'x', name: '<img src=x onerror=alert(1)>', meta: '<i>m</i>' }] }] }));
  assert.equal(h.querySelector('img'), null);
  assert.equal(h.querySelector('i'), null);
  assert.equal(h.querySelector('.plugins-row-name').textContent, '<img src=x onerror=alert(1)>');
});

test('header actions are styled buttons; an empty view says so', () => {
  const { host: h } = host();
  let pressed = 0;
  kit.mountView(h, view({ sections: [], actions: [{ label: 'Add', onClick: () => { pressed++; } }], emptyText: 'No servers yet.' }));
  const add = h.querySelector('.plugins-head-actions button');
  assert.ok(add.classList.contains('settings-action-btn'));
  add.click();
  assert.equal(pressed, 1);
  assert.equal(h.querySelector('.plugins-empty').textContent, 'No servers yet.');
  assert.equal(h.querySelector('.plugins-count').textContent, '0');
});

test('refresh leaves an open detail page untouched while its row is there, and returns to the list when it is not', () => {
  const { host: h } = host();
  const v = kit.mountView(h, view());
  v.openDetail('b');
  const page = h.querySelector('.plugins-detail');
  v.refresh(view({ renderDetail: (r, c) => { c.textContent = 'fresh ' + r.name; } }));
  assert.equal(h.querySelector('.plugins-detail'), page, 'not rebuilt — it may hold the user\'s work');
  assert.equal(page.textContent, 'detail of beta');
  v.refresh(view({ sections: [{ title: 'Servers', rows: [{ id: 'a', name: 'alpha', meta: '' }] }] }));
  assert.equal(h.querySelector('.plugins-detail-page').hidden, true);
  assert.equal(h.querySelectorAll('.plugins-row').length, 1);
  assert.equal(h.querySelector('.plugins-row-meta').hidden, true, 'an empty meta takes no space');
});
