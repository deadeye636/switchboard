'use strict';
// Backend-neutral resource discovery: the renderer asks a capability, not a backend id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendResources = require('../src/app/backend-resources');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');

function fakeRegistry(map) {
  return { get: (id) => map[id] || null };
}

test('backend resource discovery delegates to the descriptor hook', async () => {
  const calls = [];
  backendResources.init({ backends: fakeRegistry({
    pi: { listResources: async (opts) => { calls.push(opts); return { ok: true, resources: [{ kind: 'skill', name: 's' }] }; } },
  }) });
  const res = await backendResources.listResources('pi', '/project');
  assert.deepEqual(calls, [{ projectPath: '/project' }]);
  assert.deepEqual(res, { ok: true, resources: [{ kind: 'skill', name: 's' }] });
});

test('backend resource discovery declines for backends without the capability', async () => {
  backendResources.init({ backends: fakeRegistry({ codex: {} }) });
  const res = await backendResources.listResources('codex', '/project');
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not expose resources/);
});

test('opening a backend resource is restricted to discovered paths', async () => {
  const opened = [];
  backendResources.init({
    shell: { openPath: async (p) => { opened.push(p); return ''; } },
    backends: fakeRegistry({
      pi: { listResources: async () => ({ ok: true, resources: [{ kind: 'settings', path: '/ok/settings.json' }] }) },
    }),
  });
  assert.deepEqual(await backendResources.openResource('pi', '/ok/settings.json', null), { ok: true });
  assert.deepEqual(opened, ['/ok/settings.json']);
  const denied = await backendResources.openResource('pi', '/nope', null);
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /not a discovered resource/);
});

test('the resource-discovery IPC is registered in an app module, not main.js', () => {
  assert.doesNotMatch(MAIN, /ipcMain\.handle\('backend-list-resources'/,
    'new IPC handlers must not be added to main.js');
  assert.match(MAIN, /backendResources\.registerIpc\(ipcMain\)/,
    'main wires the app module instead');
  assert.match(PRELOAD, /listResources: \(backendId, projectPath\) => ipcRenderer\.invoke\('backend-list-resources', backendId, projectPath\)/,
    'the renderer has a narrow API surface for the capability');
  assert.match(PRELOAD, /openResource: \(backendId, resourcePath, projectPath\) => ipcRenderer\.invoke\('backend-open-resource', backendId, resourcePath, projectPath\)/,
    'opening is scoped through the same backend-owned resource list');
});
