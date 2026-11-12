'use strict';
// #858: the session sidebar's Repository group follows the VCS poller while it is open, and the poller watches what
// it follows. Renderer half in jsdom with the real session-sidebar.js; main half against the real vcs.js with a fake
// ipc; the preload binding is run against a fake electron.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { stripComments } = require('./helpers/strip-comments');
const { setupSessionSidebar, closeSessionSidebarWindows } = require('./helpers/session-sidebar-dom');

after(closeSessionSidebarWindows);
const flush = () => new Promise((r) => setTimeout(r, 0));
const src = (rel) => stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));

function mount() {
  const h = setupSessionSidebar();
  const listeners = [];
  const follows = [];
  const described = [];
  h.w.api.vcsDescribe = (cwd, opts) => {
    described.push(cwd);
    return Promise.resolve({ ok: true, vcs: 'Git', repo: { name: 'app', path: cwd }, branch: 'main', state: null, ahead: 0, behind: 0 });
  };
  h.w.api.onVcsStatusChanged = (cb) => { listeners.push(cb); return () => { listeners.splice(listeners.indexOf(cb), 1); }; };
  h.w.api.vcsFollow = (cwds) => follows.push(JSON.parse(JSON.stringify(cwds)));
  h.run('loadOpenSidebarGroups(__entry, true)');
  return { h, listeners, follows, described };
}
const summary = (over) => ({ branch: 'main', state: null, ahead: 0, behind: 0, ...over });

test('an open Repository group subscribes once and asks main to poll its folder', async () => {
  const { listeners, follows } = mount();
  await flush(); await flush();
  assert.equal(listeners.length, 1);
  assert.deepEqual(follows.at(-1), ['/p']);
});

test('a push for the folder that changes the branch reads the group again; a push that changes nothing drawn does not', async () => {
  const { listeners, described } = mount();
  await flush(); await flush();
  const before = described.length;
  listeners[0]({ cwd: '/p', summary: summary({ staged: 4 }) });
  listeners[0]({ cwd: '/elsewhere', summary: summary({ branch: 'dev' }) });
  await flush();
  assert.equal(described.length, before, 'same figures, or another folder: no read');
  listeners[0]({ cwd: '/p', summary: summary({ branch: 'dev' }) });
  await flush();
  assert.equal(described.length, before + 1, 'a branch switch reads again');
});

test('closing the group ends the subscription and stops asking main to poll the folder', async () => {
  const { h, listeners, follows } = mount();
  await flush(); await flush();
  const section = h.root().querySelector('.ssb-group[data-group="repository"]');
  section.open = false;
  section.dispatchEvent(new h.w.Event('toggle'));
  assert.equal(listeners.length, 0);
  assert.deepEqual(follows.at(-1), []);
});

test('closing the sidebar and destroying the session each end it', async () => {
  const a = mount();
  await flush(); await flush();
  a.h.run('hideSidebar(__entry)');
  assert.equal(a.listeners.length, 0, 'sidebar closed');
  assert.deepEqual(a.follows.at(-1), []);
  const b = mount();
  await flush(); await flush();
  b.h.run('sidebarUnfollowVcs(__entry)');
  assert.equal(b.listeners.length, 0, 'what destroySession calls');
  assert.match(src('src/renderer/terminal/terminal-manager.js'), /function destroySession[\s\S]*?sidebarUnfollowVcs\(entry\)/,
    'destroySession (also a move to another window) ends it');
});

test('the preload binding returns the function that removes its own listener, and vcsFollow sends the list', () => {
  const sent = [];
  const handlers = new Map();
  const ipcRenderer = {
    on: (ch, fn) => handlers.set(ch, fn),
    removeListener: (ch, fn) => { if (handlers.get(ch) === fn) handlers.delete(ch); },
    send: (...a) => sent.push(a),
    invoke() {},
  };
  let api = null;
  const electron = { contextBridge: { exposeInMainWorld: (_n, o) => { api = o; } }, ipcRenderer, webUtils: {} };
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
  try { require(path.join(__dirname, '..', 'src', 'preload.js')); } finally { Module._load = load; }
  const got = [];
  const off = api.onVcsStatusChanged((p) => got.push(p));
  handlers.get('vcs-status-changed')({}, { cwd: '/p' });
  assert.deepEqual(got, [{ cwd: '/p' }]);
  assert.equal(typeof off, 'function');
  off();
  assert.equal(handlers.has('vcs-status-changed'), false);
  api.vcsFollow(['/p']);
  assert.deepEqual(sent.at(-1), ['vcs-follow', ['/p']]);
});

test('main: followed folders are polled with the chip off, per window, and dropped with the window', () => {
  const vcsPoll = require('../src/app/vcs');
  const handlers = new Map();
  const ipc = { on: (ch, fn) => handlers.set(ch, fn), handle() {} };
  vcsPoll.init({ getSetting: () => ({ vcsChipEnabled: false }), log: { debug() {} } });
  try {
    vcsPoll.registerIpc(ipc);
    const watched = () => [...vcsPoll._scheduler()._state.keys()].sort();
    const destroyed = [];
    const sender = (id) => ({ id, once: (ev, fn) => { if (ev === 'destroyed') destroyed.push([id, fn]); } });
    handlers.get('vcs-watch')({}, ['/chip']);
    assert.deepEqual(watched(), [], 'chip off: its folders are not watched');
    handlers.get('vcs-follow')({ sender: sender(1) }, ['/a']);
    handlers.get('vcs-follow')({ sender: sender(2) }, ['/b']);
    assert.deepEqual(watched(), ['/a', '/b']);
    handlers.get('vcs-follow')({ sender: sender(1) }, []);
    assert.deepEqual(watched(), ['/b'], 'a closed group removes its folder');
    destroyed.find(([id]) => id === 2)[1]();
    assert.deepEqual(watched(), [], 'a window that goes takes its folders with it');
  } finally { vcsPoll.stop(); }
});

test('main: a status push reaches the detached windows as well as the main one', () => {
  const vcsPoll = require('../src/app/vcs');
  const sends = [];
  const win = (name) => ({ isDestroyed: () => false, webContents: { send: (ch, p) => sends.push([name, ch, p.cwd]) } });
  const main = win('main');
  const det = win('det');
  const gone = { isDestroyed: () => true, webContents: { send() { throw new Error('destroyed'); } } };
  vcsPoll.init({ getMainWindow: () => main, getDetachedWindows: () => [det, det, gone], getSetting: () => ({}), log: { debug() {} } });
  try {
    // The scheduler pushes through the module's own pushStatus.
    assert.match(src('src/app/vcs.js'), /onStatus:\s*pushStatus/);
    vcsPoll._push('/p', { branch: 'main' });
    assert.deepEqual(sends, [['main', 'vcs-status-changed', '/p'], ['det', 'vcs-status-changed', '/p']]);
  } finally { vcsPoll.stop(); }
});

test('main: a reload or crash recovery drops what the old page followed; an in-place navigation does not', () => {
  const vcsPoll = require('../src/app/vcs');
  const handlers = new Map();
  const ipc = { on: (ch, fn) => handlers.set(ch, fn), handle() {} };
  const nav = [];
  const sender = { id: 7, once() {}, on: (ev, fn) => { if (ev === 'did-start-navigation') nav.push(fn); } };
  vcsPoll.init({ getSetting: () => ({ vcsChipEnabled: false }), log: { debug() {} } });
  try {
    vcsPoll.registerIpc(ipc);
    const watched = () => [...vcsPoll._scheduler()._state.keys()];
    handlers.get('vcs-follow')({ sender }, ['/a']);
    handlers.get('vcs-follow')({ sender }, ['/a', '/b']);
    assert.equal(nav.length, 1, 'bound once per window');
    nav[0]({}, 'x', true, true);
    nav[0]({}, 'x', false, false);
    assert.deepEqual(watched().sort(), ['/a', '/b'], 'in place or a subframe: kept');
    nav[0]({}, 'x', false, true);
    assert.deepEqual(watched(), []);
  } finally { vcsPoll.stop(); }
});

test('a read that finishes after the sidebar closed does not follow', async () => {
  const h = setupSessionSidebar();
  const listeners = [];
  let release;
  h.w.api.vcsDescribe = () => new Promise((r) => { release = () => r({ ok: true, vcs: 'Git', repo: { name: 'a', path: '/p' }, branch: 'main' }); });
  h.w.api.onVcsStatusChanged = (cb) => { listeners.push(cb); return () => { listeners.splice(listeners.indexOf(cb), 1); }; };
  h.w.api.vcsFollow = () => {};
  h.run('loadOpenSidebarGroups(__entry, true)');
  await flush();
  h.run('hideSidebar(__entry)');
  release();
  await flush(); await flush();
  assert.equal(listeners.length, 0);
  assert.equal(h.run('sidebarVcsFollowers.size'), 0);
});

test('every following session shares one subscription, removed with the last', async () => {
  const { h, listeners, follows } = mount();
  await flush(); await flush();
  const el = h.w.document.createElement('div');
  el.className = 'terminal-container visible';
  h.w.document.body.appendChild(el);
  h.ctx.__second = { element: el, session: { sessionId: 's2', projectPath: '/q' } };
  h.run('openSessions.set("s2", __second); showSidebar(__second, 280)');
  await flush(); await flush();
  assert.equal(h.run('sidebarVcsFollowers.size'), 2);
  assert.equal(listeners.length, 1, 'one listener for two sessions');
  assert.deepEqual([...follows.at(-1)].sort(), ['/p', '/q']);
  h.run('sidebarUnfollowVcs(__entry)');
  assert.equal(listeners.length, 1, 'the other still follows');
  h.run('sidebarUnfollowVcs(__second)');
  assert.equal(listeners.length, 0);
});
