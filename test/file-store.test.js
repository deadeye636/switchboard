// backends/file-store.js — the file-mode seam Codex and Pi both compose (#156).
//
// These test the shared mechanics ONCE, against a synthetic backend. The point of the extraction is that
// a fix here reaches every file backend; the point of these tests is that the fix is checked here rather
// than in one backend's suite, where the sibling would quietly miss it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFileStore, findOnPath, pathExtensions, walkStore, BIRTH_HINT_SKEW_MS } = require('../src/backends/file-store');

// A store shaped like a real one: nested folders, a mix of matching and non-matching files.
// `<root>/2026/07/12/log-<id>.jsonl`, with a sidecar the backend must ignore.
function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-store-'));
  const bucket = path.join(root, '2026', '07', '12');
  fs.mkdirSync(bucket, { recursive: true });
  return { root, bucket };
}

function writeSession(bucket, id, cwd, { name } = {}) {
  const file = path.join(bucket, name || `log-${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ id, cwd }) + '\n');
  return file;
}

// The synthetic backend: its transcripts are `log-*.jsonl`, its parser reads the first line, and a
// filename names a session by ending in `-<id>.jsonl`.
function storeFor(root) {
  return createFileStore({
    root: () => root,
    matches: (name) => name.startsWith('log-') && name.endsWith('.jsonl'),
    parseSession: (handle) => {
      try {
        const head = JSON.parse(fs.readFileSync(handle.path, 'utf8').split('\n')[0]);
        return { sessionId: head.id, cwd: head.cwd };
      } catch { return null; }
    },
    refSuffix: (id) => `-${id}.jsonl`,
  });
}

test('createFileStore refuses a spec it cannot honour', () => {
  // A root passed as a STRING is the tempting mistake, and a silent one: the store would freeze the root
  // it was constructed with, and setHome()/setRoot() (and every test fixture) would stop moving it.
  assert.throws(() => createFileStore({ root: '/tmp', matches: () => true, parseSession: () => null, refSuffix: () => '' }),
    /root must be a function/);
  assert.throws(() => createFileStore({ root: () => '/tmp' }), /matches must be a function/);
});

test('discoverSessions recurses the store and yields {kind:file} handles', () => {
  const { root, bucket } = makeStore();
  try {
    const a = writeSession(bucket, 'aaa', '/p');
    writeSession(bucket, 'bbb', '/p', { name: 'notes.txt' });      // not a transcript
    fs.writeFileSync(path.join(root, 'index.json'), '{}');          // nor is this
    const handles = storeFor(root).discoverSessions();

    assert.equal(handles.length, 1, 'only the matching file is a session');
    assert.deepEqual(handles[0], {
      kind: 'file', path: a, sessionId: null, parentSessionId: null, root,
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a store root that does not exist yields no sessions, and does not throw', () => {
  const missing = path.join(os.tmpdir(), 'file-store-nope-' + process.pid);
  assert.deepEqual(storeFor(missing).discoverSessions(), []);
  assert.deepEqual(walkStore(missing, () => true), []);
});

test('the root is read on every call — setHome()/setRoot() must keep working', () => {
  // The whole reason `root` is a function. A store that captured the path at construction would keep
  // reading the old one after the backend was pointed somewhere else (and every fixture would leak).
  const first = makeStore();
  const second = makeStore();
  try {
    writeSession(first.bucket, 'one', '/p');
    writeSession(second.bucket, 'two', '/p');

    let current = first.root;
    const store = createFileStore({
      root: () => current,
      matches: (name) => name.endsWith('.jsonl'),
      parseSession: () => null,
      refSuffix: (id) => `-${id}.jsonl`,
    });

    assert.equal(store.discoverSessions().length, 1);
    assert.equal(store.watchTargets()[0].path, first.root);
    current = second.root;
    assert.equal(store.discoverSessions()[0].root, second.root);
    assert.equal(store.watchTargets()[0].path, second.root);
  } finally {
    fs.rmSync(first.root, { recursive: true, force: true });
    fs.rmSync(second.root, { recursive: true, force: true });
  }
});

test('watchTargets watches the root recursively, and its match accepts transcripts + WAL siblings', () => {
  // Recursive, because new subdirectories appear on their own: a date bucket at midnight (Codex), a
  // cwd folder with its first session (Pi). A non-recursive watch would go blind at the rollover.
  // The target carries a `match` so the dir watcher never hardcodes an extension (the `.jsonl` hardcode
  // made agy's `.db` store invisible); it also accepts a `-wal`/`-shm` sibling, because a WAL-buffered
  // store (agy) commits its live busy signal there without touching the main file's mtime.
  const { root } = makeStore();
  try {
    const [target] = storeFor(root).watchTargets();
    assert.equal(target.kind, 'dir');
    assert.equal(target.path, root);
    assert.equal(target.recursive, true);
    assert.equal(typeof target.match, 'function');
    assert.ok(target.match('log-abc.jsonl'));          // a transcript
    assert.ok(target.match('log-abc.jsonl-wal'));       // its WAL sibling
    assert.ok(target.match('log-abc.jsonl-shm'));       // its SHM sibling
    // A recursive fs.watch reports a path relative to the root, NOT a basename. A prefix-anchored
    // matcher (this synthetic backend, like Codex, requires `log-`/`rollout-` at the START) would drop
    // every date-bucketed event if match did not basename its input first.
    assert.ok(target.match('2026/07/12/log-abc.jsonl'), 'a recursive-watch relative path still matches');
    assert.ok(target.match('2026/07/12/log-abc.jsonl-wal'), 'and its WAL sibling under a subdir');
    assert.ok(!target.match('notes.txt'));              // a sidecar / dir churn
    assert.ok(!target.match('index.json'));
    assert.ok(!target.match('2026/07/12/notes.txt'));   // a non-transcript under a subdir
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('matchLiveSession pairs a freshly spawned session with its transcript', () => {
  const { root, bucket } = makeStore();
  try {
    const file = writeSession(bucket, 'live-1', 'D:\\Projekte\\demo');
    const match = storeFor(root).matchLiveSession({ cwd: 'D:\\Projekte\\demo', sinceMs: 0, claimed: new Set() });
    assert.deepEqual(match, { sessionId: 'live-1', ref: file });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('matchLiveSession ignores another project, a claimed record, and anything older than the spawn', () => {
  const { root, bucket } = makeStore();
  try {
    const file = writeSession(bucket, 'live-1', 'D:\\Projekte\\demo');
    const store = storeFor(root);

    assert.equal(store.matchLiveSession({ cwd: 'D:\\Projekte\\elsewhere', sinceMs: 0, claimed: new Set() }), null,
      'a transcript from another cwd is not the session we just launched');
    assert.equal(store.matchLiveSession({ cwd: 'D:\\Projekte\\demo', sinceMs: 0, claimed: new Set([file]) }), null,
      'a record another session already claimed must never be handed out twice');
    assert.equal(store.matchLiveSession({ cwd: 'D:\\Projekte\\demo', sinceMs: Date.now() + 3600_000, claimed: new Set() }), null,
      'a record that predates the spawn belongs to an older session');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('matchLiveSession takes the OLDEST unclaimed record, not the most recently touched', () => {
  // Correlation is by birth time. Newest-mtime would let a working session's file — which keeps growing —
  // be stolen by an older session whose own transcript is still just a header.
  const { root, bucket } = makeStore();
  try {
    const older = writeSession(bucket, 'first', '/p');
    const newer = writeSession(bucket, 'second', '/p');
    // The OLDER session is the busy one: touch it so it has the newest mtime.
    const soon = new Date(Date.now() + 60_000);
    fs.utimesSync(older, soon, soon);

    const match = storeFor(root).matchLiveSession({ cwd: '/p', sinceMs: 0, claimed: new Set() });
    assert.equal(match.ref, older, 'the first-born record wins, however busy the file has been since');
    assert.ok(match.ref !== newer);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('matchLiveSession skips a transcript with no id or no cwd', () => {
  const { root, bucket } = makeStore();
  try {
    writeSession(bucket, 'no-cwd', null);
    assert.equal(storeFor(root).matchLiveSession({ cwd: '/p', sinceMs: 0, claimed: new Set() }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- #209: the birthHint pre-filter (skip the stat for what the NAME already rules out) ---------------
//
// matchLiveSession stat'd EVERY transcript to read its birth time, on the main thread, on every watcher
// flush while a session was unpaired: ~163 ms of pure stat for a 5000-transcript store. A backend whose
// filename carries the start time can reject the old ones before touching the disk.

// The synthetic backend again, but declaring a birthHint: `log-<epochMs>-<id>.jsonl`.
function storeWithHint(root, { onStat } = {}) {
  return createFileStore({
    root: () => root,
    matches: (name) => name.startsWith('log-') && name.endsWith('.jsonl'),
    parseSession: (handle) => {
      try {
        const head = JSON.parse(fs.readFileSync(handle.path, 'utf8').split('\n')[0]);
        return { sessionId: head.id, cwd: head.cwd };
      } catch { return null; }
    },
    refSuffix: (id) => `-${id}.jsonl`,
    birthHint: (name) => {
      if (onStat) onStat(name);
      const m = /^log-(\d+)-/.exec(name);
      return m ? Number(m[1]) : null;
    },
  });
}

test('birthHint rejects a transcript the NAME proves is older than the spawn — without stat-ing it', () => {
  const { root, bucket } = makeStore();
  try {
    const spawn = Date.now();
    // The file's REAL birth is now (it was just written), so a stat would happily accept it. Only the
    // name says it is a week old. If the record is still returned, the hint never ran.
    const old = path.join(bucket, `log-${spawn - 7 * 24 * 3600_000}-week-old.jsonl`);
    fs.writeFileSync(old, JSON.stringify({ id: 'week-old', cwd: '/p' }) + '\n');

    assert.equal(storeWithHint(root).matchLiveSession({ cwd: '/p', sinceMs: spawn, claimed: new Set() }), null,
      'the name alone ruled it out — no stat, no match');
    // Control: the SAME file, through a store with no birthHint, IS matched (its real birth is post-spawn).
    // This is what proves the skip above came from the hint and not from the file being genuinely old.
    const viaStat = storeFor(root).matchLiveSession({ cwd: '/p', sinceMs: spawn - 60_000, claimed: new Set() });
    assert.equal(viaStat && viaStat.sessionId, 'week-old', 'without the hint the stat accepts it (control)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('birthHint never rejects inside the skew margin — a nameless timezone must not lose a session', () => {
  // A filename carries no timezone in the formats we read, so a hint can be a whole UTC offset out. If the
  // margin were tight, that misreading would drop the session's OWN record and it would never pair.
  const { root, bucket } = makeStore();
  try {
    const spawn = Date.now();
    // The name claims 13 h before the spawn — the worst a UTC-offset misreading can produce. Inside the
    // 24 h margin, so it must still be stat'd (and its real birth is post-spawn → it matches).
    const file = path.join(bucket, `log-${spawn - 13 * 3600_000}-tz-skewed.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ id: 'tz-skewed', cwd: '/p' }) + '\n');

    const match = storeWithHint(root).matchLiveSession({ cwd: '/p', sinceMs: spawn - 60_000, claimed: new Set() });
    assert.equal(match && match.sessionId, 'tz-skewed', 'a hint inside the margin is not trusted to mean "old"');
    assert.ok(BIRTH_HINT_SKEW_MS >= 14 * 3600_000, 'the margin must cover every real UTC offset');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('birthHint falls through to the stat when it cannot answer (unparseable name, a throw, no sinceMs)', () => {
  const { root, bucket } = makeStore();
  try {
    const spawn = Date.now();
    // A name the hint cannot parse → null → must be stat'd like any other file, not silently dropped.
    writeSession(bucket, 'no-stamp', '/p');
    assert.equal(storeWithHint(root).matchLiveSession({ cwd: '/p', sinceMs: spawn - 60_000, claimed: new Set() })?.sessionId,
      'no-stamp', 'an unparseable name is not a reject');

    // A hint that THROWS must not take the match down with it.
    const throwing = createFileStore({
      root: () => root,
      matches: (name) => name.startsWith('log-') && name.endsWith('.jsonl'),
      parseSession: () => ({ sessionId: 'no-stamp', cwd: '/p' }),
      refSuffix: (id) => `-${id}.jsonl`,
      birthHint: () => { throw new Error('bad name'); },
    });
    assert.equal(throwing.matchLiveSession({ cwd: '/p', sinceMs: spawn - 60_000, claimed: new Set() })?.sessionId,
      'no-stamp', 'a throwing hint falls through to the stat');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('createFileStore refuses a birthHint that is not a function', () => {
  assert.throws(() => createFileStore({
    root: () => '/tmp', matches: () => true, parseSession: () => null, refSuffix: () => '', birthHint: 'nope',
  }), /birthHint must be a function/);
});

test('liveRefFor finds a RESUMED session by id, whatever the record\'s age', () => {
  // matchLiveSession only accepts records born after the spawn, which a resumed session's transcript
  // never is. Without this hook the resumed session claims nothing — and the stale claim then adopts the
  // id of the next NEW session in the same cwd.
  const { root, bucket } = makeStore();
  try {
    const file = writeSession(bucket, 'RESUMED-1', '/p');
    const store = storeFor(root);

    assert.equal(store.liveRefFor('RESUMED-1'), file);
    assert.equal(store.liveRefFor('resumed-1'), file, 'the id is matched case-insensitively');
    assert.equal(store.liveRefFor('11111111-2222-4333-8444-555555555555'), null,
      'a store must never claim to know an id it never issued');
    assert.equal(store.liveRefFor(null), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('liveRefFor matches the SUFFIX, not a substring of the id', () => {
  // `_<uuid>.jsonl` (Pi) and `-<uuid>.jsonl` (Codex) are the shapes; a bare `includes()` would let a
  // session whose id merely CONTAINS another's claim the wrong transcript.
  const { root, bucket } = makeStore();
  try {
    writeSession(bucket, 'abc', '/p');           // log-abc.jsonl
    const store = storeFor(root);
    assert.match(store.liveRefFor('abc'), /log-abc\.jsonl$/);
    assert.equal(store.liveRefFor('b'), null, 'a suffix of the id is not the id');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('findOnPath honours PATHEXT — the npm CLIs are .cmd shims on Windows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-store-path-'));
  const oldPath = process.env.PATH;
  const oldExt = process.env.PATHEXT;
  try {
    const ext = process.platform === 'win32' ? '.CMD' : '';
    const exe = path.join(dir, 'faketool' + ext);
    fs.writeFileSync(exe, '');
    process.env.PATH = dir;
    process.env.PATHEXT = '.EXE;.CMD;.BAT';

    assert.equal(findOnPath('faketool'), exe);
    assert.equal(findOnPath('nosuchtool'), null);
  } finally {
    process.env.PATH = oldPath;
    if (oldExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = oldExt;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #240: there used to be a second PATHEXT fallback in main.js (`.COM;.EXE;.BAT;.CMD` there,
// `.EXE;.CMD;.BAT` here) — one question, two answers, on the path that decides whether a backend's CLI is
// found at all. Now there is one list and one walk; main.js's resolveArgvExecutable calls findOnPath and
// only adds its own shim check. Read as text because main.js needs Electron and cannot be required.
test('the PATHEXT fallback exists once, and keeps .CMD', () => {
  const oldExt = process.env.PATHEXT;
  try {
    delete process.env.PATHEXT;
    const exts = pathExtensions();
    if (process.platform === 'win32') {
      assert.ok(exts.includes('.CMD'), 'the npm CLIs are .cmd shims — dropping it hides installed backends');
      assert.ok(exts.includes('.EXE') && exts.includes('.BAT') && exts.includes('.COM'));
    } else {
      assert.deepEqual(exts, [''], 'no extension juggling off Windows');
    }
  } finally {
    if (oldExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = oldExt;
  }

  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.doesNotMatch(MAIN, /process\.env\.PATHEXT/,
    'main.js must not grow its own PATHEXT list back — it calls findOnPath');
});
