'use strict';
// #770, #787: an agent call in a conversation opens its subagent's transcript in the document viewer's overlay over
// the conversation (src/renderer/jsonl/jsonl-viewer.js `openAgentOverlay`, src/renderer/jsonl/document-viewer.js),
// the way a document card opens. Drawn through the real renderer with the conversation's draw context, against a
// stand-in `window.api` that records what is asked of main.
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
  vm.runInContext(read('src/renderer/jsonl/document-viewer.js'), ctx);
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
  const overlays = () => host.querySelectorAll(':scope > .document-viewer');
  const overlay = () => host.querySelector(':scope > .document-viewer');
  // What the overlay shows: the prompt line of the agent it holds.
  const shown = () => {
    const o = overlay();
    const t = o && o.querySelector('.jsonl-subagent-overlay');
    return t ? t.textContent : null;
  };
  const press = (key) => overlay().dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true }));
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { w, ctx, host, calls, opened, draw, card, overlays, overlay, shown, press, settle };
}

test('#787: a conversation opens the subagent its call started in an overlay over it, with Open in tab', async () => {
  const h = setup({ subagents: [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }, { agentId: 'a2', sessionId: 'sub-2', description: 'Review', subagentType: 'verifier' }] });
  h.ctx.__exact = { toolu_1: 'a2' };
  const el = h.draw('toolu_1');
  h.card(el).click();
  await h.settle();
  assert.deepEqual(h.calls.read, [['s1', 'a2']], 'the subagent the backend named, under the conversation\'s session');
  assert.equal(h.overlays().length, 1, 'one overlay, on the conversation\'s root');
  assert.match(h.shown(), /prompt of a2/);
  assert.equal(el.querySelector('.jsonl-subagent-nested'), null, 'nothing is expanded inside the log');
  assert.equal(h.host.querySelector(':scope > .jsonl-subagent-nested'), null);
  assert.match(h.overlay().querySelector('.document-viewer-title').textContent, /Agent · verifier · Review/);
  const btn = [...h.overlay().querySelectorAll('.document-viewer-actions button')].find(b => b.textContent === 'Open in tab');
  assert.ok(btn, 'Open in tab in the viewer\'s bar');
  btn.click();
  assert.deepEqual(h.opened, [['a2', 'toolu_1']]);
  assert.equal(h.overlays().length, 0, 'the action closes the overlay');
  assert.deepEqual(h.calls.start, [], 'a finished agent is not followed');
});

test('without a named subagent, a call takes its place among the same calls on screen', async () => {
  const h = setup({ subagents: [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }, { agentId: 'a2', sessionId: 'sub-2', description: 'Review', subagentType: 'verifier' }] });
  h.draw('toolu_1');
  const second = h.draw('toolu_2');
  h.draw('toolu_x', { subagent_type: 'other', description: 'Else' });
  h.card(second).click();
  await h.settle();
  assert.deepEqual(h.calls.read, [['s1', 'a2']]);
});

test('#787: a running agent is followed, another viewer closing does not stop it, and closing the overlay does', async () => {
  const h = setup();
  h.ctx.__exact = { toolu_1: 'a1' };
  h.ctx._setSubagentLive('s1', 'a1', true, 'exact');
  const el = h.draw('toolu_1');
  h.card(el).click();
  await h.settle();
  assert.deepEqual(h.calls.start, [['s1', 'a1']]);
  assert.ok(h.overlay().querySelector('.document-viewer-title .jsonl-subagent-live-indicator'), 'the live marker sits in the title');
  vm.runInContext('drainViewerWatches()', h.ctx);
  await h.settle();
  assert.deepEqual(h.calls.stop, [], 'another viewer closing leaves the overlay\'s tail alone');
  h.press('Escape');
  await h.settle();
  assert.equal(h.overlays().length, 0);
  assert.deepEqual(h.calls.stop, [1], 'Esc closes the overlay and stops its tail');
});

test('#787: a running agent\'s end stops the tail while the overlay is open', async () => {
  const h = setup();
  h.ctx.__exact = { toolu_1: 'a1' };
  h.ctx._setSubagentLive('s1', 'a1', true, 'exact');
  h.card(h.draw('toolu_1')).click();
  await h.settle();
  h.ctx._setSubagentLive('s1', 'a1', false, 'exact');
  await new Promise((r) => setTimeout(r, 2700));
  assert.deepEqual(h.calls.stop, [1], 'stopped a little after the end');
  assert.equal(h.overlays().length, 1, 'the transcript stays readable');
  h.press('Escape');
  assert.deepEqual(h.calls.stop, [1], 'closing does not stop it twice');
});

test('#787: one overlay per conversation — opening a second agent replaces the first and stops its tail', async () => {
  const h = setup({ subagents: [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }, { agentId: 'a2', sessionId: 'sub-2', description: 'Fix', subagentType: 'verifier' }] });
  h.ctx.__exact = { toolu_1: 'a1', toolu_2: 'a2' };
  h.ctx._setSubagentLive('s1', 'a1', true, 'exact');
  h.ctx._setSubagentLive('s1', 'a2', true, 'exact');
  const first = h.draw('toolu_1');
  const second = h.draw('toolu_2', { subagent_type: 'verifier', description: 'Fix' });
  h.card(first).click();
  await h.settle();
  h.card(second).click();
  await h.settle();
  assert.equal(h.overlays().length, 1);
  assert.match(h.shown(), /prompt of a2/);
  assert.deepEqual(h.calls.stop, [1], 'the first one\'s tail stopped');
});

test('#787: a redraw of the call leaves the overlay alone and reads nothing again', async () => {
  const h = setup();
  h.ctx.__exact = { toolu_1: 'a1' };
  const first = h.draw('toolu_1');
  h.card(first).click();
  await h.settle();
  first.remove();
  h.draw('toolu_1');
  await h.settle();
  assert.equal(h.overlays().length, 1);
  assert.equal(h.calls.read.length, 1);
});

test('#784: the open asked for last wins, even when an older read returns later', async () => {
  const h = setup({ subagents: [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }, { agentId: 'a2', sessionId: 'sub-2', description: 'Fix', subagentType: 'verifier' }], delays: { a1: 60 } });
  h.ctx.__exact = { toolu_1: 'a1', toolu_2: 'a2' };
  const first = h.draw('toolu_1');
  const second = h.draw('toolu_2', { subagent_type: 'verifier', description: 'Fix' });
  h.card(first).click();
  h.card(second).click();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(h.overlays().length, 1);
  assert.match(h.shown(), /prompt of a2/, 'the later request is shown, the slower, older one gave way');
});

test('#784: an open with a fallback lands in the transcript view when nothing can be shown', async () => {
  const h = setup({ subagents: [], unreadable: ['a9'] });
  h.ctx.__exact = { toolu_1: 'a9' };
  const el = h.draw('toolu_1');
  h.card(el).dataset.fallbackOpen = '1';
  h.card(el).click();
  await h.settle();
  assert.equal(h.overlays().length, 0);
  assert.deepEqual(h.opened, [['a9', 'toolu_1']], 'handed to the opener');
  assert.equal(h.card(el).dataset.fallbackOpen, undefined, 'the request is used once');
  h.card(el).click();
  await h.settle();
  assert.equal(h.opened.length, 1, 'a plain click keeps its note instead');
  assert.ok(el.querySelector('.jsonl-agent-pending'));
});

test('#784: a failed open leaves the overlay on screen', async () => {
  const h = setup({ subagents: [{ agentId: 'a1', sessionId: 'sub-1', description: 'Review', subagentType: 'verifier' }, { agentId: 'a2', sessionId: 'sub-2', description: 'Fix', subagentType: 'verifier' }], unreadable: ['a2'] });
  h.ctx.__exact = { toolu_1: 'a1', toolu_2: 'a2' };
  const first = h.draw('toolu_1');
  const second = h.draw('toolu_2', { subagent_type: 'verifier', description: 'Fix' });
  h.card(first).click();
  await h.settle();
  h.card(second).click();
  await h.settle();
  assert.match(h.shown(), /prompt of a1/, 'still open');
});

test('#787: the conversation view opens a named subagent without its call on screen', async () => {
  const h = setup({ subagents: [] });
  const opened = [];
  h.ctx.__args = {
    host: h.host,
    parentSessionId: 's1',
    resolve: async () => ({ agentId: 'a5', sessionId: null, description: 'Late', subagentType: 'worker' }),
    openInTab: (m) => opened.push(m.agentId),
  };
  await vm.runInContext('openAgentOverlay(__args)', h.ctx);
  assert.deepEqual(h.calls.read, [['s1', 'a5']]);
  assert.match(h.shown(), /prompt of a5/);
  const src = read('src/renderer/session/conversation-view.js');
  assert.match(src, /openAgentOverlay\(\{\s*host: container/, 'conversation-view.js opens the overlay on its own root');
  assert.doesNotMatch(src, /scrollIntoView\(\{ block: 'start' \}\)/, 'and no longer scrolls the log to the call');
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

test('the history viewer still expands a call in place', async () => {
  const h = setup();
  vm.runInContext('currentViewerSessionId = "hist-1"', h.ctx);
  h.ctx.__id = 'toolu_h';
  const el = vm.runInContext(`renderJsonlEntry(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: __id, name: 'Agent', input: { subagent_type: 'verifier', description: 'Review' } }] } },
    new Map())`, h.ctx);
  h.host.appendChild(el);
  h.card(el).click();
  await h.settle();
  assert.deepEqual(h.calls.read, [['hist-1', 'a1']]);
  assert.ok(el.querySelector('.jsonl-subagent-nested .jsonl-subagent-inline-bar'), 'expanded under the call');
  assert.equal(h.overlays().length, 0);
});

test('#787: a document opened while an agent is still being read wins, and the document card claims its turn', async () => {
  const h = setup({ delays: { a1: 60 } });
  h.ctx.__exact = { toolu_1: 'a1' };
  h.card(h.draw('toolu_1')).click();
  // What a document card's click does first (jsonl/document-card.js).
  h.ctx.__host = h.host;
  vm.runInContext('claimInlineOpen(__host)', h.ctx);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(h.overlays().length, 0, 'the older agent open gave way');
  const card = read('src/renderer/jsonl/document-card.js');
  assert.match(card, /claimInlineOpen\(host\)/);
  assert.match(card, /if \(stale\(host, seq\)\) return;/);
});
