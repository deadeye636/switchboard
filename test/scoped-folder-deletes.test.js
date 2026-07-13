'use strict';
// Regression guard for CROSS-BACKEND DATA LOSS.
//
// A project's folder key is derived from its working directory, so it is SHARED across backends: a
// Claude session and a Codex session in the same cwd land under the same `folder`. Every folder-wide
// delete must therefore be scoped to the backend whose data is actually being removed, or it takes the
// other backend's rows with it — rows whose session files are still on disk, and which the owning
// backend never asked anyone to touch.
//
// session-cache.js's scan paths already pass `claudeStoreScope()`. The handlers that delete a folder's
// rows (remove-project, delete-project-sessions, delete-worktree) delete only CLAUDE's files from disk,
// so they must be scoped the same way. They were not, which silently wiped a project's Codex rows.
//
// The rule follows the CODE, not the file: project management moved to projects.js (#170), so both files
// are checked. A new home for a folder-wide delete must be added here.
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

for (const file of ['main.js', 'projects.js']) {
  test(`every folder-wide delete in ${file} is backend-scoped`, () => {
    const calls = folderDeleteCalls(read(file))
      // The destructured import and the ctx.db allow-list are declarations, not calls.
      .filter(c => c.args !== '' && !/^\s*$/.test(c.args));

    const unscoped = calls.filter(c => c.args.split(',').length < 2);
    assert.deepStrictEqual(
      unscoped.map(c => `${file}:${c.line} ${c.fn}(${c.args})`),
      [],
      'a folder-wide delete without a scope also deletes other backends\' rows for that project'
    );
  });
}

test('projects.js clears the cache BY ROW, never by folder', () => {
  // The folder is the wrong unit for anything keyed on a project. It is derived from the cwd a session
  // STARTED from, so since #157 one store folder can hold rows of several projects — and since #167 a
  // "remove" is a real removal, not a hide, so what it clears it clears for good. Both of this file's
  // purges (remove-project and the hard delete) therefore go row by row, from the project's own rows.
  const calls = folderDeleteCalls(read('projects.js')).filter(c => c.args !== '');
  assert.deepStrictEqual(calls.map(c => `projects.js:${c.line} ${c.fn}(${c.args})`), []);

  const src = read('projects.js');
  assert.match(src, /deleteCachedSession\s*\(/, 'it deletes the cached rows one by one');
  assert.match(src, /deleteSearchSession\s*\(/, 'and their search rows with them');
});

test('the hard delete clears the cache row by row, never by folder', () => {
  // A store folder is keyed on the cwd a session STARTED from, so since #157 it can hold rows belonging
  // to other projects. Deleting this project's history by folder would drop those rows too — while their
  // transcripts sat untouched on disk, which no rescan is guaranteed to notice.
  const src = read('projects.js');
  const from = src.indexOf('function deleteProjectSessions');
  assert.ok(from !== -1, 'deleteProjectSessions must exist');
  const rest = src.slice(from + 1);
  const fn = rest.slice(0, rest.indexOf('\nfunction ') === -1 ? rest.length : rest.indexOf('\nfunction '));

  assert.doesNotMatch(fn, /delete(Cached|Search)Folder\s*\(/,
    'the hard delete must not clear the cache by folder — the folder is shared with other projects');
  assert.match(fn, /deleteCachedSession\s*\(/, 'it must delete the cached rows one by one');
  assert.match(fn, /deleteSearchSession\s*\(/, 'and their search rows with them');
});

test('the scoped deletes use the same scope the scanner uses', () => {
  // A folder-wide delete must pass claudeStoreScope() (directly or via the injected ctx), not an ad-hoc
  // literal that could drift from session-cache.js's definition. main.js still has such deletes (the
  // store sweeps); projects.js no longer does any — see the row-by-row test above.
  assert.match(read('main.js'), /sessionCache\.claudeStoreScope/,
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
