'use strict';
// What main knows about a running session (#461).
//
// The renderer builds its session list from the index. A session whose backend never wrote a store record
// is not in it, so after a reload the window has a live PTY id and no way to name what it belongs to. This
// is the answer to that: the facts main holds anyway, on a channel of their own rather than folded into
// the projects payload, which has not seen these sessions.

const test = require('node:test');
const assert = require('node:assert/strict');

const liveSessions = require('../src/app/live-sessions');

// `rebinding` is which backend ids declare `supportsLiveRebinding` — the capability half of #305. Claude
// and Pi declare it in the real registry; a test that needs the other half names it here.
function setup(entries, backends = {}, rebinding = ['claude', 'pi']) {
  liveSessions.init({
    activeSessions: new Map(entries),
    sessionBackends: { get: (id) => (backends[id] ? { backendId: backends[id] } : null) },
    backends: { get: (id) => (id ? { id, supportsLiveRebinding: rebinding.includes(id) } : null) },
  });
}

const live = (over = {}) => ({ projectPath: '/p', _openedAt: 1000, exited: false, ...over });

test('a live session is reported with what the renderer needs to draw it', () => {
  setup([['s1', live()]], { s1: 'hermes' });

  assert.deepEqual(liveSessions.snapshot(), [{
    sessionId: 's1', projectPath: '/p', backendId: 'hermes', isPlainTerminal: false,
    liveBound: false, liveBindingMissing: false, startedAt: 1000,
  }]);
});

test('a session reports whether its live binding actually reached the spawn (#305)', () => {
  // `supportsLiveRebinding` says a backend CAN report; this says the argument that makes it report was
  // appended to THIS spawn. Everything that can stop that is swallowed on purpose — no hook URL, a
  // backend that declines, a throw — and without this a session that will never say a word looks
  // exactly like one that has nothing to say.
  setup([['s1', live({ _liveBound: true })]], { s1: 'claude' });
  assert.equal(liveSessions.snapshot()[0].liveBound, true);

  setup([['s2', live()]], { s2: 'claude' });
  assert.equal(liveSessions.snapshot()[0].liveBound, false,
    'a spawn that never got the argument reports false, not undefined');
});

// `liveBindingMissing` is the PAIRING of the two facts, answered here because both live in this process:
// a backend that CAN report, on a spawn that did not get what makes it report. A consumer that has to
// remember to ask the second question is one that will one day forget — and the renderer, which is where
// it is read, may not ask it at all (no backend id there, CLAUDE.md reflex 5).
test('#305: only a backend that CAN report counts as missing its binding', () => {
  setup([['s1', live()]], { s1: 'claude' });
  assert.equal(liveSessions.snapshot()[0].liveBindingMissing, true,
    'Claude declares the capability and this spawn did not get the argument');

  setup([['s1', live({ _liveBound: true })]], { s1: 'claude' });
  assert.equal(liveSessions.snapshot()[0].liveBindingMissing, false, 'a bound spawn is not missing it');

  setup([['s1', live()]], { s1: 'codex' });
  assert.equal(liveSessions.snapshot()[0].liveBindingMissing, false,
    'a backend that never could report is the NORMAL case, not a defect to mark');
});

test('#305: a plain terminal is never missing a binding it was never meant to have', () => {
  setup([['s1', live({ isPlainTerminal: true })]], { s1: 'claude' });
  const row = liveSessions.snapshot()[0];
  assert.equal(row.isPlainTerminal, true);
  assert.equal(row.liveBindingMissing, false);
});

test('#305: the answer fails toward silence when it cannot be established', () => {
  // A mark that appears because a lookup failed is worse than no mark at all: it accuses a session that
  // is working. So an unmapped session, a registry that is not there, and one that throws all say false.
  setup([['s1', live()]], {});
  assert.equal(liveSessions.snapshot()[0].liveBindingMissing, false, 'no backend id, no accusation');

  liveSessions.init({
    activeSessions: new Map([['s1', live()]]),
    sessionBackends: { get: () => ({ backendId: 'claude' }) },
  });
  assert.equal(liveSessions.snapshot()[0].liveBindingMissing, false, 'no registry in ctx, no accusation');

  liveSessions.init({
    activeSessions: new Map([['s1', live()]]),
    sessionBackends: { get: () => ({ backendId: 'claude' }) },
    backends: { get: () => { throw new Error('registry blew up'); } },
  });
  assert.equal(liveSessions.snapshot()[0].liveBindingMissing, false, 'a throw is not evidence either');
});

test('an exited session is not live', () => {
  setup([['s1', live({ exited: true })]]);
  assert.deepEqual(liveSessions.snapshot(), []);
});

test('a session that was adopted is reported under the id its backend chose', () => {
  // The row on screen is drawn for the adopted id, so reporting the launch id would name something the
  // window cannot match against anything.
  setup([['temp-1', live({ realSessionId: 'codex-real' })]], { 'codex-real': 'codex' });

  assert.deepEqual(liveSessions.snapshot().map((s) => s.sessionId), ['codex-real']);
  assert.equal(liveSessions.snapshot()[0].backendId, 'codex');
});

test('both keys of one adopted session are one row, not two', () => {
  // `activeSessions` can hold a session under its launch id AND its adopted one around an adoption. Two
  // entries for one process would become two rows for one session.
  const session = live({ realSessionId: 'codex-real' });
  setup([['temp-1', session], ['codex-real', session]], { 'codex-real': 'codex' });

  assert.equal(liveSessions.snapshot().length, 1);
});

test('a plain terminal says so rather than being left out', () => {
  // It is a live process with a project, and the window has the same problem naming it. Whether it
  // belongs in a session list is the caller's decision, not this one's.
  setup([['t1', live({ isPlainTerminal: true })]]);

  assert.equal(liveSessions.snapshot()[0].isPlainTerminal, true);
});

test('a session with no backend mapping still reports', () => {
  // The mapping is written when the session is launched; a race that reads before it lands must not drop
  // the session, which is the one thing this exists to prevent.
  setup([['s1', live()]]);

  assert.deepEqual(liveSessions.snapshot()[0].backendId, '');
});

test('registerIpc answers on its own channel', () => {
  const handlers = {};
  setup([['s1', live()]], { s1: 'pi' });
  liveSessions.registerIpc({ handle: (channel, fn) => { handlers[channel] = fn; } });

  assert.equal(handlers['live-sessions:get']().length, 1);
});

test('an uninitialised module answers nothing rather than throwing', () => {
  liveSessions.init({});
  assert.deepEqual(liveSessions.snapshot(), []);
});
