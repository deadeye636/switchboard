'use strict';
// The harness the `src/app/agent-rpc.js` test files share (#568, #643).
//
// Each test drives the real module against a REAL child on a REAL pipe — the stand-in for `pi --mode rpc`
// in `test/fixtures/fake-rpc-agent.js` — so what is exercised is the core moving a real backend's ops
// rather than a mock agreeing with itself. That costs a process per test, which is why the tests are
// split across several files by subject: node parallelises across FILES and not within one, and one file
// holding all of them measured 35 s alone and failed under the suite's own concurrency.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const agentRpc = require('../../src/app/agent-rpc');
const piNative = require('../../src/backends/pi-native');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'fake-rpc-agent.js');
const TAG = 'tag-1';
// The session's project, and therefore what an `@` completes against and what a relative path a user
// types is resolved from. It is the TEST directory rather than this one: tests assert against paths
// inside it (`fixtures/…`), and it must not move when a helper does.
const SESSION_CWD = path.join(__dirname, '..');

// `rpc` and `fixture` swap in another protocol half and the child that speaks it
// (`agent-rpc-stream.test.js`); the default is pi-native's own half against the Pi stand-in.
function harness({ dataDir, env, timeouts, rpc, fixture } = {}) {
  const activeSessions = new Map();
  const sent = [];
  const signals = [];
  const rekeys = [];
  const clipped = [];
  const logged = [];
  const window = { isDestroyed: () => false, webContents: { send: (ch, id, op) => sent.push({ ch, id, op }) } };
  agentRpc.init({
    activeSessions,
    getMainWindow: () => window,
    windowForSession: () => window,
    getAppQuitting: () => false,
    // The re-key every live binding goes through, reduced to what it does to the map.
    adoptSessionId: (tag, id) => {
      for (const [key, s] of activeSessions) {
        if (s && s._terminalTag === tag && key !== id) {
          activeSessions.delete(key);
          activeSessions.set(id, s);
          s.realSessionId = id;
          rekeys.push({ from: key, to: id });
          return { from: key, to: id, kind: 'terminal' };
        }
      }
      return null;
    },
    deliverBindSignal: (sessionId, hook) => signals.push({ sessionId, ...hook }),
    // Electron's own parts arrive through ctx, which is what keeps this module loadable here at all.
    dataDir,
    clipboard: { writeText: (text) => clipped.push(text) },
    log: { info: (line) => logged.push(line), warn() {}, debug() {} },
  });
  const proc = agentRpc.start({
    tag: TAG, rpc: rpc || piNative.rpc, command: process.execPath, args: [fixture || FIXTURE], cwd: SESSION_CWD, env: { ...process.env, ...(env || {}) }, label: 'Fake', timeouts,
  });
  activeSessions.set('launch-id', { pty: proc, _terminalTag: TAG, exited: false });
  return { activeSessions, sent, signals, rekeys, clipped, logged, proc };
}

// Kill the child AND wait for it to be gone. `agentRpc` holds one module-level ctx, so a late op from a
// session still dying is delivered to whatever window is current — which is the NEXT test's. That is a
// property of driving one module from several harnesses, not of the app, where there is one ctx for the
// life of the process; waiting here is what keeps it out of the next test's assertions.
const stopped = (h) => new Promise((resolve) => {
  let done = false;
  const end = () => { if (!done) { done = true; setTimeout(resolve, 20); } };
  h.proc.onExit(end);
  h.proc.kill();
  setTimeout(end, 2000);
});

const tempDataDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-agent-rpc-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS will */ } });
  return dir;
};

// The default budget is generous because every wait here crosses a real process boundary, and the suite's
// own concurrency is enough to push a couple of round trips past a few seconds on a busy machine.
const until = async (cond, ms = 20000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
};

module.exports = { harness, stopped, tempDataDir, until, agentRpc, piNative, FIXTURE, TAG, SESSION_CWD };
