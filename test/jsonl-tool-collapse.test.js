'use strict';
// #687: a tool call's body (its input and its output) opens and closes on its header, and whether it starts
// open is the global `expandToolOutput` setting, default OFF. Drawn through the real entry renderer in
// src/renderer/jsonl/jsonl-viewer.js, which both the conversation view and the session history use.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { stripComments } = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function setup(globalSettings) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const w = dom.window;
  // Every window.api call the file makes at load is a listener registration; none of them matter here.
  w.api = new Proxy({}, { get: () => () => {} });
  const ctx = vm.createContext(w);
  vm.runInContext(read('src/shared/partial-args.js'), ctx);
  vm.runInContext(read('src/renderer/session/subagent-live.js'), ctx);
  vm.runInContext(`
    function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  `, ctx);
  if (globalSettings !== undefined) {
    ctx.__settings = globalSettings;
    vm.runInContext('var appGlobalSettings = __settings;', ctx);
  }
  vm.runInContext(read('src/renderer/jsonl/jsonl-viewer.js'), ctx);
  const draw = (id) => {
    ctx.__id = id;
    return vm.runInContext(`renderJsonlEntry(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: __id, name: 'Bash', input: { command: 'ls' } }] } },
      new Map([[__id, 'file-a\\nfile-b']]))`, ctx);
  };
  return { w, ctx, draw };
}

const block = (el) => el.querySelector('.jsonl-tool-block');
const header = (el) => block(el).querySelector(':scope > .jsonl-tool-header');

test('a tool call starts collapsed by default, with its output in the DOM', () => {
  const h = setup({});
  const el = draw(h, 't1');
  assert.ok(block(el).classList.contains('jsonl-tool-collapsible'));
  assert.ok(block(el).classList.contains('jsonl-tool-collapsed'));
  assert.match(block(el).textContent, /file-a/, 'collapsed hides the body, it does not drop it');
});

test('expandToolOutput: true starts it open', () => {
  const h = setup({ expandToolOutput: true });
  const el = draw(h, 't1');
  assert.ok(!block(el).classList.contains('jsonl-tool-collapsed'));
});

test('a page without app.js (no appGlobalSettings) gets the default', () => {
  const h = setup(undefined);
  assert.ok(block(draw(h, 't1')).classList.contains('jsonl-tool-collapsed'));
});

test('a click on the header toggles, and the choice survives the redraw a result causes', () => {
  const h = setup({});
  const first = draw(h, 't1');
  header(first).dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.ok(!block(first).classList.contains('jsonl-tool-collapsed'), 'opened');
  // The conversation view replaces the entry's element when the result arrives.
  assert.ok(!block(draw(h, 't1')).classList.contains('jsonl-tool-collapsed'), 'still open after the redraw');
  assert.ok(block(draw(h, 't2')).classList.contains('jsonl-tool-collapsed'), 'another call keeps the default');
});

test('an Agent block keeps its own click and is not made collapsible on top of it', () => {
  const h = setup({});
  const el = vm.runInContext(`renderJsonlEntry(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'd', prompt: 'p' } }] } },
    new Map([['a1', 'summary']]))`, h.ctx);
  assert.ok(!block(el).classList.contains('jsonl-tool-collapsible'));
});

test('a closed Bash call still names its command in the header', () => {
  const h = setup({});
  const peek = header(draw(h, 't1')).querySelector('.jsonl-tool-peek');
  assert.ok(peek, 'the header carries the command');
  assert.equal(peek.textContent, 'ls');
});

test('a hit the history search jumps to inside a closed tool call opens it', () => {
  // A wiring guard, read as code: the search file opens the closed block around the active hit. The jump
  // itself scrolls by layout, which jsdom does not have.
  const src = stripComments(read('src/renderer/jsonl/jsonl-search.js'));
  assert.match(src, /closest\('\.jsonl-tool-collapsed'\)/);
  assert.match(src, /classList\.remove\('jsonl-tool-collapsed'\)/);
});

function draw(h, id) { return h.draw(id); }
