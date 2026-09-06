'use strict';
// #585 — which program "Auto" actually starts on Windows.
//
// Git for Windows installs bash twice. `<git>\bin\bash.exe` is the wrapper a Git Bash shortcut runs: it
// sets MSYSTEM and the MinGW PATH, then execs the second copy. `<git>\usr\bin\bash.exe` is that second
// copy, the raw MSYS binary, and starting it directly is a different shell — measured through node-pty
// in a ConPTY, it comes up as `MSYSTEM=MSYS` where the wrapper gives `MINGW64`.
//
// `discoverShellProfiles()` has always offered the WRAPPER as the "Git Bash" profile. Auto detection did
// not: its first step returns `$SHELL`, and `$SHELL` inside a Git Bash names the raw binary (Git's MSYS
// runtime rewrites it into Windows spelling on the way to a native child). So the shell a project's
// Terminal got depended on how Switchboard itself had been started — a Git Bash window gave one shell,
// Explorer gave another — with nothing on screen to say which.
//
// Two halves are checked, and the second is the acceptance criterion from #585 ("shell detection is
// covered by a test for the profile it picks on this platform"): the rewrite rule as a pure function,
// and then the profile auto really resolves to HERE, on this machine, with this environment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { gitBashWrapperFor, resolveShell, getShellProfiles, isWindows } = require('../src/app/terminal/shell-profiles');

// Invented roots throughout — the repo is public and a tracked file names no real directory.
const GIT_ROOT = ['X:', 'tools', 'scm'].join(path.sep);
const RAW_BASH = [GIT_ROOT, 'usr', 'bin', 'bash.exe'].join(path.sep);
const WRAPPER = [GIT_ROOT, 'bin', 'bash.exe'].join(path.sep);

test('a raw MSYS bash with a wrapper beside it is rewritten to the wrapper', () => {
  assert.equal(gitBashWrapperFor(RAW_BASH, (p) => p === WRAPPER), WRAPPER);
});

test('forward slashes are the same path — the env var can arrive either way', () => {
  assert.equal(gitBashWrapperFor('X:/tools/scm/usr/bin/bash.exe', (p) => p === WRAPPER), WRAPPER);
});

test('no wrapper beside it, no rewrite — this is the MSYS2 layout', () => {
  // MSYS2 installs `<root>\usr\bin\bash.exe` and NOTHING at `<root>\bin\bash.exe`. Rewriting there
  // would hand the spawn a path that does not exist, which is worse than the shell it was asked for.
  assert.equal(gitBashWrapperFor(['C:', 'msys64', 'usr', 'bin', 'bash.exe'].join(path.sep), () => false), null);
});

test('it only touches bash.exe under usr\\bin, and nothing else', () => {
  const yes = () => true; // say every candidate exists, so only the SHAPE can refuse
  assert.equal(gitBashWrapperFor(WRAPPER, yes), null, 'the wrapper itself must not be rewritten again');
  assert.equal(gitBashWrapperFor(['X:', 'tools', 'scm', 'usr', 'bin', 'sh.exe'].join(path.sep), yes), null);
  assert.equal(gitBashWrapperFor(['X:', 'tools', 'scm', 'usr', 'lib', 'bash.exe'].join(path.sep), yes), null);
  assert.equal(gitBashWrapperFor(['usr', 'bin', 'bash.exe'].join(path.sep), yes), null,
    'a relative path with nothing above `usr` has no root to hang a wrapper off');
  assert.equal(gitBashWrapperFor('', yes), null);
  assert.equal(gitBashWrapperFor(null, yes), null);
});

test('a POSIX /usr/bin/bash is left exactly where it is', () => {
  // The `.exe` is what keeps this Windows-shaped. On Linux `/bin/bash` exists next to `/usr/bin/bash`
  // and is usually the same file — rewriting there would be churn at best and wrong at worst.
  assert.equal(gitBashWrapperFor('/usr/bin/bash', () => true), null);
  assert.equal(gitBashWrapperFor('/usr/bin/zsh', () => true), null);
});

// --- what this platform actually resolves to ---------------------------------------------------------

test('the profile auto picks on this platform exists and is startable', () => {
  const picked = resolveShell('auto');
  assert.ok(picked && picked.path, 'auto must always answer with a shell');
  assert.equal(picked.id, 'auto');
  // wsl.exe is resolved through PATH rather than by absolute path, so it is the one answer that need
  // not exist on disk under the name it is spelled with.
  if (picked.path !== 'wsl.exe') {
    assert.ok(fs.existsSync(picked.path), `auto resolved to a path that is not there: ${path.basename(picked.path)}`);
  }
});

test('auto never lands on a raw MSYS bash that has a wrapper beside it (#585)', () => {
  const picked = resolveShell('auto');
  assert.equal(gitBashWrapperFor(picked.path), null,
    'auto picked the raw MSYS binary while the Git Bash wrapper sits next to it — that is the shell '
    + 'mismatch #585 is about, and it means the app inherited $SHELL from whatever started it');
});

test('the Git Bash profile and auto agree about which bash that is', { skip: !isWindows ? 'Windows only' : false }, () => {
  const gitBash = getShellProfiles().find(p => p.id === 'git-bash');
  if (!gitBash) return; // no Git for Windows on this machine — nothing to disagree about
  const picked = resolveShell('auto');
  if (path.basename(picked.path).toLowerCase() !== 'bash.exe') return; // auto found something else first
  assert.equal(picked.path.toLowerCase(), gitBash.path.toLowerCase(),
    'when auto settles on a bash at all it must be the same bash the "Git Bash" profile offers, or the '
    + 'picker and the default describe two different shells under one name');
});
