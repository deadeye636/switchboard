'use strict';
// #770: an agent call opens its subagent's transcript in place inside a conversation, through the history viewer's
// own Agent block in src/renderer/jsonl/jsonl-viewer.js. Drawn through the real renderer with the conversation's
// draw context, against a stand-in `window.api` that records what is asked of main.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function setup({ subagents = [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }] } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const w = dom.window;
  const calls = { read: [], start: [], stop: [] };
  let nextWatch = 1;
  const api = {
    listSubagents: async () => subagents,
    readSubagentJsonl: async (parent, agentId) => {
      calls.read.push([parent, agentId]);
      return { entries: [{ type: 'user', message: { role: 'user', content: `prompt of ${agentId}` } }] };
    },
    startSubagentWatch: async (parent, agentId) => { calls.start.push([parent, agentId]); return { watchId: nextWatch++ }; },
    stopSubagentWatch: async (id) => { calls.stop.push(id); },
  };
  // Every other call the file makes at load is a listener registration; none of them matter here.
  w.api = new Proxy(api, { get: (t, k) => (k in t ? t[k] : () => {}) });
  const ctx = vm.createContext(w);
  vm.runInContext(read('src/shared/partial-args.js'), ctx);
  vm.runInContext(read('src/renderer/session/subagent-live.js'), ctx);
  vm.runInContext(`
    function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  `, ctx);
  vm.runInContext(read('src/renderer/jsonl/jsonl-viewer.js'), ctx);
  const host = w.document.getElementById('host');
  const opened = [];
  ctx.__draw = {
    sessionId: () => 's1', host, focusFallback() {},
    subagentIdFor: (id) => (ctx.__exact || {})[id] || null,
    openSubagent: (agentId, toolUseId) => opened.push([agentId, toolUseId]),
  };
  // One assistant entry per call, appended to the host the way the conversation's log holds them.
  const draw = (id, input = { subagent_type: 'verifier', description: 'Review' }) => {
    ctx.__id = id;
    ctx.__input = input;
    const el = vm.runInContext(`renderJsonlEntry(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: __id, name: 'Agent', input: __input }] } },
      new Map(), __draw)`, ctx);
    host.appendChild(el);
    return el;
  };
  const card = (el) => el.querySelector('.jsonl-agent-expandable');
  const box = (el) => el.querySelector('.jsonl-subagent-inline');
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { w, ctx, host, calls, opened, draw, card, box, settle };
}

test('a conversation opens the subagent its call started, in a box of its own with Open in tab', async () => {
  const h = setup({ subagents: [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }, { agentId: 'a2', sessionId: 'sub-2', description: 'Review', subagentType: 'verifier' }] });
  h.ctx.__exact = { toolu_1: 'a2' };
  const el = h.draw('toolu_1');
  h.card(el).click();
  await h.settle();
  assert.deepEqual(h.calls.read, [['s1', 'a2']], 'the subagent the backend named, under the conversation\'s session');
  assert.ok(h.box(el), 'inline');
  const btn = h.box(el).querySelector('.jsonl-subagent-inline-bar button');
  assert.equal(btn.textContent, 'Open in tab');
  btn.click();
  assert.deepEqual(h.opened, [['a2', 'toolu_1']]);
  assert.deepEqual(h.calls.start, [], 'a finished agent is not followed');
});

test('without a named subagent, a call takes its place among the same calls on screen', async () => {
  const h = setup({ subagents: [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }, { agentId: 'a2', sessionId: 'sub-2', description: 'Review', subagentType: 'verifier' }] });
  h.draw('toolu_1');
  const second = h.draw('toolu_2');
  // Redraws of the first call do not move the second one's answer.
  h.draw('toolu_x', { subagent_type: 'other', description: 'Else' });
  h.card(second).click();
  await h.settle();
  assert.deepEqual(h.calls.read, [['s1', 'a2']]);
});

test('a running agent is followed, a viewer closing does not stop it, and its end does', async () => {
  const h = setup();
  h.ctx.__exact = { toolu_1: 'a1' };
  h.ctx._setSubagentLive('s1', 'a1', true, 'exact');
  const el = h.draw('toolu_1');
  h.card(el).click();
  await h.settle();
  assert.deepEqual(h.calls.start, [['s1', 'a1']]);
  vm.runInContext('drainViewerWatches()', h.ctx);
  await h.settle();
  assert.deepEqual(h.calls.stop, [], 'another viewer opening leaves the conversation\'s box alone');
  h.ctx._setSubagentLive('s1', 'a1', false, 'exact');
  await new Promise((r) => setTimeout(r, 2700));
  assert.deepEqual(h.calls.stop, [1], 'stopped a little after the end');
});

test('a redrawn call opens again and its new box takes the tail over', async () => {
  const h = setup();
  h.ctx.__exact = { toolu_1: 'a1' };
  h.ctx._setSubagentLive('s1', 'a1', true, 'exact');
  const first = h.draw('toolu_1');
  h.card(first).click();
  await h.settle();
  first.remove();
  const again = h.draw('toolu_1');
  await h.settle();
  await h.settle();
  assert.ok(h.box(again), 'opened again without a click');
  assert.deepEqual(h.calls.start.length, 2);
  assert.deepEqual(h.calls.stop, [1], 'the box the redraw took away stops following');
  h.card(again).click();
  await h.settle();
  assert.ok(!h.box(again), 'a collapse is a collapse');
  const third = h.draw('toolu_1');
  await h.settle();
  assert.ok(!h.box(third), 'and is remembered');
});

test('the history viewer is unchanged: no session of its own, no expansion', async () => {
  const h = setup();
  vm.runInContext('currentViewerSessionId = null', h.ctx);
  h.ctx.__id = 'toolu_h';
  const el = vm.runInContext(`renderJsonlEntry(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: __id, name: 'Agent', input: { subagent_type: 'verifier', description: 'Review' } }] } },
    new Map())`, h.ctx);
  h.host.appendChild(el);
  h.card(el).click();
  await h.settle();
  assert.deepEqual(h.calls.read, []);
});
