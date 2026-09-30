'use strict';
// src/renderer/session/servers-dialog.js (#728) — `/mcp` in a session with no terminal opens the session's MCP
// servers as a manager: a grouped list, a server's details, its actions as a numbered menu, by mouse and by key.
// Loaded into a jsdom window the way the page loads it: control-dialogs.js (its focus trap and ids), the dialog,
// then the conversation view, each a classic script on the shared scope. What is pinned is what the user can
// do and what reaches main.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', ...p), 'utf8');
const SOURCES = [read('dialogs', 'control-dialogs.js'), read('session', 'servers-dialog.js'), read('session', 'conversation-view.js')];

const disable = (name) => ({ id: 'disable', label: 'Disable', confirm: `Disable ${name}? Stored for the whole project.` });
const ROWS = [
  { name: 'claude.ai Docs', group: 'claude.ai', groupOrder: 6, state: 'connected', tone: 'ok', tools: 2, needsSignIn: false,
    toolList: [{ name: 'read', readOnly: true, destructive: false }, { name: 'delete', readOnly: false, destructive: true }],
    error: '', actions: [{ id: 'tools', label: 'View tools' }, { id: 'reconnect', label: 'Reconnect' }, disable('claude.ai Docs')] },
  { name: 'alpha', group: 'User MCPs', groupOrder: 2, state: 'connected', tone: 'ok', tools: 1, needsSignIn: false,
    toolList: [{ name: 'echo', readOnly: true, destructive: false }], error: '',
    actions: [{ id: 'tools', label: 'View tools' }, { id: 'reconnect', label: 'Reconnect' }, disable('alpha')] },
  { name: 'broken', group: 'User MCPs', groupOrder: 2, state: 'failed', tone: 'failed', tools: null, needsSignIn: false,
    toolList: [], error: 'Connection closed', actions: [{ id: 'reconnect', label: 'Reconnect' }, disable('broken')] },
  { name: 'remote', group: 'User MCPs', groupOrder: 2, state: 'needs sign-in', tone: 'waiting', tools: null, needsSignIn: true,
    toolList: [], error: '', actions: [{ id: 'authenticate', label: 'Authenticate' }, disable('remote')] },
];

function setup(t, { act, load } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="terminals"></div></body>');
  const w = dom.window;
  const calls = [];
  const opened = [];
  let rows = JSON.parse(JSON.stringify(ROWS));
  w.api = {
    onAgentEvent() {},
    openExternal: (url) => { opened.push(url); return Promise.resolve(); },
    agent: {
      send: () => Promise.resolve({ ok: true }),
      abort: () => Promise.resolve({ ok: true }),
      attach: () => Promise.resolve({ ok: true, entries: [], seq: 0 }),
      answer: () => Promise.resolve({ ok: true }),
      servers: () => (load ? load(rows) : Promise.resolve({ ok: true, list: { title: 'MCP servers', rows } })),
      serverAction: (id, name, action, extra) => {
        calls.push({ id, name, action, extra });
        return act ? act(name, action, rows, (next) => { rows = next; }) : Promise.resolve({ ok: true, error: '' });
      },
    },
  };
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
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  const dialog = () => w.document.querySelector('.servers-dialog');
  const key = (k) => w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const texts = (sel) => [...w.document.querySelectorAll(sel)].map(e => e.textContent);
  const open = () => entry.conversation.apply({ op: 'servers', list: { title: 'MCP servers', rows }, seq: 1 });
  // A dialog left open keeps its poll running, and that would hold the test file open; closed whatever happened.
  t.after(() => { const c = w.document.querySelector('.servers-dialog .control-dialog-cancel'); if (c) click(c); });
  return { w, entry, calls, opened, settle, dialog, key, click, texts, open, setRows: (r) => { rows = r; } };
}

test('/mcp opens a list grouped the way the CLI groups it, with the count of what is connected', (t) => {
  const h = setup(t);
  h.open();
  assert.ok(h.dialog(), 'the dialog is open');
  assert.deepEqual(h.texts('.servers-group'), ['User MCPs', 'claude.ai'], 'groups in the backend\'s order, not the arrival order');
  assert.deepEqual(h.texts('.servers-row .servers-name'), ['alpha', 'broken', 'remote', 'claude.ai Docs']);
  assert.match(h.dialog().textContent, /2 of 4 connected/);
  const alpha = h.w.document.querySelector('.servers-row[data-name="alpha"]');
  assert.ok(alpha.classList.contains('selected'), 'the first server is selected');
  assert.match(alpha.textContent, /1 tool/);
  assert.match(h.w.document.querySelector('.servers-row[data-name="remote"]').textContent, /needs sign-in/);
});

test('the keyboard walks the list, opens a server, runs an action by number, and Esc goes back then closes', async (t) => {
  const h = setup(t);
  h.open();
  h.key('ArrowDown');
  assert.ok(h.w.document.querySelector('.servers-row[data-name="broken"]').classList.contains('selected'));
  h.key('Enter');
  assert.match(h.dialog().textContent, /Connection closed/, 'a failed server\'s error is in its details');
  assert.deepEqual(h.texts('.servers-action'), ['1. Reconnect', '2. Disable']);
  assert.doesNotMatch(h.dialog().textContent, /node|server\.js|Command/, 'no command line in the details (O2)');
  h.key('1');
  await h.settle();
  assert.deepEqual(h.calls.map(c => [c.id, c.name, c.action]), [['s1', 'broken', 'reconnect']]);
  assert.match(h.dialog().textContent, /Reconnect: done/);
  h.key('Escape');
  assert.ok(h.w.document.querySelector('.servers-list'), 'Esc on the details goes back to the list');
  h.key('Escape');
  assert.equal(h.dialog(), null, 'Esc on the list closes the dialog');
});

test('Disable asks first, and Cancel is what Enter picks until the user moves', async (t) => {
  const h = setup(t);
  h.open();
  h.click(h.w.document.querySelector('.servers-row[data-name="alpha"]'));
  h.click([...h.w.document.querySelectorAll('.servers-action')].find(e => /Disable/.test(e.textContent)));
  assert.match(h.dialog().textContent, /Stored for the whole project/, 'the backend\'s warning is shown');
  h.key('Enter');
  await h.settle();
  assert.deepEqual(h.calls, [], 'Enter on the default choice cancels');
  h.click([...h.w.document.querySelectorAll('.servers-action')].find(e => /Disable/.test(e.textContent)));
  h.key('ArrowUp');
  h.key('Enter');
  await h.settle();
  assert.deepEqual(h.calls.map(c => [c.name, c.action]), [['alpha', 'disable']]);
});

test('View tools lists the names and hints the list holds, and sends nothing', (t) => {
  const h = setup(t);
  h.open();
  h.click(h.w.document.querySelector('.servers-row[data-name="claude.ai Docs"]'));
  h.key('Enter');
  assert.deepEqual(h.texts('.servers-tools .servers-name'), ['read', 'delete']);
  assert.match(h.dialog().textContent, /destructive/);
  assert.deepEqual(h.calls, []);
  h.key('Escape');
  assert.deepEqual(h.texts('.servers-action'), ['1. View tools', '2. Reconnect', '3. Disable']);
});

test('Authenticate opens the sign-in page, follows the sign-in, and reconnects once it arrives (O3)', async (t) => {
  const h = setup(t, {
    act: (name, action, rows, set) => {
      if (action === 'authenticate') return Promise.resolve({ ok: true, error: '', authUrl: 'https://auth.example.invalid/authorize?x=1' });
      if (action === 'reconnect') {
        set(rows.map(r => (r.name === name ? { ...r, state: 'connected', tone: 'ok', tools: 3, needsSignIn: false } : r)));
      }
      return Promise.resolve({ ok: true, error: '' });
    },
  });
  h.open();
  h.click(h.w.document.querySelector('.servers-row[data-name="remote"]'));
  h.key('Enter');
  await h.settle();
  assert.deepEqual(h.opened, ['https://auth.example.invalid/authorize?x=1']);
  assert.match(h.dialog().textContent, /Finish signing in to remote in your browser/);
  assert.ok(h.texts('.servers-action').some(t => /Paste the redirect address/.test(t)), 'a redirect can be pasted while it waits');
  // The token arrives: the server no longer needs a sign-in but is not up yet, so the dialog reconnects it.
  h.setRows(JSON.parse(JSON.stringify(ROWS)).map(r => (r.name === 'remote' ? { ...r, state: 'failed', tone: 'failed', needsSignIn: false, actions: [{ id: 'reconnect', label: 'Reconnect' }] } : r)));
  await new Promise((r) => setTimeout(r, 2100));
  await h.settle();
  assert.deepEqual(h.calls.map(c => c.action), ['authenticate', 'reconnect']);
  assert.match(h.dialog().textContent, /Signed in to remote/);
  h.key('Escape'); h.key('Escape');
});

test('a pasted redirect goes to main as the callback of that server', async (t) => {
  const h = setup(t, { act: (name, action) => Promise.resolve(action === 'authenticate' ? { ok: true, authUrl: 'https://auth.example.invalid/a' } : { ok: true }) });
  h.open();
  h.click(h.w.document.querySelector('.servers-row[data-name="remote"]'));
  h.key('Enter');
  await h.settle();
  h.click([...h.w.document.querySelectorAll('.servers-action')].find(e => /Paste/.test(e.textContent)));
  const input = h.w.document.querySelector('.servers-input');
  assert.equal(h.w.document.activeElement, input);
  input.value = 'http://localhost:1234/callback?code=abc&state=s';
  input.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await h.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1])), { id: 's1', name: 'remote', action: 'callback', extra: { callbackUrl: 'http://localhost:1234/callback?code=abc&state=s' } });
});

test('a refused action shows the reason the session gave', async (t) => {
  const h = setup(t, { act: () => Promise.resolve({ ok: false, error: 'Server not found: broken' }) });
  h.open();
  h.click(h.w.document.querySelector('.servers-row[data-name="broken"]'));
  h.key('Enter');
  await h.settle();
  assert.match(h.w.document.querySelector('.servers-message').textContent, /Server not found: broken/);
  assert.ok(h.w.document.querySelector('.servers-message').classList.contains('servers-message-failed'));
  h.click(h.w.document.querySelector('.control-dialog-cancel'));
  assert.equal(h.dialog(), null);
});

test('a poll during a sign-in keeps what the user is pasting (#728 verifier finding)', async (t) => {
  const h = setup(t, { act: (name, action) => Promise.resolve(action === 'authenticate' ? { ok: true, authUrl: 'https://auth.example.invalid/a' } : { ok: true }) });
  h.open();
  h.click(h.w.document.querySelector('.servers-row[data-name="remote"]'));
  h.key('Enter');
  await h.settle();
  h.click([...h.w.document.querySelectorAll('.servers-action')].find(e => /Paste/.test(e.textContent)));
  const input = h.w.document.querySelector('.servers-input');
  input.value = 'http://localhost:1234/callback?code=half';
  await new Promise((r) => setTimeout(r, 2200));
  await h.settle();
  assert.equal(h.w.document.querySelector('.servers-input'), input, 'the same field, not a rebuilt one');
  assert.equal(input.value, 'http://localhost:1234/callback?code=half');
});

test('a number with Ctrl, Alt or Meta held is an app shortcut, not a menu pick', async (t) => {
  const h = setup(t);
  h.open();
  h.click(h.w.document.querySelector('.servers-row[data-name="alpha"]'));
  for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
    h.w.document.activeElement.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: '2', [mod]: true, bubbles: true }));
  }
  await h.settle();
  assert.deepEqual(h.calls, []);
  h.key('2');
  await h.settle();
  assert.deepEqual(h.calls.map(c => c.action), ['reconnect']);
});

test('Tab stays inside the dialog, from the list through the buttons and back', (t) => {
  const h = setup(t);
  h.open();
  const tab = (shift) => h.w.document.activeElement.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true }));
  const list = h.w.document.querySelector('.servers-list');
  assert.equal(h.w.document.activeElement, list);
  tab(true);
  assert.ok(h.dialog().contains(h.w.document.activeElement), 'Shift+Tab from the list stays in the dialog');
  assert.equal(h.w.document.activeElement.textContent, 'Close', 'the hidden Back button is skipped');
  tab();
  assert.equal(h.w.document.activeElement, list);
});
