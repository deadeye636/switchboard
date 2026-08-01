'use strict';
// Backend-neutral model discovery: the renderer asks a capability, not a backend id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendModels = require('../src/app/backend-models');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');

function fakeRegistry(map) {
  return { get: (id) => map[id] || null };
}

test('backend model discovery delegates to the descriptor hook', async () => {
  const calls = [];
  backendModels.init({ backends: fakeRegistry({
    pi: { listModels: async (opts) => { calls.push(opts); return { ok: true, models: [{ id: 'p/m', label: 'p/m' }] }; } },
  }) });
  const res = await backendModels.listModels('pi', 'gpt');
  assert.deepEqual(calls, [{ search: 'gpt' }]);
  assert.deepEqual(res, { ok: true, models: [{ id: 'p/m', label: 'p/m' }] });
});

test('backend model discovery declines for backends without the capability', async () => {
  backendModels.init({ backends: fakeRegistry({ codex: {} }) });
  const res = await backendModels.listModels('codex', 'gpt');
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not support/);
});

test('the model-discovery IPC is registered in an app module, not main.js', () => {
  assert.doesNotMatch(MAIN, /ipcMain\.handle\('backend-list-models'/,
    'new IPC handlers must not be added to main.js');
  assert.match(MAIN, /backendModels\.registerIpc\(ipcMain\)/,
    'main wires the app module instead');
  assert.match(PRELOAD, /listModels: \(backendId, search\) => ipcRenderer\.invoke\('backend-list-models', backendId, search\)/,
    'the renderer has a narrow API surface for the capability');
});
