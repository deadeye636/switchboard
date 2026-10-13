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

function setup({ subagents = [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }], delays = {}, unreadable = [] } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const w = dom.window;
  const calls = { read: [], start: [], stop: [] };
  let nextWatch = 1;
  const api = {
    listSubagents: async () => subagents,
    readSubagentJsonl: async (parent, agentId) => {
      calls.read.push([parent, agentId]);
      if (unreadable.includes(agentId)) return { error: 'not there yet' };
      if (delays[agentId]) await new Promise((r) => setTimeout(r, delays[agentId]));
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

test('#783: one box per conversation — opening a second folds the first and stops its tail', async () => {
  const h = setup({ subagents: [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }, { agentId: 'a2', sessionId: 'sub-2', description: 'Fix', subagentType: 'verifier' }] });
  h.ctx.__exact = { toolu_1: 'a1', toolu_2: 'a2' };
  h.ctx._setSubagentLive('s1', 'a1', true, 'exact');
  h.ctx._setSubagentLive('s1', 'a2', true, 'exact');
  const first = h.draw('toolu_1');
  const second = h.draw('toolu_2', { subagent_type: 'verifier', description: 'Fix' });
  // The Background list finds the card by its call id (session/conversation-view.js, `openAgentInline`).
  assert.equal(h.card(first).dataset.toolUseId, 'toolu_1');
  h.card(first).click();
  await h.settle();
  assert.equal(h.card(first).dataset.inlineOpen, '1');
  h.card(second).click();
  await h.settle();
  assert.ok(h.box(second), 'the second is open');
  assert.ok(!h.box(first), 'the first folded');
  assert.equal(h.card(first).dataset.inlineOpen, undefined);
  assert.deepEqual(h.calls.stop, [1], 'and its tail stopped');
  assert.equal(h.host.querySelectorAll('.jsonl-subagent-inline').length, 1);
  // A redraw brings back only the box still open.
  first.remove();
  const again = h.draw('toolu_1');
  await h.settle();
  assert.ok(!h.box(again));
});

test('#784: the open asked for last wins, even when an older read returns later', async () => {
  const h = setup({ subagents: [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }, { agentId: 'a2', sessionId: 'sub-2', description: 'Fix', subagentType: 'verifier' }], delays: { a1: 60 } });
  h.ctx.__exact = { toolu_1: 'a1', toolu_2: 'a2' };
  const first = h.draw('toolu_1');
  const second = h.draw('toolu_2', { subagent_type: 'verifier', description: 'Fix' });
  h.card(first).click();
  h.card(second).click();
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(h.box(second), 'the later request is open');
  assert.ok(!h.box(first), 'the slower, older one gave way');
});

test('#784: an open with a fallback lands in the transcript view when the box cannot open', async () => {
  const h = setup({ subagents: [], unreadable: ['a9'] });
  h.ctx.__exact = { toolu_1: 'a9' };
  const el = h.draw('toolu_1');
  h.card(el).dataset.fallbackOpen = '1';
  h.card(el).click();
  await h.settle();
  assert.ok(!h.box(el));
  assert.deepEqual(h.opened, [['a9', 'toolu_1']], 'handed to the opener');
  assert.equal(h.card(el).dataset.fallbackOpen, undefined, 'the request is used once');
  h.card(el).click();
  await h.settle();
  assert.equal(h.opened.length, 1, 'a plain click keeps its note instead');
});

test('#784: a redraw reopen that returns late gives way to the reader\'s newer open', async () => {
  const h = setup({ subagents: [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }, { agentId: 'a2', sessionId: 'sub-2', description: 'Fix', subagentType: 'verifier' }], delays: { a1: 80, a2: 20 } });
  h.ctx.__exact = { toolu_1: 'a1', toolu_2: 'a2' };
  const first = h.draw('toolu_1');
  const second = h.draw('toolu_2', { subagent_type: 'verifier', description: 'Fix' });
  h.card(first).click();
  await new Promise((r) => setTimeout(r, 120));
  // X's entry is redrawn and its reopen reads slowly; the reader opens Y meanwhile, and Y's read returns first.
  first.remove();
  const again = h.draw('toolu_1');
  await new Promise((r) => setTimeout(r, 5));
  h.card(second).click();
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(h.box(second), 'the reader\'s open stays');
  assert.ok(!h.box(again), 'the late reopen gave way');
});

test('#784: a failed open leaves the box on screen, and a redraw still brings it back', async () => {
  const h = setup({ subagents: [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }, { agentId: 'a2', sessionId: 'sub-2', description: 'Fix', subagentType: 'verifier' }], unreadable: ['a2'] });
  h.ctx.__exact = { toolu_1: 'a1', toolu_2: 'a2' };
  const first = h.draw('toolu_1');
  const second = h.draw('toolu_2', { subagent_type: 'verifier', description: 'Fix' });
  h.card(first).click();
  await h.settle();
  h.card(second).click();
  await h.settle();
  assert.ok(h.box(first), 'still open');
  first.remove();
  const again = h.draw('toolu_1');
  await h.settle();
  await h.settle();
  assert.ok(h.box(again), 'and remembered');
});

test('#784: an Open pressed while the card is already reading still gets its fallback', async () => {
  const h = setup({ subagents: [], unreadable: ['a9'] });
  h.ctx.__exact = { toolu_1: 'a9' };
  const el = h.draw('toolu_1');
  h.card(el).click();
  h.card(el).dataset.fallbackOpen = '1';
  h.card(el).click();
  await h.settle();
  assert.deepEqual(h.opened, [['a9', 'toolu_1']]);
  assert.equal(h.card(el).dataset.fallbackOpen, undefined);
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
