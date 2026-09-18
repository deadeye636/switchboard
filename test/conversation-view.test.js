'use strict';
// src/renderer/session/conversation-view.js (#568) — the surface of a session with no terminal. Loaded into
// a jsdom window the way the page loads it (a classic script, top-level functions on the shared scope), with
// the handful of globals it reads at call time stubbed. What is pinned is what a user does with the text
// field and what the view does with ops arriving while it mounts; the drawing itself is jsonl-viewer's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'session', 'conversation-view.js'), 'utf8');

function setup({ attachAnswer } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="terminals"></div></body>');
  const w = dom.window;
  const calls = { send: [], abort: 0, attach: 0 };
  let resolveSend = null;
  w.api = {
    onAgentEvent() {},
    agent: {
      send: (id, payload) => { calls.send.push({ id, ...payload }); return new Promise((r) => { resolveSend = r; }); },
      abort: () => { calls.abort++; return Promise.resolve({ ok: true }); },
      attach: () => { calls.attach++; return attachAnswer ? attachAnswer() : Promise.resolve({ ok: true, entries: [], seq: 0 }); },
      answer: () => Promise.resolve({ ok: true }),
    },
  };
  const ctx = vm.createContext(w);
  // What the page provides around it. An entry is drawn as a div carrying its text, which is all the
  // assertions below read.
  vm.runInContext(`
    var openSessions = new Map();
    var terminalsEl = document.getElementById('terminals');
    var lastActivityTime = new Map();
    var isMac = false;
    function buildToolResultMap() { return new Map(); }
    function renderJsonlEntry(entry) {
      const d = document.createElement('div');
      d.className = 'jsonl-entry';
      d.textContent = JSON.stringify(entry.message && entry.message.content);
      return d;
    }
  `, ctx);
  vm.runInContext(SRC, ctx);
  const entry = vm.runInContext("createConversationEntry({ sessionId: 's1', projectPath: '/p' })", ctx);
  const input = entry.element.querySelector('.conversation-input');
  const key = (props) => input.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...props }));
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { w, entry, input, key, calls, settle, answerSend: (res) => resolveSend(res) };
}

test('Enter sends a plain turn; Shift+Enter does not; the send mode is decided in main, not here', async () => {
  const h = setup();
  h.input.value = 'hello';
  h.key({ key: 'Enter', shiftKey: true });
  assert.equal(h.calls.send.length, 0);
  h.key({ key: 'Enter' });
  assert.deepEqual(h.calls.send, [{ id: 's1', text: 'hello', mode: 'prompt' }]);
  h.answerSend({ ok: true });
  await h.settle();
  assert.equal(h.input.value, '');
});

test('while a turn runs: Ctrl+Enter steers, Escape stops, Enter is still a plain turn', async () => {
  const h = setup();
  h.entry.conversation.apply({ op: 'busy', busy: true, seq: 1 });
  h.input.value = 'change course';
  h.key({ key: 'Enter', ctrlKey: true });
  assert.equal(h.calls.send[0].mode, 'steer');
  h.answerSend({ ok: true });
  await h.settle();
  h.key({ key: 'Escape' });
  await h.settle();
  assert.equal(h.calls.abort, 1);
  h.input.value = 'later';
  h.key({ key: 'Enter' });
  assert.equal(h.calls.send[1].mode, 'prompt');
});

test('an input method composing a character owns Enter and Escape', () => {
  const h = setup();
  h.entry.conversation.apply({ op: 'busy', busy: true, seq: 1 });
  h.input.value = 'x';
  h.key({ key: 'Enter', keyCode: 229 });
  h.key({ key: 'Escape', isComposing: true });
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.calls.abort, 0);
});

test('text typed while a send is in flight stays, and the sent text is not sent twice', async () => {
  const h = setup();
  h.input.value = 'foo';
  h.key({ key: 'Enter' });
  h.input.value = 'foo bar';          // typed before the answer came back
  h.answerSend({ ok: true });
  await h.settle();
  assert.equal(h.input.value, 'bar');
});

test('a failed send keeps the text and says why', async () => {
  const h = setup();
  h.input.value = 'foo';
  h.key({ key: 'Enter' });
  h.answerSend({ ok: false, error: 'The session is not running.' });
  await h.settle();
  assert.equal(h.input.value, 'foo');
  assert.match(h.entry.element.textContent, /not running/);
});

test('a picked text lands at the caret; a picked skill is sent, even when a send is already in flight', async () => {
  const h = setup();
  h.input.value = 'ab';
  h.input.setSelectionRange(1, 1);
  assert.equal(h.entry.conversation.insertText('X\nY'), true);
  assert.equal(h.input.value, 'aX\nYb');
  h.input.value = 'first';
  h.key({ key: 'Enter' });
  h.input.value = '';
  h.entry.conversation.insertText('/skill:review', { submit: true });   // while "first" is still in flight
  assert.equal(h.calls.send.length, 1);
  h.answerSend({ ok: true });
  await h.settle();
  assert.equal(h.calls.send.length, 2, 'the skill went out once the first send was back');
  assert.equal(h.calls.send[1].text, '/skill:review');
});

test('an ended session takes nothing and says so', () => {
  const h = setup();
  h.entry.conversation.markExited(0);
  assert.equal(h.entry.conversation.insertText('x'), false);
  assert.match(h.entry.element.textContent, /nothing was inserted/);
  assert.equal(h.input.disabled, true);
});

test('ops arriving while a view mounts are replayed after the snapshot — only the newer ones', async () => {
  let release;
  const h = setup({ attachAnswer: () => new Promise((r) => { release = r; }) });
  const attaching = h.entry.conversation.attach();
  const user = (text) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
  // Two ops land while the attach is in flight: #5 is already in the snapshot, #6 happened after it.
  h.entry.conversation.apply({ op: 'append', entry: user('old'), seq: 5 });
  h.entry.conversation.apply({ op: 'append', entry: user('new'), seq: 6 });
  release({ ok: true, entries: [user('old')], seq: 5, busy: false, queue: { steering: [], followUp: [] }, asks: [] });
  await attaching;
  const drawn = [...h.entry.element.querySelectorAll('.conversation-log > .jsonl-entry')].map(d => d.textContent);
  assert.equal(drawn.length, 2);
  assert.match(drawn[0], /old/);
  assert.match(drawn[1], /new/);
});
