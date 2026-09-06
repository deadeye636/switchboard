'use strict';
// #585 — a terminal that shows nothing must not be indistinguishable from a terminal that is working,
// and the log must not be readable as the opposite of what happened.
//
// The report behind this file drew three conclusions from a running app, and two of them were wrong
// because of how `src/app/terminal/spawn.js` wrote things down:
//
//   "args=[]"                     — the `[shell]` line printed `shellProfile.args`, which is the WSL
//                                   profile's `-d <distro>` and nothing else, so off WSL it is `[]` for
//                                   every session there has ever been. It reads as "started with no
//                                   arguments"; the argv is `-l -i`.
//   "nothing is logged about the  — true, and it was true of a session that had exited as well as of one
//    exit"                          that had not, so the log could not tell those apart.
//   "the Custom command route      — the launcher line is there, eleven milliseconds after the shell
//    logged the bare shell"          line. Only the FIRST line was being read.
//
// WHY SOURCE CHECKS FOR THE WIRING: `node-pty` is required at module load rather than taken through ctx,
// so nothing in the suite can reach past `pty.spawn` — the same reason `test/spawn-first-resize.test.js`
// and `test/spawn-timeline-echo.test.js` give for reading this file as text. What CAN be run for real is
// the notice's own text, which is why it is a pure exported function rather than a template inside the
// timer. Reading is done with `test/helpers/strip-comments.js`, per the repo rule: a comment must never
// be able to satisfy one of these assertions, and the positive control at the bottom proves it cannot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripComments } = require('./helpers/strip-comments');
const { silentTerminalNotice, SILENT_TERMINAL_NOTICE_MS } = require('../src/app/terminal/spawn');

const SPAWN = path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js');
const CODE = stripComments(fs.readFileSync(SPAWN, 'utf8'));

// --- the notice itself, run for real ------------------------------------------------------------------

test('the silence notice names the shell by basename, never by path', () => {
  // Same rule the spawn failure follows (#457): the terminal gets a sentence, the log gets the detail.
  // A path here would put the user's directory layout on screen and, through a screenshot, anywhere.
  const shell = ['X:', 'tools', 'scm', 'bin', 'bash.exe'].join(path.sep);
  const notice = silentTerminalNotice(shell, SILENT_TERMINAL_NOTICE_MS);
  assert.ok(notice.includes('bash.exe'), 'it has to say WHICH shell went quiet');
  assert.ok(!notice.includes('X:'), 'and it must not say where that shell lives');
  assert.ok(!notice.includes('tools'), 'no directory from the path may survive into the notice');
});

test('it says how long it waited, and agrees with the deadline it waited for', () => {
  const notice = silentTerminalNotice('bash.exe', SILENT_TERMINAL_NOTICE_MS);
  assert.match(notice, new RegExp(`\\b${Math.round(SILENT_TERMINAL_NOTICE_MS / 1000)}s\\b`),
    'a notice that names a different number than the timer used is worse than no number');
});

test('it points at the setting that can change the answer', () => {
  const notice = silentTerminalNotice('bash.exe', SILENT_TERMINAL_NOTICE_MS);
  // "Terminal shell" is the label on the global settings page (settings-global-html.js). Naming a
  // control that is not there is how a helpful line becomes a wild goose chase.
  assert.ok(notice.includes('Terminal shell'), 'it must name the setting, not just report the problem');
});

test('it is one line, and it repaints as a notice rather than as shell output', () => {
  const notice = silentTerminalNotice('bash.exe', SILENT_TERMINAL_NOTICE_MS);
  assert.ok(notice.endsWith('\r\n'), 'a terminal write needs CR LF, or the next line starts mid-column');
  assert.equal(notice.split('\n').length, 2, 'exactly one line — it is a notice, not a paragraph');
  assert.ok(notice.startsWith('\x1b[33m') && notice.includes('\x1b[0m'),
    'coloured and closed again, like the other two notices this path writes');
});

test('it survives being asked about nothing', () => {
  assert.ok(silentTerminalNotice(undefined, SILENT_TERMINAL_NOTICE_MS).length > 0);
  assert.ok(silentTerminalNotice('', 1000).length > 0);
});

test('the deadline is a few seconds, not a few hundred milliseconds and not a minute', () => {
  // Below a second it would accuse a shell that is merely reading its profile; past ~15 s nobody is
  // still looking at the tab when the answer arrives.
  assert.ok(SILENT_TERMINAL_NOTICE_MS >= 2000 && SILENT_TERMINAL_NOTICE_MS <= 15000,
    `an out-of-range silence deadline: ${SILENT_TERMINAL_NOTICE_MS} ms`);
});

// --- the wiring around it -----------------------------------------------------------------------------

test('the timer is armed for plain terminals only', () => {
  assert.match(CODE, /if \(isPlainTerminal\) \{\s*session\._silenceTimer = setTimeout\(/,
    'a backend CLI is expected to be quiet while it boots — Hermes takes about twelve seconds, and '
    + '`startupHint` is what covers that case. Arming this for backends would fire on every one of them');
});

test('the first byte of output disarms it', () => {
  assert.match(CODE, /session\._sawOutput = true;\s*clearTimeout\(session\._silenceTimer\)/,
    'without this the notice appears under a terminal that already printed its prompt');
});

test('the exit disarms it too', () => {
  assert.match(CODE, /session\.exited = true;\s*clearTimeout\(session\._silenceTimer\)/,
    'a session that has exited already has an exit banner; a silence notice arriving after it would '
    + 'describe a process that is not there');
});

test('the notice goes through the output buffer, like the other two', () => {
  const armed = CODE.slice(CODE.indexOf('session._silenceTimer = setTimeout('));
  assert.match(armed.slice(0, 900), /session\.outputBuffer\.push\(notice\)/,
    'a detach and reattach replays the buffer — a notice written only to the live stream is lost there');
});

// --- what the log says --------------------------------------------------------------------------------

test('the shell line no longer calls the profile extras "args" (#585)', () => {
  assert.ok(!/\[shell\][^`]*args=\$\{JSON\.stringify\(shellExtraArgs\)\}/.test(CODE),
    'spelled `args=` this field reads as the shell\'s argv, which it is not — that misreading is the '
    + 'whole first half of #585');
  assert.match(CODE, /\[shell\][^`]*extraArgs=\$\{JSON\.stringify\(shellExtraArgs\)\}/);
});

test('the shell line says which session and which kind it is about', () => {
  const line = CODE.match(/`\[shell\][^`]*`/);
  assert.ok(line, 'the [shell] log line must still exist');
  assert.match(line[0], /session=\$\{sessionId\}/,
    'several sessions spawn within milliseconds of each other on a restore — without an id the lines '
    + 'cannot be matched to the tab that stayed empty');
  assert.match(line[0], /kind=\$\{sessionKind\}/);
});

test('a plain terminal logs the argv it really passes', () => {
  assert.match(CODE, /argv=\$\{JSON\.stringify\(terminalArgv\)\}/,
    'the argv is resolved per branch, so the [shell] line above cannot state it — and the argv is '
    + 'exactly what #585 guessed wrong about');
  assert.match(CODE, /pty\.spawn\(shell, terminalArgv,/,
    'the logged argv has to be the one that is passed, not a second call that could drift from it');
});

test('an exit is logged, with the code and how long the process lived', () => {
  const line = CODE.match(/`\[exit\][^`]*`(\s*\+\s*`[^`]*`)?/);
  assert.ok(line, 'onExit must log — "nothing is logged about an exit" was read as "it did not exit"');
  const text = line[0];
  assert.match(text, /code=\$\{exitCode\}/);
  assert.match(text, /after=/, 'a shell that dies in 40 ms and one that dies after a minute are '
    + 'different faults, and only the elapsed time separates them');
});

// --- the positive control -----------------------------------------------------------------------------

test('the stripper is doing its job, so a comment cannot satisfy these checks', () => {
  assert.ok(CODE.includes('pty.spawn'), 'the stripped source must still hold the code it is asked about');
  assert.ok(!CODE.includes('A terminal whose shell never says anything'),
    'the prose explaining the silence notice must be gone, or these checks are reading the comment');
});
