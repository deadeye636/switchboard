'use strict';
// The IPC surface of `src/app/session-changes.js` (#870): every preload binding exists and names a channel the module
// registers, the renderer cannot name a path (a diff takes the id of a row of the last state), and Clear writes one entry.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sc = require('../src/app/session-changes');
const { stripComments } = require('./helpers/strip-comments');
const { makeCheckout, makeProvider, makeExec, makeStore, makeCtx, FULL } = require('./helpers/session-changes-fakes');

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function registered() {
  const handlers = new Map();
  const listened = [];
  sc.registerIpc({ handle: (ch, fn) => handlers.set(ch, fn), on: (ch) => { listened.push(ch); } });
  handlers.listened = listened;   // fire-and-forget channels (`ipc.on`): the follow pair, tested in session-changes-follow
  return handlers;
}

function setup() {
  const root = makeCheckout();
  roots.push(root);
  const { exec, calls } = makeExec({
    'rev-list': { out: FULL('a') }, 'cat-file': { out: '' }, log: { out: '' }, diff: { out: '' }, 'rev-parse': { out: FULL('b') },
  });
  const store = makeStore();
  store.changes.set('S', { files: [{ path: 'src/a.js', count: 1, first: 1, last: 4, at: 1 }], commits: [], pushes: [], truncated: false });
  sc.init(makeCtx({ root, sessions: [{ sessionId: 'S', folder: 'F', projectPath: root, startedAt: '2026-11-16T08:00:00.000Z' }], provider: makeProvider(root), exec, store }));
  return { calls, store };
}

const BINDINGS = {
  sessionChangesSummary: ['session-changes-summary'],
  sessionChanges: ['session-changes-state'],
  sessionChangesDetails: ['session-changes-details'],
  sessionChangesDiff: ['session-changes-diff'],
  sessionChangesOpen: ['session-changes-open'],
  sessionChangesFollow: ['session-changes-follow'],
  sessionChangesClear: ['session-changes-clear'],
  sessionChangesEntries: ['session-changes-entries'],
  sessionChangesView: ['session-changes-view-get', 'session-changes-view-set'],
};

test('every preload binding exists and invokes a channel the module registers', () => {
  const preload = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8'));
  const handlers = registered();
  for (const [name, channels] of Object.entries(BINDINGS)) {
    const at = preload.indexOf(`  ${name}: (`);
    assert.ok(at >= 0, `preload binds ${name}`);
    const body = preload.slice(at, preload.indexOf('\n  ', at + 4 + name.length + 200 > preload.length ? at : at + 1));
    for (const ch of channels) {
      assert.ok(preload.includes(`'${ch}'`), `preload names ${ch}`);
      assert.ok(handlers.has(ch), `the module registers ${ch}`);
    }
  }
  assert.deepEqual([...handlers.keys()].sort(), Object.values(BINDINGS).flat().sort());
  // Follow answers `{ ok }` (invoke), so a refused follow is not recorded; unfollow is fire-and-forget (`ipc.on`). The push
  // comes back as `session-changes-updated`.
  assert.deepEqual([...handlers.listened].sort(), ['session-changes-unfollow']);
  for (const ch of ['session-changes-follow', 'session-changes-unfollow', 'session-changes-updated']) assert.ok(preload.includes(`'${ch}'`), `preload names ${ch}`);
});

test('the module is wired from main.js and adds no handler there', () => {
  const main = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'));
  assert.match(main, /require\('\.\/app\/session-changes'\)/);
  assert.match(main, /sessionChanges\.registerIpc\(ipcMain\)/);
  assert.doesNotMatch(main, /ipcMain\.handle\('session-changes/);
});

test('a diff takes a row id: a path or a SHA from the renderer is refused before anything runs', async () => {
  const { calls } = setup();
  const handlers = registered();
  const st = await handlers.get('session-changes-state')({}, 'S', {});
  assert.equal(st.ok, true);
  const before = calls.length;
  for (const forged of ['src/a.js', '../../secret', 'C:/x', FULL('a'), { path: 'src/a.js' }, 'f99']) {
    const r = await handlers.get('session-changes-diff')({}, 'S', forged);
    assert.equal(r.ok, false, `refused: ${JSON.stringify(forged)}`);
  }
  assert.equal(calls.length, before, 'nothing ran for a forged target');
  const good = await handlers.get('session-changes-diff')({}, 'S', st.files[0].id);
  assert.equal(good.ok, true);
});

test('Open answers the contained absolute path of a listed file row; a path, a commit id or a forged id is refused', async () => {
  const { calls } = setup();
  const handlers = registered();
  const st = await handlers.get('session-changes-state')({}, 'S', {});
  const before = calls.length;
  const good = await handlers.get('session-changes-open')({}, 'S', st.files[0].id);
  assert.equal(good.ok, true);
  assert.ok(path.isAbsolute(good.path) && good.path.replace(/\\/g, '/').endsWith('/src/a.js'), good.path);
  for (const forged of ['src/a.js', '../../secret', 'f:deadbeef', FULL('a'), { id: st.files[0].id }, null]) {
    const r = await handlers.get('session-changes-open')({}, 'S', forged);
    assert.equal(r.ok, false, `refused: ${JSON.stringify(forged)}`);
    assert.ok(!/[\\/]/.test(r.error), 'the refusal says no path');
  }
  assert.equal((await handlers.get('session-changes-open')({}, 'other', st.files[0].id)).ok, false, 'another session has no such row');
  assert.equal(calls.length, before, 'Open runs no version control');
});

test('Open in a session that runs in a subfolder resolves the root-relative key against the checkout root', async () => {
  const root = makeCheckout();
  roots.push(root);
  fs.mkdirSync(path.join(root, 'pkg', 'src'), { recursive: true });
  const { exec } = makeExec({ 'rev-list': { out: FULL('a') }, 'cat-file': { out: '' }, log: { out: '' }, diff: { out: '' }, 'rev-parse': { out: FULL('b') } });
  const store = makeStore();
  // The transcript names `src/a.js`, relative to the session's folder: the row's key is `pkg/src/a.js`.
  store.changes.set('S', { files: [{ path: 'src/a.js', count: 1, first: 1, last: 4, at: 1 }], commits: [], pushes: [], truncated: false });
  sc.init(makeCtx({ root, sessions: [{ sessionId: 'S', folder: 'F', projectPath: path.join(root, 'pkg'), startedAt: '2026-11-16T08:00:00.000Z' }], provider: makeProvider(root), exec, store }));
  const handlers = registered();
  const st = await handlers.get('session-changes-state')({}, 'S', {});
  assert.equal(st.files[0].key, 'pkg/src/a.js');
  const r = await handlers.get('session-changes-open')({}, 'S', st.files[0].id);
  assert.equal(r.ok, true);
  assert.equal(path.normalize(r.path), path.join(root, 'pkg', 'src', 'a.js'));
});

test('Open\'s refusal of an outside file has its own sentence, not the diff\'s', async () => {
  const root = makeCheckout();
  roots.push(root);
  const { exec } = makeExec({ 'rev-list': { out: FULL('a') }, 'cat-file': { out: '' }, log: { out: '' }, diff: { out: '' }, 'rev-parse': { out: FULL('b') } });
  const store = makeStore();
  const outside = path.join(path.dirname(root), 'sc-elsewhere', 'x.js');
  store.changes.set('S', { files: [{ path: outside, count: 1, first: 1, last: 4, at: 1 }], commits: [], pushes: [], truncated: false });
  sc.init(makeCtx({ root, sessions: [{ sessionId: 'S', folder: 'F', projectPath: root, startedAt: '2026-11-16T08:00:00.000Z' }], provider: makeProvider(root), exec, store }));
  const handlers = registered();
  const st = await handlers.get('session-changes-state')({}, 'S', {});
  const row = st.files.find((f) => f.outside);
  assert.ok(row, 'the file is listed as outside');
  const r = await handlers.get('session-changes-open')({}, 'S', row.id);
  assert.deepEqual([r.ok, r.error], [false, 'This file is outside this checkout.']);
});

test('Clear writes exactly one clear entry, with the review data', async () => {
  const { store } = setup();
  const handlers = registered();
  await handlers.get('session-changes-state')({}, 'S', {});
  const n = store.added.length;
  const r = await handlers.get('session-changes-clear')({}, 'S');
  assert.equal(r.ok, true);
  assert.deepEqual(store.added.slice(n), ['clear']);
  const e = store.entries[store.entries.length - 1];
  assert.equal(e.fromSha, FULL('a'));
  assert.equal(e.toSha, FULL('b'));
  assert.equal(e.position, 4);
  assert.deepEqual(e.files.files, [['src/a.js', 1]]);
  const after = await handlers.get('session-changes-summary')({}, 'S');
  assert.equal(after.figure, null, 'nothing since the review any more');
});

test('the view is kept per session, a pick that ends at a push included; a forged key is dropped', async () => {
  const { store } = setup();
  const handlers = registered();
  assert.deepEqual(await handlers.get('session-changes-view-get')({}, 'S'), { range: 'since-review', view: 'all', pickFrom: null, pickTo: null });
  await handlers.get('session-changes-view-set')({}, 'S', { range: 'pick', view: 'split', pickFrom: 2, pickTo: 'push:S:4' });
  assert.deepEqual(store.views.get('S'), { range: 'pick', view: 'split', pickFrom: 2, pickTo: 'push:S:4' });
  await handlers.get('session-changes-view-set')({}, 'S', { range: 'pick', view: 'all', pickFrom: '../../x', pickTo: 'push:S:4; rm' });
  assert.deepEqual(store.views.get('S'), { range: 'pick', view: 'all', pickFrom: null, pickTo: null });
});

test('the header figure of a fork figure leaves its inherited work out before its timeline is made (DB only, G3)', () => {
  const root = makeCheckout();
  roots.push(root);
  const { exec, calls } = makeExec({});
  const store = makeStore();
  const sessions = [
    { sessionId: 'P', folder: 'F', projectPath: root },
    { sessionId: 'K', folder: 'F', projectPath: root, lineageParentId: 'P', lineageKind: 'fork' },
    { sessionId: 'C', folder: 'F', projectPath: root, lineageParentId: 'P', lineageKind: 'clear' },
  ];
  store.changes.set('K', { files: [{ path: 'src/inherited.js', count: 3, first: 1, last: 40, at: 1 }], commits: [{ sha: 'abcdef1', subject: 's', branch: 'm', position: 30, at: 1 }], pushes: [], truncated: false });
  store.changes.set('P', { files: [{ path: 'src/inherited.js', count: 3, first: 1, last: 40, at: 1 }], commits: [], pushes: [], truncated: false });
  sc.init(makeCtx({ root, sessions, provider: makeProvider(root), exec, store }));
  assert.equal(sc.summary('K').figure, null, 'a fork starts where it stands at first sight');
  assert.deepEqual(sc.summary('P').figure, { files: 1, commits: 0 }, 'its parent still counts its own work');
  assert.equal(calls.length, 0, 'the summary runs nothing');
  const starts = store.entries.filter((e) => e.lineageId === 'K' && e.kind === 'start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].how, 'fork-first-seen');
  assert.equal(starts[0].sha, null);
  // The fork works on: the start does not move, so its own later edit is counted.
  store.changes.get('K').files.push({ path: 'src/own.js', count: 2, first: 50, last: 60, at: 2 });
  assert.deepEqual(sc.summary('K').figure, { files: 1, commits: 0 });
  assert.equal(store.entries.filter((e) => e.lineageId === 'K' && e.kind === 'start').length, 1, 'stored once');
});

test('a fork without a repository shows its own edits in Since last review and Whole session; a repository fills the SHA later', async () => {
  const root = makeCheckout();
  roots.push(root);
  const store = makeStore();
  const sessions = [{ sessionId: 'P', folder: 'F', projectPath: root }, { sessionId: 'K', folder: 'F', projectPath: root, lineageParentId: 'P', lineageKind: 'fork', startedAt: '2026-11-16T08:00:00.000Z' }];
  store.changes.set('K', { files: [{ path: 'src/inherited.js', count: 3, first: 1, last: 40, at: 1 }], commits: [], pushes: [], truncated: false });
  const none = makeExec({});
  sc.init({ ...makeCtx({ root, sessions, provider: null, exec: none.exec, store }), vcs: { detect: () => null } });
  assert.equal(sc.summary('K').figure, null);
  store.changes.get('K').files.push({ path: 'src/own.js', count: 2, first: 50, last: 60, at: 2 });
  const review = await sc.state('K', {});
  assert.deepEqual(review.files.map((f) => f.key), ['src/own.js']);
  assert.ok(review.notes.some((n) => n.code === 'no-repo'));
  const whole = await sc.state('K', { range: 'whole' });
  assert.deepEqual(whole.files.map((f) => f.key), ['src/own.js']);
  assert.equal(none.calls.length, 0);
  // A repository answers later: the stored start gets its SHA, its position stays.
  const withRepo = makeExec({ 'rev-list': { out: FULL('a') }, 'cat-file': { out: '' }, log: { out: '' }, diff: { out: '' } });
  sc.init(makeCtx({ root, sessions, provider: makeProvider(root), exec: withRepo.exec, store }));
  const again = await sc.state('K', { range: 'whole' });
  assert.deepEqual(again.files.map((f) => f.key), ['src/own.js']);
  const start = store.entries.find((e) => e.lineageId === 'K' && e.kind === 'start');
  assert.equal(start.sha, FULL('a'));
  assert.equal(start.position, 40);
});

test('forget drops what is kept for a session; an id from it is then stale', async () => {
  setup();
  const handlers = registered();
  const st = await handlers.get('session-changes-state')({}, 'S', {});
  sc.forget('S');
  const d = await handlers.get('session-changes-diff')({}, 'S', st.files[0].id);
  assert.equal(d.ok, false);
  assert.match(d.error, /no longer listed/);
});
