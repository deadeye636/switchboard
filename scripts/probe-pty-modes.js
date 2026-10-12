// Which terminal mode requests and OSC sequences a program's output still carries after the PTY layer (#775).
// It starts the program in node-pty the way the app does (ConPTY on Windows), collects its output for a few
// seconds, and prints the DEC private modes set or reset (`?1049h`, `?1003h`, …) and the OSC numbers seen.
// Prints sequences and a byte count only, never the output text.
//
// node-pty is built for Electron's ABI, so run it with Electron as Node:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron <this file> [--dll] [--ms=<n>] -- <command> [args...]
//   --dll       use the bundled conpty.dll (the app's default; `conptyBackend: system` turns it off)
//   --ms=<n>    how long to collect (default 8000)
// Run it once with a command that only WRITES the sequences (`node -e "process.stdout.write('\x1b[?1003h')"`)
// to see what the PTY layer passes, then with the CLI itself to see what the CLI sends.
// The last measurement is in issue #775: ConPTY drops ?1000/1002/1003/1006h with either backend, OSC 7501 passes.
'use strict';

const path = require('path');

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const opts = split === -1 ? argv : argv.slice(0, split);
const cmd = split === -1 ? [] : argv.slice(split + 1);
if (!cmd.length) {
  console.error('usage: ELECTRON_RUN_AS_NODE=1 electron scripts/probe-pty-modes.js [--dll] [--ms=<n>] -- <command> [args...]');
  process.exit(2);
}
const useConptyDll = opts.includes('--dll');
const msOpt = opts.find(o => o.startsWith('--ms='));
const ms = msOpt ? Number(msOpt.slice(5)) || 8000 : 8000;

const pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;   // the child is the program under test, not Electron

// node-pty on Windows wants a path, not a name it would look up itself.
const file = path.isAbsolute(cmd[0]) ? cmd[0] : (require('../src/backends/file-store').findOnPath(cmd[0]) || cmd[0]);
const child = pty.spawn(file, cmd.slice(1), { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.cwd(), env, useConptyDll });
let out = '';
child.onData(d => { out += d; });
child.onExit(e => console.log('exit', e.exitCode));

setTimeout(() => {
  const modes = new Set([...out.matchAll(/\x1b\[\?([\d;]+)([hl])/g)].map(m => m[1] + m[2]));
  const oscs = new Set([...out.matchAll(/\x1b\](\d+)[;\x07\x1b]/g)].map(m => m[1]));
  console.log('bytes', out.length);
  console.log('dec modes', [...modes].join(' ') || '(none)');
  console.log('osc', [...oscs].join(' ') || '(none)');
  try { child.kill(); } catch {}
  process.exit(0);
}, ms);
