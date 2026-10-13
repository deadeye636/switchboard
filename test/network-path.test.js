'use strict';
// src/app/network-path.js (#780) — which paths name a network share, and when a panel reader may touch one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { networkShareOf, isForeignNetworkPath } = require('../src/app/network-path');
const { stripComments } = require('./helpers/strip-comments');

const read = (rel) => stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
// The text of one handler or function, from its opening line to the next top-level one.
function bodyOf(src, opener) {
  const at = src.indexOf(opener);
  assert.ok(at >= 0, `${opener} not found`);
  const next = src.slice(at + opener.length).search(/\n(?:ipcMain\.handle\(|ipcMain\.on\(|async function |function )/);
  return src.slice(at, next < 0 ? undefined : at + opener.length + next);
}

// A source check, because main.js's handlers have no seam a test can reach (it requires Electron). It pins the
// handlers named below — the check present, and before the first fs call. A NEW reader is not covered until
// it is added to the list.
test('every panel reader, the writer, the openers, the watch and the MCP bridge ask before touching a path', () => {
  const main = read('src/main.js');
  for (const opener of ["ipcMain.handle('read-file-for-panel'", "ipcMain.handle('read-file-dataurl'",
    "ipcMain.handle('save-file-for-panel'", "ipcMain.handle('open-path'", "ipcMain.handle('open-in-editor'"]) {
    const body = bodyOf(main, opener);
    const asked = body.indexOf('isForeignNetworkFile(');
    assert.ok(asked > 0, `${opener} asks isForeignNetworkFile`);
    for (const touch of ['fs.', 'shell.openPath(', 'execFile(', 'writeTextAtomic(']) {
      const t = body.indexOf(touch);
      if (t >= 0) assert.ok(asked < t, `${opener} asks before ${touch}`);
    }
  }
  assert.match(main, /setMcpPathGuard\(/, 'main hands the bridge its guard');
  assert.match(main, /fileWatch\.init\(\{[^}]*isForeignNetworkFile/, 'main hands the watch its guard');
  const watch = bodyOf(read('src/app/file-watch.js'), 'function watchFile(');
  assert.ok(watch.indexOf('isForeignNetworkFile') < watch.indexOf('attach('), 'the watch asks before it attaches');
  const bridge = read('src/servers/mcp-bridge.js');
  for (const fn of ['async function handleOpenDiff(', 'async function handleOpenFile(']) {
    const body = bodyOf(bridge, fn);
    assert.ok(body.indexOf('refusePath(') >= 0 && body.indexOf('refusePath(') < body.indexOf('readFileSync('), `${fn} asks before it reads`);
  }
});

test('every spelling of a network path names its share; a local path names none', () => {
  for (const p of ['\\\\host\\share\\x.png', '//host/share/x.png', '\\/host/share\\x.png', '\\\\?\\UNC\\host\\share\\x.png', '\\\\HOST\\Share']) {
    assert.equal(networkShareOf(p), '\\\\host\\share', p);
  }
  // The drive letter is put together here so the example does not read as a real path from this machine.
  const D = 'X' + ':';
  for (const p of ['/home/u/x.png', `${D}\\work\\x.png`, `${D}/work/x.png`, `\\\\?\\${D}\\work\\x.png`, 'relative/x.png', '', null]) {
    assert.equal(networkShareOf(p), null, String(p));
  }
  assert.equal(networkShareOf('\\\\.\\pipe\\x'), '\\\\.\\pipe', 'a device path is a share of its own');
});

test('a network path is foreign unless a known project lives on the same share', () => {
  const projects = ['/home/u/app', '\\\\nas\\projects\\site'];
  assert.equal(isForeignNetworkPath('\\\\attacker\\s\\x.png', projects), true);
  assert.equal(isForeignNetworkPath('\\\\nas\\other\\x.png', projects), true, 'same host, another share');
  assert.equal(isForeignNetworkPath('//NAS/Projects/site/docs/a.md', projects), false, 'the project\'s share, any spelling');
  assert.equal(isForeignNetworkPath('\\\\nas\\projects\\elsewhere\\a.md', projects), false, 'anywhere on that share');
  assert.equal(isForeignNetworkPath('/home/u/app/a.md', projects), false, 'a local path is not this check\'s business');
  assert.equal(isForeignNetworkPath('\\\\nas\\projects\\a.md', []), true, 'no projects, no trusted share');
});
