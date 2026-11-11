'use strict';
// #805 T2: the owner marker for the worktrees the app creates, `app_worktree`. The store runs against a real SQLite
// database: `node:sqlite` stands in for better-sqlite3 behind a stubbed `src/db/connection.js`, with
// the real schema and the real migrations, so no test loads `db.js` (.claude/rules/db.md).
const test = require('node:test');
const assert = require('node:assert/strict');

const { DatabaseSync } = require('node:sqlite');
const { applySchema } = require('../src/db/schema');
const { migrations, runMigrations } = require('../src/db/migrations');

const db = new DatabaseSync(':memory:');
applySchema(db);
runMigrations(db);
const connectionPath = require.resolve('../src/db/connection');
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: { db } };
const store = require('../src/db/worktree-store');

test('the migration creates the table once and is a no-op on a database that has it', () => {
  const at = migrations.findIndex((m) => String(m).includes('app_worktree'));
  assert.ok(at > 0, 'the app_worktree migration is in the array');
  const old = new DatabaseSync(':memory:');
  applySchema(old);
  for (let i = 0; i < at; i++) migrations[i](old);
  old.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(JSON.stringify(at));
  const hasTable = () => !!old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_worktree'").get();
  assert.equal(hasTable(), false);
  const step = runMigrations(old);
  assert.deepEqual([step.from, step.to], [at, migrations.length]);
  assert.equal(hasTable(), true);
  assert.doesNotThrow(() => migrations[at](old), 'running it again changes nothing');
});

test('record, read back and forget; a path recorded twice is refused, never overwritten', () => {
  const row = { worktreePath: '/data/wt/t1', repoPath: '/work/proj', branch: 'switchboard/task-t1', baseCommit: 'a'.repeat(40), taskId: 't1' };
  store.recordAppWorktree(row, 5);
  assert.deepEqual(store.getAppWorktrees().map(r => ({ ...r })), [{ ...row, createdAt: 5 }]);
  assert.throws(() => store.recordAppWorktree({ ...row, branch: 'other' }));
  assert.equal(store.getAppWorktrees()[0].branch, 'switchboard/task-t1');
  store.forgetAppWorktree(row.worktreePath);
  assert.deepEqual(store.getAppWorktrees(), []);
  // The observed facts are a different table: forgetting an app-owned row leaves them alone.
  store.recordKnownWorktree('/data/wt/t2', '/work/proj', 1);
  store.forgetAppWorktree('/data/wt/t2');
  assert.equal(store.getKnownWorktrees().length, 1);
});
