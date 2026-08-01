'use strict';
// Backend-neutral resource discovery: the renderer asks a capability, not a backend id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendResources = require('../src/app/backend-resources');
const claude = require('../src/backends/claude');
const codex = require('../src/backends/codex');
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

test('Claude resource discovery exposes safe settings and project customizations only', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'claude-resources-'));
  const project = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'claude-project-resources-'));
  const roots = claude._roots();
  try {
    claude.setRoots([path.join(home, 'projects')]);
    fs.mkdirSync(path.join(home, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(project, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, 'settings.json'), '{}');
    fs.writeFileSync(path.join(home, '.credentials.json'), '{}');
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'instructions');
    fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), '{}');

    const res = claude.listResources({ projectPath: project });
    assert.equal(res.ok, true);
    const keys = res.resources.map(r => `${r.scope}:${r.kind}:${r.name}`);
    assert.ok(keys.includes('global:settings:settings.json'));
    assert.ok(keys.includes('global:command:commands'));
    assert.ok(keys.includes('project:memory:CLAUDE.md'));
    assert.ok(keys.includes('project:settings:settings.local.json'));
    assert.ok(keys.includes('project:agent:agents'));
    assert.ok(!res.resources.some(r => /credentials|auth|history/i.test(r.path || '')), 'credentials/history are not resources');
  } finally {
    claude.setRoots(roots);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('Codex resource discovery exposes safe config and project instructions only', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codex-resources-'));
  const project = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codex-project-resources-'));
  try {
    codex.setHome(home);
    fs.mkdirSync(path.join(home, 'plugins', 'demo'), { recursive: true });
    fs.mkdirSync(path.join(home, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(project, '.codex', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt"');
    fs.writeFileSync(path.join(home, 'work.config.toml'), 'profile = true');
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    fs.writeFileSync(path.join(project, 'AGENTS.md'), 'instructions');
    fs.writeFileSync(path.join(project, '.codex', 'config.toml'), 'sandbox = "read-only"');

    const res = codex.listResources({ projectPath: project });
    assert.equal(res.ok, true);
    const keys = res.resources.map(r => `${r.scope}:${r.kind}:${r.name}`);
    assert.ok(keys.includes('global:settings:config.toml'));
    assert.ok(keys.includes('global:profile:work'));
    assert.ok(keys.includes('global:plugin:plugins'));
    assert.ok(keys.includes('global:rule:rules'));
    assert.ok(keys.includes('project:memory:AGENTS.md'));
    assert.ok(keys.includes('project:settings:config.toml'));
    assert.ok(keys.includes('project:rule:rules'));
    assert.ok(!res.resources.some(r => /auth|history|sandbox-secrets/i.test(r.path || '')), 'secrets/history are not resources');
  } finally {
    codex.setHome(null);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
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
