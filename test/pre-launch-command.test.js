'use strict';
// A pre-launch command belongs to every backend, not to Claude.
//
// It is a raw shell prefix — `nvm use 20 &&`, `aws-vault exec profile --`, `conda activate x &&`. Nothing
// about it is Claude's. It was gated on the claude binary for a reason that was never written down and
// turns out to be about the SPAWN MODE: Claude starts through a shell (there is a command line to prefix),
// while the Axis-B backends start argv (no shell, because Windows shell quoting mangles their arguments).
//
// So the fix is not to keep the option Claude's forever. It is to spawn through the shell for the one
// session where somebody actually set a prefix, and leave argv the default for everyone else.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backends = require('../src/backends');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8');

// --- the option is offered everywhere ---------------------------------------------------------------

test('every backend offers a pre-launch command', () => {
  for (const b of backends.list()) {
    if (b.status !== 'ready') continue;
    const field = (b.configFields || []).find(f => f.id === 'preLaunchCmd');
    assert.ok(field, `${b.id} does not offer a pre-launch command — it is not a Claude thing`);
    assert.equal(field.appliesAt, 'spawn',
      'it prefixes the command line, so it is not part of any backend\'s argv');
  }
});

test('it is declared ONCE, centrally — not copied into four descriptors to drift', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'backends', 'index.js'), 'utf8');
  assert.match(src, /const UNIVERSAL_FIELDS = \[/,
    'an option that belongs to Switchboard rather than to a CLI is added by the registry');
  const claude = fs.readFileSync(path.join(__dirname, '..', 'src', 'backends', 'claude', 'index.js'), 'utf8');
  const fields = claude.slice(claude.indexOf('const configFields = ['), claude.indexOf('\n];'));
  assert.ok(!/id: 'preLaunchCmd'/.test(fields),
    'Claude must not declare it too, or a backend would carry the field twice');
});

test('a backend that already declares it is not given a second copy', () => {
  const fake = backends.register({
    id: 'faketest-prelaunch', label: 'Fake', status: 'ready', axis: 'B', tier: 1,
    monogram: 'F', colour: 'fake',
    configFields: [{ id: 'preLaunchCmd', label: 'Mine', type: 'text', default: 'x', appliesAt: 'spawn' }],
    buildLaunch: () => ({ command: 'fake', args: [], env: {}, spawnMode: 'argv' }),
    discoverSessions: () => [], parseSession: () => null, watchTargets: () => [], deriveState: null,
  });
  const listed = backends.get('faketest-prelaunch');
  const hits = listed.configFields.filter(f => f.id === 'preLaunchCmd');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].default, 'x', 'and the backend\'s own declaration wins');
  assert.ok(fake);
});

// --- the spawn -------------------------------------------------------------------------------------
//
// A static guard on spawn.js's source. Not because the module cannot be required — since #213 it can —
// but because reaching this code means spawning a real PTY. The refusal paths ARE exercised for real in
// test/spawn-guards.test.js; what stays here is the shape of the command that gets built.

test('setting a pre-launch command drops the session to the shell path', () => {
  assert.match(MAIN, /const useArgvSpawn = !!argvExe && !preLaunchCmd;/,
    'argv mode has no command line to prefix — so a prefix means a shell, for that session only');
});

test('the prefix is applied to EVERY backend, not just the claude binary', () => {
  const block = MAIN.slice(MAIN.indexOf('let claudeCmd = null;'));
  const body = block.slice(0, block.indexOf('\n      }') + 8);
  assert.match(body, /if \(preLaunchCmd\) claudeCmd = preLaunchCmd \+ ' ' \+ claudeCmd;/);
  assert.ok(!/isClaudeBinary && sessionOptions\?\.preLaunchCmd/.test(MAIN),
    'the old Claude-only gate must be gone');
});

// The MCP bridge is a different matter and must STAY Claude's: `--ide` is a claude flag and the bridge
// speaks Claude's own protocol. The two were gated together, which is the only reason they looked alike.
test('the MCP bridge stays Claude-only', () => {
  assert.match(MAIN, /if \(isClaudeBinary && sessionOptions\?\.mcpEmulation !== false\)/,
    'handing Codex `--ide` would be a flag it does not know');
});

test('a newline is refused — it would smuggle a second command line in', () => {
  assert.match(MAIN, /if \(preLaunchCmd && \/\[\\r\\n\]\/\.test\(preLaunchCmd\)\)/);
  assert.match(MAIN, /must not contain newlines/);
});
