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

function setup(entries, backends = {}) {
  liveSessions.init({
    activeSessions: new Map(entries),
    sessionBackends: { get: (id) => (backends[id] ? { backendId: backends[id] } : null) },
  });
}

const live = (over = {}) => ({ projectPath: '/p', _openedAt: 1000, exited: false, ...over });

test('a live session is reported with what the renderer needs to draw it', () => {
  setup([['s1', live()]], { s1: 'hermes' });

  assert.deepEqual(liveSessions.snapshot(), [{
    sessionId: 's1', projectPath: '/p', backendId: 'hermes', isPlainTerminal: false, startedAt: 1000,
  }]);
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
