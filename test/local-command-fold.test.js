'use strict';
// #836 (owner choice 19a): a `!` shell line folds like any tool block. Closed or open per "Show tool calls
// expanded", the command stays readable in the closed header, and a click is remembered per line key, so the
// conversation view's redraw on each output chunk does not undo it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function setup(globalSettings) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const w = dom.window;
  w.api = new Proxy({}, { get: () => () => {} });
  const ctx = vm.createContext(w);
  vm.runInContext(read('src/shared/partial-args.js'), ctx);
  vm.runInContext(read('src/renderer/session/subagent-live.js'), ctx);
  vm.runInContext('function escapeHtml(s) { return String(s); }', ctx);
  if (globalSettings !== undefined) {
    ctx.__settings = globalSettings;
    vm.runInContext('var appGlobalSettings = __settings;', ctx);
  }
  vm.runInContext(read('src/renderer/jsonl/jsonl-viewer.js'), ctx);
  ctx.__args = null;
  const draw = (args) => { ctx.__args = args; return vm.runInContext('renderLocalCommand(__args)', ctx); };
  return { w, draw };
}

test('a shell line folds like a tool block and starts closed by default', () => {
  const { draw } = setup({});
  const el = draw({ cmd: 'ping -n 30 127.0.0.1', output: 'Reply from 127.0.0.1' });
  assert.ok(el.classList.contains('jsonl-tool-collapsible'));
  assert.ok(el.classList.contains('jsonl-tool-collapsed'), 'closed while "Show tool calls expanded" is off');
  const peek = el.querySelector('.jsonl-tool-header .jsonl-tool-peek code');
  assert.equal(peek && peek.textContent, 'ping -n 30 127.0.0.1', 'the closed header still names the command');
});

test('with "Show tool calls expanded" on it starts open', () => {
  const { draw } = setup({ expandToolOutput: true });
  assert.ok(!draw({ cmd: 'echo hi', output: 'hi' }).classList.contains('jsonl-tool-collapsed'));
});

test('a click is remembered per line key across a redraw, and folds back again', () => {
  const { draw } = setup({});
  const first = draw({ cmd: 'ping', output: 'a', key: 'line-1' });
  first.querySelector('.jsonl-tool-header').click();
  assert.ok(!first.classList.contains('jsonl-tool-collapsed'), 'opened by the click');
  const redrawn = draw({ cmd: 'ping', output: 'a\nb', key: 'line-1' });
  assert.ok(!redrawn.classList.contains('jsonl-tool-collapsed'), 'the redraw on new output keeps it open');
  redrawn.querySelector('.jsonl-tool-header').click();
  const again = draw({ cmd: 'ping', output: 'a\nb\nc', key: 'line-1' });
  assert.ok(again.classList.contains('jsonl-tool-collapsed'), 'and closing it sticks too');
  assert.ok(draw({ cmd: 'ping', output: 'x', key: 'line-2' }).classList.contains('jsonl-tool-collapsed'),
    'another line has its own state');
});
