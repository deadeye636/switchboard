// backends/pi/exec-command.js — how to start Pi without a shell.
//
// On Windows `pi` is an npm `.cmd` shim, and a process started without a shell cannot run one. The shim only
// hands its arguments to `node <package>/dist/cli.js`, so that is what is started instead; elsewhere the
// binary on PATH runs as it is.
//
// Two callers, which is why this is its own module rather than a function on the descriptor: the model probe
// in `./index.js` (`pi --list-models` through `execFile`) and the runtime-driven backend in `../pi-native/`,
// which runs Pi on a pipe (#568). A descriptor key would have been a capability every template inherits.
'use strict';

const path = require('path');
const { findOnPath } = require('../file-store');

function piExecCommand() {
  const exe = findOnPath('pi');
  if (!exe) return { command: 'pi', args: [] };
  if (process.platform === 'win32' && /\.cmd$/i.test(exe)) {
    const cli = path.join(path.dirname(exe), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    return { command: 'node', args: [cli] };
  }
  return { command: exe, args: [] };
}

module.exports = { piExecCommand };
