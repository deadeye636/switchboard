'use strict';

// Coverage for shellArgs() — the spawn-arg builder per shell family
// (previously only quoteArgForShell was tested). Pure (path.basename only) (#82).

const test = require('node:test');
const assert = require('node:assert/strict');
const { shellArgs } = require('../shell-profiles');

test('shellArgs: bash-like with a command → login+interactive -c', () => {
  assert.deepEqual(shellArgs('/bin/bash', 'ls', null), ['-l', '-i', '-c', 'ls']);
  assert.deepEqual(shellArgs('/usr/bin/zsh', 'ls', null), ['-l', '-i', '-c', 'ls']);
  assert.deepEqual(shellArgs('/bin/sh', 'ls', null), ['-l', '-i', '-c', 'ls']);
});

test('shellArgs: bash-like without a command → login+interactive', () => {
  assert.deepEqual(shellArgs('/bin/bash', null, null), ['-l', '-i']);
});

test('shellArgs: fish and nushell', () => {
  assert.deepEqual(shellArgs('/usr/bin/fish', 'ls', null), ['-l', '-c', 'ls']);
  assert.deepEqual(shellArgs('/usr/bin/nu', 'ls', null), ['-l', '-c', 'ls']);
  assert.deepEqual(shellArgs('/usr/bin/fish', null, null), ['-l', '-i']);
  assert.deepEqual(shellArgs('/usr/bin/nu', null, null), ['-l', '-i']);
});

test('shellArgs: PowerShell / pwsh', () => {
  assert.deepEqual(shellArgs('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 'gci', null),
    ['-NoLogo', '-Command', 'gci']);
  assert.deepEqual(shellArgs('C:/Program Files/PowerShell/7/pwsh.exe', 'gci', null),
    ['-NoLogo', '-Command', 'gci']);
  assert.deepEqual(shellArgs('C:/Program Files/PowerShell/7/pwsh.exe', null, null),
    ['-NoLogo', '-NoExit']);
});

test('shellArgs: cmd.exe (else branch)', () => {
  assert.deepEqual(shellArgs('C:/Windows/System32/cmd.exe', 'dir', null), ['/C', 'dir']);
  assert.deepEqual(shellArgs('C:/Windows/System32/cmd.exe', null, null), []);
});

test('shellArgs: WSL passes the command through -- to the distro bash', () => {
  assert.deepEqual(shellArgs('wsl.exe', 'ls', null), ['--', 'bash', '-l', '-i', '-c', 'ls']);
  assert.deepEqual(shellArgs('wsl.exe', null, null), ['--', 'bash', '-l', '-i']);
  // extraArgs (e.g. -d <distro>) are prepended before the -- separator.
  assert.deepEqual(shellArgs('wsl.exe', 'ls', ['-d', 'Ubuntu']),
    ['-d', 'Ubuntu', '--', 'bash', '-l', '-i', '-c', 'ls']);
});
