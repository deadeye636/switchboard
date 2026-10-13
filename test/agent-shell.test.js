'use strict';
// `src/app/agent-shell.js` (#786): one shell line run to completion with no terminal, and the arguments each
// shell family is started with for it (`commandArgs` in `src/app/terminal/shell-profiles.js`).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { runShellLine } = require('../src/app/agent-shell');
const { commandArgs } = require('../src/app/terminal/shell-profiles');

const SHELL = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
const LONG = process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30';

test('a login shell, never an interactive one: there is no terminal behind it', () => {
  assert.deepEqual(commandArgs('/bin/bash', 'ls -la'), { args: ['-l', '-c', 'ls -la'], verbatim: false });
  assert.deepEqual(commandArgs('/usr/bin/zsh', 'ls'), { args: ['-l', '-c', 'ls'], verbatim: false });
  assert.deepEqual(commandArgs('/usr/bin/fish', 'ls'), { args: ['-l', '-c', 'ls'], verbatim: false });
  assert.deepEqual(commandArgs('wsl.exe', 'ls', '/work'), { args: ['--cd', '/work', '--', 'bash', '-l', '-c', 'ls'], verbatim: false });
});

test('cmd gets the line quoted the way Node quotes `shell: true`, and verbatim', { skip: process.platform !== 'win32' && 'cmd exists only on Windows' }, () => {
  assert.deepEqual(commandArgs('cmd.exe', 'echo "a b"'), { args: ['/d', '/s', '/c', '"echo "a b""'], verbatim: true });
});

test('off Windows, a shell of no known family takes `-c`, never cmd\'s arguments', { skip: process.platform === 'win32' && 'the fallback there is cmd' }, () => {
  assert.deepEqual(commandArgs('/bin/dash', 'ls'), { args: ['-c', 'ls'], verbatim: false });
});

test('PowerShell gets the line encoded inside a script that keeps its output plain', () => {
  const { args, verbatim } = commandArgs('pwsh.exe', 'Write-Output "it\'s"');
  assert.equal(verbatim, false);
  assert.deepEqual(args.slice(0, 6), ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand']);
  const script = Buffer.from(args[6], 'base64').toString('utf16le');
  assert.ok(script.includes('\nWrite-Output "it\'s"\n'), 'the line itself, untouched');
  assert.match(script, /\$ProgressPreference = 'SilentlyContinue'/);
});

// Measured on both editions (#786): with the streams redirected, PowerShell wrote CLIXML to stderr and exited 1
// for a native command's 3. Run for real where PowerShell exists.
for (const ps of ['powershell.exe', 'pwsh.exe']) {
  test(`${ps}: plain errors and the line's own exit code`, { skip: process.platform !== 'win32' && 'Windows PowerShell editions' }, async (t) => {
    const ok = await runShellLine({ command: 'Write-Output ok', cwd: os.tmpdir(), shellPath: ps, env: process.env }).done;
    if (ok.failed) { t.skip(`${ps} is not installed`); return; }
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.stderr, '', 'no progress record');
    const code = await runShellLine({ command: 'cmd /c exit 3', cwd: os.tmpdir(), shellPath: ps, env: process.env }).done;
    assert.equal(code.exitCode, 3);
    const err = await runShellLine({ command: 'Get-Item C:\\no-such-item-786', cwd: os.tmpdir(), shellPath: ps, env: process.env }).done;
    assert.equal(err.exitCode, 1);
    assert.match(err.stderr, /no-such-item-786/);
    assert.doesNotMatch(err.stderr, /CLIXML|\u001b\[/, 'text, not CLIXML or escape codes');
    const warn = await runShellLine({ command: 'cmd /c "echo warn 1>&2"', cwd: os.tmpdir(), shellPath: ps, env: process.env }).done;
    assert.equal(warn.exitCode, 0, 'a native command writing to stderr has not failed');
    const host = await runShellLine({ command: 'Write-Host hosttext; Write-Warning careful', cwd: os.tmpdir(), shellPath: ps, env: process.env }).done;
    assert.match(host.stdout, /hosttext/);
    assert.match(host.stderr, /^WARNING: careful/);
    const thrown = await runShellLine({ command: 'throw "boom-786"', cwd: os.tmpdir(), shellPath: ps, env: process.env }).done;
    assert.equal(thrown.exitCode, 1);
    for (const r of [host, thrown]) assert.doesNotMatch(r.stdout + r.stderr, /CLIXML|\u001b\[/);
  });
}

test('a line runs in its directory and reports what it wrote and its exit code', async () => {
  const seen = [];
  const run = runShellLine({ command: 'echo out-here && exit 4', cwd: os.tmpdir(), shellPath: SHELL, env: process.env, onOutput: (text) => seen.push(text) });
  const r = await run.done;
  assert.match(r.stdout, /out-here/);
  assert.equal(r.exitCode, 4);
  assert.equal(r.cancelled, false);
  assert.equal(r.failed, false);
  assert.ok(seen.length >= 1 && /out-here/.test(seen[seen.length - 1]), 'the output was handed on as it came');
});

test('stop ends a running line and says it was stopped', async () => {
  const run = runShellLine({ command: LONG, cwd: os.tmpdir(), shellPath: SHELL, env: process.env });
  setTimeout(() => run.stop(), 300);
  const started = Date.now();
  const r = await run.done;
  assert.equal(r.cancelled, true);
  assert.ok(Date.now() - started < 20000, 'well before the command would have ended by itself');
});

test('a shell that cannot be started is a failed line, not a throw', async () => {
  const run = runShellLine({ command: 'echo x', cwd: os.tmpdir(), shellPath: 'no-such-shell-anywhere', env: process.env });
  const r = await run.done;
  assert.equal(r.failed, true);
});
