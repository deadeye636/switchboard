'use strict';
// Identity adoption for the backends that name their own sessions (T-4.5 / T-5.3).
//
// Codex and Hermes do not accept our session id — they invent their own in their own store. Until the
// two are reconciled the app shows two rows for one session, the pending row never dies, and a resume
// from the sidebar targets an id the tool never had. This is the code that reconciles them, and every
// rule in it exists because of a specific way it went wrong.
//
// It could not be tested while it lived in main.js (Electron). #213 moved it to watch/adopt.js, which
// takes the session map, the registry and the window through ctx.
const test = require('node:test');
const assert = require('node:assert/strict');

const adopt = require('../src/watch/adopt');

// A backend that names its own sessions: it implements all three identity hooks.
function fakeBackend(over = {}) {
  return {
    id: 'codex',
    label: 'Codex',
    axis: 'B',
    matchLiveSession: () => null,
    liveState: () => null,
    liveRefFor: () => null,
    ...over,
  };
}

function setup({ sessions = [], backend = fakeBackend() } = {}) {
  const sent = [];
  const activeSessions = new Map(sessions);
  const rekeyed = [];
  adopt.liveStoreRef.clear();
  adopt.liveBusy.clear();
  adopt.init({
    activeSessions,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } }),
    backends: { get: () => backend },
    sessionBackends: {
      get: () => ({ backendId: 'codex' }),
      rekeySession: (from, to) => rekeyed.push([from, to]),
    },
    log: { info() {}, warn() {}, error() {} },
  });
  return { activeSessions, sent, rekeyed, backend };
}

const live = (over = {}) => ({ _openedAt: Date.now(), _resumed: false, projectPath: '/p', ...over });

test('a spawned session adopts the id the backend gave itself, and the renderer folds the two rows', () => {
  const { activeSessions, sent, rekeyed } = setup({
    sessions: [['temp-1', live()]],
    backend: fakeBackend({ matchLiveSession: () => ({ sessionId: 'codex-real', ref: '/store/rec.jsonl' }) }),
  });

  adopt.updateBackendLiveStates();

  assert.equal(activeSessions.has('temp-1'), false, 'the temp id is gone');
  assert.equal(activeSessions.get('codex-real')?.realSessionId, 'codex-real', 're-keyed onto the real one');
  assert.deepEqual(rekeyed, [['temp-1', 'codex-real']], 'the backend overlay moved with it');
  assert.deepEqual(sent.find(([ch]) => ch === 'session-forked'), ['session-forked', 'temp-1', 'codex-real'],
    'without this the pending row never dies');
  assert.equal(adopt.liveStoreRef.get('codex-real'), '/store/rec.jsonl');
});

// #155. A new session's record is about to be named BY the backend, so asking "is there a record under
// OUR id?" is guaranteed to come back empty — and liveRefFor walks the whole store, on every watcher
// flush, for every unclaimed session. That walk bought nothing.
test('a NEW session never asks liveRefFor — the answer cannot be yes, and the walk is not free (#155)', () => {
  let asked = 0;
  setup({
    sessions: [['temp-1', live({ _resumed: false })]],
    backend: fakeBackend({
      liveRefFor: () => { asked++; return null; },
      matchLiveSession: () => null,
    }),
  });

  adopt.updateBackendLiveStates();
  assert.equal(asked, 0);
});

// The order matters and the comment says why: matchLiveSession only accepts records born AFTER the
// spawn, so a resumed session's (older) record could never be claimed by it — but it would happily claim
// the NEXT new session's record in the same cwd and collapse two tabs onto one id.
test('a RESUMED session confirms its own record first, and never runs correlation', () => {
  let correlated = 0;
  setup({
    sessions: [['codex-real', live({ _resumed: true })]],
    backend: fakeBackend({
      liveRefFor: (id) => (id === 'codex-real' ? '/store/own.jsonl' : null),
      matchLiveSession: () => { correlated++; return { sessionId: 'someone-else', ref: '/store/other.jsonl' }; },
      liveState: () => 'idle',
    }),
  });

  adopt.updateBackendLiveStates();
  assert.equal(adopt.liveStoreRef.get('codex-real'), '/store/own.jsonl');
  assert.equal(correlated, 0, 'correlation would have stolen the next session\'s record');
});

// A null from liveRefFor is not proof of absence — Hermes' openDb() returns null while its DB is locked,
// and the moment of heaviest write contention is right after a resume. Caching that first "no" would
// leave the session with no busy/idle for good.
test('a resumed session keeps asking until its record answers', () => {
  let calls = 0;
  setup({
    sessions: [['codex-real', live({ _resumed: true })]],
    backend: fakeBackend({
      liveRefFor: () => (++calls >= 3 ? '/store/own.jsonl' : null),
      liveState: () => 'idle',
    }),
  });

  adopt.updateBackendLiveStates();
  assert.equal(adopt.liveStoreRef.has('codex-real'), false, 'locked DB: no answer yet');
  adopt.updateBackendLiveStates();
  adopt.updateBackendLiveStates();
  assert.equal(adopt.liveStoreRef.get('codex-real'), '/store/own.jsonl', 'and it heals on a later flush');
});

test('a record another session already claimed is not offered again', () => {
  const seen = [];
  setup({
    sessions: [['a', live()], ['b', live()]],
    backend: fakeBackend({
      matchLiveSession: ({ claimed }) => {
        seen.push([...claimed]);
        return claimed.has('/store/one.jsonl') ? null : { sessionId: 'one', ref: '/store/one.jsonl' };
      },
    }),
  });

  adopt.updateBackendLiveStates();
  assert.deepEqual(seen[0], [], 'the first asks with nothing claimed');
  assert.deepEqual(seen[1], ['/store/one.jsonl'], 'the second is told what is already taken');
});

test('busy/idle pushes EDGES, not every watcher event', () => {
  let state = 'busy';
  const { sent } = setup({
    sessions: [['codex-real', live({ _resumed: true })]],
    backend: fakeBackend({
      liveRefFor: () => '/store/own.jsonl',
      liveState: () => state,
    }),
  });

  adopt.updateBackendLiveStates();
  adopt.updateBackendLiveStates();   // same state — must say nothing
  state = 'idle';
  adopt.updateBackendLiveStates();

  const busyPushes = sent.filter(([ch]) => ch === 'cli-busy-state');
  assert.deepEqual(busyPushes, [
    ['cli-busy-state', 'codex-real', true],
    ['cli-busy-state', 'codex-real', false],
  ], 'the store fires on every write; the renderer hears only the transitions');
});

test('an exited session drops its claim, so the maps do not grow for the life of the app', () => {
  const session = live({ _resumed: true, realSessionId: 'codex-real' });
  const { activeSessions } = setup({
    sessions: [['codex-real', session]],
    backend: fakeBackend({ liveRefFor: () => '/store/own.jsonl', liveState: () => 'busy' }),
  });

  adopt.updateBackendLiveStates();
  assert.equal(adopt.liveStoreRef.size, 1);
  assert.equal(adopt.liveBusy.get('codex-real'), true);

  session.exited = true;
  adopt.updateBackendLiveStates();
  assert.equal(adopt.liveStoreRef.size, 0, 'and a relaunch re-claims cleanly instead of inheriting a dead ref');
  assert.equal(adopt.liveBusy.size, 0);
  assert.equal(activeSessions.size, 1, 'the session row itself is not this function\'s to remove');
});

test('Claude and plain terminals are skipped — they own their id and report through the terminal', () => {
  let asked = 0;
  setup({
    sessions: [['plain', live({ isPlainTerminal: true })]],
    backend: fakeBackend({ matchLiveSession: () => { asked++; return null; } }),
  });
  adopt.updateBackendLiveStates();

  setup({
    sessions: [['claude-1', live()]],
    backend: { id: 'claude', axis: 'A' },   // no identity hooks at all
  });
  adopt.updateBackendLiveStates();

  assert.equal(asked, 0);
});

// #151: a live session with no store record shows no state at all, forever. Hermes' degraded mode puts it
// there. Say so once — a blank indicator the user cannot explain is worse than a notice.
test('a session with no record is noticed once, not on every flush', () => {
  const session = live({ _openedAt: Date.now() - 60_000 });
  const { sent } = setup({
    sessions: [['temp-1', session]],
    backend: fakeBackend({ matchLiveSession: () => null }),
  });

  adopt.updateBackendLiveStates();
  adopt.updateBackendLiveStates();
  adopt.updateBackendLiveStates();

  const notices = sent.filter(([ch]) => ch === 'session-notice');
  assert.equal(notices.length, 1, 'once');
  assert.equal(notices[0][1], 'temp-1');
});

test('hasUnclaimedStoreSession stops counting a session it has already spoken up about', () => {
  const session = live({ _openedAt: Date.now() - 60_000 });
  setup({
    sessions: [['temp-1', session]],
    backend: fakeBackend({ matchLiveSession: () => null }),
  });

  assert.equal(adopt.hasUnclaimedStoreSession(), true, 'unpaired: the slow tick must keep running');

  adopt.updateBackendLiveStates();          // notices it
  assert.equal(adopt.hasUnclaimedStoreSession(), false,
    'a session that can never pair would otherwise drive a full store walk every 30s, forever');
});
