'use strict';

// Protocol test for the projects scan worker (workers/scan-projects.js). Guards
// the message shapes the main process depends on: progress {type:'progress',text},
// success {ok:true,results}, failure {ok:false,error}. Runs the real worker in a
// worker thread — its deps (folder-index-state / derive-project-path /
// read-session-file) are pure JS, so no native module is needed (#82).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKER = path.join(__dirname, '..', 'workers', 'scan-projects.js');

function runWorker(projectsDir) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const w = new Worker(WORKER, { workerData: { projectsDir } });
    w.on('message', (m) => messages.push(m));
    w.on('error', reject);
    w.on('exit', () => resolve(messages));
  });
}

test('scan worker emits progress messages then a final {ok:true, results}', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-proj-'));
  try {
    const folder = path.join(tmp, '-tmp-proj');
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, 's.jsonl'),
      '{"type":"user","message":{"role":"user","content":"hi"}}\n',
      'utf8',
    );

    const msgs = await runWorker(tmp);

    const final = msgs[msgs.length - 1];
    assert.equal(final.ok, true, 'final message must be {ok:true}');
    assert.ok(Array.isArray(final.results), 'final message must carry a results array');

    const progress = msgs.filter((m) => m && m.type === 'progress');
    assert.ok(progress.length >= 1, 'at least one progress message');
    for (const p of progress) assert.equal(typeof p.text, 'string');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scan worker reports {ok:false, error} when the projects dir is unreadable', async () => {
  const missing = path.join(os.tmpdir(), 'scan-proj-missing-' + process.pid + '-' + process.hrtime.bigint());
  const msgs = await runWorker(missing);
  const final = msgs[msgs.length - 1];
  assert.equal(final.ok, false, 'a readdir failure must surface as {ok:false}');
  assert.equal(typeof final.error, 'string', 'error must be a string message');
});
