'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sb = require('../src/session/session-backends');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbtest-'));
  return path.join(dir, 'session-backends.json');
}

test('record + getAll round-trip', () => {
  sb._configureForTests({ filePath: tmpFile() });
  sb.record('s1', 'claude', null);
  sb.record('s2', 'deepseek', 'prof-ds');
  const all = sb.getAll();
  assert.deepStrictEqual(all.s1, { backendId: 'claude', profileId: null });
  assert.deepStrictEqual(all.s2, { backendId: 'deepseek', profileId: 'prof-ds' });
});

test('get returns a single entry or null', () => {
  sb._configureForTests({ filePath: tmpFile() });
  sb.record('s1', 'codex');
  assert.deepStrictEqual(sb.get('s1'), { backendId: 'codex', profileId: null });
  assert.strictEqual(sb.get('nope'), null);
});

test('record ignores invalid input', () => {
  sb._configureForTests({ filePath: tmpFile() });
  sb.record('', 'claude');
  sb.record('s', '');
  assert.deepStrictEqual(sb.getAll(), {});
});

test('flushNow persists and reloads from disk', () => {
  const file = tmpFile();
  sb._configureForTests({ filePath: file });
  sb.record('s1', 'claude');
  sb.record('s2', 'codex', 'p2');
  sb.flushNow();
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.version, 1);
  assert.deepStrictEqual(onDisk.sessions.s2, { backendId: 'codex', profileId: 'p2' });
  // fresh load
  sb._configureForTests({ filePath: file });
  assert.deepStrictEqual(sb.getAll().s1, { backendId: 'claude', profileId: null });
});

test('load drops junk entries', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    sessions: {
      good: { backendId: 'claude', profileId: null },
      bad1: { profileId: 'x' },          // no backendId
      bad2: { backendId: '' },           // empty backendId
      bad3: 'nope',                      // not an object
      good2: { backendId: 'codex', profileId: 'p' },
    },
  }));
  sb._configureForTests({ filePath: file });
  const all = sb.getAll();
  assert.deepStrictEqual(Object.keys(all).sort(), ['good', 'good2']);
});

test('rekeySession copies temp->real and deletes temp', () => {
  sb._configureForTests({ filePath: tmpFile() });
  sb.record('temp-abc', 'deepseek', 'p-ds');
  sb.rekeySession('temp-abc', 'real-123');
  const all = sb.getAll();
  assert.ok(!('temp-abc' in all), 'temp removed');
  assert.deepStrictEqual(all['real-123'], { backendId: 'deepseek', profileId: 'p-ds' });
});

test('rekeySession is a no-op when temp is absent (idempotent)', () => {
  sb._configureForTests({ filePath: tmpFile() });
  sb.record('real-1', 'claude');
  sb.rekeySession('missing', 'real-2');
  assert.ok(!('real-2' in sb.getAll()));
  // second rekey of an already-rekeyed id does nothing bad
  sb.rekeySession('real-1', 'real-1');
  assert.deepStrictEqual(sb.get('real-1'), { backendId: 'claude', profileId: null });
});

test('rekeySession carries the persisted flag', () => {
  sb._configureForTests({ filePath: tmpFile() });
  sb.record('temp', 'codex');
  sb.markPersisted('temp');
  sb.rekeySession('temp', 'real');
  assert.strictEqual(sb.isPersisted('real'), true);
  assert.strictEqual(sb.isPersisted('temp'), false);
});

test('FIFO cap spares un-persisted entries, evicts oldest persisted first', () => {
  sb._configureForTests({ filePath: tmpFile() });
  const CAP = sb.CAP;
  // Fill exactly to CAP, all persisted.
  for (let i = 0; i < CAP; i++) { sb.record('p' + i, 'claude'); sb.markPersisted('p' + i); }
  // Add one un-persisted entry -> over CAP by 1.
  sb.record('unscanned', 'deepseek', 'prof');
  const all = sb.getAll();
  assert.ok('unscanned' in all, 'un-persisted entry must be spared by eviction');
  assert.ok(!('p0' in all), 'oldest persisted entry evicted to make room');
  assert.strictEqual(Object.keys(all).length, CAP);
});

test('un-persisted entries are NEVER evicted, even far past CAP (§5.7 correctness-over-memory)', () => {
  sb._configureForTests({ filePath: tmpFile() });
  // No markPersisted calls at all -> nothing is eligible; every entry survives (no age-order fallback).
  const n = sb.CAP + 2000;
  for (let i = 0; i < n; i++) sb.record('u' + i, 'codex');
  assert.strictEqual(Object.keys(sb.getAll()).length, n, 'no persisted entries -> none evicted, ever');
});

test('mixed: persisted evicted down to CAP, un-persisted always spared', () => {
  sb._configureForTests({ filePath: tmpFile() });
  const CAP = sb.CAP;
  // CAP persisted + 50 un-persisted interleaved at the end.
  for (let i = 0; i < CAP; i++) { sb.record('p' + i, 'claude'); sb.markPersisted('p' + i); }
  for (let i = 0; i < 50; i++) sb.record('u' + i, 'codex');
  const all = sb.getAll();
  for (let i = 0; i < 50; i++) assert.ok('u' + i in all, `un-persisted u${i} spared`);
  // 50 oldest persisted evicted to make room.
  assert.strictEqual(Object.keys(all).length, CAP);
});

// --- the flag must survive a restart, or the file grows forever (#155) -----------------------------

test('the persisted flag is written to disk', () => {
  const file = tmpFile();
  sb._configureForTests({ filePath: file });
  sb.record('scanned', 'codex');
  sb.record('fresh', 'codex');
  sb.markPersisted('scanned');
  sb.flushNow();

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.sessions.scanned.persisted, true);
  assert.strictEqual('persisted' in onDisk.sessions.fresh, false,
    'an un-scanned entry carries no flag — absent reads as "not scanned yet", which is the safe default');
});

test('a reloaded entry stays evictable — the cap must still fire after a restart', () => {
  // The bug: `persisted` was runtime-only, so after a restart every entry read back looked un-scanned.
  // Eviction spares un-scanned entries by design, so the cap could never fire and the file grew for the
  // life of the install.
  const file = tmpFile();
  sb._configureForTests({ filePath: file });
  const CAP = sb.CAP;
  for (let i = 0; i < CAP; i++) { sb.record('p' + i, 'claude'); sb.markPersisted('p' + i); }
  sb.flushNow();

  // Restart.
  sb._configureForTests({ filePath: file });
  assert.strictEqual(sb.isPersisted('p0'), true, 'the flag came back from disk');

  // One more launch pushes us over the cap: the oldest PERSISTED entry goes.
  sb.record('new-one', 'codex');
  const all = sb.getAll();
  assert.strictEqual(Object.keys(all).length, CAP, 'the cap fires again instead of growing forever');
  assert.ok(!('p0' in all), 'the oldest persisted entry was evicted');
  assert.ok('new-one' in all);
});

test('an old file with no flags loses nothing — every entry is spared until the next scan', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    sessions: Object.fromEntries(
      Array.from({ length: sb.CAP + 10 }, (_, i) => ['old' + i, { backendId: 'codex', profileId: null }])
    ),
  }));
  sb._configureForTests({ filePath: file });
  sb.record('new-one', 'codex');

  // Nothing is marked yet, so nothing may be dropped: provenance is unrecoverable, size is not (§5.7).
  assert.strictEqual(Object.keys(sb.getAll()).length, sb.CAP + 11);
  assert.strictEqual(sb.isPersisted('old0'), false);
});
