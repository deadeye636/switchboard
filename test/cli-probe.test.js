'use strict';
// #532 — a probe that reads a CLI's output must not leave the child an open stdin pipe.
//
// Antigravity 1.1.23 fixed `agy models` hanging on an inherited standard input pipe. The reported side is
// theirs; the shape is ours, in every backend that spawns a CLI to read what it prints, and a user on an
// older install gets the hang regardless of what the CLI fixed. Two halves are checked here:
//
//   1. `backends/cli-probe.js` really closes stdin — proven against a child that BLOCKS reading it, so a
//      regression hangs the assertion rather than passing on a child that never looked.
//   2. Every probe under `src/backends/**` uses it. That is the half worth a source scan: the same defect
//      was fixed in one backend and kept in its siblings four separate times (`.claude/rules/backends.md`),
//      and a new backend copying an existing probe would copy the open pipe with it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync, spawnSync } = require('node:child_process');

const { PROBE_STDIO, closeStdin, cliComplaint } = require('../src/backends/cli-probe');

const BACKENDS = path.join(__dirname, '..', 'src', 'backends');

// A child that reads standard input to the end before printing anything. Without an EOF it never answers —
// which is the failure this module exists to prevent, and the only honest way to test for it.
const READS_STDIN = 'require("fs").readFileSync(0); process.stdout.write("answered");';

test('closeStdin lets a child that reads stdin finish', async () => {
  const answer = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['-e', READS_STDIN], { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
    closeStdin(child);
  });
  assert.equal(answer, 'answered');
});

test('closeStdin survives a spawner that hands back nothing', () => {
  // `claude/live-agents.js` takes its `exec` as an argument and the tests pass a fake, so the wrapper has to
  // treat a missing child as a child with nothing to close, not as an error.
  assert.equal(closeStdin(undefined), undefined);
  assert.deepEqual(closeStdin({}), {});
});

test('PROBE_STDIO closes stdin and still captures both output streams', () => {
  const res = spawnSync(process.execPath, ['-e', READS_STDIN], { encoding: 'utf8', timeout: 5000, stdio: PROBE_STDIO });
  assert.equal(res.stdout, 'answered');
  assert.equal(res.stderr, '');

  const out = execFileSync(process.execPath, ['-e', READS_STDIN], { encoding: 'utf8', timeout: 5000, stdio: PROBE_STDIO });
  assert.equal(out, 'answered');
});

test('PROBE_STDIO cannot be edited by a caller', () => {
  // It is one shared array handed to every synchronous probe. A caller that wrote `PROBE_STDIO[0]` would
  // un-fix all of them at once, silently and everywhere.
  assert.throws(() => { PROBE_STDIO[0] = 'inherit'; }, TypeError);
  assert.equal(PROBE_STDIO[0], 'ignore');
});

test('execFile ignores a stdio option, which is why closeStdin exists', () => {
  // The reason `cli-probe.js` has two exports rather than one. Node hands `spawn` an allow-list of
  // execFile's options and `stdio` is not on it, so a probe "fixed" by passing one is not fixed at all.
  // If a future Node honours it, this fails and the module can lose half of itself.
  const child = execFile(process.execPath, ['-e', '0'], { stdio: ['ignore', 'pipe', 'pipe'] }, () => {});
  assert.notEqual(child.stdin, null, 'execFile honoured `stdio` — cli-probe.js can be simplified');
  child.stdin.end();
  child.kill();
});

// --- the sibling sweep -------------------------------------------------------------------------------
//
// Comments are NOT stripped before scanning, and this sweep is the one place that stays true after #554.
// `test/helpers/strip-comments.js` no longer cuts a line short at a URL, so the original reason is gone —
// but the preference behind it is not. A sweep whose blind spot is invisible is worse than one that
// occasionally objects to prose, and reading the raw text is the only version with no blind spot at all.
// What keeps the prose out instead is that a CALL never
// puts a space before its parenthesis and prose usually does — these files are full of "spawn (#512)" and
// "execFileSync (no shell)", and every one of those is a mention, not a call.

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

test('every child process spawned under src/backends closes its stdin', () => {
  // A PTY is not a probe: `local-usage.js` spawns one to make `agy` start its quota service, and a terminal
  // with no standard input is not a terminal. Everything else that starts a child answers for stdin.
  //
  // A receiver is allowed before the name (`cp.execFile(...)`) because writing the require that way is legal
  // and would otherwise walk straight past this guard — except `pty.`, which is the exemption above. Bare
  // `exec` is matched WITHOUT a receiver on purpose: `re.exec(...)` is a regular expression, not a process.
  // The leading lookbehind is what keeps `respawn(` out.
  const SYNC_CALL = /(?<![\w$])(?:(\w+)\.)?(execFileSync|spawnSync|spawn)\(/g;
  const ASYNC_CALL = /(?<![\w$])(?:(\w+)\.)?(execFile)\(|(?<![.\w$])(exec)\(/g;

  const offenders = [];
  let inspected = 0;

  for (const file of jsFiles(BACKENDS)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');

    for (const m of src.matchAll(SYNC_CALL)) {
      if (m[1] === 'pty') continue;
      inspected++;
      const args = argumentList(src, m.index + m[0].length - 1);
      if (!/PROBE_STDIO|stdio\s*:/.test(args)) offenders.push(`${rel}: ${m[2]}(...) without a stdio option`);
    }

    for (const m of src.matchAll(ASYNC_CALL)) {
      if (m[1] === 'pty') continue;
      inspected++;
      const name = m[2] || m[3];
      const idStart = m.index + m[0].lastIndexOf(name);
      if (/closeStdin\s*\(\s*$/.test(src.slice(Math.max(0, idStart - 20), idStart))) continue;
      offenders.push(`${rel}: ${name}(...) is not wrapped in closeStdin(...)`);
    }
  }

  assert.deepEqual(offenders, [],
    'a child process under src/backends does not close its stdin (#532). A synchronous call takes '
    + '`stdio: PROBE_STDIO`; an execFile call must be WRAPPED — `closeStdin(execFile(...))`, not a separate '
    + '`closeStdin(child)` afterwards, because only the wrapper form is greppable. See src/backends/cli-probe.js.');

  // A positive control: the assertion above also passes when the regexes match nothing at all, which is what
  // a renamed directory or a broken pattern looks like. The five known call sites are agy/index, pi/index
  // (twice), agy/local-usage and claude/live-agents; claude/usage brings the sixth.
  assert.ok(inspected >= 6, `the sweep inspected ${inspected} call sites — it has stopped seeing the code`);
});

// --- #540: what a failing probe is allowed to say ------------------------------------------------------
//
// A probe's failure message is the one place a raw string from another program reaches the user, and it
// had two doors for an absolute path: the spawn errno, which names the executable, and the CLI's own
// stderr — a Node-based CLI that fails to start prints a whole stack trace with paths in it, and all of
// that used to land in the message.

test('a complaint a person can act on is passed through (#540)', () => {
  assert.equal(cliComplaint('not signed in — run agy login'), 'not signed in — run agy login');
  assert.equal(cliComplaint('   quota exhausted   \nsomething else'), 'quota exhausted', 'the first line, trimmed');
});

test('anything that looks like a path or a stack is refused (#540)', () => {
  const B = String.fromCharCode(92);
  const cases = [
    `Error: Cannot find module 'C:${B}store${B}cli.js'`,
    'node:internal/modules/cjs/loader:1386',
    '    at Function._resolveFilename (node:internal/modules/cjs/loader:1383:15)',
    'failed reading /home/someone/.config/agy',
    'could not open /Users/someone/thing',
  ];
  for (const c of cases) {
    assert.equal(cliComplaint(c), null, `${JSON.stringify(c.slice(0, 40))} says nothing safe`);
  }
});

test('nothing to say is null, so the caller words it (#540)', () => {
  for (const empty of ['', '   \n\n', null, undefined]) assert.equal(cliComplaint(empty), null);
});

test('a complaint is capped and stripped of colour (#540)', () => {
  const long = cliComplaint('x'.repeat(400));
  assert.ok(long.length <= 200, `capped at 200, got ${long.length}`);
  assert.ok(long.endsWith('…'), 'and says it was cut');
  const ESC = String.fromCharCode(27);
  assert.equal(cliComplaint(`${ESC}[31mred text${ESC}[0m`), 'red text');
});
