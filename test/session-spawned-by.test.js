'use strict';
// Spec 39, T8: the link between a session the app started for another one (a review) and its caller,
// `session_meta.spawnedBy` + `spawnKind`. The store runs against a real SQLite database: `node:sqlite` stands in
// for better-sqlite3 (Electron's ABI) behind a stubbed `src/db/connection.js`, with the real schema and the real
// migrations, so no test loads `db.js` (.claude/rules/db.md).
const test = require('node:test');
const assert = require('node:assert/strict');

const { DatabaseSync } = require('node:sqlite');
const { applySchema } = require('../src/db/schema');
const { migrations, runMigrations } = require('../src/db/migrations');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  runMigrations(db);
  return db;
}

// meta-store prepares its statements at load against `connection.db`, so the stub is in place before it loads.
// better-sqlite3's `transaction(fn)` is the one call node:sqlite does not have; a store in the require chain wraps
// with it at load.
const db = freshDb();
db.transaction = (fn) => (...args) => {
  db.exec('BEGIN');
  try { const out = fn(...args); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
};
const connectionPath = require.resolve('../src/db/connection');
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { db } };
const meta = require('../src/db/meta-store');

const reset = () => db.exec('DELETE FROM session_meta');

test('the migration is appended, adds both columns once, and is a no-op on a database that has them', () => {
  const old = new DatabaseSync(':memory:');
  applySchema(old);
  // A database one version behind: every migration but the last has run.
  for (let i = 0; i < migrations.length - 1; i++) migrations[i](old);
  old.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(JSON.stringify(migrations.length - 1));
  const cols = () => old.prepare('PRAGMA table_info(session_meta)').all().map((c) => c.name);
  assert.ok(!cols().includes('spawnedBy'));
  const step = runMigrations(old);
  assert.deepEqual([step.from, step.to], [migrations.length - 1, migrations.length], 'exactly one version');
  assert.ok(cols().includes('spawnedBy') && cols().includes('spawnKind'));
  assert.doesNotThrow(() => migrations[migrations.length - 1](old), 'running it again changes nothing');
  const again = runMigrations(old);
  assert.equal(again.from, again.to, 'a current database fires nothing');
});

test('set and get round trip; a link to itself or to nobody is not written', () => {
  reset();
  meta.setSpawnedBy('child', 'caller', 'review');
  assert.deepEqual(meta.getSpawnedBy('child'), { spawnedBy: 'caller', spawnKind: 'review' });
  assert.equal(meta.getSpawnedBy('caller'), null);
  meta.setSpawnedBy('self', 'self', 'review');
  meta.setSpawnedBy('orphan', '', 'review');
  assert.equal(meta.getSpawnedBy('self'), null);
  assert.equal(meta.getSpawnedBy('orphan'), null);
  meta.setName('named', 'A name');
  meta.setSpawnedBy('named', 'caller', 'review');
  assert.equal(meta.getMeta('named').name, 'A name', 'a link sits beside what the user decided, it does not replace it');
});

test('a re-key of the child copies its link and never overwrites one the new id carries', () => {
  reset();
  meta.setSpawnedBy('child-temp', 'caller', 'review');
  assert.deepEqual(meta.rekeySpawnLinks('child-temp', 'child-real'), { copied: true, moved: 0 });
  assert.deepEqual(meta.getSpawnedBy('child-real'), { spawnedBy: 'caller', spawnKind: 'review' });
  meta.setSpawnedBy('other-temp', 'caller-a', 'review');
  meta.setSpawnedBy('other-real', 'caller-b', 'review');
  assert.equal(meta.rekeySpawnLinks('other-temp', 'other-real').copied, false);
  assert.equal(meta.getSpawnedBy('other-real').spawnedBy, 'caller-b');
});

test('a re-key of the caller moves every child that names it', () => {
  reset();
  meta.setSpawnedBy('r1', 'caller-old', 'review');
  meta.setSpawnedBy('r2', 'caller-old', 'review');
  meta.setSpawnedBy('r3', 'someone-else', 'review');
  assert.deepEqual(meta.rekeySpawnLinks('caller-old', 'caller-new'), { copied: false, moved: 2 });
  assert.equal(meta.getSpawnedBy('r1').spawnedBy, 'caller-new');
  assert.equal(meta.getSpawnedBy('r2').spawnedBy, 'caller-new');
  assert.equal(meta.getSpawnedBy('r3').spawnedBy, 'someone-else');
});

test('an id that is neither a child nor a caller is a no-op', () => {
  reset();
  meta.setSpawnedBy('r1', 'caller', 'review');
  assert.deepEqual(meta.rekeySpawnLinks('nobody', 'nobody-new'), { copied: false, moved: 0 });
  assert.deepEqual(meta.rekeySpawnLinks('', 'x'), { copied: false, moved: 0 });
  assert.deepEqual(meta.rekeySpawnLinks('r1', 'r1'), { copied: false, moved: 0 });
  assert.equal(meta.getSpawnedBy('nobody-new'), null);
});

test('both re-key paths carry the link, stored and on the live children', () => {
  const transitions = require('../src/session/session-transitions');
  const calls = [];
  const child = { _spawnedBy: 'temp', _terminalTag: 'tag-child' };
  const caller = { _terminalTag: 'tag-caller' };
  const activeSessions = new Map([['temp', caller], ['child-id', child]]);
  transitions.init({
    PROJECTS_DIR: '/invented/nowhere', activeSessions, getMainWindow: () => null,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    rekeyMcpServer: () => {}, rekeySessionBackend: () => {},
    rekeySpawnLinks: (from, to) => calls.push([from, to]),
    getClearClaim: () => null, releaseClearClaim: () => {},
  });
  transitions.adoptSessionId('tag-caller', 'real');
  assert.deepEqual(calls, [['temp', 'real']]);
  assert.equal(child._spawnedBy, 'real', 'a live child follows its caller');

  const adopt = require('../src/watch/adopt');
  const adoptCalls = [];
  const liveChild = { _spawnedBy: 'temp-a' };
  adopt.liveStoreRef.clear();
  adopt.liveBusy.clear();
  adopt.init({
    activeSessions: new Map([['temp-a', { _openedAt: Date.now(), _resumed: false, projectPath: '/p' }], ['kid', liveChild]]),
    getMainWindow: () => null,
    backends: { get: () => ({
      id: 'selfnamer', label: 'Self-namer', axis: 'B',
      matchLiveSession: () => ({ sessionId: 'real-a', ref: '/store/rec' }),
      liveState: () => null, liveRefFor: () => null,
    }) },
    sessionBackends: { get: () => ({ backendId: 'selfnamer' }), rekeySession: () => {} },
    rekeySpawnLinks: (from, to) => adoptCalls.push([from, to]),
    log: { info() {}, debug() {}, warn() {}, error() {} },
  });
  adopt.updateBackendLiveStates();
  assert.ok(adoptCalls.some(([from, to]) => from === 'temp-a' && to === 'real-a'), JSON.stringify(adoptCalls));
  assert.equal(liveChild._spawnedBy, 'real-a');
});

test('the sidebar payload carries the link only for a linked row, and in its own fields', () => {
  const view = require('../src/index/projects-view');
  const ALPHA = '/invented/demo-review';
  const row = (sessionId) => ({
    sessionId, projectPath: ALPHA, modified: '2026-06-01T00:00:00Z', summary: 'work', messageCount: 1, backendId: 'claude',
  });
  view.init({
    PROJECTS_DIR: '/invented/nowhere',
    activeSessions: new Map(),
    db: {
      getAllMeta: () => new Map([['review-1', { sessionId: 'review-1', spawnedBy: 'caller-1', spawnKind: 'review' }]]),
      getAllCached: () => [row('caller-1'), row('review-1')],
      getAllFolderMeta: () => new Map(),
      setFolderMeta: () => {},
      getFavoritedProjects: () => new Set(),
      getProjectDisplayNames: () => new Map(),
      getProjectStates: () => new Map([[ALPHA, { registered: true, registeredAt: '2026-01-01T00:00:00Z' }]]),
    },
  });
  const sessions = new Map();
  for (const p of view.buildProjectsFromCache(false)) for (const s of p.sessions) sessions.set(s.sessionId, s);
  const review = sessions.get('review-1');
  const caller = sessions.get('caller-1');
  assert.ok(review && caller, 'both rows are top-level rows of the payload');
  assert.deepEqual([review.spawnedBy, review.spawnKind], ['caller-1', 'review']);
  assert.deepEqual([caller.spawnedBy, caller.spawnKind], [null, null]);
  assert.equal(review.parentSessionId, null, 'not a subagent');
  assert.equal(review.lineageParentId, null, 'not a continuation');
});

test('the live snapshot carries the link of a session a review started', () => {
  const live = require('../src/app/live-sessions');
  live.init({
    activeSessions: new Map([
      ['rev', { projectPath: '/p', _spawnedBy: 'caller', _review: true, _openedAt: 1 }],
      ['plain', { projectPath: '/p', _openedAt: 2 }],
    ]),
    sessionBackends: { get: () => null },
    backends: { get: () => null },
  });
  const rows = new Map(live.snapshot().map((r) => [r.sessionId, r]));
  assert.deepEqual([rows.get('rev').spawnedBy, rows.get('rev').spawnKind], ['caller', 'review']);
  assert.deepEqual([rows.get('plain').spawnedBy, rows.get('plain').spawnKind], [null, null]);
});
