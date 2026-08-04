// session-shutdown.js — stopping every CLI process, and CHECKING that it stopped (#424).
//
// Killing a PTY used to be `session.pty.kill()` at two places, each fire-and-forget, and the quit path
// then dropped the sessions from `activeSessions` in the same breath. So nothing could tell a process
// that died from one that did not: the app exited, and a CLI that outlived its ConPTY host was simply
// orphaned in the background. Measured symptom: Claude still running with no window to reach it from.
//
// A single kill does work — that was measured too, so this is not a fix for `pty.kill()` being wrong.
// What was missing is the second half: on quit, several kills fire at once and the process exits
// immediately afterwards, and an asynchronous kill that has not landed by then never lands at all.
//
// So this module remembers what it killed, waits for those pids to actually go, and escalates to the
// process TREE for whatever is left. The remembering is what makes it work across the two call sites:
// the window's `closed` handler empties `activeSessions`, so by the time `before-quit` runs there is no
// session list left to check — but there is still a list of pids.
//
// ELECTRON-FREE, and every side effect is injected, so `node --test` can drive the timeout and the
// escalation without spawning anything.
'use strict';

const { execFile } = require('child_process');

// How long a CLI gets to exit on its own after being asked. Long enough for a busy Claude to finish
// its signal handling, short enough that quitting never feels hung — and quitting is the one moment a
// user reads a delay as a crash.
const DEFAULT_TIMEOUT_MS = 3000;
const POLL_MS = 100;

/** Is this pid still alive? Signal 0 tests for existence without touching the process. */
function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — alive, for our purposes.
    return err && err.code === 'EPERM';
  }
}

/**
 * Kill a whole process tree.
 *
 * `pty.kill()` ends the pty's own process. A CLI that spawned children of its own — or one whose
 * ConPTY host outlives it — leaves those behind, and on Windows there is no process group to signal.
 * `taskkill /T` is the only thing that reliably takes the tree; elsewhere SIGKILL on the pid is.
 *
 * execFile, never a shell string: the pid is interpolated, and this runs at quit when nothing is
 * watching the output (rule 10 in CLAUDE.md).
 */
function defaultKillTree(pid, done) {
  if (!Number.isInteger(pid) || pid <= 0) return done();
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => done());
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  done();
}

// The pids this module has asked to stop and has not yet seen go. Module-level on purpose: the two
// call sites are in different modules and the second one runs after the session list is gone.
const pendingPids = new Set();

/**
 * Ask one session's process to stop, and remember it.
 *
 * Returns whether a kill was actually attempted — a session already marked exited is not killed twice,
 * and its pid is not waited on.
 */
function killSession(session) {
  if (!session || session.exited || !session.pty) return false;
  const pid = session.pty.pid;
  try {
    session.pty.kill();
  } catch {
    // Already gone, or a handle that outlived its process. Either way it is not ours to wait for.
    return false;
  }
  if (Number.isInteger(pid) && pid > 0) pendingPids.add(pid);
  return true;
}

/** Ask every live session in a map to stop. Returns how many kills were attempted. */
function killAll(activeSessions) {
  let killed = 0;
  for (const [, session] of activeSessions || []) {
    if (killSession(session)) killed++;
  }
  return killed;
}

/**
 * Say how the wait ended — ALWAYS, not only when something went wrong (#397).
 *
 * Silence on the good path was the gap. A clean quit's last line was the window teardown's, which is
 * the exact line the one observed hang stopped at too, so the log could not tell the two apart. A step
 * that says nothing when it succeeds cannot say where it stopped when it does not.
 *
 * `how` separates the two ways this ends without a poll seeing the pids go: an escalation that ran, and
 * the hard deadline giving up on one that did not answer.
 */
function report(log, { waited, escalated, leftover, how }) {
  if (!log) return;
  const at = how === 'deadline' ? ' at the hard deadline' : '';
  if (leftover.length) {
    if (typeof log.warn === 'function') {
      log.warn(`[shutdown] ${leftover.length} of ${waited.length} process(es) survived the stop${at}: ${leftover.join(', ')}`);
    }
    return;
  }
  if (typeof log.info !== 'function') return;
  if (how === 'deadline') {
    log.info(`[shutdown] ${waited.length} process(es) confirmed gone at the hard deadline`);
  } else if (escalated.length) {
    log.info(`[shutdown] ${waited.length} process(es) stopped, ${escalated.length} needed a tree kill`);
  } else {
    log.info(`[shutdown] ${waited.length} process(es) stopped`);
  }
}

/**
 * Wait for everything that was killed to be gone, then escalate for the rest.
 *
 * Resolves with `{ waited, escalated, leftover, how }` — `leftover` is what survived even the tree kill,
 * and it is the only outcome worth a warning: a user who quits and finds a CLI still running has no way
 * to find out why, which is the whole failure this module exists to end. `how` is how the wait ended
 * (`gone` / `escalated` / `deadline`), and every one of them is logged (#397).
 */
function awaitAllStopped({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  isAlive = defaultIsAlive,
  killTree = defaultKillTree,
  setTimer = setTimeout,
  log = null,
} = {}) {
  const waited = [...pendingPids];
  if (waited.length === 0) return Promise.resolve({ waited: [], escalated: [], leftover: [], how: 'gone' });

  return new Promise((resolve) => {
    let elapsed = 0;
    let settled = false;

    const finish = (escalated, how) => {
      if (settled) return;
      settled = true;
      const leftover = escalated.filter((pid) => isAlive(pid));
      for (const pid of waited) pendingPids.delete(pid);
      report(log, { waited, escalated, leftover, how });
      resolve({ waited, escalated, leftover, how });
    };

    const escalate = () => {
      const stubborn = waited.filter((pid) => isAlive(pid));
      if (stubborn.length === 0) return finish([], 'gone');
      let outstanding = stubborn.length;
      for (const pid of stubborn) {
        killTree(pid, () => {
          if (settled) return;
          outstanding -= 1;
          if (outstanding === 0) finish(stubborn, 'escalated');
        });
      }
    };

    // THE HARD DEADLINE, and it is the reason this cannot hang the app.
    //
    // Everything above depends on someone else finishing: `isAlive` on the OS, and `killTree` on a
    // `taskkill` that has to call its callback. A taskkill that never returns — a zombie, an antivirus
    // holding the handle, a permission prompt nobody sees — would leave `outstanding` above zero forever,
    // and the quit that awaits this would never come back. An app that will not close is a worse failure
    // than the orphaned process this module exists to prevent, so the answer is guaranteed to arrive:
    // whatever has not been settled by the deadline is reported as leftover and the quit continues.
    setTimer(() => finish(waited.filter((pid) => isAlive(pid)), 'deadline'), timeoutMs * 2);

    const poll = () => {
      if (settled) return;
      if (waited.every((pid) => !isAlive(pid))) return finish([], 'gone');
      elapsed += POLL_MS;
      if (elapsed >= timeoutMs) return escalate();
      setTimer(poll, POLL_MS);
    };

    poll();
  });
}

/** How many pids are still owed an exit. For the quit's log line — the count is the wait's size. */
function pendingCount() {
  return pendingPids.size;
}

module.exports = {
  killSession,
  killAll,
  awaitAllStopped,
  pendingCount,
  DEFAULT_TIMEOUT_MS,
  // For the suite: the defaults are what production runs, so they are worth exercising directly.
  _defaultIsAlive: defaultIsAlive,
  _pendingPids: pendingPids,
};
