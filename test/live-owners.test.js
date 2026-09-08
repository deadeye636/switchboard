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
  // The stop hook (#607). `undefined` means the descriptor does not declare it, which is what every
  // backend but Claude does — so the default here is the one that must offer no button.
  stopTarget = undefined,
} = {}) {
  const calls = [];
  const backend = {
    id: 'claude',
    label: 'Claude Code',
    refreshLiveOwners: hooked ? () => { calls.push('claude'); return Promise.resolve(answers); } : undefined,
    liveOwnerStopTarget: stopTarget,
  };
  if (!hooked) delete backend.refreshLiveOwners;
  if (stopTarget === undefined) delete backend.liveOwnerStopTarget;
  const ctx = {
    calls,
    window,
    backend,
    backends: { list: () => [backend], get: (id) => (id === backend.id ? backend : null), isLaunchable: () => launchable },
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

// --- Stopping the process that holds a session (#607) ---------------------------------------------
//
// This is the only place in the app that kills a process it did not start, so the tests are about the
// three things that keep that narrow: the renderer names a session and never a pid, the pid comes from
// the backend's own descriptor, and a backend that will not name one is offered nothing.

const HELD = { sessionId: 'held-1', kind: 'background', pid: 4242, name: 'a job', state: 'blocked' };

// Every entry the poller publishes as stoppable is checked against the OS, so the tests say which pids
// are alive rather than depending on whatever this machine happens to be running.
const alive = (...pids) => (pid) => pids.includes(pid);

/** A `stopForeignPid` stand-in: records the pid it was given, answers what the test wants. */
function fakeStop(answer = { stopped: true, alreadyGone: false, survived: false }) {
  const seen = [];
  const fn = (pid) => { seen.push(pid); return Promise.resolve(answer); };
  fn.seen = seen;
  return fn;
}

test('#607: an entry the backend can name a process for is published as stoppable', async () => {
  setup({ answers: [HELD], stopTarget: (o) => o.pid });
  const [owner] = await liveOwners.poll({ isAlive: alive(4242) });
  assert.equal(owner.canStop, true, 'the dialog reads this to decide whether to offer the button');
});

test('#607: a backend that declares no stop hook publishes nothing stoppable', async () => {
  setup({ answers: [HELD] });
  const [owner] = await liveOwners.poll({ isAlive: alive(4242) });
  assert.equal(owner.canStop, false, 'every backend but Claude declines, and a button that cannot act is worse than none');
});

test('#607: a backend that declines for THIS entry publishes nothing stoppable', async () => {
  // The hook is per entry, not per backend: an entry with no pid has no process to name, and answering
  // the daemon behind it would be a guess at something that hosts sessions nobody asked about.
  setup({ answers: [{ ...HELD, pid: null }], stopTarget: (o) => o.pid });
  const [owner] = await liveOwners.poll({ isAlive: alive(4242) });
  assert.equal(owner.canStop, false);
});

test('#607: stopping kills the pid the DESCRIPTOR named, and refreshes the list', async () => {
  const ctx = setup({ answers: [HELD], stopTarget: (o) => o.pid });
  await liveOwners.poll({ isAlive: alive(4242) });
  const stopPid = fakeStop();

  const result = await liveOwners.stopOwner('held-1', { stopPid, isAlive: alive(4242) });
  assert.equal(result.ok, true);
  assert.deepEqual(stopPid.seen, [4242], 'the pid comes from the backend, never from the caller');
  assert.equal(ctx.calls.length, 3, 'the poll, the refresh after the kill, and the re-poll it publishes');
});

test('#607: a pid that had already exited is a success, not an error', async () => {
  setup({ answers: [HELD], stopTarget: (o) => o.pid });
  await liveOwners.poll({ isAlive: alive(4242) });
  const stopPid = fakeStop({ stopped: false, alreadyGone: true, survived: false });

  const result = await liveOwners.stopOwner('held-1', { stopPid, isAlive: alive(4242) });
  assert.equal(result.ok, true, 'the caller asked for the process to be gone, and it is');
  assert.equal(result.alreadyGone, true, 'and they are told it was already that way');
});

test('#607: a process that survived is reported as a failure', async () => {
  setup({ answers: [HELD], stopTarget: (o) => o.pid });
  await liveOwners.poll({ isAlive: alive(4242) });
  const stopPid = fakeStop({ stopped: false, alreadyGone: false, survived: true });

  const result = await liveOwners.stopOwner('held-1', { stopPid, isAlive: alive(4242) });
  assert.equal(result.ok, false, 'reporting a stop that did not happen sends the user back into the same refusal');
  assert.match(result.error, /did not stop/);
});

// Not a refusal: nothing holding the session IS what the click asked for. Reporting it as a failure gave
// a message that contradicted its own title and sent the user back to "Resume anyway" for a session that
// was already free. What must hold is only that no process was touched.
test('#607: a session nobody is holding is already the wanted state, and nothing is killed', async () => {
  setup({ answers: [HELD], stopTarget: (o) => o.pid });
  await liveOwners.poll({ isAlive: alive(4242) });
  const stopPid = fakeStop();

  const result = await liveOwners.stopOwner('some-other-session', { stopPid, isAlive: alive(4242) });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyGone, true);
  assert.equal(result.pid, null, 'no process was named, so none can be reported as stopped');
  assert.deepEqual(stopPid.seen, [], 'the owner comes from the published list — an unknown id names no process');
});

test('#607: a backend that will not name a process is refused, and nothing is killed', async () => {
  setup({ answers: [HELD] });
  await liveOwners.poll({ isAlive: alive(4242) });
  const stopPid = fakeStop();

  const result = await liveOwners.stopOwner('held-1', { stopPid, isAlive: alive(4242) });
  assert.equal(result.ok, false);
  assert.deepEqual(stopPid.seen, []);
  assert.match(result.error, /cannot name the process/);
});

// The offer has to describe something that exists. A pid out of the CLI's list can be a minute and a
// half old (a 45 s poll over a 60 s cache), and a button offering to end a process that exited yesterday
// is a button about nothing.
test('#607: a pid the OS no longer has is not offered as stoppable', async () => {
  setup({ answers: [HELD], stopTarget: (o) => o.pid });
  const [owner] = await liveOwners.poll({ isAlive: alive() });
  assert.equal(owner.canStop, false);
  assert.equal(owner.sessionId, 'held-1', 'the session is still reported as held — only the offer goes');
});

// The list said stoppable; by the press the process is gone. That is the state the click asked for, so
// it is a success — and it must not be reported as "this backend cannot name the process", which is a
// different answer about a different problem.
test('#607: a pid that died between the offer and the click is a success, not a refusal', async () => {
  setup({ answers: [HELD], stopTarget: (o) => o.pid });
  await liveOwners.poll({ isAlive: alive(4242) });
  const stopPid = fakeStop({ stopped: false, alreadyGone: true, survived: false });

  const result = await liveOwners.stopOwner('held-1', { stopPid, isAlive: alive() });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyGone, true);
  assert.deepEqual(stopPid.seen, [4242], 'it still goes through the one place that decides a pid is gone');
});
