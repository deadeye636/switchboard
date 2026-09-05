'use strict';
// #541 — the shell-discovery probe must not leave its child an open stdin pipe.
//
// `src/app/terminal/shell-profiles.js` runs `wsl.exe --list --quiet` purely to read what it prints, with a
// 5 s timeout. A probe never writes to the child, so the stdin pipe Node hands it by default is only a way
// to hang: a CLI that reads standard input before answering waits for an EOF that never comes, and the
// probe spends its whole timeout instead of failing. The file's own comment already records that this call
// stalled discovery once.
//
// The fix lives in that file rather than being imported from `src/backends/cli-probe.js`: that module's
// scope is `src/backends/**` and it stays there, so an app-side probe closes its own stdin. Two halves are
// checked here, the same two `test/cli-probe.test.js` checks for the backends:
//
//   1. `closeProbeStdin` really closes stdin — proven against a child that BLOCKS reading it, so a
//      regression hangs the assertion rather than passing on a child that never looked.
//   2. The `wsl.exe` call site goes through it, by reading the source. That is the half that catches a
//      later probe added beside it with the pipe left open.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { closeProbeStdin } = require('../src/app/terminal/shell-profiles');

const TERMINAL_DIR = path.join(__dirname, '..', 'src', 'app', 'terminal');

// A child that reads standard input to the end before printing anything. Without an EOF it never answers —
// which is the failure this exists to prevent, and the only honest way to test for it.
const READS_STDIN = 'require("fs").readFileSync(0); process.stdout.write("answered");';

test('closeProbeStdin lets a child that reads stdin finish', async () => {
  const answer = await new Promise((resolve, reject) => {
    closeProbeStdin(execFile(process.execPath, ['-e', READS_STDIN], { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))));
  });
  assert.equal(answer, 'answered');
});

test('closeProbeStdin survives a spawner that hands back nothing', () => {
  // It wraps the call, so whatever `execFile` returned is what it gets. A child that is already gone has no
  // stdin to close, and that is not an error.
  assert.equal(closeProbeStdin(undefined), undefined);
  assert.deepEqual(closeProbeStdin({}), {});
});

test('the real wsl.exe probe is not exercised here', { skip: 'wsl.exe exists only on Windows and running it starts a distribution VM — minutes of cold start, and nothing on a Linux runner to start. The test above stands in for it: it proves the helper against a child that really blocks on standard input, and the sweep below proves the wsl.exe call site goes through that helper.' }, () => {});

// --- the call-site sweep -----------------------------------------------------------------------------
//
// Comments are NOT stripped before scanning, for the reason `test/cli-probe.test.js` gives: a stripper that
// deletes from `//` to end-of-line also deletes a call sharing its line with a regex literal or a URL. What
// keeps prose out is that a CALL never puts a space before its parenthesis and prose usually does.

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** The text of one call's own argument list, so an option belonging to the NEXT call cannot answer for it. */
function argumentList(src, openParen) {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(openParen, i + 1);
  }
  return src.slice(openParen);            // unbalanced source: judge on what there is
}

test('every child process spawned under src/app/terminal closes its stdin', () => {
  // A PTY is not a probe: `spawn.js` opens terminals, and a terminal with no standard input is not a
  // terminal. Everything else that starts a child here reads output and answers for stdin.
  //
  // A receiver is allowed before the name (`cp.execFile(...)`) because writing the require that way is
  // legal and would otherwise walk straight past this guard — except `pty.`, the exemption above. Bare
  // `exec` is matched WITHOUT a receiver on purpose: `re.exec(...)` is a regular expression, not a process.
  const SYNC_CALL = /(?<![\w$])(?:(\w+)\.)?(execFileSync|spawnSync|spawn)\(/g;
  const ASYNC_CALL = /(?<![\w$])(?:(\w+)\.)?(execFile)\(|(?<![.\w$])(exec)\(/g;

  const offenders = [];
  let inspected = 0;

  for (const file of jsFiles(TERMINAL_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    // Forward slashes in the reported path: a Windows separator in an expectation goes red on a Linux runner.
    const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');

    for (const m of src.matchAll(SYNC_CALL)) {
      if (m[1] === 'pty') continue;
      inspected++;
      const args = argumentList(src, m.index + m[0].length - 1);
      if (!/stdio\s*:/.test(args)) offenders.push(`${rel}: ${m[2]}(...) without a stdio option`);
    }

    for (const m of src.matchAll(ASYNC_CALL)) {
      if (m[1] === 'pty') continue;
      inspected++;
      const name = m[2] || m[3];
      const idStart = m.index + m[0].lastIndexOf(name);
      if (/closeProbeStdin\s*\(\s*$/.test(src.slice(Math.max(0, idStart - 24), idStart))) continue;
      offenders.push(`${rel}: ${name}(...) is not wrapped in closeProbeStdin(...)`);
    }
  }

  assert.deepEqual(offenders, [],
    'a child process under src/app/terminal does not close its stdin (#541). An execFile call must be '
    + 'WRAPPED — `closeProbeStdin(execFile(...))`, not a separate `closeProbeStdin(child)` afterwards, '
    + 'because only the wrapper form is greppable. A synchronous call takes a `stdio` option instead. '
    + 'See closeProbeStdin in src/app/terminal/shell-profiles.js, and src/backends/cli-probe.js beside it.');

  // A positive control: the assertion above also passes when the regexes match nothing at all, which is what
  // a moved directory or a broken pattern looks like. The one known non-PTY call site is the wsl.exe probe.
  assert.ok(inspected >= 1, `the sweep inspected ${inspected} call sites — it has stopped seeing the code`);
});
