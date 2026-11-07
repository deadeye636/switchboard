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

test('showList({ focus: false }) leaves focus where it is; clearFilter drops the filter; viewsIn finds every view', () => {
  const { host: h, doc, window: win } = host();
  const v = kit.mountView(h, view());
  const f = h.querySelector('.plugins-filter');
  f.value = 'beta';
  f.dispatchEvent(new win.Event('input'));
  v.openDetail('b');
  const outside = doc.createElement('input');
  doc.body.appendChild(outside);
  outside.focus();
  assert.equal(v.showList({ focus: false }), true);
  assert.equal(doc.activeElement, outside, 'no jump to the row');
  v.clearFilter();
  assert.equal(h.querySelectorAll('.plugins-row').length, 3, 'every row again');
  assert.equal(h.querySelector('.plugins-filter').value, '');
  assert.deepEqual(kit.viewsIn(doc.body), [v]);
});

test('canLeave asks the open page without moving the view', () => {
  const { host: h } = host();
  let allow = false;
  const v = kit.mountView(h, view({ canLeave: () => allow }));
  assert.equal(v.canLeave(), true, 'on the list there is nothing to refuse');
  v.openDetail('a');
  assert.equal(v.canLeave(), false);
  assert.equal(h.querySelector('.plugins-list-page').hidden, true, 'still on its page');
  allow = true;
  assert.equal(v.canLeave(), true);
  assert.equal(h.querySelector('.plugins-list-page').hidden, true, 'asking never moves it');
});

// --- Group chips (#824) ----------------------------------------------------------------------------------

function grouped(extra = {}) {
  const A = { key: 'a', label: 'Alpha' };
  const B = { key: 'b', label: 'Beta' };
  const rows = [
    { id: '1', name: 'one', g: [A] },
    { id: '2', name: 'two', g: [B] },
    { id: '3', name: 'three', g: [A, B] },
    { id: '4', name: 'four', g: [] },
  ];
  return view({ title: 'Grouped', sections: [{ title: '', rows }], rowGroups: r => r.g, ...extra });
}

const chips = (h) => [...h.querySelectorAll('.plugins-chip-row .sv-mcp-chip')];
const names = (h) => [...h.querySelectorAll('.plugins-row-name')].map(n => n.textContent);

test('chips: one per group with its count, none on shows every row', () => {
  const { host: h } = host();
  kit.mountView(h, grouped({ filterKey: 'chips-basic' }));
  assert.deepEqual(chips(h).map(c => c.textContent), ['Alpha 2', 'Beta 2']);
  assert.ok(chips(h).every(c => c.tagName === 'BUTTON' && c.getAttribute('aria-pressed') === 'false'));
  assert.equal(h.querySelector('.plugins-chip-row').hidden, false);
  assert.equal(h.querySelectorAll('.plugins-row').length, 4);
  assert.equal(h.querySelector('.plugins-count').textContent, '4');
});

test('chips: several on at once show the union; a row without groups always passes; the count reads "n of m"', () => {
  const { host: h } = host();
  kit.mountView(h, grouped({ filterKey: 'chips-multi' }));
  chips(h)[0].click();
  assert.equal(chips(h)[0].getAttribute('aria-pressed'), 'true');
  assert.deepEqual(names(h).sort(), ['four', 'one', 'three']);
  assert.equal(h.querySelector('.plugins-count').textContent, '3 of 4');
  chips(h)[1].click();
  assert.deepEqual(names(h).sort(), ['four', 'one', 'three', 'two']);
  chips(h)[0].click();
  chips(h)[1].click();
  assert.equal(h.querySelectorAll('.plugins-row').length, 4, 'none on is all');
});

test('chips: ANDed with the text filter, and the empty text still answers', () => {
  const { host: h, window: win } = host();
  kit.mountView(h, grouped({ filterKey: 'chips-and' }));
  chips(h)[1].click();
  const f = h.querySelector('.plugins-filter');
  f.value = 't';
  f.dispatchEvent(new win.Event('input'));
  assert.deepEqual(names(h).sort(), ['three', 'two']);
  f.value = 'one';
  f.dispatchEvent(new win.Event('input'));
  assert.equal(names(h).length, 0);
  assert.equal(h.querySelector('.plugins-empty').textContent, 'Nothing matches the filter.');
});

test('chips: the choice survives a re-mount with the same filterKey, not one with another', () => {
  const { host: h } = host();
  kit.mountView(h, grouped({ filterKey: 'chips-keep' }));
  chips(h)[0].click();
  kit.mountView(h, grouped({ filterKey: 'chips-keep' }));
  assert.equal(chips(h)[0].getAttribute('aria-pressed'), 'true');
  assert.equal(h.querySelector('.plugins-count').textContent, '3 of 4');
  kit.mountView(h, grouped({ filterKey: 'chips-other' }));
  assert.equal(chips(h)[0].getAttribute('aria-pressed'), 'false');
});

test('chips: fewer than two groups draw no chip row and apply no stored choice', () => {
  const { host: h } = host();
  kit.mountView(h, grouped({ filterKey: 'chips-few' }));
  chips(h)[0].click();
  const one = [{ id: '1', name: 'one', g: [{ key: 'a', label: 'Alpha' }] }, { id: '2', name: 'two', g: [] }];
  kit.mountView(h, grouped({ filterKey: 'chips-few', sections: [{ title: '', rows: one }] }));
  assert.equal(h.querySelector('.plugins-chip-row').hidden, true);
  assert.equal(chips(h).length, 0);
  assert.equal(h.querySelectorAll('.plugins-row').length, 2);
  const { host: h2 } = host();
  kit.mountView(h2, view());
  const none = h2.querySelector('.plugins-chip-row');
  assert.ok(!none || none.hidden, 'a view without rowGroups has none');
});

test('chips: clearFilter drops the text and leaves the chips; refresh keeps them', () => {
  const { host: h, window: win } = host();
  const v = kit.mountView(h, grouped({ filterKey: 'chips-clear' }));
  chips(h)[0].click();
  const f = h.querySelector('.plugins-filter');
  f.value = 'one';
  f.dispatchEvent(new win.Event('input'));
  v.clearFilter();
  assert.deepEqual(names(h).sort(), ['four', 'one', 'three']);
  v.refresh(grouped({ filterKey: 'chips-clear' }));
  assert.equal(chips(h)[0].getAttribute('aria-pressed'), 'true');
  assert.equal(h.querySelectorAll('.plugins-row').length, 3);
});

test('chips: suspendGroups lifts the narrowing for the settings search and restores the stored choice', () => {
  const { host: h } = host();
  const v = kit.mountView(h, grouped({ filterKey: 'chips-suspend' }));
  chips(h)[0].click();
  assert.equal(h.querySelectorAll('.plugins-row').length, 3);
  v.suspendGroups(true);
  assert.equal(h.querySelectorAll('.plugins-row').length, 4, 'every row is drawn for the search');
  assert.equal(h.querySelector('.plugins-count').textContent, '4');
  v.suspendGroups(false);
  assert.equal(h.querySelectorAll('.plugins-row').length, 3);
  assert.equal(chips(h)[0].getAttribute('aria-pressed'), 'true');
});

// --- Several chip sets (spec 44): one row per set, ANDed with each other, each with its own stored choice ---

function twoSets(extra = {}) {
  const A = { key: 'a', label: 'Alpha' };
  const B = { key: 'b', label: 'Beta' };
  const M = { key: 'm', label: 'Memory' };
  const S = { key: 's', label: 'Settings' };
  const rows = [
    { id: '1', name: 'one', g: [A], k: [M] },
    { id: '2', name: 'two', g: [B], k: [M] },
    { id: '3', name: 'three', g: [A], k: [S] },
    { id: '4', name: 'four', g: [B], k: [S] },
  ];
  return view({
    title: 'Two sets', sections: [{ title: '', rows }],
    chipSets: [{ id: 'cli', label: 'Filter by CLI', rowGroups: r => r.g }, { id: 'kind', label: 'Filter by kind', rowGroups: r => r.k }],
    ...extra,
  });
}
const chipRowsOf = (h) => [...h.querySelectorAll('.plugins-chip-row')];
const chipsIn = (row) => [...row.querySelectorAll('.sv-mcp-chip')];

test('chip sets: one labelled row per set, in order, each counted over all rows', () => {
  const { host: h } = host();
  kit.mountView(h, twoSets({ filterKey: 'sets-basic' }));
  const rows = chipRowsOf(h);
  assert.deepEqual(rows.map(r => r.getAttribute('aria-label')), ['Filter by CLI', 'Filter by kind']);
  assert.deepEqual(rows.map(r => r.dataset.chipSet), ['cli', 'kind'], 'each row carries its declared id');
  assert.deepEqual(chipsIn(rows[0]).map(c => c.textContent), ['Alpha 2', 'Beta 2']);
  assert.deepEqual(chipsIn(rows[1]).map(c => c.textContent), ['Memory 2', 'Settings 2']);
});

test('chip sets: a chip on in each set ANDs the two; within a set it stays OR', () => {
  const { host: h } = host();
  kit.mountView(h, twoSets({ filterKey: 'sets-and' }));
  chipsIn(chipRowsOf(h)[0])[0].click();
  assert.deepEqual(names(h).sort(), ['one', 'three']);
  chipsIn(chipRowsOf(h)[1])[0].click();
  assert.deepEqual(names(h), ['one']);
  assert.equal(h.querySelector('.plugins-count').textContent, '1 of 4');
  chipsIn(chipRowsOf(h)[0])[1].click();
  assert.deepEqual(names(h).sort(), ['one', 'two']);
});

test('chip sets: each set keeps its own choice across a re-mount, and the first set keeps the old store key', () => {
  const { host: h } = host();
  kit.mountView(h, twoSets({ filterKey: 'sets-keep' }));
  chipsIn(chipRowsOf(h)[1])[1].click();
  kit.mountView(h, twoSets({ filterKey: 'sets-keep' }));
  assert.equal(chipsIn(chipRowsOf(h)[0])[0].getAttribute('aria-pressed'), 'false');
  assert.equal(chipsIn(chipRowsOf(h)[1])[1].getAttribute('aria-pressed'), 'true');
  // A choice made under `rowGroups` alone applies to the first set of the same view.
  kit.mountView(h, grouped({ filterKey: 'sets-old' }));
  chips(h)[0].click();
  kit.mountView(h, twoSets({ filterKey: 'sets-old' }));
  assert.equal(chipsIn(chipRowsOf(h)[0])[0].getAttribute('aria-pressed'), 'true');
  assert.equal(chipsIn(chipRowsOf(h)[1])[0].getAttribute('aria-pressed'), 'false');
});

test('chip sets: an id used twice gets two rows, and a skipped first set leaves the old store key unused', () => {
  const { host: h } = host();
  const base = twoSets();
  const kind = base.chipSets[1];
  kit.mountView(h, twoSets({ filterKey: 'sets-dup', chipSets: [base.chipSets[0], kind, { ...kind }] }));
  assert.equal(chipRowsOf(h).length, 3);
  // A choice under the bare key (the old CLI store) must not land on a kind set when the first set is not a set.
  kit.mountView(h, grouped({ filterKey: 'sets-skip' }));
  chips(h)[0].click();
  kit.mountView(h, twoSets({ filterKey: 'sets-skip', chipSets: [{ id: 'cli' }, kind] }));
  assert.ok(chipsIn(chipRowsOf(h)[0]).every(c => c.getAttribute('aria-pressed') === 'false'));
});

test('chip sets: suspendGroups lifts every set', () => {
  const { host: h } = host();
  const v = kit.mountView(h, twoSets({ filterKey: 'sets-suspend' }));
  chipsIn(chipRowsOf(h)[0])[0].click();
  chipsIn(chipRowsOf(h)[1])[0].click();
  v.suspendGroups(true);
  assert.equal(h.querySelectorAll('.plugins-row').length, 4);
  v.suspendGroups(false);
  assert.deepEqual(names(h), ['one']);
});

// --- Content filter (#823 T4): `rowMatch`, debounced, tokened, never at mount ---

function typeInto(win, h, text) {
  const f = h.querySelector('.plugins-filter');
  f.value = text;
  f.dispatchEvent(new win.Event('input'));
}
const flush = () => new Promise(r => setImmediate(r));
const shown = (h) => [...h.querySelectorAll('.plugins-row')].map(r => r.dataset.key).sort();

test('content filter: a row passes by name or by the keys rowMatch answers, after the debounce', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host: h, window: win } = host();
  const asked = [];
  const v = kit.mountView(h, view({ rowMatch: async (q) => { asked.push(q); return new Set(['c']); } }));
  assert.deepEqual(asked, [], 'nothing is asked at mount');
  typeInto(win, h, 'alp');
  assert.deepEqual(shown(h), ['a'], 'the name matches at once');
  t.mock.timers.tick(199);
  assert.deepEqual(asked, [], 'still resting');
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(asked, ['alp']);
  assert.deepEqual(shown(h), ['a', 'c'], 'the content hit joins the name hit');
  v.clearFilter();
  assert.equal(h.querySelectorAll('.plugins-row').length, 3);
});

test('content filter: typing again restarts the debounce, and a stale answer draws nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host: h, window: win } = host();
  const pending = [];
  kit.mountView(h, view({ rowMatch: (q) => new Promise((res) => { pending.push({ q, res }); }) }));
  typeInto(win, h, 'zz');
  t.mock.timers.tick(150);
  typeInto(win, h, 'zzz');
  t.mock.timers.tick(150);
  assert.equal(pending.length, 0, 'the first timer was replaced');
  t.mock.timers.tick(50);
  assert.deepEqual(pending.map(p => p.q), ['zzz']);
  typeInto(win, h, 'zzzz');   // the answer for zzz is now stale
  pending[0].res(['a']);
  await flush();
  assert.deepEqual(shown(h), [], 'a stale answer draws nothing');
});

test('content filter: an empty or one-character filter asks nothing; a rejection falls back to names', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host: h, window: win } = host();
  let calls = 0;
  kit.mountView(h, view({ rowMatch: async () => { calls += 1; throw new Error('boom'); } }));
  typeInto(win, h, 'a');
  t.mock.timers.tick(500);
  typeInto(win, h, '');
  t.mock.timers.tick(500);
  assert.equal(calls, 0);
  typeInto(win, h, 'gamm');
  t.mock.timers.tick(200);
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(shown(h), ['c']);
});

test('content filter: the previous answer stays applied until the next arrives; below two characters it goes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host: h, window: win } = host();
  const pending = [];
  kit.mountView(h, view({ rowMatch: (q) => new Promise((res) => { pending.push({ q, res }); }) }));
  typeInto(win, h, 'zz');
  t.mock.timers.tick(200);
  pending[0].res(['c']);
  await flush();
  assert.deepEqual(shown(h), ['c']);
  typeInto(win, h, 'zzz');
  assert.deepEqual(shown(h), ['c'], 'no flicker while the next answer is out');
  t.mock.timers.tick(200);
  pending[1].res([]);
  await flush();
  assert.deepEqual(shown(h), []);
  pending.length = 0;
  typeInto(win, h, 'zz');
  t.mock.timers.tick(200);
  pending[0].res(['c']);
  await flush();
  typeInto(win, h, 'z');
  assert.deepEqual(shown(h), [], 'one character: the old answer is dropped');
});
