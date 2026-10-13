// app/agent-shell.js — a `!` line run BY THE APP, for a session driven over a pipe whose runtime has no shell
// command of its own (#786).
//
// pi-native's runtime has one: Pi's `bash` RPC runs the line and books the output into its context, so the
// core only forwards the request (`rpc.shellCommand`, #643). Claude Code's stream-json protocol has none — its
// `!` is a feature of the terminal interface, and over the pipe `!ls` is a prompt like any other. So for such
// a runtime the core runs the line here and hands the result to the backend, which carries it into the next
// turn in its own format (`rpc.shellLineResult`, `rpc.carriesShellLines`, `sendCommand`'s `shellLines`).
//
// What this module decides, and nothing else: how the line is started, what it may write, and how it ends.
//
//   - The shell is the one a terminal of this app would open in the session's directory — the caller resolves
//     it from the project's terminal profile and passes its path. Started as a login shell, not an interactive
//     one: there is no terminal behind it (`commandArgs` in `./terminal/shell-profiles.js`).
//   - Standard input is closed. Nothing can type into it, and a command that waits for input would otherwise
//     wait for good; with no stdin it reads an end of file and gets on with it.
//   - Each stream is kept up to OUTPUT_CAP characters, the head, and the line says whether it cut. The app only
//     draws this text and the backend sends the model a smaller cut of its own; a command that writes megabytes
//     must not hold them in the main process.
//   - Stopping takes the whole tree — `taskkill /T` on Windows, the process group elsewhere — because a shell
//     line is usually a shell running something else, and killing the shell alone leaves that running.
//   - No timeout. `!npm test` runs for minutes; Stop and the session's end are the bounds. A line counts as
//     finished when its output streams close, so one that leaves a background child holding them (`!server &`)
//     stays running until Stop — the honest reading, since its output is still coming.
'use strict';

const { spawn, execFile } = require('child_process');
const { commandArgs, closeProbeStdin } = require('./terminal/shell-profiles');

const OUTPUT_CAP = 200000;

/**
 * Runs one shell line. `onOutput(text)` is called with everything written so far, both streams in the order
 * they arrived, each time more arrives. Answers `{ done, stop }`: `done` resolves once with
 * `{ stdout, stderr, exitCode, cancelled, truncated, failed }` — `failed` when the shell could not be started,
 * in which case nothing ran — and `stop()` ends the line and its tree.
 */
function runShellLine({ command, cwd, shellPath, env, onOutput }) {
  let stdout = '';
  let stderr = '';
  let shown = '';
  let truncated = false;
  let cancelled = false;
  let child;
  const { args, verbatim } = commandArgs(shellPath, command, cwd);
  try {
    child = spawn(shellPath, args, {
      cwd,
      // A login Git Bash or MSYS2 shell changes to the home directory unless it is told it was started where
      // it should stay.
      env: { ...(env || process.env), CHERE_INVOKING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      // Its own process group off Windows, so a stop reaches what the shell started too.
      detached: process.platform !== 'win32',
    });
  } catch {
    return { done: Promise.resolve({ stdout: '', stderr: '', exitCode: null, cancelled: false, truncated: false, failed: true }), stop() {} };
  }

  const keep = (have, chunk) => {
    if (have.length >= OUTPUT_CAP) { truncated = true; return have; }
    const room = OUTPUT_CAP - have.length;
    if (chunk.length > room) truncated = true;
    return have + chunk.slice(0, room);
  };
  const take = (which) => (chunk) => {
    if (which === 'stdout') stdout = keep(stdout, chunk); else stderr = keep(stderr, chunk);
    shown = keep(shown, chunk);
    if (typeof onOutput === 'function') {
      try { onOutput(shown); } catch { /* a view that went away is not the line's concern */ }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', take('stdout'));
  child.stderr.on('data', take('stderr'));

  let settled = false;
  const done = new Promise((resolve) => {
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    child.on('error', () => finish({ stdout, stderr, exitCode: null, cancelled, truncated, failed: true }));
    // 'close', not 'exit': the streams are read to the end first, so the last of the output is in.
    child.on('close', (code) => finish({ stdout, stderr, exitCode: code == null ? null : code, cancelled, truncated, failed: false }));
  });

  function stop() {
    if (settled || cancelled) return;
    cancelled = true;
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      closeProbeStdin(execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}));
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    }
  }

  return { done, stop };
}

module.exports = { runShellLine, OUTPUT_CAP };
