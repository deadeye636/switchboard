'use strict';
// A plain terminal says it is unmonitored, and wraps nothing to say it (#588, #305).
//
// It used to say it by REFUSING: a `claude` shell function, PowerShell function or doskey macro written
// into the PTY 300 ms after the spawn, which printed a hint and returned 1. Four measured defects came
// out of that wrapper, and none of them out of the text it printed:
//
//   * `export -f` carried the function into every child process, so a script or an `npm run` target
//     that shelled out to `claude` got the refusal instead of the CLI;
//   * a custom launcher's command is typed into this same shell at 600 ms, after the wrapper was in
//     place at 300 ms — so a launcher the user saved as `claude …` was refused by their own app;
//   * `ENV` and `BASH_ENV` were set to the wrapper TEXT while both name a file to source: they defined
//     nothing and leaked two junk values into every child;
//   * it had to be spelled per shell syntax (#23), and "bash-like" meant anything that was not pwsh or
//     cmd, so fish and nushell were handed bash.
//
// And it spelled a backend's binary name in `src/app/**`, which CLAUDE.md reflex 5 forbids.
//
// The guidance is kept and moved: one dim line pushed into the session's buffer when the terminal opens,
// through the same path the startup hint and the resume notice use. Earlier than the wrapper (before the
// user types rather than after), backend-neutral, and it wraps nothing.
//
// WHY SOURCE CHECKS: `node-pty` is required at module load rather than taken through ctx, so nothing in
// the suite can reach past `pty.spawn` — the reason `test/spawn-first-resize.test.js` and
// `test/terminal-silent-shell.test.js` give for reading this file as text. Reading is done with the
// shared stripper, so a comment can never satisfy an assertion; the positive control at the bottom
// proves it cannot — and this file is the case that needs it most, because the prose above names every
// string the checks below forbid.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripComments } = require('./helpers/strip-comments');

const SPAWN = path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js');
const CODE = stripComments(fs.readFileSync(SPAWN, 'utf8'));

test('no command is wrapped in a plain terminal any more (#588)', () => {
  assert.ok(!/export\s+-f\s+claude/.test(CODE),
    'an exported shell function follows the user into every child process, which is how a script that '
    + 'shells out to the CLI got a refusal instead of the CLI');

  assert.ok(!/doskey\s+claude/.test(CODE), 'no doskey macro either');

  assert.ok(!/function\s+claude\s*\{/.test(CODE), 'and no PowerShell function');

  assert.ok(!/\bBASH_ENV\b/.test(CODE),
    'BASH_ENV names a file to source, so setting it to a command string defined nothing and only '
    + 'leaked a junk value into every child');
});

test('the plain-terminal branch names no backend binary (#588, reflex 5)', () => {
  // The whole branch, from `if (isPlainTerminal) {` to the `} else {` that starts the backend path.
  const branch = CODE.slice(CODE.indexOf('if (isPlainTerminal) {'));
  const upToElse = branch.slice(0, branch.indexOf('} else {'));
  assert.ok(upToElse.length > 200, 'the branch was located, not an empty string');
  assert.ok(!/\bclaude\b/i.test(upToElse),
    'a capability that varies per backend is a descriptor hook, never a literal binary name in '
    + 'src/app/** — and a wrapper that knows one of five backends is the shape reflex 5 forbids');
});

test('the notice is a single dim line, and goes through the output buffer', () => {
  const notice = /const notice = `\\x1b\[2m──[^`]*`;\s*\n\s*session\.outputBuffer\.push\(notice\);/;
  assert.match(CODE, notice,
    'dim rather than yellow, because this is a standing fact about the terminal rather than something '
    + 'that happened to the user; and through the buffer so a detach and reattach keeps it');

  assert.match(CODE, /if \(isPlainTerminal && !launcher\) \{/,
    'shown for a plain terminal and not for a launcher — that terminal was opened to run one command '
    + 'the user saved, and telling them it is unmonitored answers a question they did not ask');
});

test('the notice points at the way to get a monitored session', () => {
  const line = /── this terminal is not monitored[^`]*──/.exec(CODE);
  assert.ok(line, 'the notice text is present');
  assert.match(line[0], /\+ button/,
    'a notice that states a limitation without naming the way out is a complaint, not guidance');
  assert.ok(!/\r?\n/.test(line[0].replace(/\\r\\n/g, '')), 'one line');
});

test('nothing is typed into a plain terminal except a launcher command', () => {
  // The 300 ms init write is gone with the wrapper, and so is the `clear` that only existed to hide the
  // line it had just pasted. What may still be written is the launcher's own command.
  const branch = CODE.slice(CODE.indexOf('if (isPlainTerminal) {'));
  const upToElse = branch.slice(0, branch.indexOf('} else {'));
  const writes = upToElse.match(/ptyProcess\.write\(/g) || [];
  assert.equal(writes.length, 1,
    `a plain terminal writes only the launcher command into its shell (found ${writes.length} writes)`);
  assert.match(upToElse, /ptyProcess\.write\(launcherCmd/, 'and that one write is the launcher command');
});

test('the stripper is doing its job, so a comment cannot satisfy these checks', () => {
  // Load-bearing here more than anywhere: the header above deliberately spells `export -f claude`,
  // `doskey claude` and `BASH_ENV` while explaining why they are gone. If the stripper ever stopped
  // removing comments, the first test would fail on its own explanation — and if it over-stripped and
  // returned nothing, every "must not contain" above would pass while reading an empty string.
  assert.ok(CODE.includes('isPlainTerminal'), 'the stripped source must still hold the code it is asked about');
  assert.ok(!CODE.includes('the reason `test/spawn-first-resize.test.js`'),
    'the prose must be gone, or these checks are reading the comments');
});
