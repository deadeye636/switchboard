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

function setup({ sessions = [], backend = fakeBackend(), echo = null, noticeHooks = true } = {}) {
  const sent = [];
  const activeSessions = new Map(sessions);
  const rekeyed = [];
  // "This backend has no record of the session" is published as a state now (#460), not sent as a toast.
  // Recorded here as the two calls adopt makes, so a test can see both the saying and the taking back.
  const noticed = [];   // [sessionId, message]
  const cleared = [];   // sessionId
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
    // The record-only echo to a window of its own (#395). Absent in the older cases on purpose: a ctx
    // without it must not throw.
    sendTimelineSignal: echo ? (id, signal) => echo.push([id, signal]) : undefined,
    // Omitted entirely when `noticeHooks` is false: a ctx without them must not throw, the same
    // contract every other optional hook here has.
    noteMissingStoreRecord: noticeHooks ? (id, message) => noticed.push([id, message]) : undefined,
    clearMissingStoreRecord: noticeHooks ? (id) => cleared.push(id) : undefined,
  });
  return { activeSessions, sent, rekeyed, backend, noticed, cleared };
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

// The busy/idle edge on the ADOPTION tick must be addressed to the id the renderer was just re-keyed to,
// not the launch id. liveId used to be read BEFORE claimLiveRecord adopted, so the first edge went to the
// launch id — which the session-forked fold had just retired — and the real card never updated. Because a
// store like agy then stops changing (its turn ended), no later flush ever corrects it and the card is
// stuck on its launch state ("Running"). This pins liveId being read AFTER the claim.
test('the busy edge on the adoption tick carries the adopted id, not the launch id', () => {
  const { sent } = setup({
    sessions: [['temp-1', live()]],
    backend: fakeBackend({
      matchLiveSession: () => ({ sessionId: 'codex-real', ref: '/store/rec.jsonl' }),
      liveState: () => 'busy',
    }),
  });

  adopt.updateBackendLiveStates();

  const busyPushes = sent.filter(([ch]) => ch === 'cli-busy-state');
  assert.deepEqual(busyPushes, [['cli-busy-state', 'codex-real', true]],
    'addressed to the adopted id — not temp-1, which session-forked has just retired');
  assert.equal(adopt.liveBusy.get('codex-real'), true, 'and the dedup map is keyed by the adopted id');
  assert.equal(adopt.liveBusy.has('temp-1'), false, 'nothing left stranded under the launch id');
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
  const { sent, noticed } = setup({
    sessions: [['temp-1', session]],
    backend: fakeBackend({ matchLiveSession: () => null }),
  });

  adopt.updateBackendLiveStates();
  adopt.updateBackendLiveStates();
  adopt.updateBackendLiveStates();

  assert.equal(noticed.length, 1, 'once');
  assert.equal(noticed[0][0], 'temp-1');
  assert.match(noticed[0][1], /has not recorded this session/);
  // #460 moved it off the toast channel. It went out as a message that faded in eight seconds while the
  // condition it explains lasts as long as the session — the tab is still blank minutes later.
  assert.equal(sent.filter(([ch]) => ch === 'session-notice').length, 0,
    'not a toast any more — the fact is published as a state');
});

// #460: the record can still turn up (the store watcher fires the moment anything is written). A session
// that pairs late shows its state like any other, so the explanation has to go with the condition —
// otherwise the app keeps saying "no state can be shown" beside a dot that is showing one.
test('a record that turns up later takes the explanation back', () => {
  let ref = null;
  const session = live({ _openedAt: Date.now() - 60_000 });
  const { noticed, cleared } = setup({
    sessions: [['temp-1', session]],
    backend: fakeBackend({ matchLiveSession: () => (ref ? { sessionId: 'temp-1', ref } : null), liveState: () => 'idle' }),
  });

  adopt.updateBackendLiveStates();
  assert.equal(noticed.length, 1, 'said once while there was no record');
  assert.deepEqual(cleared, [], 'and nothing taken back while it is still true');

  ref = '/store/rec.jsonl';                  // the backend finally writes it
  adopt.updateBackendLiveStates();
  assert.deepEqual(cleared, ['temp-1'], 'taken back the moment it pairs');
});

test('a session noticed before adoption has the explanation taken back under BOTH ids', () => {
  // The marker is published under the id the session was running as. Adoption renames it, and the row on
  // screen is drawn for the backend's own id — clear only one and a marker outlives its session.
  let match = null;
  const session = live({ _openedAt: Date.now() - 60_000 });
  const { cleared } = setup({
    sessions: [['temp-1', session]],
    backend: fakeBackend({ matchLiveSession: () => match, liveState: () => 'idle' }),
  });

  adopt.updateBackendLiveStates();          // no record yet → noticed under 'temp-1'
  match = { sessionId: 'codex-real', ref: '/store/rec.jsonl' };
  adopt.updateBackendLiveStates();          // adopted AND paired on the same tick

  assert.deepEqual(cleared.sort(), ['codex-real', 'temp-1']);
});

test('a ctx without the notice hooks does not throw', () => {
  const session = live({ _openedAt: Date.now() - 60_000 });
  setup({
    sessions: [['temp-1', session]],
    backend: fakeBackend({ matchLiveSession: () => null }),
    noticeHooks: false,
  });

  assert.doesNotThrow(() => adopt.updateBackendLiveStates());
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

// --- #395: these backends' busy state has no other source ----------------------------------------
//
// Claude reports through its terminal, so the spawn path echoes there. For a backend that names its own
// sessions this watcher IS the only producer — miss it and the recap in a window of its own works for
// one backend and silently not for the others, which is worse than not working at all.

test('#395: a store-derived busy edge is echoed to the window that renders the session', () => {
  const echo = [];
  const { sent } = setup({
    sessions: [['s1', live({ realSessionId: 's1' })]],
    backend: fakeBackend({ liveRefFor: () => '/store/rec.jsonl', liveState: () => 'busy' }),
    echo,
  });
  adopt.liveStoreRef.set('s1', '/store/rec.jsonl');

  adopt.updateBackendLiveStates();

  assert.deepEqual(sent.filter(([c]) => c === 'cli-busy-state'), [['cli-busy-state', 's1', true]],
    'main still hears it exactly as before');
  assert.deepEqual(echo, [['s1', { kind: 'busy', source: 'store', reason: '' }]]);
});

test('#395: the echo carries no backend id', () => {
  const echo = [];
  setup({
    sessions: [['s1', live({ realSessionId: 's1' })]],
    backend: fakeBackend({ id: 'hermes', liveRefFor: () => '/store/rec.jsonl', liveState: () => 'idle' }),
    echo,
  });
  adopt.liveStoreRef.set('s1', '/store/rec.jsonl');
  adopt.liveBusy.set('s1', true);

  adopt.updateBackendLiveStates();

  assert.deepEqual(echo, [['s1', { kind: 'idle', source: 'store', reason: '' }]],
    'source names the KIND of producer, never which backend — that must not cross into the renderer');
});
