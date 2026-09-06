'use strict';

// Protocol test for the projects scan worker (workers/scan-projects.js). Guards
// the message shapes the main process depends on: progress {type:'progress',text},
// one {type:'folder',result} per scanned folder (#567), the terminal {ok:true,folders},
// and the failure {ok:false,status}. Runs the real worker in a
// worker thread — its deps (folder-index-state / derive-project-path /
// read-session-file) are pure JS, so no native module is needed (#82).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { encodeProjectPath } = require('../src/session/encode-project-path');

const WORKER = path.join(__dirname, '..', 'src', 'workers', 'scan-projects.js');

function runWorker(projectsDir) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const w = new Worker(WORKER, { workerData: { projectsDir } });
    w.on('message', (m) => messages.push(m));
    w.on('error', reject);
    w.on('exit', () => resolve(messages));
  });
}

// One scannable folder: a real cwd on disk, the store folder encoded from it, and a transcript naming
// that cwd — the worker skips a folder it cannot derive a project path for, so the cwd has to be real.
function writeFolder(tmp, name) {
  const cwd = path.join(tmp, 'cwds', name);
  fs.mkdirSync(cwd, { recursive: true });
  const folderKey = encodeProjectPath(cwd);
  const dir = path.join(tmp, 'store', folderKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 's.jsonl'),
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } }) + '\n',
    'utf8',
  );
  return folderKey;
}

test('scan worker streams one {type:"folder"} per folder, then {ok:true, folders}', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-proj-'));
  try {
    const folderKey = writeFolder(tmp, 'demo');

    const msgs = await runWorker(path.join(tmp, 'store'));

    const final = msgs[msgs.length - 1];
    assert.equal(final.ok, true, 'final message must be {ok:true}');
    assert.equal(final.folders, 1, 'the terminal message reports how many folders were streamed');
    // #567: the results do NOT ride the terminal message any more — main applies each folder as it
    // arrives, so a whole store is never deserialised and written in one uninterruptible stretch.
    assert.equal(final.results, undefined, 'no results array on the terminal message');

    const folders = msgs.filter((m) => m && m.type === 'folder');
    assert.equal(folders.length, 1, 'one folder message per scanned folder');
    assert.equal(folders[0].result.folder, folderKey);
    assert.equal(folders[0].result.sessions.length, 1);
    assert.equal(typeof folders[0].result.indexMtimeMs, 'number');
    assert.equal(typeof folders[0].result.projectPath, 'string');

    const progress = msgs.filter((m) => m && m.type === 'progress');
    assert.ok(progress.length >= 1, 'at least one progress message');
    for (const p of progress) assert.equal(typeof p.text, 'string');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a folder message is posted BEFORE the scan has finished every folder', async () => {
  // The whole point of the stream (#567): main gets folder 1 while the worker is still reading folder N,
  // so the DB writes overlap the parse instead of landing in one bite at the end. The observable form of
  // that is ordering — the first folder message precedes the terminal one, with the others in between.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-proj-'));
  try {
    for (let i = 0; i < 4; i++) writeFolder(tmp, `demo-${i}`);

    const msgs = await runWorker(path.join(tmp, 'store'));
    const kinds = msgs.map((m) => (m && m.type) || (m && m.ok === true ? 'done' : 'fail'));

    assert.equal(kinds.filter((k) => k === 'folder').length, 4);
    assert.equal(kinds[kinds.length - 1], 'done', 'the terminal message comes last');
    assert.ok(
      kinds.indexOf('folder') < kinds.lastIndexOf('folder'),
      'folders arrive as separate messages, not as one batch',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scan worker reports {ok:false, status} when the projects dir is unreadable', async () => {
  const missing = path.join(os.tmpdir(), 'scan-proj-missing-' + process.pid + '-' + process.hrtime.bigint());
  const msgs = await runWorker(missing);
  const final = msgs[msgs.length - 1];
  assert.equal(final.ok, false, 'a readdir failure must surface as {ok:false}');

  // `status`, not `error`, since #457. This string is not internal: `store-indexer.js` puts it straight
  // into the main window's status bar, so the field name says which of the two it is — and the worker
  // words it, because the thrown message names the store root, a path under the user's home.
  assert.equal(typeof final.status, 'string', 'the reader-facing line must be a string');
  assert.equal(final.error, undefined, 'nothing here forwards the thrown message any more');
  assert.ok(!final.status.includes(missing), 'and it does not carry the path it failed on');
  assert.ok(!/^E[A-Z]+:/.test(final.status), 'nor the raw errno');
});
