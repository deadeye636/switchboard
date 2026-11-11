'use strict';
// src/app/dialog-dirs.js (#843): since Electron 43 a file dialog without a `defaultPath` opens in Downloads every time,
// so the app remembers the folder per kind of dialog. Only an existing local folder is handed back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dialogDirs = require('../src/app/dialog-dirs');

function setup(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = [];
  dialogDirs.init({
    getSetting: (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    setSetting: (k, v) => { writes.push([k, v]); store.set(k, v); },
    log: { warn() {} },
  });
  return { store, writes };
}

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dialog-dirs-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('nothing remembered: no default folder, and a save path is the bare file name', () => {
  setup();
  assert.equal(dialogDirs.lastDialogDir('projectFolder'), undefined);
  assert.equal(dialogDirs.defaultSavePath('settingsFile', 'a.json'), 'a.json');
});

test('a picked folder and a chosen file are remembered per kind, and a cancelled dialog writes nothing', () => {
  const { writes } = setup();
  const projects = tmp();
  const files = tmp();
  dialogDirs.rememberDialogDir('projectFolder', projects, true);
  dialogDirs.rememberDialogDir('settingsFile', path.join(files, 'export.json'));
  dialogDirs.rememberDialogDir('settingsFile', '');
  dialogDirs.rememberDialogDir('settingsFile', undefined);
  assert.equal(dialogDirs.lastDialogDir('projectFolder'), projects);
  assert.equal(dialogDirs.lastDialogDir('settingsFile'), files);
  assert.equal(dialogDirs.defaultSavePath('settingsFile', 'b.json'), path.join(files, 'b.json'));
  assert.equal(writes.length, 2);
  assert.ok(writes.every(([k]) => k === dialogDirs.KEY));
});

test('the same folder again writes nothing', () => {
  const dir = tmp();
  const { writes } = setup({ [dialogDirs.KEY]: { projectFolder: dir } });
  dialogDirs.rememberDialogDir('projectFolder', dir, true);
  assert.equal(writes.length, 0);
});

test('a folder that is gone, a file instead of a folder, or a network spelling is not handed back', () => {
  const file = path.join(tmp(), 'f.txt');
  fs.writeFileSync(file, 'x');
  setup({ [dialogDirs.KEY]: {
    gone: path.join(tmp(), 'missing'),
    file,
    unc: String.raw`\\nas-host\share\dir`,
    slashes: '//nas-host/share/dir',
    junk: 42,
  } });
  for (const kind of ['gone', 'file', 'unc', 'slashes', 'junk']) assert.equal(dialogDirs.lastDialogDir(kind), undefined, kind);
});

test('a stored value that is not a map, or a settings read that throws, counts as nothing remembered', () => {
  setup({ [dialogDirs.KEY]: ['not', 'a', 'map'] });
  assert.equal(dialogDirs.lastDialogDir('projectFolder'), undefined);
  dialogDirs.init({ getSetting: () => { throw new Error('locked'); }, setSetting: () => { throw new Error('locked'); }, log: { warn() {} } });
  assert.equal(dialogDirs.lastDialogDir('projectFolder'), undefined);
  assert.doesNotThrow(() => dialogDirs.rememberDialogDir('projectFolder', tmp(), true));
});
