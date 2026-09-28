// How a pasted or dropped path is quoted for whoever reads the terminal (#700).
//
// `shellEscape` (renderer/lib/utils.js) used to wrap every path in POSIX single quotes, which cmd reads as
// part of the path and PowerShell escapes differently. The plain terminal's shell family now comes from
// main (`pathShell` on the open-terminal answer), and everything main cannot name — a CLI session, WSL,
// fish — keeps the POSIX form it always had. Paths are invented.
//
// What main answers is pinned in `test/spawn-guards.test.js` (the reattach cases). The renderer wiring —
// each mount path storing `entry.pathShell`, `insertFromDataTransfer` reading it — has no harness here and
// was checked with a real file drop into a cmd, pwsh, Windows PowerShell and Git Bash terminal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_DIR = path.join(__dirname, '..', 'src');

function loadShellEscape() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, 'renderer', 'lib', 'utils.js'), 'utf8'), context);
  return vm.runInContext('shellEscape', context);
}

const shellEscape = loadShellEscape();
const WIN_SPACED = 'C:\\invented\\my docs\\report.pdf';
const WITH_QUOTE = 'C:\\invented\\it\'s\\report.pdf';

test('cmd gets double quotes, which it reads as quotes', () => {
  assert.equal(shellEscape(WIN_SPACED, 'cmd'), '"C:\\invented\\my docs\\report.pdf"');
  assert.equal(shellEscape(WITH_QUOTE, 'cmd'), '"C:\\invented\\it\'s\\report.pdf"');
});

test('PowerShell doubles an embedded single quote, the typographic ones included', () => {
  assert.equal(shellEscape(WITH_QUOTE, 'pwsh'), "'C:\\invented\\it''s\\report.pdf'");
  assert.equal(shellEscape(WITH_QUOTE, 'powershell'), "'C:\\invented\\it''s\\report.pdf'");
  assert.equal(shellEscape('C:\\invented\\it\u2019s.txt', 'pwsh'), "'C:\\invented\\it\u2019\u2019s.txt'");
});

test('bash and every shell main could not name keep POSIX single quotes', () => {
  const posix = "'C:\\invented\\it'\\''s\\report.pdf'";
  for (const shell of ['bash', 'unknown', null, undefined]) {
    assert.equal(shellEscape(WITH_QUOTE, shell), posix, String(shell));
  }
  assert.equal(shellEscape('/srv/invented/my docs/a.txt'), "'/srv/invented/my docs/a.txt'");
});
