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
      // The real one draws a shell line through renderLocalCommand (jsonl/jsonl-viewer.js); here it is
      // enough that the entry the view builds carries the command and the output where that reader looks.
      d.textContent = entry && entry._localCmd
        ? entry._localCmd.cmd + '\\n' + entry._localCmd.output
        : JSON.stringify(entry.message && entry.message.content);
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

test('an approval is drawn with the call it is about, answers with the value it was given, and holds the status', async () => {
  const h = setup();
  const answers = [];
  h.w.api.agent.answer = (id, req, a) => { answers.push([req, a]); return Promise.resolve({ ok: true }); };
  // The call as the viewer draws it; the stub stands in for jsonl-viewer's renderer.
  vm.runInContext("function renderToolUse(b) { const d = document.createElement('div'); d.className = 'tool'; d.textContent = b.name + ': ' + b.input.command; return d; }", h.w);
  const conv = h.entry.conversation;
  conv.apply({ op: 'busy', busy: true, seq: 1 });
  conv.apply({ op: 'append', seq: 2, entry: { type: 'message', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'rm -rf build' } }] } } });
  conv.apply({ op: 'tool', id: 'c1', status: 'running', output: '', seq: 3 });
  conv.apply({ op: 'ask', seq: 4, request: { id: 'q1', kind: 'approval', tool: 'bash', toolCallId: 'c1', answers: { once: 'A1', session: 'A2', refuse: 'A3' } } });
  const card = h.entry.element.querySelector('.conversation-approval');
  assert.ok(card);
  assert.match(card.textContent, /rm -rf build/, 'the command is on the card');
  assert.match(card.textContent, /not a security boundary/);
  assert.match(h.entry.element.querySelector('.conversation-status').textContent, /Waiting for your answer/);
  assert.match(h.entry.element.querySelector('.conversation-activity').textContent, /Waiting for your approval/);
  [...card.querySelectorAll('button')].find(b => b.textContent === 'Allow for this session').click();
  await h.settle();
  assert.equal(JSON.stringify(answers), JSON.stringify([['q1', { value: 'A2' }]]));   // built in the page's realm
  conv.apply({ op: 'answered', id: 'q1', seq: 5 });
  assert.equal(h.entry.element.querySelector('.conversation-approval'), null);
  assert.match(h.entry.element.querySelector('.conversation-status').textContent, /Working/);
});

// #642: a login asks for an API key in a masked one-line field, answered with Enter or OK, and locked while the
// answer is on its way so a second Enter does not answer twice.
test('a secret question is a masked field that answers once with Enter', async () => {
  const h = setup();
  const answers = [];
  h.w.api.agent.answer = (id, req, a) => { answers.push([req, a]); return new Promise(() => {}); };
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'k1', method: 'input', title: 'Enter Groq API key', message: '', options: [], placeholder: '', prefill: '', secret: true } });
  const field = h.entry.element.querySelector('.conversation-ask input.conversation-ask-input');
  assert.ok(field, 'an input, not a textarea');
  assert.equal(field.type, 'password');
  field.value = 'sk-test';
  field.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(field.disabled, true, 'locked while the answer is on its way');
  field.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(JSON.stringify(answers), JSON.stringify([['k1', { value: 'sk-test' }]]));

  h.entry.conversation.apply({ op: 'ask', seq: 2, request: { id: 'k2', method: 'input', title: 'Name?', message: '', options: [], placeholder: '', prefill: '' } });
  assert.ok(h.entry.element.querySelector('.conversation-ask textarea.conversation-ask-input'), 'an ordinary question keeps its text area');
});

test('a notice with a page to open draws a button that hands a web address to the browser, and nothing else', () => {
  const h = setup();
  const opened = [];
  h.w.api.openExternal = (u) => { opened.push(u); return Promise.resolve(); };
  h.entry.conversation.apply({ op: 'notice', seq: 1, level: 'info', text: 'Log in.', links: [
    { url: 'https://example.test/authorize?x=1', label: 'Open the login page' },
    { url: 'file:///etc/passwd', label: 'Not this' },
  ] });
  const notice = [...h.entry.element.querySelectorAll('.conversation-notice')].pop();
  assert.match(notice.textContent, /Log in\./);
  const buttons = [...notice.querySelectorAll('button')];
  assert.deepEqual(buttons.map(b => b.textContent), ['Open the login page']);
  assert.ok(buttons[0].classList.contains('new-session-secondary-btn'), 'a styled control');
  buttons[0].click();
  assert.deepEqual(opened, ['https://example.test/authorize?x=1']);
});

// #643 — a file the app produced for this session (`/export`). A separate field from `links`, because the
// two go to different openers: a page to the browser, a file to the OS default application.
test('a notice with a file draws a button that opens the file, never the browser', () => {
  const h = setup();
  const opened = [];
  const browsed = [];
  h.w.api.openPath = (p) => { opened.push(p); return Promise.resolve(); };
  h.w.api.openExternal = (u) => { browsed.push(u); return Promise.resolve(); };
  h.entry.conversation.apply({ op: 'notice', seq: 1, level: 'info', text: 'Session written to somewhere.', files: [
    { path: 'somewhere/session.html', label: 'Open the file' },
    { path: '', label: 'Not this' },
  ] });
  const notice = [...h.entry.element.querySelectorAll('.conversation-notice')].pop();
  const buttons = [...notice.querySelectorAll('button')];
  assert.deepEqual(buttons.map(b => b.textContent), ['Open the file'], 'an entry with no path is not a button');
  assert.ok(buttons[0].classList.contains('new-session-secondary-btn'), 'a styled control');
  assert.equal(buttons[0].title, 'somewhere/session.html', 'the path is readable without opening it');
  buttons[0].click();
  assert.deepEqual(opened, ['somewhere/session.html']);
  assert.deepEqual(browsed, [], 'a file never goes to the browser opener');
});

// #643 — a shell line the user ran. It keeps its place in the conversation and is REPLACED as its output
// grows, rather than appended to, and it cannot use the partial slot: a shell line and an assistant turn
// can be live at once.
test('a shell line is one entry that grows, and keeps its place in the order', () => {
  const h = setup();
  const entries = () => [...h.entry.element.querySelectorAll('.conversation-log > *')];

  h.entry.conversation.apply({ op: 'localCommand', seq: 1, id: 'r1', command: 'ls -la', status: 'running', output: '' });
  const afterStart = entries().length;
  assert.ok(h.entry.element.textContent.includes('ls -la'), 'the command is on screen before any output');

  h.entry.conversation.apply({ op: 'localCommand', seq: 2, id: 'r1', status: 'running', output: 'one\n' });
  h.entry.conversation.apply({ op: 'localCommand', seq: 3, id: 'r1', status: 'running', output: 'one\ntwo\n' });
  assert.equal(entries().length, afterStart, 'the same entry is replaced, never a second one appended');
  assert.ok(h.entry.element.textContent.includes('two'), 'and it shows the latest output');
  assert.ok(h.entry.element.textContent.includes('ls -la'), 'the command survives ops that do not repeat it');

  h.entry.conversation.apply({ op: 'localCommand', seq: 4, id: 'r1', status: 'done', output: 'one\ntwo\n\n[exit 0]' });
  assert.equal(entries().length, afterStart);
  assert.ok(h.entry.element.textContent.includes('[exit 0]'));
});

// A shell line raises no busy edge — the agent is not working — so a control gated on `busy` alone left
// a running command with nothing to stop it, while main had the abort all along.
test('Stop is offered while a shell line runs, and Escape reaches it', () => {
  const h = setup();
  const stopBtn = [...h.entry.element.querySelectorAll('button')].find(b => b.textContent === 'Stop');
  assert.ok(stopBtn, 'the control exists');
  assert.equal(stopBtn.style.display, 'none', 'and is hidden while nothing is running');

  h.entry.conversation.apply({ op: 'localCommand', seq: 1, id: 'r1', command: 'sleep 9', status: 'running', output: '' });
  assert.equal(stopBtn.style.display, '', 'a running shell line offers Stop, although the session is not busy');
  h.key({ key: 'Escape' });
  assert.equal(h.calls.abort, 1, 'and Escape reaches the same abort');

  h.entry.conversation.apply({ op: 'localCommand', seq: 2, id: 'r1', status: 'cancelled', output: '[stopped]' });
  assert.equal(stopBtn.style.display, 'none', 'and it goes again when the line ends');
  h.key({ key: 'Escape' });
  assert.equal(h.calls.abort, 1, 'Escape stops nothing once there is nothing to stop');
});

test('two shell lines are two entries, and a re-mount forgets them', () => {
  const h = setup();
  h.entry.conversation.apply({ op: 'localCommand', seq: 1, id: 'a', command: 'first', status: 'running', output: '' });
  h.entry.conversation.apply({ op: 'localCommand', seq: 2, id: 'b', command: 'second', status: 'running', output: '' });
  const text = h.entry.element.textContent;
  assert.ok(text.includes('first') && text.includes('second'), 'each id is its own entry');

  // The conversation is re-read from the runtime, where a finished line is an ordinary entry — so nothing
  // may still hold an index into the list that was just thrown away.
  h.entry.conversation.apply({ op: 'reset', seq: 3, entries: [] });
  const stopBtn = [...h.entry.element.querySelectorAll('button')].find(b => b.textContent === 'Stop');
  assert.equal(stopBtn.style.display, 'none', 'a re-mount starts with nothing running');

  // Main stamps the command onto EVERY op for a line it started, so a view that mounts mid-command draws
  // it whole and gets its Stop back rather than showing output under an empty heading.
  h.entry.conversation.apply({ op: 'localCommand', seq: 4, id: 'a', command: 'first', status: 'running', output: 'again' });
  assert.ok(h.entry.element.textContent.includes('again'), 'a later op for a known id draws a fresh entry');
  assert.ok(h.entry.element.textContent.includes('first'), 'and the entry still names the command');
  assert.equal(stopBtn.style.display, '', 'and the line can be stopped again');
});

test('a notice with neither a page nor a file has no actions at all', () => {
  const h = setup();
  h.entry.conversation.apply({ op: 'notice', seq: 1, level: 'info', text: 'Just a line.' });
  const notice = [...h.entry.element.querySelectorAll('.conversation-notice')].pop();
  assert.equal(notice.querySelectorAll('button').length, 0);
  assert.equal(notice.querySelectorAll('.conversation-ask-actions').length, 0);
});

// --- The palette anchor (#637) ---
//
// A wiring guard, not a behaviour test. `paletteAnchor` is a public member of the view that
// `src/renderer/app.js` reads BY NAME, so the four insert rows of the command palette can open against a
// session that has no terminal. Nothing else connects the two: rename it, or drop the branch in
// `focusedActionTerminal`, and the rows go silently absent again with the whole suite green — which is the
// "absent, not broken" shape #637 exists to remove.

test('the view exposes one palette anchor, shaped the way openPalette uses a terminal', () => {
  const h = setup();
  const anchor = h.entry.conversation.paletteAnchor;
  assert.ok(anchor, 'the view exposes paletteAnchor');
  // `openPalette` does exactly three things with it: position() reads element.getBoundingClientRect(),
  // closePalette() calls focus(), and the picker hands it on as its context.
  assert.ok(anchor.element && typeof anchor.element.getBoundingClientRect === 'function', 'it has an element');
  assert.equal(typeof anchor.focus, 'function', 'and it can take the caret');

  // One anchor, not a second one beside the chords' — the same object the view uses itself.
  anchor.focus();
  assert.equal(h.entry.element.ownerDocument.activeElement, h.entry.element.querySelector('textarea'),
    'focusing the anchor puts the caret in the session text field');
});

test('focusedActionTerminal still answers for an entry with no terminal', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function focusedActionTerminal'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.ok(body.includes('paletteAnchor'),
    'focusedActionTerminal reads the conversation view\'s paletteAnchor — without it the command palette '
    + 'offers no insert row for a session with no terminal (#637)');
});
