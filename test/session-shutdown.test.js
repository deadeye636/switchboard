'use strict';
// Quitting must not leave a CLI running (#424). The defect was never that `pty.kill()` fails — a single
// kill was measured to work — but that nothing waited for it and nothing checked afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const shutdown = require('../src/app/session-shutdown');

function fakeSession(pid, { exited = false, throws = false } = {}) {
  const calls = { killed: 0 };
  return {
    exited,
    calls,
    pty: {
      pid,
      kill() {
        calls.killed++;
        if (throws) throw new Error('handle already closed');
      },
    },
  };
}

function reset() {
  shutdown._pendingPids.clear();
}

// A timer that fires when the test says so, so a 3 s timeout costs nothing to exercise.
function manualTimer() {
  const queue = [];
  return {
    setTimer: (fn) => { queue.push(fn); return queue.length; },
    tick(times = 1) {
      for (let i = 0; i < times; i++) {
        const fn = queue.shift();
        if (fn) fn();
      }
    },
    get pending() { return queue.length; },
  };
}

test('#424: a session that exits in time is neither escalated nor left behind', async () => {
  reset();
  const session = fakeSession(4242);
  assert.equal(shutdown.killSession(session), true);
  assert.equal(session.calls.killed, 1);

  const result = await shutdown.awaitAllStopped({
    isAlive: () => false,
    killTree: () => assert.fail('a process that already exited must not be tree-killed'),
  });

  assert.deepEqual(result.waited, [4242]);
  assert.deepEqual(result.escalated, []);
  assert.deepEqual(result.leftover, []);
  assert.equal(shutdown._pendingPids.size, 0, 'the pid list is cleared, or the next quit waits on a ghost');
});

test('#424: a process still alive at the deadline gets its whole tree killed', async () => {
  reset();
  shutdown.killSession(fakeSession(77));
  const timer = manualTimer();
  const trees = [];
  let alive = true;

  const pending = shutdown.awaitAllStopped({
    timeoutMs: 300,
    isAlive: () => alive,
    killTree: (pid, done) => { trees.push(pid); alive = false; done(); },
    setTimer: timer.setTimer,
  });

  // Three polls at 100 ms reach the deadline; nothing has been escalated before it.
  timer.tick(3);
  const result = await pending;

  assert.deepEqual(trees, [77], 'the stubborn pid is escalated, not merely reported');
  assert.deepEqual(result.escalated, [77]);
  assert.deepEqual(result.leftover, [], 'the tree kill worked, so nothing survives');
});

test('#424: a process that survives even the tree kill is REPORTED, not swallowed', async () => {
  reset();
  shutdown.killSession(fakeSession(99));
  const timer = manualTimer();
  const warnings = [];

  const pending = shutdown.awaitAllStopped({
    timeoutMs: 100,
    isAlive: () => true,                       // nothing ever dies
    killTree: (pid, done) => done(),
    setTimer: timer.setTimer,
    log: { warn: (msg) => warnings.push(msg), info() {} },
  });
  timer.tick(1);
  const result = await pending;

  assert.deepEqual(result.leftover, [99]);
  assert.equal(warnings.length, 1, 'a CLI still running after a quit must leave a trace somewhere');
  assert.match(warnings[0], /99/);
});

test('#424: a session already marked exited is not killed and not waited on', async () => {
  reset();
  const session = fakeSession(5, { exited: true });
  assert.equal(shutdown.killSession(session), false);
  assert.equal(session.calls.killed, 0);
  assert.equal(shutdown._pendingPids.size, 0);

  const result = await shutdown.awaitAllStopped({ isAlive: () => true });
  assert.deepEqual(result.waited, [], 'nothing was killed, so the quit waits for nothing');
});

test('#424: a kill that throws is not waited on either', async () => {
  reset();
  const session = fakeSession(6, { throws: true });
  assert.equal(shutdown.killSession(session), false);
  assert.equal(shutdown._pendingPids.size, 0,
    'a handle that outlived its process must not hold the quit for the full timeout');
});

test('#424: killAll walks the session map and counts what it asked to stop', () => {
  reset();
  const sessions = new Map([
    ['a', fakeSession(11)],
    ['b', fakeSession(12, { exited: true })],
    ['c', fakeSession(13)],
  ]);
  assert.equal(shutdown.killAll(sessions), 2);
  assert.deepEqual([...shutdown._pendingPids].sort((x, y) => x - y), [11, 13]);
});

test('#424: the pid list survives the map being emptied — that is the whole point', () => {
  reset();
  const sessions = new Map([['a', fakeSession(21)]]);
  shutdown.killAll(sessions);
  sessions.clear();   // what the window's `closed` handler does immediately afterwards
  assert.deepEqual([...shutdown._pendingPids], [21],
    'the quit path has no session list left; without the remembered pid it can check nothing');
});

// --- The wiring, because the logic above is worth nothing if the quit does not use it ---

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('#424: the quit HOLDS for the processes instead of exiting hopefully', () => {
  const lifecycle = read('src/app/lifecycle.js');
  assert.match(lifecycle, /event\.preventDefault\(\)/,
    'before-quit must cancel its first pass, or nothing can be awaited before the process goes');
  assert.match(lifecycle, /awaitAllStopped/,
    'the quit must wait for the kills it fired');
  assert.match(lifecycle, /sessionsConfirmedStopped/,
    'the second pass needs a way through, or the app can never quit at all');
});

test('#424: both kill sites go through the module that remembers', () => {
  for (const rel of ['src/app/lifecycle.js', 'src/app/windows.js']) {
    const src = read(rel);
    assert.match(src, /sessionShutdown\.killAll\(/, `${rel} must kill through session-shutdown`);
    assert.doesNotMatch(src, /session\.pty\.kill\(\)/,
      `${rel} still kills a pty directly — that pid is then forgotten and nothing checks it`);
  }
});
