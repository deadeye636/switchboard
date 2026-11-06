// A bare program name never goes with a working directory (CLAUDE.md reflex 10).
//
// On Windows `execFile('git', args, { cwd })` looks in `cwd` before PATH, so a repository holding its own git.exe
// would run. Measured with scripts/measure-planted-exe.js. This walks the main process's source, so a new file is
// covered by default in the directories named below. It reads text, which is what it can do without starting anything:
// it pins the shape that will actually come back, a literal name next to a `cwd`, and `CALL_SITES` pins the places
// that hold the name in a variable. An options object in a variable is out of its reach.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');
const git = require('../src/vcs/git');
const { absoluteSystemShell } = require('../src/app/terminal/shell-profiles');

const ROOT = path.join(__dirname, '..', 'src');
// src/backends is left out for one reason: its generated Pi code is text for another process, and open.
const DIRS = ['app', 'vcs', 'projects', 'servers', 'session', 'watch', 'index'];
const BARE_WITH_CWD = /\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync|spawnChild)\(\s*(?:'[^'/\\]+'|"[^"/\\]+"|`[^`/\\$]+`)\s*,\s*(?:(?:\[[^;{}]*?\]|[\w.]+(?:\([^)]*\))?)\s*,\s*)?\{(?:[^{}]|\{[^{}]*\})*\bcwd\b/;
// A name in a variable, at the places measured to need the answer: file -> what has to be there.
const CALL_SITES = {
  'app/agent-shell.js': 'spawn(absoluteSystemShell(shellPath)',
  'main.js': 'spawn(absoluteSystemShell(shellPath)',
};

function sources() {
  const out = [path.join(ROOT, 'main.js')];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  for (const d of DIRS) walk(path.join(ROOT, d));
  return out;
}

test('the pattern catches the shapes a copy would take', () => {
  for (const shape of [
    "execFile('git', args, { cwd }, cb)",
    "execFile('cmd.exe', ['/c', 'start'], { cwd: dir }, () => {})",
    "spawn('gh', ['x'], { windowsHide: true, cwd: root })",
    "execFileSync('git', ['log'], {\n  encoding: 'utf8',\n  cwd,\n})",
    "spawn('gh', [], { env: { A: 1 }, cwd })",
    'spawn("gh", args, { cwd })',
    "execFileAsync('git', [...a, b[0]], { cwd })",
  ]) assert.match(shape, BARE_WITH_CWD, shape);
  for (const fine of ["execFile('git', ['-C', dir, 'status'], { windowsHide: true }, cb)", 'execFile(file, args, { cwd }, cb)']) {
    assert.doesNotMatch(fine, BARE_WITH_CWD, fine);
  }
});

test('no main-process source starts a bare name with a working directory', () => {
  // main.js's own build stamp asks git about this checkout, the app's own directory and no project.
  const BUILD_STAMP = "execFileSync('git', a, { encoding: 'utf8', cwd: path.join(__dirname, '..') })";
  const hits = [];
  for (const file of sources()) {
    let text = stripComments(fs.readFileSync(file, 'utf8'));
    if (file === path.join(ROOT, 'main.js')) {
      // The Linux branch of the external terminal: POSIX has no such search.
      const XTERM = "execFile('xterm', [], { cwd }";
      for (const allowed of [BUILD_STAMP, XTERM]) {
        assert.ok(text.includes(allowed), `the exemption for ${allowed} is stale: delete it`);
        text = text.replace(allowed, '');
      }
    }
    if (BARE_WITH_CWD.test(text)) hits.push(path.relative(ROOT, file));
  }
  assert.deepEqual(hits, [], 'Resolve the program to an absolute path, or drop the cwd. absoluteSystemShell names the Windows shells.');
});

const win = (over = {}) => ({ platform: 'win32', env: { SystemRoot: 'X:\\Win', Path: 'X:\\bin;X:\\git\\cmd', ...over.env }, isFile: (p) => p === 'X:\\git\\cmd\\git.exe', now: over.now ?? 1 });

test('the starts that hold the name in a variable ask for the absolute one', () => {
  for (const [file, shape] of Object.entries(CALL_SITES)) {
    assert.ok(stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8')).includes(shape), `${file}: ${shape}`);
  }
  const main = stripComments(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'));
  assert.ok(main.includes('execFile(absoluteSystemShell(chosenShell.path)'));
  assert.ok(main.includes('[absoluteSystemShell(chosenShell.path)'));
  assert.ok(/get bin\(\) \{ return resolveBin\(\); \}/.test(fs.readFileSync(path.join(ROOT, 'vcs', 'git.js'), 'utf8')), 'the provider asks');
  if (process.platform === 'win32') assert.ok(path.isAbsolute(git.bin));
});

test('on Windows the provider answers an absolute git', () => {
  assert.equal(git.resolveBin(win()), 'X:\\git\\cmd\\git.exe');
  assert.equal(typeof git.bin, 'string');
  assert.equal(git.resolveBin({ platform: 'linux' }), 'git');
});

test('a relative PATH entry is the working directory again, and a shim cannot start', () => {
  const asked = [];
  const file = git.resolveBin({ platform: 'win32', now: 5, env: { SystemRoot: 'X:\\Win', PATH: '.;tools;"X:\\q";X:\\s' }, isFile: (p) => { asked.push(p); return false; } });
  assert.ok(asked.every((p) => /^X:/.test(p)), asked.join());
  assert.ok(asked.includes('X:\\q\\git.exe'), 'a quoted entry is read');
  assert.ok(!asked.some((p) => /\.(cmd|bat)$/.test(p)));
  assert.ok(path.win32.isAbsolute(file), 'a miss is absolute too, so it fails without a search');
});

test('a removed git falls through to the next PATH entry', () => {
  let files = ['X:\\one\\git.exe', 'X:\\two\\git.exe'];
  const opts = () => ({ platform: 'win32', now: 1, env: { SystemRoot: 'X:\\Win', Path: 'X:\\one;X:\\two;X:\\removed-case' }, isFile: (p) => files.includes(p) });
  assert.equal(git.resolveBin(opts()), 'X:\\one\\git.exe');
  files = ['X:\\two\\git.exe'];
  assert.equal(git.resolveBin(opts()), 'X:\\two\\git.exe');
});

test('a miss is asked again later, and a changed PATH at once', () => {
  let present = false;
  const opts = (now, Path = 'X:\\later') => ({ platform: 'win32', now, env: { SystemRoot: 'X:\\Win', Path }, isFile: () => present });
  const miss = git.resolveBin(opts(100));
  assert.match(miss, /git-is-not-on-path/);
  present = true;
  assert.equal(git.resolveBin(opts(200)), miss, 'not yet');
  assert.equal(git.resolveBin(opts(100 + 30001)), 'X:\\later\\git.exe', 'installed meanwhile');
  assert.equal(git.resolveBin(opts(100 + 30002, 'X:\\other')), 'X:\\other\\git.exe');
});

test('the Windows shells a profile names bare become absolute, and nothing else changes', () => {
  const opts = { platform: 'win32', env: { SystemRoot: 'X:\\Win', COMSPEC: 'X:\\Win\\System32\\cmd.exe' } };
  assert.equal(absoluteSystemShell('wsl.exe', opts), 'X:\\Win\\System32\\wsl.exe');
  assert.equal(absoluteSystemShell('cmd.exe', opts), 'X:\\Win\\System32\\cmd.exe');
  assert.equal(absoluteSystemShell('powershell.exe', opts), 'X:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(absoluteSystemShell('X:\\own\\sh.exe', opts), 'X:\\own\\sh.exe');
  assert.equal(absoluteSystemShell('wsl.exe', { platform: 'linux' }), 'wsl.exe');
});
