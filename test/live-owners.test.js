'use strict';
// The poller behind "this session is running somewhere else" (#172).
//
// It is the part of that feature that costs something: a recurring child process the app did not have
// before. So every test here is about it doing LESS than it could — asking only the backends that can
// answer, only while someone is looking, never during quit — and about the one thing it must never
// report: a session THIS app is running. Marking our own tab as "held elsewhere" would be the app lying
// about its own window, and it is what the spawn guard reads to decide whether to ask.
const test = require('node:test');
const assert = require('node:assert/strict');

const liveOwners = require('../src/app/live-owners');

const CLAUDE_ENTRY = { sessionId: 'bg-1', kind: 'background', pid: null, name: 'a job', state: 'blocked' };

function fakeWindow({ visible = true, minimized = false, destroyed = false } = {}) {
  const sent = [];
  return {
    sent,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    webContents: { send: (...args) => sent.push(args) },
  };
}

function setup({
  answers = [CLAUDE_ENTRY],
  hooked = true,
  launchable = true,
  sessions = [],
  quitting = false,
  window = fakeWindow(),
  detached = [],
} = {}) {
  const calls = [];
  const backend = {
    id: 'claude',
    refreshLiveOwners: hooked ? () => { calls.push('claude'); return Promise.resolve(answers); } : undefined,
  };
  if (!hooked) delete backend.refreshLiveOwners;
  const ctx = {
    calls,
    window,
    backends: { list: () => [backend], isLaunchable: () => launchable },
    activeSessions: new Map(sessions),
    getMainWindow: () => window,
    getDetachedWindows: () => detached,
    getAppQuitting: () => quitting,
    log: { info() {}, debug() {}, warn() {} },
  };
  liveOwners.init(ctx);
  return ctx;
}

test('#172: the answer carries the backend that gave it, and reaches every window', async () => {
  const detached = fakeWindow();
  const ctx = setup({ detached: [detached] });

  const owners = await liveOwners.poll();
  assert.equal(owners.length, 1);
  assert.equal(owners[0].backendId, 'claude', 'the renderer needs to know which CLI said so');
  assert.deepEqual(liveOwners.current(), owners);

  for (const win of [ctx.window, detached]) {
    assert.equal(win.sent.length, 1);
    assert.equal(win.sent[0][0], 'live-owners');
  }
});

// The whole point of the filter: our own tab is not "elsewhere".
test('#172: a session THIS app is running is dropped before anyone hears about it', async () => {
  setup({ sessions: [['bg-1', { exited: false }]] });
  assert.deepEqual(await liveOwners.poll(), [],
    'reporting our own session would refuse a resume of the tab the user is looking at');
});

test('#172: a backend that cannot answer is never asked, and neither is a disabled one', async () => {
  const noHook = setup({ hooked: false });
  await liveOwners.poll();
  assert.deepEqual(noHook.calls, []);

  const disabled = setup({ launchable: false });
  await liveOwners.poll();
  assert.deepEqual(disabled.calls, [], 'a disabled backend must not have its binary run on a timer');
});

test('#172: a CLI that cannot answer empties nothing', async () => {
  setup();
  await liveOwners.poll();
  assert.equal(liveOwners.current().length, 1);

  setup({ answers: null });
  await liveOwners.poll();
  assert.deepEqual(liveOwners.current(), [],
    'a null answer contributes nothing — and with one backend that is an empty list, not a kept one');
});

test('#172: a hook that throws does not take the tick down', async () => {
  const ctx = setup();
  ctx.backends.list = () => [{ id: 'claude', refreshLiveOwners: () => { throw new Error('nope'); } }];
  assert.deepEqual(await liveOwners.poll(), []);
});

// The gates. Each one is the difference between a background process that is invisible and one that is
// not, and a gate that silently stops working makes the whole feature do nothing — which is exactly how
// it failed once, from a window that started hidden.
test('#172: nobody looking, nothing asked', () => {
  const hidden = setup({ window: fakeWindow({ visible: false }) });
  liveOwners._tick();
  assert.deepEqual(hidden.calls, []);

  const minimized = setup({ window: fakeWindow({ minimized: true }) });
  liveOwners._tick();
  assert.deepEqual(minimized.calls, []);

  const watching = setup();
  liveOwners._tick();
  assert.deepEqual(watching.calls, ['claude'], 'a visible window is what makes the answer worth having');
});

test('#172: a detached window counts as someone looking', () => {
  const ctx = setup({ window: fakeWindow({ visible: false }), detached: [fakeWindow()] });
  liveOwners._tick();
  assert.deepEqual(ctx.calls, ['claude'], 'the main window may be minimised while the work is elsewhere');
});

test('#172: the quit asks nothing', () => {
  const ctx = setup({ quitting: true });
  liveOwners._tick();
  assert.deepEqual(ctx.calls, [], 'a child process started during the teardown is one the quit waits for');
});

test('#172: a destroyed window is neither watched nor sent to', async () => {
  const dead = fakeWindow({ destroyed: true });
  const ctx = setup({ window: dead });
  liveOwners._tick();
  assert.deepEqual(ctx.calls, []);
  await liveOwners.poll();
  assert.deepEqual(dead.sent, []);
});

test('#172: start() twice leaves ONE interval behind', () => {
  setup();
  const intervals = [];
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  global.setInterval = (fn, ms) => { const h = { fn, ms, unref() {} }; intervals.push(h); return h; };
  global.clearInterval = (h) => { const i = intervals.indexOf(h); if (i >= 0) intervals.splice(i, 1); };
  try {
    liveOwners.start();
    liveOwners.start();
    assert.equal(intervals.length, 1, 'a second start must replace the first, not run beside it');
    liveOwners.stop();
    assert.equal(intervals.length, 0);
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }
});
