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

test('an Agent block with its own click keeps it; without one (the conversation view) it collapses like any call', () => {
  const agent = (h) => vm.runInContext(`renderJsonlEntry(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'd', prompt: 'p' } }] } },
    new Map([['a1', 'summary']]))`, h.ctx);
  const history = setup({});
  // The history viewer has a session to fetch the subagent's transcript against, so the block wires its click.
  vm.runInContext("currentViewerSessionId = 'parent';", history.ctx);
  assert.ok(!block(agent(history)).classList.contains('jsonl-tool-collapsible'));
  const conversation = setup({});
  assert.ok(block(agent(conversation)).classList.contains('jsonl-tool-collapsed'), 'no own click, so it starts closed');
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

// #691: a background task that ended is a backend-neutral entry, drawn as a card, with Output for a shell.
test('a task-notice entry draws as a card; a shell offers its output, an agent does not', () => {
  const h = setup({});
  const card = (task) => vm.runInContext(`renderJsonlEntry(${JSON.stringify({ type: 'task-notice', uuid: 'u', _task: task })}, new Map())`, h.ctx);
  const shell = card({ id: 'b1', kind: 'shell', status: 'completed', description: 'Dev server', exitCode: 0, hasOutput: true });
  assert.ok(shell.classList.contains('task-notice'));
  assert.match(shell.textContent, /Shell Dev server finished/);
  assert.match(shell.textContent, /exit 0/);
  assert.equal(shell.querySelector('.task-notice-output').dataset.taskId, 'b1');
  // #725: Output only where the core found some — a shell whose file is empty or gone gets no link.
  assert.equal(card({ id: 'b3', kind: 'shell', status: 'completed', description: 'Quiet', exitCode: 0 }).querySelector('.task-notice-output'), null);
  const stopped = card({ id: 'b2', kind: 'shell', status: 'stopped', description: 'Long' });
  assert.ok(stopped.classList.contains('stopped'));
  const agent = card({ id: 'a1', kind: 'agent', status: 'completed', description: 'Review', tokens: 24212, durationMs: 1229 });
  assert.equal(agent.querySelector('.task-notice-output'), null);
  assert.match(agent.textContent, /Agent Review finished/);
});

test('a subagent report is always drawn closed to its sender line, and opens by mouse or key (#729)', () => {
  // expandToolOutput ON must not open it: a report is always closed, whatever the tool setting says.
  const h = setup({ expandToolOutput: true });
  const report = { kind: 'report', from: 'af71f04c3392acfe6', text: 'All **done**.', subagentId: 'af71f04c3392acfe6' };
  const el = vm.runInContext(`renderJsonlEntry(${JSON.stringify({ type: 'agent-report', _report: report })}, new Map())`, h.ctx);
  const head = el.querySelector(':scope > .agent-report-head');
  assert.ok(el.classList.contains('agent-report-closed'));
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(head.getAttribute('role'), 'button');
  assert.equal(head.tabIndex, 0);
  assert.match(head.textContent, /^Agent report af71f04c3392acfe6/);
  assert.doesNotMatch(head.textContent, /done/, 'the closed line names the sender only, no preview');
  head.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.ok(!el.classList.contains('agent-report-closed'));
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  head.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.ok(el.classList.contains('agent-report-closed'));
  head.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.ok(!el.classList.contains('agent-report-closed'));
  // The Open button keeps its own click and does not fold the card.
  el.querySelector('.task-notice-open').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.ok(!el.classList.contains('agent-report-closed'));
  // Nothing to fold without a text: no toggle is offered.
  const bare = vm.runInContext(`renderJsonlEntry(${JSON.stringify({ type: 'agent-report', _report: { kind: 'session', from: 'x' } })}, new Map())`, h.ctx);
  assert.ok(!bare.classList.contains('agent-report-closed'));
  assert.equal(bare.querySelector('.agent-report-toggle'), null);
});
