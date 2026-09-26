'use strict';
// src/renderer/session/branch-tree-dialog.js (#646) — the branch tree of a session with no terminal, and the
// two ops the conversation view gained with it (`branchTree`, `draft`). Loaded into a jsdom window the way
// the page loads it: control-dialogs.js (its focus trap and ids), the dialog, then the view, each a classic
// script on the shared scope. What is pinned is what the user can do in the dialog and what reaches main.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', ...p), 'utf8');
const SOURCES = [read('dialogs', 'control-dialogs.js'), read('session', 'branch-tree-dialog.js'), read('session', 'conversation-view.js')];

function setup() {
  const dom = new JSDOM('<!doctype html><body><div id="terminals"></div></body>');
  const w = dom.window;
  const navigations = [];
  w.api = {
    onAgentEvent() {},
    agent: {
      send: () => Promise.resolve({ ok: true }),
      abort: () => Promise.resolve({ ok: true }),
      attach: () => Promise.resolve({ ok: true, entries: [], seq: 0 }),
      answer: () => Promise.resolve({ ok: true }),
      navigate: (id, target, options) => { navigations.push({ id, target, ...options }); return Promise.resolve({ ok: true }); },
    },
  };
  // jsdom has no CSS.escape; the ids here are plain.
  if (!w.CSS) w.CSS = { escape: (s) => String(s) };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const ctx = vm.createContext(w);
  vm.runInContext(`
    var openSessions = new Map();
    var terminalsEl = document.getElementById('terminals');
    var lastActivityTime = new Map();
    var isMac = false;
    function escapeHtml(s) { return String(s); }
    function buildToolResultMap() { return new Map(); }
    function renderJsonlEntry(entry) { const d = document.createElement('div'); d.textContent = JSON.stringify(entry.message && entry.message.content); return d; }
  `, ctx);
  for (const src of SOURCES) vm.runInContext(src, ctx);
  const entry = vm.runInContext("createConversationEntry({ sessionId: 's1', projectPath: '/p' })", ctx);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const dialog = () => w.document.querySelector('.branch-tree-dialog');
  const rowsShown = () => [...w.document.querySelectorAll('.branch-tree-row')].map(r => r.dataset.id);
  const button = (text) => [...dialog().querySelectorAll('button')].find(b => b.textContent === text);
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  return { w, entry, navigations, settle, dialog, rowsShown, button, click };
}

const ROWS = [
  { id: 'u1', depth: 0, kind: 'user', text: 'first', label: '', onPath: true, current: false },
  { id: 'm1', depth: 0, kind: 'setting', text: 'Model: p/x', label: '', onPath: true, current: false },
  { id: 'a1', depth: 0, kind: 'assistant', text: 'ALPHA', label: 'checkpoint', onPath: true, current: true },
  { id: 'u2', depth: 1, kind: 'user', text: 'old branch', label: '', onPath: false, current: false },
];

test('the tree opens on the current point, and the settings rows only in the full view', () => {
  const h = setup();
  h.entry.conversation.apply({ op: 'branchTree', rows: ROWS, seq: 1 });
  assert.ok(h.dialog(), 'the dialog is open');
  assert.deepEqual(h.rowsShown(), ['u1', 'a1', 'u2'], 'the conversation view leaves settings out');
  const here = h.w.document.querySelector('.branch-tree-row.current');
  assert.equal(here.classList.contains('selected'), true, 'it opens where the session stands');
  assert.match(here.textContent, /you are here/);
  assert.match(here.textContent, /checkpoint/, 'a label the runtime holds is shown');
  assert.equal(h.button('Switch here').disabled, true, 'switching to where it already is is not offered');

  h.click(h.button('Everything'));
  assert.deepEqual(h.rowsShown(), ['u1', 'm1', 'a1', 'u2']);
  h.click(h.button('Your messages'));
  assert.deepEqual(h.rowsShown(), ['u1', 'u2']);
  assert.equal(h.button('Switch here').disabled, true, 'the selection left the view, so nothing is picked');
});

test('picking a point and switching asks main, with or without a summary, and closes', async () => {
  const h = setup();
  h.entry.conversation.apply({ op: 'branchTree', rows: ROWS, seq: 1 });
  h.click(h.w.document.querySelector('[data-id="u2"]'));
  assert.match(h.dialog().querySelector('.branch-tree-hint').textContent, /goes back into the input/,
    'a user message says what happens to it');
  h.click(h.button('Switch with summary'));
  await h.settle();
  assert.equal(h.dialog(), null, 'the dialog closed');
  assert.deepEqual(h.navigations, [{ id: 's1', target: 'u2', summarize: true }]);

  h.entry.conversation.apply({ op: 'branchTree', rows: ROWS, seq: 2 });
  h.click(h.w.document.querySelector('[data-id="u1"]'));
  h.click(h.button('Switch here'));
  await h.settle();
  assert.deepEqual(h.navigations[1], { id: 's1', target: 'u1', summarize: false });
});

test('the keyboard walks the rows, Enter switches, Escape closes without a word to main', async () => {
  const h = setup();
  h.entry.conversation.apply({ op: 'branchTree', rows: ROWS, seq: 1 });
  const list = h.dialog().querySelector('.branch-tree-list');
  const key = (k) => list.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key('ArrowDown');
  assert.equal(h.w.document.querySelector('.branch-tree-row.selected').dataset.id, 'u2');
  key('Home');
  assert.equal(h.w.document.querySelector('.branch-tree-row.selected').dataset.id, 'u1');
  key('Escape');
  assert.equal(h.dialog(), null);
  assert.deepEqual(h.navigations, []);

  h.entry.conversation.apply({ op: 'branchTree', rows: ROWS, seq: 2 });
  const again = h.dialog().querySelector('.branch-tree-list');
  again.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  again.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await h.settle();
  assert.deepEqual(h.navigations, [{ id: 's1', target: 'u2', summarize: false }]);
});

test('a message handed back goes into an empty input, and never over what the user is typing', () => {
  const h = setup();
  const input = h.entry.element.querySelector('.conversation-input');
  h.entry.conversation.apply({ op: 'draft', text: 'rewrite me', seq: 1 });
  assert.equal(input.value, 'rewrite me');
  input.value = 'mine';
  h.entry.conversation.apply({ op: 'draft', text: 'another', seq: 2 });
  assert.equal(input.value, 'mine', 'the user\'s own text is not overwritten');
  assert.match(h.entry.element.querySelector('.conversation-log').textContent, /another/, 'the message is quoted instead');
});
