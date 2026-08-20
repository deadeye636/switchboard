'use strict';
// Backend-neutral resource discovery: the renderer asks a capability, not a backend id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendResources = require('../src/app/backend-resources');
const claude = require('../src/backends/claude');
const codex = require('../src/backends/codex');
const agyResources = require('../src/backends/agy/resources');
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

// --- what a failure is allowed to say (#444) ---------------------------------
//
// These reasons are put on screen verbatim. A filesystem error names the path it failed on, which here
// is always somewhere under the user's home — so an errno is translated and the rest of the message is
// dropped rather than trimmed. The assertions look for the home marker the fixture plants, because a
// check for "no path" cannot be written and a check for "not THIS path" can.

const SECRET_PATH = '/home/someone/.pi/skills';

function errnoError(code) {
  const err = new Error(`${code}: whatever the OS said, scandir '${SECRET_PATH}'`);
  err.code = code;
  return err;
}

test('a listing that throws is reported in words, without the path it failed on', async () => {
  backendResources.init({ backends: fakeRegistry({
    pi: { listResources: async () => { throw errnoError('EACCES'); } },
  }) });
  const res = await backendResources.listResources('pi', null);
  assert.equal(res.ok, false);
  assert.match(res.reason, /Could not list backend resources/);
  assert.match(res.reason, /Permission was denied/, 'the errno is translated, so the user learns something');
  assert.ok(!res.reason.includes(SECRET_PATH), 'and never carries the path');
  assert.ok(!/EACCES|scandir/.test(res.reason), 'nor the raw error string');
});

test('an unrecognised throw falls back to the caller sentence and nothing else', async () => {
  backendResources.init({ backends: fakeRegistry({
    pi: { listResources: async () => { throw new Error(`something odd about ${SECRET_PATH}`); } },
  }) });
  const res = await backendResources.listResources('pi', null);
  // No code to translate means no way to tell what the message carries — so none of it is passed on.
  assert.equal(res.reason, 'Could not list backend resources.');
});

test('what the user is not told, the log still is', async () => {
  // Dropping the detail in BOTH places would make a failure nobody can explain and nobody can look up.
  const lines = [];
  backendResources.init({
    log: { debug: (line) => lines.push(line) },
    backends: fakeRegistry({
      pi: { listResources: async () => { throw new Error(`something odd about ${SECRET_PATH}`); } },
    }),
  });
  const res = await backendResources.listResources('pi', null);
  assert.equal(res.reason, 'Could not list backend resources.');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(SECRET_PATH), 'the raw message is the whole point of the log entry');
});

test('the module works with no log at all', async () => {
  // main.js hands one in, `node --test` does not, and a missing logger must not turn a handled failure
  // into a thrown one.
  backendResources.init({ backends: fakeRegistry({
    pi: { listResources: async () => { throw errnoError('EACCES'); } },
  }) });
  const res = await backendResources.listResources('pi', null);
  assert.match(res.reason, /Permission was denied/);
});

test('a directory that cannot be read is reported in words', async () => {
  backendResources.init({ backends: fakeRegistry({
    pi: {
      listResources: async () => ({ ok: true, resources: [{ kind: 'skill', path: '/ok/skills', source: 'skills-directory' }] }),
      expandResource: async () => { throw errnoError('EACCES'); },
    },
  }) });
  const res = await backendResources.expandResource('pi', '/ok/skills', null);
  assert.equal(res.ok, false);
  assert.match(res.reason, /Could not read that directory\. Permission was denied\./);
  assert.ok(!res.reason.includes(SECRET_PATH));
});

test('a system that refuses to open a path does not quote itself at the user', async () => {
  backendResources.init({
    shell: { openPath: async () => `Failed to open path ${SECRET_PATH}` },
    backends: fakeRegistry({
      pi: { listResources: async () => ({ ok: true, resources: [{ kind: 'settings', path: '/ok/settings.json' }] }) },
    }),
  });
  const res = await backendResources.openResource('pi', '/ok/settings.json', null);
  assert.equal(res.ok, false);
  assert.ok(!res.reason.includes(SECRET_PATH), 'the OS message is localized, quoted and full of path');
  assert.match(res.reason, /would not open/);
});

test('a backend-authored reason is not an error and passes through untouched', async () => {
  backendResources.init({ backends: fakeRegistry({
    pi: { listResources: async () => ({ ok: false, reason: 'Pi is configured to keep its skills elsewhere.' }) },
  }) });
  const res = await backendResources.listResources('pi', null);
  assert.equal(res.reason, 'Pi is configured to keep its skills elsewhere.');
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

test('agy resource discovery exposes safe settings and instructions only', () => {
  const geminiHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'agy-gemini-resources-'));
  const agyHome = path.join(geminiHome, 'antigravity-cli');
  const conversations = path.join(agyHome, 'conversations');
  const project = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'agy-project-resources-'));
  try {
    const listResources = agyResources.createListResources({ conversationsRoot: () => conversations });
    fs.mkdirSync(conversations, { recursive: true });
    fs.mkdirSync(path.join(agyHome, 'builtin'), { recursive: true });
    fs.mkdirSync(path.join(agyHome, 'implicit'), { recursive: true });
    fs.mkdirSync(path.join(agyHome, 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(agyHome, 'log'), { recursive: true });
    fs.writeFileSync(path.join(geminiHome, 'GEMINI.md'), 'instructions');
    fs.writeFileSync(path.join(geminiHome, 'settings.json'), '{}');
    fs.writeFileSync(path.join(geminiHome, 'oauth_creds.json'), '{}');
    fs.writeFileSync(path.join(agyHome, 'settings.json'), '{}');
    fs.writeFileSync(path.join(agyHome, 'history.jsonl'), '{}\n');
    fs.writeFileSync(path.join(conversations, 'abc.db'), 'sqlite');
    fs.writeFileSync(path.join(project, 'GEMINI.md'), 'project instructions');

    const res = listResources({ projectPath: project });
    assert.equal(res.ok, true);
    const keys = res.resources.map(r => `${r.scope}:${r.kind}:${r.name}`);
    assert.ok(keys.includes('global:memory:GEMINI.md'));
    assert.ok(keys.includes('global:settings:settings.json'));
    assert.ok(keys.includes('global:resource:builtin'));
    assert.ok(keys.includes('global:resource:implicit'));
    assert.ok(keys.includes('global:memory-store:knowledge'));
    assert.ok(keys.includes('project:memory:GEMINI.md'));
    const relativePaths = res.resources.map(r => path.relative(geminiHome, r.path || ''));
    assert.ok(!relativePaths.some(p => /oauth|account|auth|history|conversation|\.db$|(^|[\\/])(log|crashes|cache|tmp|scratch)([\\/]|$)/i.test(p)),
      'credentials, logs, histories and conversation stores are not resources');
  } finally {
    fs.rmSync(geminiHome, { recursive: true, force: true });
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
