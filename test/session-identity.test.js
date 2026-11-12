'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ownsId, deleteIfOwner } = require('../src/app/terminal/session-identity');

// #854: the exit of a stopped process can land after a new one took the same id.
test('a stale exit does not delete the session that replaced it', () => {
  const active = new Map();
  const oldSession = { name: 'old' };
  const newSession = { name: 'new' };
  active.set('s1', oldSession);
  active.set('s1', newSession); // stop is async: the respawn registers first
  assert.equal(ownsId(active, 's1', oldSession), false);
  assert.equal(deleteIfOwner(active, 's1', oldSession), false);
  assert.equal(active.get('s1'), newSession, 'the replacement survives');
});

test('the current session, or one whose entry is already gone, is cleaned up as before', () => {
  const active = new Map();
  const s = {};
  active.set('s1', s);
  assert.equal(deleteIfOwner(active, 's1', s), true);
  assert.equal(active.has('s1'), false);
  assert.equal(ownsId(active, 's1', s), true, 'an entry that is gone is still its own to clean up after');
  assert.equal(deleteIfOwner(active, 's1', s), true);
});

const { beginOpen, isOpening } = require('../src/app/terminal/session-identity');
const fs = require('node:fs');
const path = require('node:path');

// The ordering the issue is about: close-terminal dropped the exited entry, the reopen is still working
// through its awaits, and only then does the old process's exit land.
test('an exit that lands while a reopen is in flight is stale, before and after the replacement registers', () => {
  const active = new Map();
  const oldSession = {};
  const newSession = {};
  const endOpen = beginOpen('s1');
  assert.equal(isOpening('s1'), true);
  assert.equal(ownsId(active, 's1', oldSession), false, 'no entry, open in flight');
  active.set('s1', newSession);
  assert.equal(ownsId(active, 's1', oldSession), false, 'replacement registered');
  assert.equal(ownsId(active, 's1', newSession), true, 'the replacement\'s own exit is not stale');
  endOpen();
  endOpen();
  assert.equal(isOpening('s1'), false);
  active.delete('s1');
  assert.equal(ownsId(active, 's1', oldSession), true, 'nothing took the id: ordinary exit');
});

// A re-keyed session ended up under its real id; the original id is a stored session the user may open again.
// Its replacement takes only the original id, so this process still owns, and cleans up, the id it ended up with.
test('after a re-key, a replacement under the original id leaves the real id to the exiting process', () => {
  const active = new Map();
  const child = {};
  const replacement = {};
  active.set('real', child);
  active.set('orig', replacement);
  assert.equal(ownsId(active, 'real', child), true);
  assert.equal(ownsId(active, 'orig', child), false);
  // The user reopens the original id while the child is still exiting: that open must not take the real id.
  active.delete('orig');
  const endOpen = beginOpen('orig');
  assert.equal(ownsId(active, 'orig', child), false, 'an open in flight for the original id');
  assert.equal(ownsId(active, 'real', child), true, 'the real id stays the child\'s while the original is reopened');
  active.delete('real');
  assert.equal(ownsId(active, 'real', child), true, 'its own entry already gone, nothing opening it: still its own');
  endOpen();
});

test('nested opens of one id are counted, and the id stays taken until the last is over', () => {
  const a = beginOpen('s2');
  const b = beginOpen('s2');
  a();
  assert.equal(isOpening('s2'), true);
  b();
  assert.equal(isOpening('s2'), false);
});

// spawn.js needs node-pty at load, so the wiring is pinned as source (see .claude/rules/guards-and-scripts.md):
// the open is marked on every path by the wrapper, and the exit handler asks the helper before it announces.
test('spawn.js marks every open and gates the id-keyed exit work on the helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8');
  assert.match(src, /const endOpen = beginOpen\(sessionId\);\s*try \{\s*return await openTerminalBody\([^)]*\);\s*\} finally \{\s*endOpen\(\);/);
  // Per id, not one flag for both: a replacement under the original id must not stop the real id's cleanup.
  assert.match(src, /const ownsReal = ownsId\(ctx\.activeSessions, realId, session\)/);
  assert.match(src, /ownsId\(ctx\.activeSessions, sessionId, session\)/);
  assert.match(src, /if \(ownsReal\) ctx\.shutdownMcpServer\(/);
  assert.match(src, /if \(ownsReal\) sendToWindow\('process-exited', realId/);
  assert.match(src, /if \(!owns\(id\)\) continue;/);
  assert.match(src, /if \(ownsReal\) ctx\.cleanupSecretRefsForSession\(realId\)/);
  assert.doesNotMatch(src, /isSupersededExit/, 'one flag for both ids is the re-key regression');
});
