'use strict';
// #658 — a session a backend DRIVES (it declares `transcriptsOf`) stays the owner's row, says how it was
// driven, and reaches the sidebar while the driver is on even with the owner switched off.
//
// Three halves, each against the real module:
//   - Claude's reader reads the transport marker, the `entrypoint` the driver sets (claude/transport-marker.js);
//   - Claude's provenance stamp names the row's OWNER, not the backend a launch recorded;
//   - which stores are read follows the drivers as well as the owners (registry `storesRead`), and both the
//     Claude indexer and the other stores' scan roster ask it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backends = require('../src/backends');
const profiles = require('../src/backends/profiles');
const reader = require('../src/backends/claude/session-reader');
const marker = require('../src/backends/claude/transport-marker');
const sessionBackends = require('../src/session/session-backends');
const storeIndexer = require('../src/backends/claude/store-indexer');
const scan = require('../src/backends/scan');

// A backend that drives Claude's binary without owning its rows — the shape claude-native will have (#653).
// Registered once for this file; node runs each test file in a process of its own.
const DRIVER = 'test-claude-driver';
backends.register({ id: DRIVER, label: 'Test driver', status: 'ready', transport: 'rpc', transcriptsOf: 'claude' });

function withSettings(backendEnabled, templates, fn) {
  const store = { list: () => templates || [], get: (id) => (templates || []).find(p => p.id === id) || null };
  backends.init({ getGlobalSettings: () => ({ backendEnabled }), profiles: store });
  try { return fn(); } finally { backends.init({ getGlobalSettings: () => ({}), profiles }); }
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-driver-owner-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS will */ } });
  return dir;
}

const line = (over) => JSON.stringify({
  type: 'user', entrypoint: 'cli', cwd: path.join(os.tmpdir(), 'demo-project'), timestamp: '2026-09-26T10:00:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] }, ...over,
}) + '\n';

// --- the marker ---------------------------------------------------------------------------------------

test('the marker is the entrypoint the driver sets, spelled in one place', () => {
  assert.equal(marker.TRANSPORT_ENTRYPOINT_ENV, 'CLAUDE_CODE_ENTRYPOINT');
  assert.equal(marker.transportFromEntry({ entrypoint: marker.TRANSPORT_ENTRYPOINT }), marker.TRANSPORT);
  assert.equal(marker.transportFromEntry({ entrypoint: 'cli' }), null, 'a terminal session');
  assert.equal(marker.transportFromEntry({ entrypoint: 'sdk-cli' }), null, 'a user\'s own claude -p script');
  assert.equal(marker.transportFromEntry({}), null);
});

test('a transcript with a marked line reads as driven over the pipe; one without does not', (t) => {
  const dir = tempDir(t);
  const plain = path.join(dir, 'plain.jsonl');
  const driven = path.join(dir, 'driven.jsonl');
  fs.writeFileSync(plain, line() + line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }));
  fs.writeFileSync(driven, line() + line({ entrypoint: marker.TRANSPORT_ENTRYPOINT }));
  assert.equal(reader.readSessionFile(plain, 'f', '/p').transport, null);
  assert.equal(reader.readSessionFile(driven, 'f', '/p').transport, 'rpc', 'any one line is enough: "at least once"');
});

test('the incremental read keeps the marker it saw, and picks up one that arrives in an append', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, line());
  const first = reader.readSessionFileIncremental(file, 'f', '/p', {}, null);
  assert.equal(first.session.transport, null);
  fs.appendFileSync(file, line({ entrypoint: marker.TRANSPORT_ENTRYPOINT }));
  const second = reader.readSessionFileIncremental(file, 'f', '/p', {}, first.next);
  assert.equal(second.session.transport, 'rpc');
  fs.appendFileSync(file, line());
  const third = reader.readSessionFileIncremental(file, 'f', '/p', {}, second.next);
  assert.equal(third.session.transport, 'rpc', 'a later terminal line does not take it back');
});

// --- the owner --------------------------------------------------------------------------------------

test('rowOwnerOf: a driver answers its owner, anything else answers itself', () => {
  withSettings({}, [], () => {
    assert.equal(backends.rowOwnerOf(DRIVER), 'claude');
    assert.equal(backends.rowOwnerOf('pi-native'), 'pi');
    assert.equal(backends.rowOwnerOf('claude'), 'claude');
    assert.equal(backends.rowOwnerOf('not-registered'), 'not-registered', 'an id the registry does not know is kept');
    assert.equal(backends.rowOwnerOf(''), null);
  });
});

test('rowOwnerOf keeps a template\'s own id — its sessions are its own', () => {
  withSettings({}, [{ id: 'tpl-658', backendId: 'claude', label: 'Template' }], () => {
    assert.equal(backends.rowOwnerOf('tpl-658'), 'tpl-658');
  });
});

test('the Claude stamp names the row\'s owner for a driven launch, and leaves a plain or profile launch as it was', (t) => {
  const dir = tempDir(t);
  sessionBackends._configureForTests({ filePath: path.join(dir, 'session-backends.json') });
  t.after(() => sessionBackends._configureForTests({}));
  sessionBackends.record('driven', DRIVER);
  sessionBackends.record('plain', 'claude');
  sessionBackends.record('profiled', 'tpl-658', 'prof-1');
  withSettings({}, [{ id: 'tpl-658', backendId: 'claude', label: 'Template' }], () => {
    const driven = storeIndexer.stampClaudeProvenance({ sessionId: 'driven', backendId: 'claude', transport: 'rpc' });
    assert.equal(driven.backendId, 'claude', 'the owner, so Claude\'s own reconcile can find the row again');
    assert.equal(driven.transport, 'rpc');
    assert.equal(storeIndexer.stampClaudeProvenance({ sessionId: 'plain', backendId: 'claude' }).backendId, 'claude');
    const profiled = storeIndexer.stampClaudeProvenance({ sessionId: 'profiled', backendId: 'claude' });
    assert.equal(profiled.backendId, 'tpl-658');
    assert.equal(profiled.profileId, 'prof-1');
  });
});

test('a driven row opens in the driver while it is on, and in the owner once it is off', () => {
  const row = { backendId: 'claude', transport: 'rpc' };
  withSettings({ claude: true, [DRIVER]: true }, [], () => assert.equal(backends.openerFor(row), DRIVER));
  withSettings({ claude: true, [DRIVER]: false }, [], () => assert.equal(backends.openerFor(row), 'claude'));
});

// --- which stores are read ------------------------------------------------------------------------

test('a store is read while its owner OR a driver of it is on, and not while both are off', () => {
  withSettings({ pi: false, 'pi-native': true }, [], () => {
    assert.equal(backends.isLaunchable('pi'), false, 'Pi itself stays off');
    assert.equal(backends.storeIsRead('pi'), true);
    assert.ok(scan.axisBRoster().includes('pi'), 'so the scan picks up the sessions pi-native writes');
  });
  withSettings({ pi: false, 'pi-native': false }, [], () => {
    assert.equal(backends.storeIsRead('pi'), false);
    assert.ok(!scan.axisBRoster().includes('pi'));
  });
  withSettings({ pi: true, 'pi-native': false }, [], () => assert.ok(scan.axisBRoster().includes('pi')));
});

test('Claude\'s store is read while a driver of it is on, even with Claude switched off', () => {
  withSettings({ claude: false, [DRIVER]: true }, [], () => {
    assert.equal(backends.isLaunchable('claude'), false);
    assert.equal(storeIndexer.claudeEnabled(), true);
  });
  withSettings({ claude: false, [DRIVER]: false }, [], () => assert.equal(storeIndexer.claudeEnabled(), false));
});

test('a driver never lands in the scan roster itself — it has no store of its own', () => {
  withSettings({ pi: true, 'pi-native': true }, [], () => {
    assert.ok(!scan.axisBRoster().includes('pi-native'));
    assert.ok(!backends.storesRead().has('pi-native'));
  });
});
