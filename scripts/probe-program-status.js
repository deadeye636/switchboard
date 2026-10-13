// What a CLI reports through OSC 7501 (the Program Status Protocol) while it is driven in a PTY (#774).
// It starts the program in node-pty the way the app does (ConPTY on Windows), types the given lines at the given
// times, and prints every OSC 7501 report with its time and its fields, `msg` decoded and cut to 80 characters.
// Prints no other output text unless --tail asks for it.
//
// node-pty is built for Electron's ABI, so run it with Electron as Node:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron <this file> [options] -- <command> [args...]
//   --dll              use the bundled conpty.dll (the app's default)
//   --answer           answer the detection query (OSC 7501 ; ? ST) the way a supporting terminal does
//   --tail             print the last screen text at the end (to see why a run stopped)
//   --ms=<n>           how long to run (default 60000)
//   --send=<ms>:<text> type <text> at <ms>, then Enter as a separate write (Claude reads the kitty keyboard
//                      protocol, so an Enter in the same write is a newline). <text> `ESC` sends Escape alone,
//                      `ENTER` sends Enter alone, `DOWN` the down arrow, `REPLY` the detection reply unasked.
// Point the CLI at an isolated home (CLAUDE_CONFIG_DIR, PI_CODING_AGENT_DIR) and the smallest model.
// The measurement is in docs/specs/05-hook-attention-detection.md ("OSC 7501").
'use strict';

const path = require('path');

const ESC = '\x1b';
const BEL = '\x07';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const opts = split === -1 ? argv : argv.slice(0, split);
const cmd = split === -1 ? [] : argv.slice(split + 1);
if (!cmd.length) {
  console.error('usage: ELECTRON_RUN_AS_NODE=1 electron scripts/probe-program-status.js [options] -- <command> [args...]');
  process.exit(2);
}
const useConptyDll = opts.includes('--dll');
const answer = opts.includes('--answer');
const tail = opts.includes('--tail');
const msOpt = opts.find(o => o.startsWith('--ms='));
const ms = msOpt ? Number(msOpt.slice(5)) || 60000 : 60000;
const sends = opts.filter(o => o.startsWith('--send=')).map((o) => {
  const body = o.slice(7);
  const at = body.indexOf(':');
  return { at: Number(body.slice(0, at)), text: body.slice(at + 1) };
});

const pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// A run started from inside a Claude Code session inherits its markers, and Claude then runs as a child session.
for (const k of Object.keys(env)) if (/^CLAUDE_?CODE/.test(k)) delete env[k];

const file = path.isAbsolute(cmd[0]) ? cmd[0] : (require('../src/backends/file-store').findOnPath(cmd[0]) || cmd[0]);
const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(6, ' ') + 'ms';
const child = pty.spawn(file, cmd.slice(1), { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.cwd(), env, useConptyDll });

let screen = '';
const printTail = () => {
  if (!tail) return;
  const plain = screen.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '');
  console.log('--- tail ---\n' + plain.replace(/\s+/g, ' ').slice(-400));
};

let carry = '';
child.onData((d) => {
  if (tail) screen = (screen + d).slice(-20000);
  const text = carry + d;
  let last = 0;
  for (const m of text.matchAll(/\x1b\]7501;([^\x07\x1b]*)(\x07|\x1b\\)/g)) {
    last = m.index + m[0].length;
    const fields = m[1] === '?' ? { query: true } : Object.fromEntries(m[1].split(':').map((kv) => {
      const eq = kv.indexOf('=');
      return eq === -1 ? [kv, ''] : [kv.slice(0, eq), kv.slice(eq + 1)];
    }));
    if (fields.msg) {
      try { fields.msg = Buffer.from(fields.msg, 'base64').toString('utf8').slice(0, 80); } catch { fields.msg = '(not base64)'; }
    }
    console.log(stamp(), JSON.stringify(fields));
    if (fields.query && answer) {
      child.write(ESC + ']7501;?' + BEL);
      console.log(stamp(), 'answered the query');
    }
  }
  // An unfinished report at the end of the chunk rides along to the next one.
  const open = text.lastIndexOf(ESC + ']7501;');
  carry = open > last ? text.slice(open) : '';
});
child.onExit((e) => { console.log(stamp(), 'exit', e.exitCode); printTail(); process.exit(0); });

const KEYS = { ESC, ENTER: '\r', DOWN: ESC + '[B', REPLY: ESC + ']7501;?' + BEL };
for (const s of sends) {
  setTimeout(() => {
    console.log(stamp(), 'send', JSON.stringify(s.text.slice(0, 40)));
    if (KEYS[s.text]) { child.write(KEYS[s.text]); return; }
    child.write(s.text);
    setTimeout(() => child.write('\r'), 80);
  }, s.at);
}
setTimeout(() => { printTail(); try { child.kill(); } catch {} process.exit(0); }, ms);
