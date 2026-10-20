'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { composeMcpInjection } = require('../src/app/mcp-inject');
const { stripComments } = require('./helpers/strip-comments');

function makeLog() {
  const lines = { debug: [], info: [], warn: [] };
  return { lines, debug: (m) => lines.debug.push(m), info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) };
}

const HTTP = { name: 'own', transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer x' } };
const STDIO = { name: 'local', transport: 'stdio', command: 'node', args: ['s.js'], env: {} };

function fakeBackend(over = {}) {
  const calls = { build: [], release: [] };
  return {
    calls,
    providesMcpInjection: true,
    acceptsMcpTransports: ['http'],
    buildMcpInjection: (a) => { calls.build.push(a); return { args: ['--mcp', 'f.json'], env: { K: 'v' }, cleanup: { file: 'f.json' } }; },
    releaseMcpInjection: (c) => calls.release.push(c),
    ...over,
  };
}

test('a backend without the capability gets null and its hook is not called', async () => {
  const backend = fakeBackend({ providesMcpInjection: false });
  assert.strictEqual(await composeMcpInjection({ backend, ctx: { log: makeLog() }, sources: [[HTTP]] }), null);
  assert.strictEqual(backend.calls.build.length, 0);
});

test('a row of an undeclared transport is dropped with a reason logged', async () => {
  const log = makeLog();
  const backend = fakeBackend();
  const out = await composeMcpInjection({ backend, ctx: { log }, sources: [[HTTP, STDIO]], cwd: '/p', dir: '/d', tag: 't' });
  assert.deepStrictEqual(backend.calls.build[0].servers.map((s) => s.name), ['own']);
  assert.strictEqual(backend.calls.build[0].cwd, '/p');
  assert.deepStrictEqual(out.args, ['--mcp', 'f.json']);
  assert.deepStrictEqual(out.env, { K: 'v' });
  assert.ok(log.lines.info.some((m) => /local/.test(m) && /stdio/.test(m)));
});

test('no row left after the drop yields null without calling the hook', async () => {
  const backend = fakeBackend();
  assert.strictEqual(await composeMcpInjection({ backend, ctx: { log: makeLog() }, sources: [[STDIO]] }), null);
  assert.strictEqual(backend.calls.build.length, 0);
});

test('a throwing hook yields null plus a warning and never throws', async () => {
  const log = makeLog();
  const backend = fakeBackend({ buildMcpInjection: () => { throw new Error('boom'); } });
  assert.strictEqual(await composeMcpInjection({ backend, ctx: { log }, sources: [[HTTP]] }), null);
  assert.ok(log.lines.warn.some((m) => /boom/.test(m)));
});

test('a hook answering null yields null; a throwing source costs only its rows', async () => {
  const log = makeLog();
  const none = fakeBackend({ buildMcpInjection: () => null });
  assert.strictEqual(await composeMcpInjection({ backend: none, ctx: { log }, sources: [[HTTP]] }), null);
  const backend = fakeBackend();
  const out = await composeMcpInjection({ backend, ctx: { log }, sources: [() => { throw new Error('src'); }, async () => [HTTP]] });
  assert.ok(out);
  assert.strictEqual(backend.calls.build[0].servers.length, 1);
  assert.ok(log.lines.warn.some((m) => /src/.test(m)));
});

test('release is idempotent: the cleanup runs once', async () => {
  const backend = fakeBackend();
  const out = await composeMcpInjection({ backend, ctx: { log: makeLog() }, sources: [[HTTP]] });
  out.release();
  out.release();
  assert.deepStrictEqual(backend.calls.release, [{ file: 'f.json' }]);
});

test('a throwing release is swallowed with a warning', async () => {
  const log = makeLog();
  const backend = fakeBackend({ releaseMcpInjection: () => { throw new Error('rel'); } });
  const out = await composeMcpInjection({ backend, ctx: { log }, sources: [[HTTP]] });
  assert.doesNotThrow(() => out.release());
  assert.ok(log.lines.warn.some((m) => /rel/.test(m)));
});

test('the module names no backend id', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'mcp-inject.js'), 'utf8'));
  const ids = fs.readdirSync(path.join(__dirname, '..', 'src', 'backends'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name.replace(/-native$/, ''));
  for (const id of new Set([...ids, 'claude', 'codex', 'hermes', 'pi', 'agy'])) {
    assert.ok(!new RegExp(`\\b${id}\\b`, 'i').test(src), `names backend id "${id}"`);
  }
  assert.ok(!/require\([^)]*\b(electron|\/db\/)/.test(src));
});
