'use strict';
// Regression guard for CROSS-BACKEND DATA LOSS.
//
// A project's folder key is derived from its working directory, so it is SHARED across backends: a
// Claude session and a Codex session in the same cwd land under the same `folder`. Every folder-wide
// delete must therefore be scoped to the backend whose data is actually being removed, or it takes the
// other backend's rows with it — rows whose session files are still on disk, and which the owning
// backend never asked anyone to touch.
//
// session-cache.js's scan paths already pass `claudeStoreScope()`. The IPC handlers in main.js that
// delete a folder's rows (remove-project, delete-project-sessions, delete-worktree) delete only
// CLAUDE's files from disk, so they must be scoped the same way. They were not, which silently wiped
// a project's Codex rows.
//
// Static analysis (like main-ctx-db-wiring.test.js): db.js cannot be required under plain node —
// better-sqlite3 is compiled against Electron's ABI.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// Find every call to the folder-wide delete functions and capture its argument list.
function folderDeleteCalls(src) {
  const out = [];
  const re = /\b(deleteCachedFolder|deleteSearchFolder)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ fn: m[1], args: m[2].trim(), line });
  }
  return out;
}

test('every folder-wide delete in main.js is backend-scoped', () => {
  const calls = folderDeleteCalls(read('main.js'))
    // The destructured import and the ctx.db allow-list are declarations, not calls.
    .filter(c => c.args !== '' && !/^\s*$/.test(c.args));

  assert.ok(calls.length >= 3, 'expected the remove-project / delete-project-sessions / delete-worktree calls');

  const unscoped = calls.filter(c => c.args.split(',').length < 2);
  assert.deepStrictEqual(
    unscoped.map(c => `main.js:${c.line} ${c.fn}(${c.args})`),
    [],
    'a folder-wide delete without a scope also deletes other backends\' rows for that project'
  );
});

test('the scoped deletes use the same scope the scanner uses', () => {
  const src = read('main.js');
  // Each scoped call must pass claudeStoreScope() (directly or via a local alias assigned from it),
  // not some ad-hoc literal that could drift from session-cache.js's definition.
  assert.match(src, /sessionCache\.claudeStoreScope\(\)/,
    'main.js must reuse session-cache.js claudeStoreScope() rather than redefining the scope');
});

test('session-cache.js exports claudeStoreScope so main.js can share it', () => {
  const src = read('session-cache.js');
  const exportsBlock = src.split('module.exports')[1] || '';
  assert.match(exportsBlock, /claudeStoreScope/, 'claudeStoreScope must be exported');
});

test('session-cache.js scan paths still scope their own folder deletes', () => {
  const calls = folderDeleteCalls(read('session-cache.js')).filter(c => c.args !== '');
  const unscoped = calls.filter(c => c.args.split(',').length < 2);
  assert.deepStrictEqual(
    unscoped.map(c => `session-cache.js:${c.line} ${c.fn}(${c.args})`),
    [],
    'the scanner must never issue an unscoped folder delete either'
  );
});
