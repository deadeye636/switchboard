const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { shouldAutoHide } = require('../src/index/session-cache');

const DAY = 86400000;
const NOW = Date.parse('2026-07-01T00:00:00.000Z');

// --- shouldAutoHide (#57) — pure predicate ---

test('shouldAutoHide is off when days <= 0 (feature disabled)', () => {
  // Even a project inactive for a decade stays visible while the feature is off.
  const ancient = NOW - 3650 * DAY;
  assert.equal(shouldAutoHide(ancient, NOW, 0), false);
  assert.equal(shouldAutoHide(ancient, NOW, -5), false);
});

test('shouldAutoHide fires only past the day boundary', () => {
  // exactly N days of inactivity is NOT yet past the threshold (> not >=)
  assert.equal(shouldAutoHide(NOW - 7 * DAY, NOW, 7), false);
  // one ms over → hidden
  assert.equal(shouldAutoHide(NOW - 7 * DAY - 1, NOW, 7), true);
  // well under → visible
  assert.equal(shouldAutoHide(NOW - 1 * DAY, NOW, 7), false);
  // well over → hidden
  assert.equal(shouldAutoHide(NOW - 30 * DAY, NOW, 7), true);
});

test('shouldAutoHide respects the reset grace via effectiveActivity', () => {
  // A project whose sessions are all old, but was just unhidden/re-added: the
  // caller passes effectiveActivity = max(lastSession, autoHideResetAt). With a
  // fresh reset the effective activity is recent, so it is NOT re-hidden.
  const oldSession = NOW - 100 * DAY;
  const justReset = NOW - 1 * DAY; // reset yesterday
  const eff = Math.max(oldSession, justReset);
  assert.equal(shouldAutoHide(eff, NOW, 7), false);

  // Once the grace itself ages past the threshold, auto-hide fires again.
  const staleReset = NOW - 10 * DAY;
  const eff2 = Math.max(oldSession, staleReset);
  assert.equal(shouldAutoHide(eff2, NOW, 7), true);
});

test('shouldAutoHide treats a never-active project (eff=0) as stale when enabled', () => {
  assert.equal(shouldAutoHide(0, NOW, 7), true);
  assert.equal(shouldAutoHide(0, NOW, 0), false); // still off when disabled
});

// --- project_meta roundtrip of the new auto-hide columns ---
//
// better-sqlite3 is compiled against Electron's Node ABI and cannot be required
// under plain node:test (same constraint db-daily-activity / main-ctx-db-wiring
// document). We therefore (a) mirror the two ON CONFLICT upserts + the autoHidden
// query to lock in their semantics, and (b) source-guard db.js so the real schema,
// statements and exports stay in sync with this model.

function makeProjectMeta() {
  const rows = new Map(); // projectPath -> row
  const ensure = (p) => {
    if (!rows.has(p)) rows.set(p, { projectPath: p, favorited: 0, autoHidden: 0, autoHideResetAt: null });
    return rows.get(p);
  };
  return {
    // mirrors projectMetaSetAutoHidden (INSERT ... ON CONFLICT DO UPDATE SET autoHidden)
    setAutoHidden(p, v) { ensure(p).autoHidden = v ? 1 : 0; },
    // mirrors projectMetaResetAutoHide (INSERT ... autoHidden=0, autoHideResetAt=?)
    resetAutoHide(p, at) { const r = ensure(p); r.autoHidden = 0; r.autoHideResetAt = at; },
    get(p) { return rows.get(p) || null; },
    autoHiddenPaths() {
      return [...rows.values()].filter(r => r.autoHidden === 1).map(r => r.projectPath);
    },
  };
}

test('project_meta roundtrip: setAutoHidden marks and getAutoHiddenProjects lists it', () => {
  const meta = makeProjectMeta();
  meta.setAutoHidden('/a', 1);
  meta.setAutoHidden('/b', 1);
  meta.setAutoHidden('/b', 0); // toggle back off
  assert.equal(meta.get('/a').autoHidden, 1);
  assert.equal(meta.get('/b').autoHidden, 0);
  assert.deepEqual(meta.autoHiddenPaths(), ['/a']);
});

test('project_meta roundtrip: resetAutoHide clears the flag and stamps the timer', () => {
  const meta = makeProjectMeta();
  meta.setAutoHidden('/a', 1);
  const stamp = '2026-07-01T00:00:00.000Z';
  meta.resetAutoHide('/a', stamp);
  const row = meta.get('/a');
  assert.equal(row.autoHidden, 0);
  assert.equal(row.autoHideResetAt, stamp);
  assert.deepEqual(meta.autoHiddenPaths(), []);
});

test('project_meta roundtrip: reset works on a fresh project (INSERT branch)', () => {
  const meta = makeProjectMeta();
  const stamp = '2026-07-01T00:00:00.000Z';
  meta.resetAutoHide('/new', stamp); // no prior row → INSERT path
  const row = meta.get('/new');
  assert.equal(row.autoHidden, 0);
  assert.equal(row.autoHideResetAt, stamp);
});

// Source guards — keep db.js in sync with the model above.

function readRoot(f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); }

test('schema.js defines the auto-hide columns on project_meta', () => {
  // The DDL moved out of db.js into schema.js with #217; the columns and the idempotent ALTERs that back
  // an existing database went with it. Both halves still have to be here: the CREATE TABLE is what a fresh
  // install gets, the ALTER is what an old one gets, and a column in only one of them means the two shapes
  // drift apart.
  const src = readRoot('src/db/schema.js');
  assert.match(src, /autoHidden INTEGER DEFAULT 0/, 'CREATE TABLE should declare autoHidden');
  assert.match(src, /autoHideResetAt TEXT/, 'CREATE TABLE should declare autoHideResetAt');
  assert.match(src, /ALTER TABLE project_meta ADD COLUMN autoHidden/, 'idempotent ALTER for autoHidden');
  assert.match(src, /ALTER TABLE project_meta ADD COLUMN autoHideResetAt/, 'idempotent ALTER for autoHideResetAt');
});

test('db.js exports the auto-hide getters/setters', () => {
  const exportsBlock = readRoot('src/db/db.js').split('module.exports')[1] || '';
  for (const name of ['getProjectMeta', 'setProjectAutoHidden', 'resetProjectAutoHide', 'getAutoHiddenProjects']) {
    assert.ok(
      new RegExp(`(^|[^\\w])${name}([^\\w]|$)`, 'm').test(exportsBlock),
      `db.js module.exports should include ${name}`
    );
  }
});
