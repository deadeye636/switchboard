'use strict';

// The Details window's lifecycle (#870, spec 47 section 7), with a fake BrowserWindow: one window per session, focus-if-exists
// (and told where to land), destroy-on-close, destroyed with the main window; the window follows its session and stops when it
// goes. The window and its diff window are named by a session id and a row id, never a path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vcsApp = require('../src/app/vcs');
const sc = require('../src/app/session-changes');
const { makeCheckout, makeProvider, makeExec, makeStore, makeCtx } = require('./helpers/session-changes-fakes');

const roots = [];
test.after(() => { vcsApp.stop(); for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function makeBrowserWindow() {
  const made = [];
  class FakeWindow {
    constructor(opts) {
      this.opts = opts;
      this.shown = 0; this.focused = 0; this.destroyedFlag = false;
      this.sent = []; this.handlers = new Map(); this.loaded = null;
      this.webContents = { id: 100 + made.length, send: (ch, payload) => this.sent.push([ch, payload]), isDestroyed: () => this.destroyedFlag, once() {}, on() {} };
      made.push(this);
    }
    setMenu() {}
    loadFile(file, o) { this.loaded = { file, query: o && o.query }; }
    once(ev, fn) { this.handlers.set('once:' + ev, fn); }
    on(ev, fn) { this.handlers.set(ev, fn); }
    show() { this.shown++; }
    focus() { this.focused++; }
    isDestroyed() { return this.destroyedFlag; }
    destroy() { this.destroyedFlag = true; }
    emit(ev) { const fn = this.handlers.get(ev); if (fn) fn(); }
  }
  return { FakeWindow, made };
}

function setup({ files, status } = {}) {
  vcsApp.destroyAllVcsWindows();   // the window maps are the module's own: each test starts with none
  const root = makeCheckout();
  roots.push(root);
  const { exec } = makeExec({
    'rev-list': { out: 'a'.repeat(40) }, 'cat-file': { out: '' }, log: { out: '' }, diff: { out: '' }, 'rev-parse': { out: 'b'.repeat(40) },
  });
  const store = makeStore();
  const rows = typeof files === 'function' ? files(root) : [{ path: 'src/a.js', count: 1, first: 1, last: 4, at: 1 }];
  store.changes.set('S', { files: rows, commits: [], pushes: [], truncated: false });
  const sessions = [
    { sessionId: 'S', folder: 'F', projectPath: root, startedAt: '2026-11-16T08:00:00.000Z' },
    { sessionId: 'T', folder: 'G', projectPath: root, startedAt: '2026-11-16T08:00:00.000Z' },
  ];
  sc.init(makeCtx({ root, sessions, provider: makeProvider(root), exec, store, status }));
  const { FakeWindow, made } = makeBrowserWindow();
  const main = { isDestroyed: () => false };
  vcsApp.init({ BrowserWindow: FakeWindow, getMainWindow: () => main, log: { debug() {} } });
  return { made, root, store };
}

test('one window per session: a second open focuses it and tells it where to land', () => {
  const { made } = setup();
  assert.deepEqual(sc.openDetails('S', { id: 'f:one' }), { ok: true });
  assert.equal(made.length, 1);
  const win = made[0];
  assert.equal(win.loaded.file.endsWith('session-changes.html'), true);
  assert.equal(win.loaded.query.session, 'S');
  assert.deepEqual(JSON.parse(win.loaded.query.at), { id: 'f:one' });
  win.emit('once:ready-to-show');
  assert.equal(win.shown, 1);

  assert.deepEqual(sc.openDetails('S', { pick: true }), { ok: true });
  assert.equal(made.length, 1, 'focus-if-exists: no second window');
  assert.equal(win.shown, 2);
  assert.equal(win.focused >= 2, true);
  assert.deepEqual(win.sent.at(-1), ['session-changes-details-at', { pick: true }]);

  assert.deepEqual(sc.openDetails('T', {}), { ok: true });
  assert.equal(made.length, 2, 'another session has a window of its own');
  assert.equal(made[1].loaded.query.session, 'T');
});

test('the window names a session id only: no path in its URL, a folder name for its title', () => {
  const { made, root } = setup();
  sc.openDetails('S', {});
  const q = made[0].loaded.query;
  assert.deepEqual(Object.keys(q).sort(), ['at', 'label', 'session']);
  for (const v of Object.values(q)) assert.ok(!String(v).includes(root), 'the checkout path never travels');
  assert.equal(q.label, path.basename(root));
  assert.equal(made[0].opts.webPreferences.nodeIntegration, false);
  assert.equal(made[0].opts.webPreferences.contextIsolation, true);
});

test('a session main does not know opens nothing; a bad `at` is cleaned', () => {
  const { made } = setup();
  assert.equal(sc.openDetails('nope', {}).ok, false);
  assert.equal(sc.openDetails('', {}).ok, false);
  assert.equal(made.length, 0);
  sc.openDetails('S', { id: 42, extra: '<script>' });
  assert.deepEqual(JSON.parse(made[0].loaded.query.at), {});
});

test('destroy-on-close: a closed window is forgotten and the next open builds a new one', () => {
  const { made } = setup();
  sc.openDetails('S', {});
  made[0].emit('closed');
  sc.openDetails('S', {});
  assert.equal(made.length, 2);
});

test('destroyed with the main window', () => {
  const { made } = setup();
  sc.openDetails('S', {});
  sc.openDetails('T', {});
  vcsApp.destroyAllVcsWindows();
  assert.equal(made.every((w) => w.destroyedFlag), true);
  sc.openDetails('S', {});
  assert.equal(made.length, 3, 'nothing stale is kept after the main window went');
});

test('closing the window ends its follow: the page unfollows and its webContents going away does too', () => {
  setup();
  const listeners = new Map();
  const sender = { id: 777, sent: [], send() {}, isDestroyed: () => false, once: (ev, fn) => listeners.set(ev, fn), on() {} };
  assert.deepEqual(sc.follow('S', sender), { ok: true });
  assert.deepEqual(sc._followedSessions(), ['S']);
  listeners.get('destroyed')();
  assert.deepEqual(sc._followedSessions(), [], 'the window is gone, so is its subscription');
  sc.follow('S', { ...sender, id: 778 });
  sc.unfollow('S', { id: 778 });
  assert.deepEqual(sc._followedSessions(), []);
});

// --- the two sides of a diff (`versions`) and the pick that chooses a range ---

const FULL = (c) => c.repeat(40);
const at9 = Date.UTC(2026, 10, 16, 9);
const entry = (o) => ({ lineageId: 'S', sessionId: 'S', fromSha: null, toSha: null, fromPosition: null, files: null, repoRoot: null, how: null, ...o });
const FILE = (root) => [{ path: 'src/a.js', count: 3, first: 1, last: 50, at: at9 }];

function seedEntries(store) {
  store.entries.push(entry({ id: 1, kind: 'start', position: null, at: 1, sha: FULL('a') }));
  store.entries.push(entry({ id: 2, kind: 'clear', position: 20, at: 2, toSha: FULL('b'), files: { files: [['src/a.js', 1]], truncated: false } }));
}

// `versions` hands the read to `vcs.js`'s `fileVersions`; a spy shows exactly what it was asked, with no git behind it.
async function withSpy(fn) {
  const real = vcsApp.fileVersions;
  const asked = [];
  vcsApp.fileVersions = async (...args) => { asked.push(args); return { ok: true, old: 'o', new: 'n' }; };
  try { await fn(asked); } finally { vcsApp.fileVersions = real; }
}

test('versions: an open block reads the baseline against the working copy, by row id', async () => {
  const { store, root } = setup({ files: FILE });
  seedEntries(store);
  const st = await sc.state('S', { range: 'whole' });
  await withSpy(async (asked) => {
    const r = await sc.versions('S', st.files[0].id);
    assert.equal(r.ok, true);
    assert.deepEqual(asked, [[root, 'src/a.js', '', false, { from: FULL('a'), to: null }]]);
    assert.equal((await sc.versions('S', 'f:' + '0'.repeat(20))).ok, false, 'an id no kept answer lists is refused');
    assert.equal(asked.length, 1);
  });
});

test('versions: a picked range that ends at an entry reads both ends from history', async () => {
  const { store, root } = setup({ files: FILE });
  seedEntries(store);
  const st = await sc.state('S', { range: 'pick', pickFrom: 1, pickTo: 2 });
  assert.equal(st.files.length, 1);
  await withSpy(async (asked) => {
    await sc.versions('S', st.files[0].id);
    assert.deepEqual(asked, [[root, 'src/a.js', '', false, { from: FULL('a'), to: FULL('b') }]]);
  });
});

test('versions: an untracked file has no old side to ask history for', async () => {
  const { store, root } = setup({ files: FILE, status: { files: [{ path: 'src/a.js', kind: 'untracked' }] } });
  seedEntries(store);
  const st = await sc.state('S', { range: 'whole' });
  assert.equal(st.files[0].isNew, true);
  await withSpy(async (asked) => {
    await sc.versions('S', st.files[0].id);
    assert.deepEqual(asked, [[root, 'src/a.js', 'untracked', false]]);
  });
});

test('versions: a file outside the checkout is refused before anything is read', async () => {
  const { store } = setup({ files: (root) => [{ path: path.join(path.dirname(root), 'sc-elsewhere', 'x.js'), count: 1, first: 1, last: 5, at: at9 }] });
  seedEntries(store);
  const st = await sc.state('S', { range: 'whole' });
  const row = st.files.find((f) => f.outside);
  assert.ok(row);
  await withSpy(async (asked) => {
    const r = await sc.versions('S', row.id);
    assert.equal(r.ok, false);
    assert.match(r.error, /outside/i);
    assert.equal(asked.length, 0);
    assert.equal(sc.openDiffWindow('S', row.id).ok, false, 'nor is a diff window opened for it');
  });
});

test('a two-entry pick round-trips through setView: the ids stay what the strip named, and the next read resolves that range', async () => {
  const { store } = setup({ files: FILE });
  seedEntries(store);
  store.entries.push(entry({ id: 3, kind: 'clear', position: 30, at: 3, toSha: FULL('c'), files: { files: [['src/a.js', 2]], truncated: false } }));
  const ticks = sc.entries('S', {}).ticks;
  const start = ticks.find((t) => t.kind === 'start');
  const clears = ticks.filter((t) => t.kind === 'clear');
  assert.equal(typeof clears[0].id, 'number', 'a stored entry\'s id is a number: the page must send it back as one');
  assert.deepEqual(sc.setView('S', { range: 'pick', view: 'all', pickFrom: start.id, pickTo: clears[0].id }), { ok: true });
  assert.deepEqual(sc.getView('S'), { range: 'pick', view: 'all', pickFrom: start.id, pickTo: clears[0].id });
  const st = await sc.state('S', {});
  assert.equal(st.request.range, 'pick');
  assert.equal(st.range.fromId, start.id);
  assert.equal(st.range.toId, clears[0].id);
  // The same ids as TEXT (what a DOM dataset holds) are not an entry id: main drops them, which is the bug this pins down.
  sc.setView('S', { range: 'pick', view: 'all', pickFrom: String(start.id), pickTo: String(clears[0].id) });
  assert.deepEqual([sc.getView('S').pickFrom, sc.getView('S').pickTo], [null, null]);
});

test('a change of the kept range or view tells the windows that follow the session', () => {
  setup();
  const sent = [];
  const sender = { id: 901, send: (ch, payload) => sent.push([ch, payload]), isDestroyed: () => false, once() {}, on() {} };
  sc.follow('S', sender);
  sc.setView('S', { range: 'today', view: 'split', pickFrom: null, pickTo: null });
  assert.deepEqual(sent, [['session-changes-updated', { sessionId: 'S' }]]);
  sc.unfollow('S', sender);
});

test('a diff window is opened by row id from a kept answer, and a stale id is refused', async () => {
  const { made } = setup();
  assert.equal(sc.openDiffWindow('S', 'f:unknown').ok, false);
  const view = await sc.state('S', {});
  assert.equal(view.ok, true);
  const id = view.files[0].id;
  assert.deepEqual(sc.openDiffWindow('S', id), { ok: true });
  assert.equal(made.length, 1);
  assert.equal(made[0].loaded.file.endsWith('diff-window.html'), true);
  assert.deepEqual(Object.keys(made[0].loaded.query).sort(), ['label', 'row', 'session']);
  assert.equal(made[0].loaded.query.label, 'a.js', 'a file name for the title, never a path');
  sc.openDiffWindow('S', id);
  assert.equal(made.length, 1, 'focus-if-exists');
  const stale = await sc.versions('S', 'f:unknown');
  assert.equal(stale.ok, false);
});
