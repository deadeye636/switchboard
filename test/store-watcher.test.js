// watch/stores.js — the Axis-B store watcher, from an fs event to what the identity match is handed.
//
// This module had no test at all until #210 gave it something that fails SILENTLY. The candidate paths
// it now collects are filtered by `path.basename` further down (`backends/file-store.js`), which a bare
// relative filename passes just as happily as an absolute one — so a regression from `path.resolve` back
// to the raw event name would surface only as "this session never pairs", with nothing red anywhere.
//
// It drives real `fs.watch` / `fs.watchFile`, so it is slow by construction: the dir case pays the 600 ms
// debounce and the db case the 2 s poll interval on top.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFileStore } = require('../src/backends/file-store');
const adopt = require('../src/watch/adopt');
const stores = require('../src/watch/stores');

const log = { info() {}, debug() {}, warn() {}, error() {} };

/** Wait until `check()` answers truthily, or give up — the watchers are real, so nothing is instant. */
async function until(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = check();
    if (answer) return answer;
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, 50));
  }
}

/** One unpaired live session of `backend`, wired the way the watcher's flush finds it. */
function arm(backend, posted) {
  adopt.liveStoreRef.clear();
  adopt.liveBusy.clear();
  adopt.init({
    activeSessions: new Map([['temp-1', { _openedAt: Date.now() - 1000, _resumed: false, projectPath: '/p' }]]),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    backends: { get: () => backend },
    sessionBackends: { get: () => ({ backendId: backend.id }), rekeySession() {} },
    log,
  });
  stores.init({
    backends: { launchable: () => [backend] },
    getAppQuitting: () => false,
    indexWorker: { postReconcile: (msg) => posted.push(msg) },
    log,
  });
  stores.startBackendWatchers();
}

test('a dir event hands the match an ABSOLUTE path — a relative one would fail at the stat, silently', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-watcher-'));
  const bucket = path.join(root, '2026', '09', '09');
  fs.mkdirSync(bucket, { recursive: true });
  const asked = [];
  const store = createFileStore({
    root: () => root,
    matches: (name) => name.startsWith('log-') && name.endsWith('.jsonl'),
    parseSession: () => null,
    refSuffix: (id) => `-${id}.jsonl`,
  });
  const posted = [];
  arm({
    id: 'codex', axis: 'B',
    watchTargets: store.watchTargets,
    matchLiveSession: (q) => { asked.push(q.candidates); return null; },
    liveState: () => null,
  }, posted);

  try {
    const written = path.join(bucket, 'log-real-1.jsonl');
    fs.writeFileSync(written, '{}\n');

    const got = await until(() => (asked.length ? asked[0] : null), 15000);
    assert.ok(got, 'the flush reached the identity match');
    const paths = [...got];
    assert.equal(paths.length, 1);
    assert.ok(path.isAbsolute(paths[0]), `the candidate must be absolute, got ${paths[0]}`);
    assert.ok(fs.existsSync(paths[0]), 'and it must name the file that was actually written');
    assert.equal(path.resolve(paths[0]), path.resolve(written));
    // #282 lever 2 / #521: the reconcile is still scoped by backend ID, and a flush always names one.
    assert.deepEqual(posted, [{ backendIds: ['codex'] }]);
  } finally {
    stores.stopBackendWatchers();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a db event names no file, so the match is asked for the full walk', async () => {
  // The polled db target reports a stat, not a path in a tree. That has to arrive as "no scope" — the
  // same thing the 30 s ticker sends — or a backend whose store is a single database could never pair.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-watcher-db-'));
  const dbFile = path.join(root, 'state.db');
  fs.writeFileSync(dbFile, 'x');
  const asked = [];
  const posted = [];
  arm({
    id: 'hermes', axis: 'B',
    watchTargets: () => [{ kind: 'db', path: dbFile }],
    matchLiveSession: (q) => { asked.push(q.candidates); return null; },
    liveState: () => null,
  }, posted);

  try {
    fs.writeFileSync(dbFile, 'xx');

    const done = await until(() => (asked.length ? true : null), 20000);
    assert.ok(done, 'the poll noticed the write');
    assert.equal(asked[0], undefined, 'no scope — walk the store, exactly as this did before #210');
  } finally {
    stores.stopBackendWatchers();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
