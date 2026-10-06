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

// How a file is named in the text (#699) — the completion's own helper, taken on its own so the list the
// completion opens stays out of these tests.
const { composerPathToken } = require('../src/renderer/session/composer-completion.js');

// `diskPaths` maps a file NAME to the path `getPathForFile` answers for it; a file not in it has none, the
// way a clipboard bitmap has none.
function setup({ attachAnswer, imageInput, rightClick, clipboard = '', diskPaths = {} } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="terminals"></div></body>');
  const w = dom.window;
  // A window in view: jsdom reports `document.hidden` unless told otherwise, and a hidden window draws
  // nothing (#723). A test of a hidden window redefines it.
  Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => false });
  const calls = { send: [], abort: 0, attach: 0, copied: [] };
  let resolveSend = null;
  w.api = {
    getPathForFile: (f) => diskPaths[f.name] || '',
    readClipboard: () => Promise.resolve(clipboard),
    writeClipboard: (t) => { calls.copied.push(t); },
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
    // The attention caption's one write path (terminal/terminal-attention-notice.js), recorded (#666).
    var captionCleared = [];
    function clearTerminalAttentionNotice(id) { captionCleared.push(id); }
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
  // The right-click setting terminal/terminal-context-menu.js keeps (#690); absent means that file's default.
  if (rightClick) { ctx.__rightClick = rightClick; vm.runInContext('var terminalRightClickMode = __rightClick;', ctx); }
  // The descriptor the renderer caches, reduced to the one field the image attachment reads (#662).
  ctx.__imageInput = imageInput || null;
  vm.runInContext(`
    function sessionBackendId() { return 'b1'; }
    function getBackend() { return { id: 'b1', transport: 'rpc', imageInput: __imageInput }; }
  `, ctx);
  ctx.composerPathToken = composerPathToken;
  vm.runInContext(SRC, ctx);
  const entry = vm.runInContext("createConversationEntry({ sessionId: 's1', projectPath: '/p' })", ctx);
  // On screen, as `showSession` leaves the view it shows: `.visible` is what the view asks (#723). A test of a
  // hidden view takes the class away.
  entry.element.classList.add('visible');
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

// #662: an image pasted into the input goes out with the next turn, is shown until then, can be taken back,
// and one the session would refuse is refused before it is attached.
function pasteImages(h, files, text = '') {
  const ev = new h.w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: {
    items: files.map(f => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    getData: () => text,
  } });
  h.input.dispatchEvent(ev);
  return ev;
}
const until = async (cond) => { for (let i = 0; i < 50 && !cond(); i++) await new Promise(r => setTimeout(r, 10)); };

test('a pasted image is attached, shown, removable, and sent with the turn', async () => {
  const h = setup({ imageInput: { types: ['image/png'], maxBytes: 1024 } });
  const png = new h.w.File(['png-bytes'], 'shot.png', { type: 'image/png' });
  const ev = pasteImages(h, [png]);
  assert.equal(ev.defaultPrevented, true, 'a paste that carries only an image puts nothing into the text');
  const strip = h.entry.element.querySelector('.conversation-attachments');
  await until(() => strip.querySelectorAll('.conversation-attachment').length === 1);
  assert.equal(strip.hidden, false);
  assert.equal(strip.querySelector('img').alt, 'shot.png');
  pasteImages(h, [new h.w.File(['more'], 'two.png', { type: 'image/png' })]);
  await until(() => strip.querySelectorAll('.conversation-attachment').length === 2);
  strip.querySelectorAll('.conversation-attachment button')[1].click();
  assert.equal(strip.querySelectorAll('.conversation-attachment').length, 1, 'the × takes one back');
  // Typed after the placeholder the image left in the field (#688); overwriting the field would drop it.
  h.input.value = h.input.value.trim() + ' what is this';
  h.key({ key: 'Enter' });
  assert.equal(h.calls.send.length, 1);
  // Through JSON: the array was built in the jsdom realm, and deepEqual compares prototypes across realms.
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.send[0].images)),
    [{ mimeType: 'image/png', data: Buffer.from('png-bytes').toString('base64') }]);
  h.answerSend({ ok: true });
  await h.settle();
  assert.equal(strip.hidden, true, 'what was sent is no longer attached');
});

test('a copy that carries text pastes only the text; an image alone is a turn', async () => {
  const h = setup({ imageInput: { types: ['image/png'], maxBytes: 1024 } });
  // Excel and Word put a picture of the selection beside the text of a few copied cells.
  const withText = pasteImages(h, [new h.w.File(['x'], 'cells.png', { type: 'image/png' })], 'a cell');
  assert.equal(withText.defaultPrevented, false, 'the text pastes as usual');
  await h.settle();
  assert.equal(h.entry.element.querySelectorAll('.conversation-attachment').length, 0, 'and the picture beside it is not attached');
  pasteImages(h, [new h.w.File(['x'], 'a.png', { type: 'image/png' })]);
  await until(() => h.entry.element.querySelectorAll('.conversation-attachment').length === 1);
  h.key({ key: 'Enter' });
  assert.equal(h.calls.send.length, 1, 'a field holding only the placeholder sends because an image is attached');
  assert.equal(h.calls.send[0].text, '[Image #1] ', 'the image stands in the text the way the TUI writes it (#688)');
});

// #690: the terminal's right-click setting reaches the conversation view.
function selectLogText(h, text) {
  const log = h.entry.element.querySelector('.conversation-log');
  const p = h.w.document.createElement('p');
  p.textContent = text;
  log.appendChild(p);
  const range = h.w.document.createRange();
  range.selectNodeContents(p);
  const sel = h.w.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return log;
}
const rightClick = (h) => {
  const ev = new h.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  h.entry.element.querySelector('.conversation-log').dispatchEvent(ev);
  return ev;
};

test('copy-on-select: finishing a selection in the conversation copies it; a right click pastes into the input', async () => {
  const h = setup({ rightClick: 'copy-on-select', clipboard: 'pasted' });
  const log = selectLogText(h, 'some answer');
  log.dispatchEvent(new h.w.MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await h.settle();
  assert.deepEqual(h.calls.copied, ['some answer']);
  assert.equal(rightClick(h).defaultPrevented, true);
  await h.settle();
  assert.equal(h.input.value, 'pasted');
});

test('copy-paste: a right click copies a selection, and pastes when there is none; menu mode is left alone', async () => {
  const h = setup({ rightClick: 'copy-paste', clipboard: 'from clipboard' });
  selectLogText(h, 'chosen');
  rightClick(h);
  assert.deepEqual(h.calls.copied, ['chosen']);
  assert.equal(h.input.value, '', 'a copy pastes nothing');
  rightClick(h);
  await h.settle();
  assert.equal(h.input.value, 'from clipboard');
  const menu = setup({ rightClick: 'menu', clipboard: 'x' });
  assert.equal(rightClick(menu).defaultPrevented, false);
});

test('a whitespace-only selection is not copied', async () => {
  const h = setup({ rightClick: 'copy-on-select' });
  const log = selectLogText(h, '   ');
  log.dispatchEvent(new h.w.MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await h.settle();
  assert.deepEqual(h.calls.copied, []);
});

// #689: the page keys reach the conversation from the input, and the jump button exists for when the log
// leaves the end. jsdom has no layout, so the scrolling itself is checked in the app.
test('Ctrl+End, Ctrl+Home, PageUp and PageDown are taken from the input for the conversation', () => {
  const h = setup();
  for (const props of [{ key: 'End', ctrlKey: true }, { key: 'Home', ctrlKey: true }, { key: 'PageUp' }, { key: 'PageDown' }]) {
    const ev = new h.w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...props });
    h.input.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, JSON.stringify(props));
  }
  const plainHome = new h.w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Home' });
  h.input.dispatchEvent(plainHome);
  assert.equal(plainHome.defaultPrevented, false, 'Home alone still moves the caret');
  const jump = h.entry.element.querySelector('.conversation-jump');
  assert.ok(jump && jump.hidden, 'the jump button is there and hidden while at the end');
});

// #723: a hidden container keeps its size now (`content-visibility: hidden`), so the view must not measure it
// while hidden — reading its height would make the browser lay out what it is skipping, per arriving entry.
// On show it goes back to the end once, without waiting for a resize that no longer comes.
test('a hidden conversation reads no layout as entries arrive, and goes back to the end when shown', async () => {
  const h = setup();
  h.entry.element.classList.remove('visible');
  await h.settle();
  const log = h.entry.element.querySelector('.conversation-log');
  let reads = 0;
  let scrollTop = 0;
  let height = 2000;
  Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => { reads++; return 300; } });
  Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => { reads++; return height; } });
  Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v) => { scrollTop = v; } });
  const reply = (uuid) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] } });
  for (let i = 0; i < 20; i++) h.entry.conversation.apply({ op: 'append', entry: reply(`h${i}`) });
  await h.settle();
  assert.equal(reads, 0, 'no height or scroll height asked while hidden');
  assert.equal(scrollTop, 0);
  h.entry.element.classList.add('visible');
  await h.settle();
  assert.equal(scrollTop, 2000, 'shown: back at the end');
  height = 2400;
  h.entry.conversation.apply({ op: 'append', entry: reply('v1') });
  assert.equal(scrollTop, 2400, 'shown: an arriving entry is followed again');
  // The entry takes its real height a frame or two later (`content-visibility: auto`), moving no box the
  // ResizeObserver watches: the reader at the end is followed once more then.
  height = 3100;
  await new Promise(r => setTimeout(r, 80));
  assert.equal(scrollTop, 3100, 'followed again once the new entry has its real height');
});

// #723: a view nobody can see keeps what arrives and draws it once when it is shown — the entries in the order
// they came, a tool call with every result that arrived meanwhile, and the last state of a streamed turn.
test('a hidden conversation draws nothing as ops arrive, and draws them in order when shown', async () => {
  const h = setup();
  const conv = h.entry.conversation;
  const log = h.entry.element.querySelector('.conversation-log');
  const drawn = () => [...log.querySelectorAll(':scope > .jsonl-entry')].map(d => d.textContent);
  const text = (t) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
  const use = (id) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } });
  const result = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'out' }] } });
  conv.apply({ op: 'append', entry: use('t1') });
  assert.equal(drawn().length, 1);
  let draws = 0;
  vm.runInContext('var __draw = renderJsonlEntry; renderJsonlEntry = function (e, r) { __draws++; return __draw(e, r); }; var __draws = 0;', h.w);
  const counted = () => vm.runInContext('__draws', h.w);
  h.entry.element.classList.remove('visible');
  await h.settle();
  conv.apply({ op: 'append', entry: text('second') });
  conv.apply({ op: 'append', entry: result('t1') });
  conv.apply({ op: 'append', entry: use('t2') });
  conv.apply({ op: 'append', entry: result('t2') });
  for (let i = 0; i < 5; i++) conv.apply({ op: 'partial', entry: text(`stream ${i}`) });
  draws = counted();
  assert.equal(draws, 0, 'nothing is built while hidden');
  assert.equal(drawn().length, 1);
  h.entry.element.classList.add('visible');
  await h.settle();
  assert.equal(counted(), 4, 'on show: the first call once with its result, the two new entries, the streamed turn once');
  const shown = drawn();
  assert.equal(shown.length, 3);
  assert.match(shown[0], /t1/);
  assert.match(shown[1], /second/);
  assert.match(shown[2], /t2/);
  assert.match(log.querySelector('.conversation-partial').textContent, /stream 4/, 'the last state of the streamed turn');
});

test('a notice while hidden lands after the entries that arrived before it', async () => {
  const h = setup();
  const conv = h.entry.conversation;
  const log = h.entry.element.querySelector('.conversation-log');
  h.entry.element.classList.remove('visible');
  await h.settle();
  conv.apply({ op: 'append', entry: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'before' }] } } });
  conv.apply({ op: 'notice', level: 'info', text: 'the notice' });
  conv.apply({ op: 'append', entry: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'after' }] } } });
  h.entry.element.classList.add('visible');
  await h.settle();
  const order = [...log.querySelectorAll(':scope > .jsonl-entry')].map(d => d.textContent);
  assert.equal(order.length, 3);
  assert.match(order[0], /before/);
  assert.equal(order[1], 'the notice');
  assert.match(order[2], /after/);
});

// A covered or minimised window: `.visible` stays, `document.hidden` turns true. The view reads no layout and
// builds nothing, and catches up when the window is back.
test('a hidden window counts as hidden: no layout, no drawing, caught up on visibilitychange', async () => {
  const h = setup();
  const conv = h.entry.conversation;
  const log = h.entry.element.querySelector('.conversation-log');
  let hidden = true;
  Object.defineProperty(h.w.document, 'hidden', { configurable: true, get: () => hidden });
  let reads = 0;
  let scrollTop = 0;
  Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => { reads++; return 300; } });
  Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => { reads++; return 2000; } });
  Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v) => { scrollTop = v; } });
  for (let i = 0; i < 10; i++) conv.apply({ op: 'append', entry: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `e${i}` }] } } });
  assert.equal(reads, 0, 'no layout read while the window is hidden');
  assert.equal(log.querySelectorAll(':scope > .jsonl-entry').length, 0, 'and nothing built');
  hidden = false;
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  assert.equal(log.querySelectorAll(':scope > .jsonl-entry').length, 10, 'drawn when the window is back');
  assert.equal(scrollTop, 2000, 'and back at the end');
  conv.dispose();
  hidden = true;
  conv.apply({ op: 'append', entry: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] } } });
  hidden = false;
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  assert.equal(log.querySelectorAll(':scope > .jsonl-entry').length, 10, 'a disposed view no longer listens to the window');
});

// #747: a grid card scrolled out of the mosaic keeps `.visible`; grid-view's off-screen set says it cannot be
// seen, and its IntersectionObserver calls `reveal` when the card scrolls back in.
test('a grid card scrolled out of view draws nothing, and catches up when revealed', () => {
  const h = setup();
  const conv = h.entry.conversation;
  const log = h.entry.element.querySelector('.conversation-log');
  vm.runInContext('var gridOffscreenSessions = new Set(["s1"]);', h.w);
  let reads = 0;
  Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => { reads++; return 300; } });
  for (let i = 0; i < 5; i++) conv.apply({ op: 'append', entry: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `g${i}` }] } } });
  assert.equal(reads, 0, 'no layout read while off-screen');
  assert.equal(log.querySelectorAll(':scope > .jsonl-entry').length, 0, 'and nothing built');
  vm.runInContext('gridOffscreenSessions.delete("s1");', h.w);
  conv.reveal();
  assert.equal(log.querySelectorAll(':scope > .jsonl-entry').length, 5, 'drawn once the card is back');
});

// The other half of #747 is grid-view's IntersectionObserver, which jsdom does not have — so its source is read.
// What is pinned is the order: the card leaves the off-screen set BEFORE the view is asked to catch up, or
// `reveal` would still find it off-screen and draw nothing until the next op.
test('grid-view takes a card out of the off-screen set before it reveals its conversation', () => {
  const { stripComments } = require('./helpers/strip-comments.js');
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'views', 'grid-view.js'), 'utf8'));
  const branch = src.slice(src.indexOf('if (e.isIntersecting)'), src.indexOf('} else {', src.indexOf('if (e.isIntersecting)')));
  const cleared = branch.indexOf('gridOffscreenSessions.delete(sid)');
  const revealed = branch.indexOf('.conversation.reveal()');
  assert.ok(cleared > 0, 'the intersecting branch clears the off-screen mark');
  assert.ok(revealed > cleared, 'and reveals the conversation after that');
});

test('while hidden: a reset drops what was waiting, a shell line keeps its place, a cleared stream stays cleared', async () => {
  const h = setup();
  const conv = h.entry.conversation;
  const log = h.entry.element.querySelector('.conversation-log');
  const text = (t) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
  const drawn = () => [...log.querySelectorAll(':scope > .jsonl-entry')].map(d => d.textContent);
  conv.apply({ op: 'partial', entry: text('streaming') });
  assert.match(log.querySelector('.conversation-partial').textContent, /streaming/);
  h.entry.element.classList.remove('visible');
  await h.settle();
  conv.apply({ op: 'append', entry: text('dropped') });
  conv.apply({ op: 'reset', entries: [text('kept')] });
  conv.apply({ op: 'append', entry: text('before the shell line') });
  conv.apply({ op: 'localCommand', id: 'c1', command: 'ls', output: '', status: 'running' });
  conv.apply({ op: 'localCommand', id: 'c1', output: 'a.txt', status: 'done' });
  conv.apply({ op: 'append', entry: text('after the shell line') });
  conv.apply({ op: 'partial', entry: null });
  h.entry.element.classList.add('visible');
  await h.settle();
  const order = drawn();
  assert.equal(order.length, 4, order.join(' | '));
  assert.match(order[0], /kept/);
  assert.match(order[1], /before the shell line/);
  assert.equal(order[2], 'ls\na.txt', 'the shell line with its final output, where it started');
  assert.match(order[3], /after the shell line/);
  assert.equal(log.querySelector('.conversation-partial').childElementCount, 0, 'the stream that ended while hidden is gone');
});

// #709: the prompt of the turn being read is pinned over the log's top edge once it has scrolled out above,
// and follows the reader to an earlier turn. jsdom has no layout, so each entry is given a fixed place: 100 px
// per entry, 80 px tall, and the log shows 300 px of 2000.
test('the prompt of the turn being read is pinned while it is out of sight, and a click goes back to it', async () => {
  const h = setup();
  // `prompt` is the backend's answer; the second one is shaped the way pi-native draws a message.
  const user = (uuid, text) => ({ type: 'user', uuid, prompt: true, message: { role: 'user', content: text } });
  const piUser = (uuid, text) => ({ type: 'message', uuid, prompt: true, message: { role: 'user', content: [{ type: 'text', text }] } });
  const reply = (uuid) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] } });
  const toolResult = (uuid) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } });
  // A user-role line the backend did not call a prompt (a compaction summary, say) never counts.
  const injected = (uuid) => ({ type: 'user', uuid, message: { role: 'user', content: 'This session is being continued' } });
  for (const e of [user('u1', 'first   prompt'), reply('a1'), reply('a2'), piUser('u2', 'second prompt'), reply('a3'), toolResult('r1'),
    reply('a4'), injected('i1'), reply('a5')]) {
    h.entry.conversation.apply({ op: 'append', entry: e });
  }
  const log = h.entry.element.querySelector('.conversation-log');
  let scrollTop = 0;
  Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 300 });
  Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 2000 });
  Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v) => { scrollTop = v; } });
  log.getBoundingClientRect = () => ({ top: 0, bottom: 300 });
  for (const el of log.querySelectorAll('[data-entry-index]')) {
    const base = Number(el.dataset.entryIndex) * 100;
    el.getBoundingClientRect = () => ({ top: base - scrollTop, bottom: base + 80 - scrollTop });
  }
  const pinned = h.entry.element.querySelector('.conversation-pinned-prompt');
  const at = async (top) => {
    scrollTop = top;
    log.dispatchEvent(new h.w.Event('scroll'));
    await new Promise((r) => setTimeout(r, 40));
    return pinned.hidden ? null : pinned.textContent;
  };
  assert.ok(pinned && pinned.classList.contains('new-session-secondary-btn'), 'styled like the jump button');
  assert.equal(await at(0), null, 'its prompt is on screen');
  assert.equal(await at(150), 'first prompt', 'the first prompt scrolled out above');
  assert.equal(await at(330), null, 'the second prompt is still partly on screen, below the bar');
  assert.equal(await at(300), null, 'the second prompt flush with the top is the one being read, not covered');
  assert.equal(await at(270), null, 'nor one just below the top edge, where the bar would lie over it');
  assert.equal(await at(850), 'second prompt', 'a tool result and a line not marked as a prompt are not prompts');
  assert.equal(await at(1700), null, 'nothing at the end');
  await at(850);
  pinned.click();
  assert.equal(scrollTop, 300, 'the click scrolls the log, and only the log, to the pinned prompt');
});

// #716: Tab from the log would move the focus to the first link inside it and scroll there. It goes back to the
// input instead, from the log itself and from anything inside it. Checked with real key presses in the app; this
// pins the wiring.
test('Tab and Shift+Tab from the log go back to the input and leave the conversation where it is', () => {
  const h = setup();
  h.entry.conversation.apply({ op: 'append', entry: { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } } });
  const log = h.entry.element.querySelector('.conversation-log');
  const link = h.w.document.createElement('a');
  link.href = 'https://example.com';
  log.appendChild(link);
  for (const [target, shiftKey] of [[log, false], [link, true]]) {
    target.focus();
    const ev = new h.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.w.document.activeElement, h.input);
  }
  const fromInput = new h.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  h.input.dispatchEvent(fromInput);
  assert.equal(fromInput.defaultPrevented, false, 'Tab in the input keeps its own meaning');
});

// #688: an attached image types `[Image #n]` at the caret, and the placeholder and the thumbnail are one thing.
test('attaching types [Image #n] at the caret; the number is on the thumbnail and counts up', async () => {
  const h = setup({ imageInput: { types: ['image/png'], maxBytes: 1024 } });
  h.input.value = 'compare  please';
  h.input.setSelectionRange(8, 8);
  pasteImages(h, [new h.w.File(['a'], 'a.png', { type: 'image/png' })]);
  await until(() => h.entry.element.querySelectorAll('.conversation-attachment').length === 1);
  assert.equal(h.input.value, 'compare [Image #1] please');
  pasteImages(h, [new h.w.File(['b'], 'b.png', { type: 'image/png' })]);
  await until(() => h.entry.element.querySelectorAll('.conversation-attachment').length === 2);
  assert.match(h.input.value, /\[Image #1\].*\[Image #2\]/);
  const labels = [...h.entry.element.querySelectorAll('.conversation-attachment-label')].map(l => l.textContent);
  assert.deepEqual(labels, ['#1', '#2']);
});

test('deleting a placeholder removes its image; the × removes its placeholder', async () => {
  const h = setup({ imageInput: { types: ['image/png'], maxBytes: 1024 } });
  pasteImages(h, [new h.w.File(['a'], 'a.png', { type: 'image/png' })]);
  pasteImages(h, [new h.w.File(['b'], 'b.png', { type: 'image/png' })]);
  await until(() => h.entry.element.querySelectorAll('.conversation-attachment').length === 2);
  h.input.value = h.input.value.replace('[Image #1]', '');
  h.input.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  const shown = () => [...h.entry.element.querySelectorAll('.conversation-attachment img')].map(i => i.alt);
  assert.deepEqual(shown(), ['b.png'], 'the image whose placeholder went is gone');
  h.entry.element.querySelector('.conversation-attachment .viewer-header-close').click();
  assert.deepEqual(shown(), []);
  assert.doesNotMatch(h.input.value, /\[Image #2\]/, 'the × took the placeholder out of the text');
  pasteImages(h, [new h.w.File(['c'], 'c.png', { type: 'image/png' })]);
  await until(() => h.entry.element.querySelectorAll('.conversation-attachment').length === 1);
  assert.match(h.input.value, /\[Image #1\]/, 'with nothing attached the numbers start again');
});

test('a hand-typed [Image #n] is not reused, and a picker that overwrites a placeholder drops its image', async () => {
  const h = setup({ imageInput: { types: ['image/png'], maxBytes: 1024 } });
  h.input.value = 'see [Image #1] ';
  h.input.setSelectionRange(h.input.value.length, h.input.value.length);
  pasteImages(h, [new h.w.File(['a'], 'a.png', { type: 'image/png' })]);
  await until(() => h.entry.element.querySelectorAll('.conversation-attachment').length === 1);
  assert.match(h.input.value, /\[Image #2\]/, 'the typed #1 is skipped');
  const at = h.input.value.indexOf('[Image #2]');
  h.input.setSelectionRange(at, at + '[Image #2]'.length);
  h.entry.conversation.insertText('something else');
  assert.equal(h.entry.element.querySelectorAll('.conversation-attachment').length, 0);
});

// #699: a file that is not attached is NAMED, the way a terminal session inserts its path. Paths invented.
const NOTES = '/srv/invented/notes.txt';
const SPACED = '/srv/invented/my docs/plan.md';
const GIF = '/srv/invented/a.gif';
function dropFiles(h, files) {
  const ev = new h.w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files } });
  h.input.dispatchEvent(ev);
  return ev;
}

test('a dropped image is attached, and every other dropped file is named in the text', async () => {
  const h = setup({ imageInput: { types: ['image/png'], maxBytes: 1024 }, diskPaths: { 'notes.txt': NOTES, 'plan.md': SPACED } });
  assert.equal(dropFiles(h, [new h.w.File(['x'], 'd.png', { type: 'image/png' })]).defaultPrevented, true);
  await until(() => h.entry.element.querySelectorAll('.conversation-attachment').length === 1);
  dropFiles(h, [new h.w.File(['x'], 'notes.txt', { type: 'text/plain' }), new h.w.File(['x'], 'plan.md', { type: '' })]);
  await until(() => h.input.value.includes('@'));
  assert.equal(h.input.value, `[Image #1] @${NOTES} @"${SPACED}" `, 'several files, several references; a space is quoted');
  assert.doesNotMatch(h.entry.element.textContent, /Only images can be dropped/);
  assert.equal(h.entry.element.querySelectorAll('.conversation-attachment').length, 1);
  assert.equal(h.calls.send.length, 0, 'a reference is inserted, not sent');
});

test('references keep the order the files were dropped in, refused images included', async () => {
  const h = setup({ imageInput: { types: ['image/png'], maxBytes: 1024 }, diskPaths: { 'a.gif': GIF, 'notes.txt': NOTES } });
  dropFiles(h, [new h.w.File(['x'], 'a.gif', { type: 'image/gif' }), new h.w.File(['x'], 'notes.txt', { type: 'text/plain' })]);
  await until(() => h.input.value.includes('@'));
  assert.equal(h.input.value, `@${GIF} @${NOTES} `);
});

test('a mixed drop attaches the images and names the rest', async () => {
  const h = setup({ imageInput: { types: ['image/png'], maxBytes: 1024 }, diskPaths: { 'notes.txt': NOTES } });
  dropFiles(h, [new h.w.File(['x'], 'd.png', { type: 'image/png' }), new h.w.File(['x'], 'notes.txt', { type: 'text/plain' })]);
  await until(() => h.input.value.includes('@'));
  assert.equal(h.input.value, `[Image #1] @${NOTES} `);
  assert.equal(h.entry.element.querySelectorAll('.conversation-attachment').length, 1);
});

test('an image the session refuses is named instead when it has a path, and only refused when it has none', async () => {
  const h = setup({ imageInput: { types: ['image/png'], maxBytes: 1024 }, diskPaths: { 'a.gif': GIF } });
  dropFiles(h, [new h.w.File(['x'], 'a.gif', { type: 'image/gif' })]);
  await until(() => h.input.value.includes('@'));
  assert.equal(h.input.value, `@${GIF} `);
  assert.match(h.entry.element.textContent, /a\.gif was not attached: only PNG images can be sent here\. Its path was inserted instead\./);
  const none = setup({ diskPaths: { 'a.gif': GIF } });
  dropFiles(none, [new none.w.File(['x'], 'a.gif', { type: 'image/gif' })]);
  await until(() => none.input.value.includes('@'));
  assert.equal(none.input.value, `@${GIF} `, 'a session that takes no images still gets the name');
  assert.match(none.entry.element.textContent, /this session does not take images\. Its path was inserted instead\./);
});

test('a copied file is named even when the copy carries text; a picture beside text is still only text', async () => {
  const h = setup({ diskPaths: { 'notes.txt': NOTES } });
  const ev = pasteImages(h, [new h.w.File(['x'], 'notes.txt', { type: 'text/plain' })], 'notes.txt');
  assert.equal(ev.defaultPrevented, true, 'a file with a place on disk is a copy of files');
  await until(() => h.input.value.includes('@'));
  assert.equal(h.input.value, `@${NOTES} `);
  const cells = setup({ imageInput: { types: ['image/png'], maxBytes: 1024 } });
  const withText = pasteImages(cells, [new cells.w.File(['x'], 'cells.png', { type: 'image/png' })], 'a cell');
  assert.equal(withText.defaultPrevented, false, 'a rendered picture has no path, so the text pastes as usual');
});

test('a dropped file with no path on disk is refused by name', async () => {
  const h = setup();
  dropFiles(h, [new h.w.File(['x'], 'ghost.txt', { type: 'text/plain' })]);
  await until(() => /ghost\.txt/.test(h.entry.element.textContent));
  assert.match(h.entry.element.textContent, /ghost\.txt could not be named: it has no path on disk\./);
  assert.equal(h.input.value, '');
});

test('an image the session would refuse is refused before it is attached', async () => {
  const h = setup({ imageInput: { types: ['image/png'], maxBytes: 4 } });
  pasteImages(h, [new h.w.File(['x'], 'a.gif', { type: 'image/gif' })]);
  pasteImages(h, [new h.w.File(['too large'], 'big.png', { type: 'image/png' })]);
  await h.settle();
  assert.equal(h.entry.element.querySelectorAll('.conversation-attachment').length, 0);
  assert.match(h.entry.element.textContent, /a\.gif was not attached: only PNG images/);
  assert.match(h.entry.element.textContent, /big\.png was not attached: it is too large/);
  const none = setup();
  pasteImages(none, [new none.w.File(['x'], 'a.png', { type: 'image/png' })]);
  await none.settle();
  assert.match(none.entry.element.textContent, /does not take images/, 'a backend that declares none says so');
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

// #657: a snapshot read from a transcript file can hold an entry whose op is still on its way, and that op
// then arrives numbered past the snapshot. The key main stamps on it is what says it is a repeat — once.
test('an op for an entry the transcript snapshot already holds is skipped, once', async () => {
  let release;
  const h = setup({ attachAnswer: () => new Promise((r) => { release = r; }) });
  const attaching = h.entry.conversation.attach();
  const user = (text) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
  // The op arrives while the attach is still in flight, numbered past the snapshot it is already in.
  h.entry.conversation.apply({ op: 'append', entry: user('in the file'), key: 'k1', seq: 4 });
  release({ ok: true, entries: [user('in the file')], keys: ['k1'], seq: 3, busy: false, queue: { steering: [], followUp: [] }, asks: [] });
  await attaching;
  h.entry.conversation.apply({ op: 'append', entry: user('really new'), key: 'k2', seq: 5 });
  h.entry.conversation.apply({ op: 'append', entry: user('same key again'), key: 'k1', seq: 6 });
  const drawn = [...h.entry.element.querySelectorAll('.conversation-log > .jsonl-entry')].map(d => d.textContent);
  assert.equal(drawn.length, 3, 'the repeat was dropped, a new entry drawn, and a key is only skipped once');
  assert.match(drawn[0], /in the file/);
  assert.match(drawn[1], /really new/);
  assert.match(drawn[2], /same key again/);
});

// #647: a runtime can take a while to start reading, and main waits that out. Meanwhile the view says it is
// waiting rather than showing an empty conversation that looks finished — and the line goes once it answers.
test('while the attach is in flight the status says the view is waiting for the session', async () => {
  let release;
  const h = setup({ attachAnswer: () => new Promise((r) => { release = r; }) });
  const status = h.entry.element.querySelector('.conversation-status');
  const attaching = h.entry.conversation.attach();
  assert.match(status.textContent, /Waiting for the session/);
  release({ ok: true, entries: [], seq: 0, busy: false, queue: { steering: [], followUp: [] }, asks: [] });
  await attaching;
  assert.doesNotMatch(status.textContent, /Waiting for the session/);
});

// #648: a turn written from outside the composer that the runtime refused comes back as unsent — into an
// empty input so one press sends it, quoted in the notice when the user is already typing there.
test('a refused written turn goes back into an empty input, and is quoted when the input is in use', () => {
  const h = setup();
  h.entry.conversation.apply({ op: 'unsent', text: 'the seed', seq: 1 });
  assert.equal(h.input.value, 'the seed');
  assert.match(h.entry.element.textContent, /did not take this message\. It is back in the input/);
  h.input.value = 'my own draft';
  h.entry.conversation.apply({ op: 'unsent', text: 'second seed', seq: 2 });
  assert.equal(h.input.value, 'my own draft', 'what the user typed is theirs');
  assert.match(h.entry.element.textContent, /was not sent:\nsecond seed/);
});

// #707: each draw is handed the results for its own calls, from a running index, rather than a map rebuilt
// over the whole conversation for every entry drawn (which made loading one quadratic).
test('a call is drawn with its own result, live and after a reset, and sees no other call\'s', () => {
  const h = setup();
  const seen = [];
  vm.runInContext(`function renderJsonlEntry(entry, map) {
    __seen.push({ ids: (entry.message.content || []).map(b => b.id || b.tool_use_id), map: [...map.entries()] });
    const d = document.createElement('div'); d.className = 'jsonl-entry'; return d;
  }`, Object.assign(h.w, { __seen: seen }));
  const use = (id) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } });
  const result = (id, out) => ({ type: 'message', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] } });
  const conv = h.entry.conversation;
  conv.apply({ op: 'append', seq: 1, entry: use('c1') });
  conv.apply({ op: 'append', seq: 2, entry: use('c2') });
  conv.apply({ op: 'append', seq: 3, entry: result('c1', 'one') });
  assert.equal(JSON.stringify(seen.map(s => s.map)), JSON.stringify([[], [], [['c1', 'one']]]),
    'drawn without a result, then redrawn with its own when it arrives; c2 is not handed c1\'s');
  seen.length = 0;
  conv.apply({ op: 'reset', entries: [use('c1'), result('c1', 'one'), use('c2'), result('c2', 'two')] });
  assert.equal(JSON.stringify(seen.at(-1).map), JSON.stringify([['c2', 'two']]));
  assert.ok(seen.some(s => JSON.stringify(s.map) === JSON.stringify([['c1', 'one']])), 'c1 is redrawn with its result after the reset');
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
  conv.apply({ op: 'ask', seq: 4, request: { id: 'q1', kind: 'approval', tool: 'bash', toolCallId: 'c1', answers: { once: 'A1', session: 'A2', refuse: 'A3' }, note: 'the backend\'s own words about who asks' } });
  const card = h.entry.element.querySelector('.conversation-approval');
  assert.ok(card);
  assert.match(card.textContent, /rm -rf build/, 'the command is on the card');
  assert.match(card.textContent, /the backend's own words about who asks/, 'what the question is worth is the backend\'s sentence (#660)');
  assert.match(h.entry.element.querySelector('.conversation-status').textContent, /Waiting for your answer/);
  assert.match(h.entry.element.querySelector('.conversation-activity').textContent, /Waiting for your approval/);
  assert.equal(card.querySelectorAll('button')[1].textContent, 'Allow for this session', 'the plain words when the backend says nothing more');
  [...card.querySelectorAll('button')].find(b => b.textContent === 'Allow for this session').click();
  await h.settle();
  assert.equal(JSON.stringify(answers), JSON.stringify([['q1', { value: 'A2' }]]));   // built in the page's realm
  conv.apply({ op: 'answered', id: 'q1', seq: 5 });
  assert.equal(h.entry.element.querySelector('.conversation-approval'), null);
  assert.match(h.entry.element.querySelector('.conversation-status').textContent, /Working/);
});

// #661: the agent's own questions — one card for all of them, answered once, several choices joined.
test('a questions card answers every question at once, with several choices and a free answer', async () => {
  const h = setup();
  const answers = [];
  h.w.api.agent.answer = (id, req, a) => { answers.push([req, a]); return Promise.resolve({ ok: true }); };
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'u1', kind: 'questions', questions: [
    { question: 'Which toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese', description: 'Classic' }, { label: 'Ham', description: '' }] },
    { question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'Small', description: '' }, { label: 'Large', description: '' }] },
  ] } });
  const card = h.entry.element.querySelector('.conversation-questions');
  assert.ok(card);
  assert.equal(card.querySelectorAll('.conversation-question').length, 2);
  assert.equal(card.querySelectorAll('.conversation-question-desc').length, 1, 'a description is drawn once, where there is one');
  const [q1, q2] = card.querySelectorAll('.conversation-question');
  assert.equal(q1.querySelectorAll('input[type=checkbox]').length, 3, 'two options and "Type something", several allowed');
  assert.equal(q2.querySelectorAll('input[type=radio]').length, 3);
  // #704: one question at a time behind tabs, a review tab, and the options numbered as in the CLI.
  assert.deepEqual([...card.querySelectorAll('.conversation-question-tab')].map(t => t.textContent), ['☐ Toppings', '☐ Size', 'Submit']);
  assert.equal(q2.hidden, true, 'the second question waits behind its tab');
  assert.match(q1.querySelector('.conversation-question-label').textContent, /^1. Cheese$/);
  const submit = [...card.querySelectorAll('button')].find(b => b.textContent === 'Submit answers');
  assert.equal(submit.disabled, true, 'nothing answered yet');
  const tick = (box) => { box.checked = true; box.dispatchEvent(new h.w.Event('change', { bubbles: true })); };
  const [cheese, ham] = q1.querySelectorAll('input[type=checkbox]');
  tick(cheese);
  tick(ham);
  assert.equal(submit.disabled, true, 'the second question is still open');
  const other = q2.querySelector('.conversation-question-other');
  assert.equal(other.hidden, true, 'the free answer shows once it is chosen');
  tick(q2.querySelectorAll('input[type=radio]')[2]);
  assert.equal(other.hidden, false);
  other.value = 'Medium';
  other.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.equal(submit.disabled, false);
  submit.click();
  await h.settle();
  assert.equal(JSON.stringify(answers), JSON.stringify([['u1', { answers: { 'Which toppings?': 'Cheese, Ham', 'Which size?': 'Medium' }, notes: {} }]]));
  h.entry.conversation.apply({ op: 'answered', id: 'u1', seq: 2 });
  assert.equal(h.entry.element.querySelector('.conversation-questions'), null);
});

// #704: a card is answered from the keyboard — digits pick, Enter answers, Escape dismisses — and it takes the
// focus when it appears only if the input is empty.
test('a questions card takes the focus from an empty input and answers from the keyboard', async () => {
  const h = setup();
  const answers = [];
  h.w.api.agent.answer = (id, req, a) => { answers.push(a); return Promise.resolve({ ok: true }); };
  h.input.focus();
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'k1', kind: 'questions', questions: [
    { question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'Small', description: '' }, { label: 'Large', description: '' }] },
  ] } });
  const card = h.entry.element.querySelector('.conversation-questions');
  assert.ok(card.contains(h.w.document.activeElement), 'the card has the focus');
  const press = (key) => h.w.document.activeElement.dispatchEvent(new h.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press('2');
  assert.equal(card.querySelectorAll('input[type=radio]')[1].checked, true, 'the second option is picked');
  press('Enter');
  await h.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), [{ answers: { 'Which size?': 'Large' }, notes: {} }]);
});

// #704 P1: a card stands in the input's place. The input and what was typed in it are hidden, not lost, and
// come back when the last card closes; the focus goes to the card and back.
test('a card stands in the input\'s place and gives it back with its text when it closes', () => {
  const h = setup();
  h.input.focus();
  h.input.value = 'half a sentence';
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'k2', kind: 'plan', plan: '# P', answers: { approve: 'A', keep: 'K' } } });
  const dock = h.entry.element.querySelector('.conversation-ask-dock');
  assert.equal(dock.hidden, false);
  assert.ok(dock.querySelector('.conversation-plan'), 'the card is in the dock');
  assert.equal(h.input.hidden, true, 'the input is out of the way');
  assert.ok(dock.contains(h.w.document.activeElement), 'the focus went with it');
  const stop = [...h.entry.element.querySelectorAll('button')].find(b => b.textContent === 'Stop');
  assert.ok(stop, 'Stop is still there to end the turn');
  h.entry.conversation.apply({ op: 'answered', id: 'k2', seq: 2 });
  assert.equal(dock.hidden, true);
  assert.equal(h.input.hidden, false);
  assert.equal(h.input.value, 'half a sentence', 'what was typed is kept');
  assert.equal(h.w.document.activeElement, h.input, 'and the focus is back');
});

test('a view handed the focus gives it to the waiting card, not to the hidden input', () => {
  const h = setup();
  const elsewhere = h.w.document.createElement('input');
  h.w.document.body.appendChild(elsewhere);
  elsewhere.focus();
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'f1', kind: 'approval', tool: 'Bash', answers: { once: 'A', refuse: 'R' } } });
  assert.equal(h.w.document.activeElement, elsewhere, 'it arrived while the user was elsewhere');
  h.entry.conversation.focus();
  assert.ok(h.entry.element.querySelector('.conversation-ask-dock').contains(h.w.document.activeElement), 'switching to the view lands on the card');
});

test('two cards wait one after the other in the dock', () => {
  const h = setup();
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'm1', kind: 'approval', tool: 'Bash', answers: { once: 'A', refuse: 'R' } } });
  h.entry.conversation.apply({ op: 'ask', seq: 2, request: { id: 'm2', kind: 'approval', tool: 'Write', answers: { once: 'A', refuse: 'R' } } });
  const cards = [...h.entry.element.querySelectorAll('.conversation-ask-dock .conversation-ask')];
  assert.deepEqual(cards.map(c => c.hidden), [false, true], 'the first is shown, the second waits');
  assert.match(h.entry.element.querySelector('.conversation-ask-more').textContent, /1 of 2/);
  h.entry.conversation.apply({ op: 'answered', id: 'm1', seq: 3 });
  assert.equal(cards[1].hidden, false, 'the next follows');
  assert.equal(h.entry.element.querySelector('.conversation-ask-more'), null);
});

test('Escape on a card declines it and never stops the turn; a digit presses the n-th button', async () => {
  const h = setup();
  const sent = [];
  h.w.api.agent.answer = (id, rid, payload) => { sent.push(payload); return Promise.resolve({ ok: true }); };
  h.input.focus();
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'e1', kind: 'approval', tool: 'Bash', answers: { once: 'A', refuse: 'R' } } });
  const press = (key) => h.w.document.activeElement.dispatchEvent(new h.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press('Escape');
  await h.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ value: 'R' }]);
  assert.equal(h.calls.abort, 0, 'Escape in a card is not Stop');
  h.entry.conversation.apply({ op: 'answered', id: 'e1', seq: 2 });
  h.entry.conversation.apply({ op: 'ask', seq: 3, request: { id: 'e2', kind: 'approval', tool: 'Bash', answers: { once: 'A', refuse: 'R' } } });
  press('1');
  await h.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1])), { value: 'A' });
});

// #704: "Chat about this" is the card's last row, as in the CLI — the question is declined with what the user
// writes there, and nothing becomes a turn.
test('"chat about this" in the card declines the question with the text, and a send past the card goes nowhere', async () => {
  const h = setup();
  const answers = [];
  h.w.api.agent.answer = (id, req, a) => { answers.push(a); return Promise.resolve({ ok: true }); };
  h.input.focus();
  h.input.value = 'kept for later';
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'c1', kind: 'questions', questions: [
    { question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'Small', description: '' }] },
  ] } });
  const card = h.entry.element.querySelector('.conversation-questions');
  h.w.document.activeElement.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }));
  const box = card.querySelector('.conversation-question-chat-input');
  assert.equal(box.hidden, false, 'c opens the field');
  assert.equal(h.w.document.activeElement, box);
  box.value = 'Neither, explain the sizes first';
  box.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await h.settle();
  assert.equal(h.calls.send.length, 0, 'no turn was sent');
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), [{ answers: { 'Which size?': '' }, notes: {}, chat: 'Neither, explain the sizes first' }]);
  assert.equal(h.input.value, 'kept for later', 'the input was not touched');
});

// #704 D1–D4: an option's text graphic is shown beside the list for the option in focus, a note button opens
// the note under its option and picks it, and Tab moves between the questions.
test('a question card shows the preview of the option in focus, opens a note from its button, and tabs between questions', async () => {
  const h = setup();
  const answers = [];
  h.w.api.agent.answer = (id, req, a) => { answers.push(a); return Promise.resolve({ ok: true }); };
  h.input.focus();
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'd1', kind: 'questions', questions: [
    { question: 'Route?', header: 'Route', multiSelect: false, options: [{ label: 'Stream', description: '', preview: 'a --> b' }, { label: 'Whole', description: '', preview: 'x ==> y' }] },
    { question: 'Log?', header: 'Log', multiSelect: false, options: [{ label: 'File', description: '' }] },
  ] } });
  const card = h.entry.element.querySelector('.conversation-questions');
  const [q1, q2] = card.querySelectorAll('.conversation-question');
  const pre = q1.querySelector('.conversation-question-preview');
  assert.equal(pre.textContent, 'a --> b', 'the first option\'s graphic to begin with');
  const radios = q1.querySelectorAll('input[type=radio]');
  radios[1].dispatchEvent(new h.w.Event('focus'));
  assert.equal(pre.textContent, 'x ==> y', 'it follows the focus');
  assert.equal(q2.querySelector('.conversation-question-preview'), null, 'no box where no option has a graphic');
  // The note button on the second option picks it and opens the note field under it.
  q1.querySelectorAll('.conversation-question-note-btn')[1].click();
  assert.equal(radios[1].checked, true);
  const note = q1.querySelector('.conversation-question-note');
  assert.equal(note.hidden, false);
  assert.equal(note.previousElementSibling, radios[1].closest('.conversation-question-option'), 'under its option');
  note.value = 'keep the log';
  // Tab from an option moves to the next question.
  radios[1].focus();
  radios[1].dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(q1.hidden, true);
  assert.equal(q2.hidden, false);
  const file = q2.querySelector('input[type=radio]');
  file.focus();
  file.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(file.checked, true, 'Enter picks');
  assert.equal(card.querySelector('.conversation-question-review').hidden, false, 'and moves on to the review');
  [...card.querySelectorAll('button')].find(b => b.textContent === 'Submit answers').click();
  await h.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), [{ answers: { 'Route?': 'Whole', 'Log?': 'File' }, notes: { 'Route?': 'keep the log' } }]);
});

test('a card does not take the focus from a field outside the view (V1), and Escape on a plan card does nothing (V2)', async () => {
  const h = setup();
  const sent = [];
  h.w.api.agent.answer = (id, rid, payload) => { sent.push(payload); return Promise.resolve({ ok: true }); };
  const elsewhere = h.w.document.createElement('input');
  h.w.document.body.appendChild(elsewhere);
  elsewhere.focus();
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'v1', kind: 'approval', tool: 'Bash', answers: { once: 'A', refuse: 'R' } } });
  assert.equal(h.w.document.activeElement, elsewhere, 'the typing elsewhere keeps its caret');
  h.entry.conversation.apply({ op: 'answered', id: 'v1', seq: 2 });
  h.input.focus();
  h.entry.conversation.apply({ op: 'ask', seq: 3, request: { id: 'v2', kind: 'plan', plan: '# P', answers: { approve: 'P-OK', keep: 'P-KEEP' } } });
  h.w.document.activeElement.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await h.settle();
  assert.deepEqual(sent, [], 'Escape keeps nothing and approves nothing');
  assert.equal(h.calls.abort, 0);
});

test('"chat about this" keeps its text when the decline is refused, and goes out once', async () => {
  const h = setup();
  const answers = [];
  let settle;
  h.w.api.agent.answer = (id, req, a) => { answers.push(a); return new Promise((r) => { settle = r; }); };
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'c2', kind: 'questions', questions: [
    { question: 'Q?', header: 'Q', multiSelect: false, options: [{ label: 'a', description: '' }] },
  ] } });
  const card = h.entry.element.querySelector('.conversation-questions');
  card.querySelector('.conversation-question-chat .task-notice-output').click();
  const box = card.querySelector('.conversation-question-chat-input');
  box.value = 'why?';
  const enter = () => box.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  enter();
  enter();
  assert.equal(answers.length, 1, 'a second Enter while the first is out sends nothing');
  settle({ ok: false, error: 'gone' });
  await h.settle();
  assert.equal(box.value, 'why?', 'a refused decline leaves the text where it was');
});

// #674: the lasting allow names what it allows, its tooltip says where it lands, and it sits before Refuse.
test('an approval\'s project button names the rule, carries its note, and answers with its value', async () => {
  const h = setup();
  const sent = [];
  h.w.api.agent.answer = (id, rid, payload) => { sent.push(payload); return Promise.resolve({ ok: true }); };
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'p1', kind: 'approval', tool: 'Bash',
    answers: { once: 'A', session: 'S', project: 'P', refuse: 'R' }, sessionLabel: 'Allow all edits for this session',
    projectLabel: 'Always allow “mkdir -p x” in this project', projectNote: 'Written to .claude/settings.local.json.' } });
  const buttons = [...h.entry.element.querySelectorAll('.conversation-approval button')];
  assert.deepEqual(buttons.map(b => b.textContent),
    ['Allow once', 'Allow all edits for this session', 'Always allow “mkdir -p x” in this project', 'Refuse']);
  const project = buttons[2];
  assert.equal(project.title, 'Written to .claude/settings.local.json.');
  project.click();
  await h.settle();
  assert.equal(sent[0].value, 'P');
});

test('an approval\'s session button says what it allows, and a refused answer re-checks the questions card', async () => {
  const h = setup();
  h.w.api.agent.answer = () => Promise.resolve({ ok: false, error: 'gone' });
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 's1', kind: 'approval', tool: 'Write', answers: { once: 'A', session: 'S', refuse: 'R' }, sessionLabel: 'Allow all edits for this session' } });
  assert.ok([...h.entry.element.querySelectorAll('.conversation-approval button')].some(b => b.textContent === 'Allow all edits for this session'));
  h.entry.conversation.apply({ op: 'ask', seq: 2, request: { id: 'u2', kind: 'questions', questions: [
    { question: 'A?', header: '', multiSelect: false, options: [{ label: 'x', description: '' }] },
    { question: 'B?', header: '', multiSelect: false, options: [{ label: 'y', description: '' }] },
  ] } });
  const card = h.entry.element.querySelector('.conversation-questions');
  const submit = [...card.querySelectorAll('button')].find(b => b.textContent === 'Submit answers');
  [...card.querySelectorAll('button')].find(b => b.textContent === 'Dismiss').click();
  await h.settle();
  assert.equal(submit.disabled, true, 'after a refused send, Answer still waits for every question');
});

test('a plan card draws the plan and answers approve or keep planning', async () => {
  const h = setup();
  const answers = [];
  h.w.api.agent.answer = (id, req, a) => { answers.push([req, a]); return Promise.resolve({ ok: true }); };
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'p1', kind: 'plan', plan: '# Plan\n\n1. Create hello.txt', answers: { approve: 'P-OK', keep: 'P-KEEP' } } });
  const card = h.entry.element.querySelector('.conversation-plan');
  assert.ok(card);
  assert.match(card.querySelector('.conversation-plan-body').textContent, /Create hello\.txt/);
  assert.deepEqual([...card.querySelectorAll('button')].map(b => b.textContent), ['Approve', 'Keep planning']);
  [...card.querySelectorAll('button')].find(b => b.textContent === 'Keep planning').click();
  await h.settle();
  assert.equal(JSON.stringify(answers), JSON.stringify([['p1', { value: 'P-KEEP' }]]));
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

// #648 with the verifier's ordering: a refusal that reaches the view while an attach is in flight, numbered
// below the snapshot, must still come back — no snapshot ever holds it.
test('an unsent hand-back held during an attach is applied whatever its number', async () => {
  let release;
  const h = setup({ attachAnswer: () => new Promise((r) => { release = r; }) });
  const attaching = h.entry.conversation.attach();
  h.entry.conversation.apply({ op: 'unsent', text: 'early seed', seq: 3 });
  release({ ok: true, entries: [], seq: 7, busy: false, queue: { steering: [], followUp: [] }, asks: [] });
  await attaching;
  assert.equal(h.input.value, 'early seed');
});

// #654 — a reset re-draws the entries; a notice from before it must not end up above the re-read
// conversation, and a question still open stays open, below it.
test('a reset drops earlier notices and keeps an open question below the conversation', () => {
  const h = setup();
  const conv = h.entry.conversation;
  const entry = (text) => ({ type: 'user', message: { role: 'user', content: text } });
  conv.apply({ op: 'append', entry: entry('before'), seq: 1 });
  conv.apply({ op: 'notice', level: 'info', text: 'an old notice', seq: 2 });
  conv.apply({ op: 'ask', request: { id: 'q1', method: 'confirm', title: 'Still open?' }, seq: 3 });
  conv.apply({ op: 'reset', entries: [entry('one'), entry('two')], seq: 4 });
  conv.apply({ op: 'notice', level: 'info', text: 'about the reset', seq: 5 });
  const log = h.entry.element.querySelector('.conversation-log');
  const kids = [...log.children].filter(el => el.textContent.trim());
  const text = kids.map(el => el.textContent);
  assert.ok(!text.some(t => t.includes('an old notice')), 'the notice from before the reset is gone');
  assert.ok(text[0].includes('one') && text[1].includes('two'), 'the conversation comes first');
  // Since #704 P1 an open question waits in the dock, in the input's place, and a reset leaves it there.
  assert.equal(kids.findIndex(el => el.classList.contains('conversation-ask')), -1, 'not in the log');
  assert.ok(h.entry.element.querySelector('.conversation-ask-dock .conversation-ask'), 'still open, in the dock');
  assert.ok(text.some(t => t.includes('about the reset')), 'a notice after the reset is drawn');
});

// #666 — a session with no terminal takes its attention caption down where the user acts in the view, the
// way a keystroke does through `sendSessionInput`, and keeps it while a question is still open.
const cleared = (h) => vm.runInContext('captionCleared.length', h.w);

test('the last open question closing takes the attention caption down; one still open keeps it', () => {
  const h = setup();
  const conv = h.entry.conversation;
  conv.apply({ op: 'ask', seq: 1, request: { id: 'a1', kind: 'approval', tool: 'bash', answers: { once: 'A', refuse: 'R' } } });
  conv.apply({ op: 'ask', seq: 2, request: { id: 'u1', kind: 'questions', questions: [{ question: 'Q?', header: '', multiSelect: false, options: [{ label: 'x', description: '' }] }] } });
  conv.apply({ op: 'answered', id: 'a1', seq: 3 });
  assert.equal(cleared(h), 0, 'the questions card is still open, so the caption is still true');
  conv.apply({ op: 'answered', id: 'u1', seq: 4 });
  assert.equal(cleared(h), 1);
  assert.equal(vm.runInContext('captionCleared[0]', h.w), 's1', 'for this session');
});

test('a turn sent takes the caption down; a failed send and a send beside an open question do not', async () => {
  const h = setup();
  h.input.value = 'nope';
  h.key({ key: 'Enter' });
  h.answerSend({ ok: false, error: 'The session is not running.' });
  await h.settle();
  assert.equal(cleared(h), 0, 'nothing reached the session');
  h.input.value = 'go on';
  h.key({ key: 'Enter' });
  h.answerSend({ ok: true });
  await h.settle();
  assert.equal(cleared(h), 1);
  h.entry.conversation.apply({ op: 'ask', seq: 1, request: { id: 'p1', kind: 'plan', plan: 'x', answers: { approve: 'OK', keep: 'KEEP' } } });
  h.input.value = 'and this';
  h.key({ key: 'Enter' });
  h.answerSend({ ok: true });
  await h.settle();
  assert.equal(cleared(h), 1, 'the plan still waits on the user');
});

test('Stop takes the caption down, and with an approval open it waits for that approval to be dropped', async () => {
  const h = setup();
  const conv = h.entry.conversation;
  conv.apply({ op: 'busy', busy: true, seq: 1 });
  h.key({ key: 'Escape' });
  await h.settle();
  assert.equal(cleared(h), 1, 'a Stop with nothing open is the user acting');
  conv.apply({ op: 'ask', seq: 2, request: { id: 'a1', kind: 'approval', tool: 'bash', answers: { once: 'A', refuse: 'R' } } });
  h.key({ key: 'Escape' });
  await h.settle();
  assert.equal(h.calls.abort, 2);
  assert.equal(cleared(h), 1, 'the approval is still on screen');
  // What main sends when the stopped run settles and takes its questions with it.
  conv.apply({ op: 'answered', id: 'a1', seq: 3 });
  assert.equal(cleared(h), 2);
});

test('a questions or a plan card holds its call: the activity line waits, it does not say running', () => {
  const h = setup();
  const conv = h.entry.conversation;
  const activity = () => h.entry.element.querySelector('.conversation-activity').textContent;
  conv.apply({ op: 'busy', busy: true, seq: 1 });
  conv.apply({ op: 'tool', id: 't1', status: 'running', output: '', seq: 2 });
  assert.match(activity(), /Running/);
  conv.apply({ op: 'ask', seq: 3, request: { id: 'u1', kind: 'questions', toolCallId: 't1', questions: [{ question: 'Q?', header: '', multiSelect: false, options: [{ label: 'x', description: '' }] }] } });
  assert.match(activity(), /Waiting for your answer/);
  assert.doesNotMatch(activity(), /Running/);
  conv.apply({ op: 'answered', id: 'u1', seq: 4 });
  assert.match(activity(), /Running/, 'answered, the call runs on');
  conv.apply({ op: 'tool', id: 't2', status: 'running', output: '', seq: 5 });
  conv.apply({ op: 'ask', seq: 6, request: { id: 'p1', kind: 'plan', toolCallId: 't2', plan: 'x', answers: { approve: 'OK', keep: 'KEEP' } } });
  assert.match(activity(), /Waiting for you to review the plan/);
});

// #691: the session line and the background buttons, from the ops the core sends.
test('the context and the model show on the session line; background tasks become buttons that open the list', () => {
  const h = setup();
  const conv = h.entry.conversation;
  conv.apply({ op: 'context', context: { percent: 34, tokens: 68000, window: 200000, model: 'Opus 5.5' } });
  const status = h.entry.element.querySelector('.conversation-status');
  assert.match(status.textContent, /ctx 34 %/);
  assert.match(status.textContent, /Opus 5\.5 \(200k\)/);
  assert.equal(status.querySelectorAll('.conversation-bg-chip').length, 0, 'no buttons while nothing runs');
  conv.apply({ op: 'tasks', tasks: [
    { id: 't1', kind: 'shell', description: 'Dev server', detail: 'npm run dev' },
    { id: 't2', kind: 'shell', description: 'Watcher' },
    { id: 'a1', kind: 'agent', description: 'Review' },
  ] });
  const chips = [...status.querySelectorAll('.conversation-bg-chip')].map(c => c.textContent);
  assert.deepEqual(chips, ['2 shells', '1 agent']);
  status.querySelector('.conversation-bg-chip').click();
  const pop = h.entry.element.querySelector('.conversation-bg-pop');
  assert.equal(pop.hidden, false);
  const rows = [...pop.querySelectorAll('.conversation-bg-row')].map(r => r.querySelector('.conversation-bg-text').textContent);
  assert.deepEqual(rows, ['Dev servernpm run dev', 'Watcher', 'Review']);
  const buttons = [...pop.querySelectorAll('.conversation-bg-row')].map(r => [...r.querySelectorAll('button')].map(b => b.textContent).join('/'));
  assert.deepEqual(buttons, ['Output/Stop', 'Output/Stop', 'Open/Stop']);
  conv.apply({ op: 'tasks', tasks: [] });
  assert.equal(pop.hidden, true, 'the list closes once nothing runs');
});

test('Stop in the Background list stops that one task', async () => {
  const h = setup();
  const stopped = [];
  h.w.api.agent.stopTask = (id, taskId) => { stopped.push([id, taskId]); return Promise.resolve({ ok: true }); };
  h.entry.conversation.apply({ op: 'tasks', tasks: [{ id: 't1', kind: 'shell', description: 'Dev server' }] });
  h.entry.element.querySelector('.conversation-bg-chip').click();
  h.entry.element.querySelector('.conversation-bg-stop').click();
  await h.settle();
  assert.deepEqual(stopped, [['s1', 't1']]);
});

// #693: a suggested next prompt, offered in the empty input and taken with Tab.
test('a suggestion shows in the empty input; Tab takes it, typing drops it, a turn starting drops it', () => {
  const h = setup();
  const conv = h.entry.conversation;
  conv.apply({ op: 'suggestion', text: 'write the script' });
  assert.match(h.input.placeholder, /write the script/);
  assert.ok(h.input.classList.contains('has-suggestion'));
  const tab = new h.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  h.input.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(h.input.value, 'write the script');
  assert.ok(!h.input.classList.contains('has-suggestion'));
  h.input.value = '';
  conv.apply({ op: 'suggestion', text: 'next' });
  h.input.value = 'x';
  h.input.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  h.input.value = '';
  h.input.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.doesNotMatch(h.input.placeholder, /next/, 'typing threw it away for good');
  conv.apply({ op: 'suggestion', text: 'again' });
  conv.apply({ op: 'busy', busy: true });
  assert.doesNotMatch(h.input.placeholder, /again/);
  const plainTab = new h.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  h.input.dispatchEvent(plainTab);
  assert.equal(plainTab.defaultPrevented, false, 'without a suggestion Tab is left alone');
});

// #694: a sent message is on screen at once, and the played-back entry takes its place.
test('a sent message shows at once as pending and goes when the runtime plays it back; a refusal takes it away', async () => {
  const h = setup();
  const pending = () => [...h.entry.element.querySelectorAll('.conversation-pending')].map(e => e.textContent);
  h.input.value = 'hello there';
  h.key({ key: 'Enter' });
  assert.equal(pending().length, 1, 'shown before the send is answered');
  assert.match(pending()[0], /sending/);
  h.answerSend({ ok: true });
  await h.settle();
  assert.equal(pending().length, 1, 'still waiting for its turn');
  h.entry.conversation.apply({ op: 'append', entry: { type: 'user', message: { role: 'user', content: 'hello there' } } });
  assert.equal(pending().length, 0, 'the played-back line replaced it');
  h.entry.conversation.apply({ op: 'busy', busy: true });
  h.input.value = 'while it runs';
  h.key({ key: 'Enter' });
  assert.match(pending()[0], /queued/);
  h.answerSend({ ok: false, error: 'refused' });
  await h.settle();
  assert.equal(pending().length, 0, 'a refused line leaves no bubble');
  h.input.value = '!ls';
  h.key({ key: 'Enter' });
  assert.equal(pending().length, 0, 'a shell line is not a turn and gets no bubble');
});

test('a slash command played back with its output settles its bubble; a reset drops what is pending (#694)', async () => {
  const h = setup();
  const pending = () => h.entry.element.querySelectorAll('.conversation-pending').length;
  h.input.value = '/cost';
  h.key({ key: 'Enter' });
  h.answerSend({ ok: true });
  await h.settle();
  assert.equal(pending(), 1);
  h.entry.conversation.apply({ op: 'append', entry: { type: 'user', message: { role: 'user', content: '/cost\nTotal cost: $0.01' } } });
  assert.equal(pending(), 0, 'the command came back with its output after it');
  h.input.value = 'lost in a switch';
  h.key({ key: 'Enter' });
  h.answerSend({ ok: true });
  await h.settle();
  h.entry.conversation.apply({ op: 'reset', entries: [] });
  assert.equal(pending(), 0);
});
