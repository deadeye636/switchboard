const { test } = require('node:test');
const assert = require('node:assert');
const { projectDisplayLabel } = require('../src/renderer/lib/project-name.js');

test('custom displayName wins over shortName', () => {
  assert.strictEqual(projectDisplayLabel('Mein Projekt', 'dev/foo'), 'Mein Projekt');
});

test('empty / whitespace displayName falls back to shortName', () => {
  assert.strictEqual(projectDisplayLabel('', 'dev/foo'), 'dev/foo');
  assert.strictEqual(projectDisplayLabel('   ', 'dev/foo'), 'dev/foo');
  assert.strictEqual(projectDisplayLabel(undefined, 'dev/foo'), 'dev/foo');
  assert.strictEqual(projectDisplayLabel(null, 'dev/foo'), 'dev/foo');
});

test('displayName is trimmed', () => {
  assert.strictEqual(projectDisplayLabel('  Name  ', 'dev/foo'), 'Name');
});

// --- #667: the display name of a session's project, keyed by every spelling main put into the bucket ---
//
// A bucket carries whichever spelling of its directory had sessions first (#245). A session that is not in
// a bucket yet — one `/clear` just re-keyed onto a new id — is found by its raw path, and it spells that
// path the way its own backend does, which need not be the bucket's.

const { projectDisplayNameIndex, projectDisplayNameOf } = require('../src/renderer/lib/project-name.js');

function bucket(projectPath, displayName, sessions) {
  return { projectPath, displayName, sessions };
}

test('a re-keyed session is named by the spelling of its siblings, not only the bucket (#667)', () => {
  // The bucket is spelled by the rows that came first; the rows beside them spell it otherwise.
  const index = projectDisplayNameIndex([[
    bucket('/work/alpha', 'Alpha Service', [
      { sessionId: 'seeded', projectPath: '/work/alpha' },
      { sessionId: 'before-clear', projectPath: '\\work\\alpha' },
    ]),
  ]]);
  // The id `/clear` moved onto: in no bucket yet, carrying the record of the session it was.
  const reKeyed = { sessionId: 'after-clear', projectPath: '\\work\\alpha' };
  assert.strictEqual(projectDisplayNameOf(index, reKeyed), 'Alpha Service');
});

test('a session in a bucket is named by its id first', () => {
  const index = projectDisplayNameIndex([[
    bucket('/work/alpha', 'Alpha Service', [{ sessionId: 's1', projectPath: '/elsewhere' }]),
  ]]);
  assert.strictEqual(projectDisplayNameOf(index, { sessionId: 's1', projectPath: '/unknown' }), 'Alpha Service');
});

test('a bucket without a name contributes nothing, so the caller keeps its folder tail', () => {
  const index = projectDisplayNameIndex([[
    bucket('/work/alpha', '   ', [{ sessionId: 's1', projectPath: '\\work\\alpha' }]),
  ]]);
  assert.strictEqual(projectDisplayNameOf(index, { sessionId: 's2', projectPath: '\\work\\alpha' }), '');
  assert.strictEqual(projectDisplayNameOf(index, { sessionId: 's1' }), '');
});

test('a later list wins, so the live list passed last names a directory the archive also holds', () => {
  const archived = [bucket('/work/alpha', 'Old name', [{ sessionId: 'a', projectPath: '/work/alpha' }])];
  const live = [bucket('/work/alpha', 'New name', [{ sessionId: 'a', projectPath: '/work/alpha' }])];
  const index = projectDisplayNameIndex([archived, live]);
  assert.strictEqual(projectDisplayNameOf(index, { sessionId: 'a' }), 'New name');
  assert.strictEqual(projectDisplayNameOf(index, { sessionId: 'b', projectPath: '/work/alpha' }), 'New name');
});

test('no index or no session answers empty rather than throwing', () => {
  assert.strictEqual(projectDisplayNameOf(null, { sessionId: 'a' }), '');
  assert.strictEqual(projectDisplayNameOf(projectDisplayNameIndex([]), null), '');
  assert.strictEqual(projectDisplayNameOf(projectDisplayNameIndex(null), { sessionId: 'a' }), '');
});
