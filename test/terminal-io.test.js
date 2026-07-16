'use strict';
// What the renderer does to a live PTY: keystrokes, size, redraws, flow control, detach.
//
// Untestable until #213 moved it out of main.js (Electron). The recurring bug class here is not logic,
// it is TIMING: a PTY can die between the `exited` guard and the call on the next line, because its exit
// event has not been processed yet — node-pty then throws synchronously, and an uncaught throw in main
// kills the app. Several of these assert that a throwing PTY is survived, which is the whole point.
const test = require('node:test');
const assert = require('node:assert/strict');

const io = require('../src/app/terminal/io');

// A stand-in ipcMain that just records the handlers, so a test can call them like the renderer would.
function fakeIpc() {
  const on = new Map();
  const handle = new Map();
  return {
    on: (ch, fn) => on.set(ch, fn),
    handle: (ch, fn) => handle.set(ch, fn),
    send: (ch, ...args) => on.get(ch)(null, ...args),
    invoke: (ch, ...args) => handle.get(ch)(null, ...args),
    channels: () => [...on.keys(), ...handle.keys()],
  };
}

function fakePty(over = {}) {
  const calls = { write: [], resize: [], pause: 0, resume: 0 };
  return {
    calls,
    write: (d) => calls.write.push(d),
    resize: (c, r) => calls.resize.push([c, r]),
    pause: () => { calls.pause++; },
    resume: () => { calls.resume++; },
    ...over,
  };
}

function setup(sessions = []) {
  const warnings = [];
  const activeSessions = new Map(sessions);
  io.init({ activeSessions, log: { info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} } });
  const ipc = fakeIpc();
  io.registerIpc(ipc);
  return { ipc, activeSessions, warnings };
}

const session = (over = {}) => ({ pty: fakePty(), exited: false, isPlainTerminal: false, ...over });

test('a keystroke reaches the PTY, and an exited session swallows it', () => {
  const live = session();
  const dead = session({ exited: true });
  const { ipc } = setup([['live', live], ['dead', dead]]);

  ipc.send('terminal-input', 'live', 'ls\r');
  ipc.send('terminal-input', 'dead', 'ls\r');
  ipc.send('terminal-input', 'nonexistent', 'ls\r');

  assert.deepEqual(live.pty.calls.write, ['ls\r']);
  assert.deepEqual(dead.pty.calls.write, []);
});

test('a PTY that dies mid-write does not take the main process with it', () => {
  const s = session({ pty: fakePty({ write: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }) });
  const { ipc, warnings } = setup([['s', s]]);

  assert.doesNotThrow(() => ipc.send('terminal-input', 's', 'x'));
  assert.match(warnings.join(' '), /write failed for session=s/, 'and it says so rather than failing silently');
});

// #74. The renderer pauses the PTY while xterm's write buffer is saturated, so an output firehose backs
// up in the OS pipe instead of flooding IPC.
test('flow control pauses and resumes the PTY', () => {
  const s = session();
  const { ipc } = setup([['s', s]]);

  assert.deepEqual(ipc.invoke('pause-session-output', 's'), { ok: true });
  assert.equal(s.pty.calls.pause, 1);
  assert.deepEqual(ipc.invoke('resume-session-output', 's'), { ok: true });
  assert.equal(s.pty.calls.resume, 1);
});

test('flow control on a dead, unknown or pause-less PTY answers no rather than throwing', () => {
  const dead = session({ exited: true });
  const old = session({ pty: { write() {}, resize() {} } });   // node-pty without pause/resume
  const angry = session({ pty: fakePty({ pause: () => { throw new Error('gone'); } }) });
  const { ipc } = setup([['dead', dead], ['old', old], ['angry', angry]]);

  assert.deepEqual(ipc.invoke('pause-session-output', 'dead'), { ok: false });
  assert.deepEqual(ipc.invoke('pause-session-output', 'nope'), { ok: false });
  assert.deepEqual(ipc.invoke('pause-session-output', 'old'), { ok: false }, 'pause/resume are optional in the API');
  assert.deepEqual(ipc.invoke('resume-session-output', 'old'), { ok: false });
  assert.deepEqual(ipc.invoke('pause-session-output', 'angry'), { ok: false }, 'and a throw is an answer, not a crash');
});

test('a resize reaches the PTY and records the size', () => {
  const s = session();
  const { ipc } = setup([['s', s]]);

  ipc.send('terminal-resize', 's', 100, 40);
  assert.deepEqual(s.pty.calls.resize, [[100, 40]]);
  assert.equal(s._lastCols, 100);
  assert.equal(s._lastRows, 40);
});

// node-pty throws "Cannot resize a pty that has already exited" SYNCHRONOUSLY. Uncaught, that is the
// whole app.
test('a resize on a PTY that just died is swallowed, not fatal', () => {
  const s = session({ pty: fakePty({ resize: () => { throw new Error('Cannot resize a pty that has already exited'); } }) });
  const { ipc, warnings } = setup([['s', s]]);

  assert.doesNotThrow(() => ipc.send('terminal-resize', 's', 80, 24));
  assert.match(warnings.join(' '), /resize on exited pty ignored/);
});

// The nudge exists so a reattached TUI repaints itself: cols+1, then back.
test('the first resize nudges the TUI once, so a reattached TUI repaints', async () => {
  const s = session({ firstResize: true });
  const { ipc } = setup([['s', s]]);

  ipc.send('terminal-resize', 's', 100, 40);
  await new Promise((r) => setTimeout(r, 160));

  assert.deepEqual(s.pty.calls.resize, [[100, 40], [101, 40], [100, 40]]);
  assert.equal(s.firstResize, false, 'and only ever once');
});

// A second resize arriving before the nudge fires CANCELS it, and nothing re-schedules one — `firstResize`
// is already spent. That is deliberate, and it is the startup case: the layout keeps settling for ~100ms
// after the first size push, so the pending nudge would restore the size it was SCHEDULED with, landing
// the TUI prompt rows off until a manual window resize delivered a clean one. No nudge beats a wrong one.
test('a resize that arrives before the nudge fires cancels it rather than repainting at a stale size', async () => {
  const s = session({ firstResize: true });
  const { ipc } = setup([['s', s]]);

  ipc.send('terminal-resize', 's', 100, 40);   // schedules the nudge
  ipc.send('terminal-resize', 's', 120, 50);   // …the layout settled elsewhere first
  await new Promise((r) => setTimeout(r, 160));

  assert.deepEqual(s.pty.calls.resize, [[100, 40], [120, 50]], 'no 101/100 nudge landing on top of 120/50');
});

test('a plain terminal is never nudged — it duplicates the prompt', async () => {
  const s = session({ firstResize: true, isPlainTerminal: true });
  const { ipc } = setup([['s', s]]);

  ipc.send('terminal-resize', 's', 100, 40);
  assert.equal(s._suppressBuffer, true, 'buffering is suppressed so prompt redraws do not pollute the replay');
  await new Promise((r) => setTimeout(r, 260));
  assert.deepEqual(s.pty.calls.resize, [[100, 40]], 'no nudge');
  assert.equal(s._suppressBuffer, false, 'and the suppression is lifted again');
});

// #27: the settle-repaint is disabled globally — it fired on every window resize and made every visible
// grid card flash. A `settle` from the renderer must not resurrect it.
test('the settle nudge stays off even when the renderer asks for it (#27)', async () => {
  const s = session({ firstResize: false });
  const { ipc } = setup([['s', s]]);

  ipc.send('terminal-resize', 's', 100, 40, true);
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(s.pty.calls.resize, [[100, 40]]);
  assert.equal(io.RESIZE_SETTLE_ENABLED, false, 'flip this to bring the cursor fix back, and the flicker with it');
});

test('a redraw nudges once — and does nothing before a size is known', async () => {
  const s = session();
  const { ipc } = setup([['s', s]]);

  ipc.send('terminal-redraw', 's');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(s.pty.calls.resize, [], 'nothing to nudge back to yet');

  ipc.send('terminal-resize', 's', 90, 30);
  ipc.send('terminal-redraw', 's');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(s.pty.calls.resize, [[90, 30], [91, 30], [90, 30]]);
});

test('a redraw skips a plain terminal and an exited one', async () => {
  const plain = session({ isPlainTerminal: true, _lastCols: 80, _lastRows: 24 });
  const dead = session({ exited: true, _lastCols: 80, _lastRows: 24 });
  const { ipc } = setup([['plain', plain], ['dead', dead]]);

  ipc.send('terminal-redraw', 'plain');
  ipc.send('terminal-redraw', 'dead');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(plain.pty.calls.resize, []);
  assert.deepEqual(dead.pty.calls.resize, []);
});

// Closing a TAB is not stopping a SESSION. It keeps running and buffering so it can be reattached —
// dropping it here would kill a Claude mid-turn every time the user closed its tab.
test('closing a tab detaches the renderer but keeps a live session alive', () => {
  const live = session({ rendererAttached: true });
  const { ipc, activeSessions } = setup([['live', live]]);

  ipc.send('close-terminal', 'live');
  assert.equal(live.rendererAttached, false);
  assert.equal(activeSessions.has('live'), true, 'it is still running, and reattachable');
});

test('closing the tab of an already-dead session is what finally drops it', () => {
  const dead = session({ exited: true });
  const { ipc, activeSessions } = setup([['dead', dead]]);

  ipc.send('close-terminal', 'dead');
  assert.equal(activeSessions.has('dead'), false);
});

test('every channel the renderer talks to is registered', () => {
  const { ipc } = setup();
  assert.deepEqual(ipc.channels().sort(), [
    'close-terminal', 'pause-session-output', 'resume-session-output',
    'terminal-input', 'terminal-redraw', 'terminal-resize',
  ]);
});
