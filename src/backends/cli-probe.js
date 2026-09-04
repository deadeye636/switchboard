// backends/cli-probe.js — the one way a BACKEND runs a CLI just to read what it prints (#532).
//
// A probe asks a question and reads stdout: `agy models`, `pi --list-models`, `claude agents --json`,
// `tasklist`. It never writes to the child, and that is exactly where it goes wrong: a child spawned
// with the Node default gets a stdin PIPE that nothing ever closes, so a CLI that reads standard input
// before deciding what to do waits for an end-of-file that is never coming. The probe does not fail —
// it hangs until the timeout, and a subcommand that would have answered in 200 ms costs eight seconds
// and returns nothing.
//
// Antigravity 1.1.23 fixed that on its own side for `agy models` and `agy agents`, which is how it was
// found; the fix on their side does nothing for a user who has not updated, and the same shape sits in
// every sibling. So stdin is closed HERE, on our side, for every probe a backend runs.
//
// The scope really is `src/backends/**`, and `test/cli-probe.test.js` sweeps exactly that. Other parts of
// the app run a CLI to read its output too — shell discovery, the VCS poller — and they are not covered by
// this module today. Do not read the first line as a claim about them.
//
// **The two call shapes need different fixes, and this is the trap.** `spawnSync` and `execFileSync`
// honour a `stdio` option, so they take `PROBE_STDIO`. `execFile` does NOT: Node hands `spawn` an
// allow-list of options (`cwd`, `env`, `shell`, `signal`, `uid`, `gid`, `windowsHide`,
// `windowsVerbatimArguments`) and `stdio` is not on it, so passing one is accepted and silently
// ignored — measured on Node 22, `child.stdin` is still a pipe. An `execFile` probe has to end the
// child's stdin by hand, which is what `closeStdin` is for.
'use strict';

/**
 * `stdio` for a SYNCHRONOUS probe (`spawnSync`, `execFileSync`): no stdin, both output streams captured.
 *
 * stderr stays a pipe because the callers report it — a probe that failed says why, and inheriting it
 * would print a CLI's error into the app's own console instead.
 */
// Frozen: it is one array shared by every synchronous probe, so a caller that edited an element would
// un-fix all of them at once.
const PROBE_STDIO = Object.freeze(['ignore', 'pipe', 'pipe']);

/**
 * End the stdin of a child started with `execFile`, and hand the child back.
 *
 * Wrapping the call (`closeStdin(execFile(...))`) rather than taking a spawner keeps every probe's own
 * arguments where a reader expects them, and works with the injected `exec` the tests pass in — a fake
 * that returns nothing is not an error here, it just has no stdin to close.
 */
function closeStdin(child) {
  try {
    if (child && child.stdin) child.stdin.end();
  } catch {
    // The child may have exited between spawn and here; a stdin that cannot be closed is already closed.
  }
  return child;
}

module.exports = { PROBE_STDIO, closeStdin };
