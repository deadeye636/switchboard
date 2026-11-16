'use strict';
// #870 T2: row shapes, caps and the "since" arithmetic of the session-changes tables (pure, no database).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const rec = require('../src/db/changes-record');
const { createAccumulator } = require('../src/backends/change-events');

test('normalizeChanges keeps a good row and rejects a non-object', () => {
  assert.equal(rec.normalizeChanges(null), null);
  assert.equal(rec.normalizeChanges('x'), null);
  const acc = createAccumulator();
  acc.noteEdit('a.js', { position: 1, at: 2 });
  acc.noteCommit({ sha: 'abcdef1', subject: 's', branch: 'main', position: 3, at: 4 });
  acc.notePush({ ok: true, summary: 'updated main', position: 5, at: 6 });
  const row = acc.toRow();
  assert.deepEqual(rec.normalizeChanges(row), row); // what the accumulator emits is already normal
});

test('normalizeChanges drops bad entries and cuts to the caps', () => {
  const files = [];
  for (let i = 0; i < rec.MAX_FILES + 3; i++) files.push({ path: `f${i}`, count: 1 });
  const n = rec.normalizeChanges({
    files: [{ path: '', count: 1 }, { path: 'dup', count: 1 }, { path: 'dup', count: 5 }, { path: 'zero', count: 0 }, { path: 'frac', count: 1.5 }, null, ...files],
    commits: [{ sha: 'zz' }, { sha: 'abcdef1', subject: 'x'.repeat(999), position: 'late' }, { sha: 'abcdef1' }],
    pushes: [{ ok: 'yes' }, { ok: true, files: [['a', 1], ['a', 2], ['b', 0], ['c', 3]] }],
  });
  assert.equal(n.files.length, rec.MAX_FILES);
  assert.equal(n.files[0].path, 'dup');
  assert.equal(n.files[0].count, 1);
  assert.equal(n.truncated, true);
  assert.equal(n.commits.length, 1);
  assert.equal(n.commits[0].subject.length, rec.MAX_SUBJECT_CHARS);
  assert.equal(n.commits[0].position, null);
  assert.equal(n.pushes[0].ok, false);
  assert.deepEqual(n.pushes[1].files, [['a', 1], ['c', 3]]);
});

test('an empty or missing list normalises to empty and isEmptyChanges says so', () => {
  const n = rec.normalizeChanges({});
  assert.deepEqual(n, { files: [], commits: [], pushes: [], truncated: false });
  assert.equal(rec.isEmptyChanges(n), true);
  assert.equal(rec.isEmptyChanges(null), true);
  assert.equal(rec.isEmptyChanges({ files: [{ path: 'a', count: 1 }], commits: [], pushes: [] }), false);
});

test('the caps are the accumulator\'s: one source', () => {
  const ce = require('../src/backends/change-events');
  for (const k of ['MAX_FILES', 'MAX_COMMITS', 'MAX_PUSHES', 'MAX_SNAPSHOT_FILES']) assert.equal(rec[k], ce[k], k);
});

test('a snapshot is cut by file count and by bytes', () => {
  const many = Array.from({ length: rec.MAX_SNAPSHOT_FILES + 5 }, (_, i) => [`f${i}`, 1]);
  const a = rec.normalizeSnapshot(many);
  assert.equal(a.files.length, rec.MAX_SNAPSHOT_FILES);
  assert.equal(a.truncated, true);
  const longPaths = Array.from({ length: 100 }, (_, i) => ['p' + i + 'x'.repeat(900), 1]);
  const b = rec.normalizeSnapshot(longPaths);
  assert.ok(JSON.stringify(b.files).length <= rec.MAX_SNAPSHOT_BYTES);
  assert.equal(b.truncated, true);
  assert.deepEqual(rec.normalizeSnapshot([['a', 2]]), { files: [['a', 2]], truncated: false });
  assert.deepEqual(rec.normalizeSnapshot(undefined), { files: [], truncated: false });
});

test('timeline entries: the four kinds, a lineage and a session are required', () => {
  assert.deepEqual([...rec.ENTRY_KINDS], ['start', 'clear', 'cli-clear', 'push']);
  for (const kind of rec.ENTRY_KINDS) assert.ok(rec.makeEntry(kind, { lineageId: 'L', sessionId: 'S' }), kind);
  assert.equal(rec.makeEntry('review', { lineageId: 'L', sessionId: 'S' }), null);
  assert.equal(rec.makeEntry('clear', { sessionId: 'S' }), null);
  assert.equal(rec.makeEntry('clear', { lineageId: 'L' }), null);
  const e = rec.makeEntry('clear', { lineageId: 'L', sessionId: 'S', position: 40, fromPosition: 10, at: 7, fromSha: 'aaa1111', toSha: 'bbb2222', files: [['a.js', 2]] });
  assert.deepEqual(e, {
    kind: 'clear', lineageId: 'L', sessionId: 'S', position: 40, at: 7, sha: null, fromSha: 'aaa1111', toSha: 'bbb2222', fromPosition: 10,
    files: [['a.js', 2]], truncated: false,
  });
  assert.equal(rec.makeEntry('push', { lineageId: 'L', sessionId: 'S', sha: 'x'.repeat(200) }).sha, null);
});

test('isCuttingPush: only a successful push that moved something cuts a Split block', () => {
  assert.equal(rec.isCuttingPush({ ok: true }), true);
  assert.equal(rec.isCuttingPush({ ok: true, upToDate: true }), false);
  assert.equal(rec.isCuttingPush({ ok: false }), false);
  assert.equal(rec.isCuttingPush(null), false);
});

test('diffCounts: counts since a snapshot are a subtraction (D3, D4)', () => {
  const now = [['a.js', 5], ['b.js', 2], ['c.js', 1]];
  const then = [['a.js', 2], ['b.js', 2]];
  assert.deepEqual(rec.diffCounts(now, then), [{ path: 'a.js', count: 3 }, { path: 'c.js', count: 1 }]);
  assert.deepEqual(rec.diffCounts(now, undefined).map((x) => x.path), ['a.js', 'b.js', 'c.js']); // from the start
  assert.deepEqual(rec.diffCounts([['a.js', 1]], [['a.js', 4]]), []); // a recount that went down is not negative
  assert.deepEqual(rec.diffCounts([{ path: 'a.js', count: 2 }], new Map([['a.js', 1]])), [{ path: 'a.js', count: 1 }]);
  assert.deepEqual(rec.diffCounts([['b', 1], ['a', 1]], []), [{ path: 'a', count: 1 }, { path: 'b', count: 1 }]); // ties by path
});

test('push snapshots give a block\'s counts as the difference of two snapshots', () => {
  const acc = createAccumulator();
  acc.noteEdit('a.js', { position: 1 });
  acc.notePush({ ok: true, position: 2 });
  acc.noteEdit('a.js', { position: 3 });
  acc.noteEdit('b.js', { position: 4 });
  acc.notePush({ ok: true, position: 5 });
  const row = rec.normalizeChanges(acc.toRow());
  const [p1, p2] = row.pushes;
  assert.deepEqual(rec.diffCounts(p2.files, p1.files), [{ path: 'a.js', count: 1 }, { path: 'b.js', count: 1 }]);
  assert.deepEqual(rec.diffCounts(p1.files, []), [{ path: 'a.js', count: 1 }]);
});

test('a push keeps its pushed SHA when valid and drops a malformed one (#870)', () => {
  const acc = createAccumulator();
  acc.notePush({ ok: true, position: 1, toSha: '55c3c1f' });
  acc.notePush({ ok: true, position: 2, toSha: 'not-hex' });
  acc.notePush({ ok: true, position: 3 });
  const row = rec.normalizeChanges(acc.toRow());
  assert.deepEqual(row.pushes.map((p) => p.sha), ['55c3c1f', undefined, undefined]);
  assert.equal(rec.normalizeChanges({ pushes: [{ ok: true, sha: 'x'.repeat(10) }] }).pushes[0].sha, undefined);
});

test('sumCounts adds lists per path (a lineage, a parent and its subagents)', () => {
  assert.deepEqual(rec.sumCounts([[['a', 1], ['b', 2]], [['a', 4]], new Map([['c', 1]])]), [['a', 5], ['b', 2], ['c', 1]]);
  assert.deepEqual(rec.sumCounts(null), []);
});

test('a truncated "from" snapshot makes a missing file unknown, not new (G3)', () => {
  const to = [['a.js', 5], ['new.js', 2], ['b.js', 1]];
  const prev = { files: [['a.js', 2]], truncated: true };
  assert.deepEqual(rec.diffCounts(to, prev), [
    { path: 'a.js', count: 3 },
    { path: 'b.js', count: null, unknown: true },
    { path: 'new.js', count: null, unknown: true },
  ]);
  // not truncated: a missing file is new and its total is the difference
  assert.deepEqual(rec.diffCounts(to, { files: [['a.js', 2]], truncated: false }).map((x) => x.count), [3, 2, 1]);
  // a push event or an entry is passed as it is: its files and its truncated flag are read
  assert.deepEqual(rec.diffCounts(to, { ok: true, files: [['a.js', 5], ['b.js', 1]], truncated: true }), [{ path: 'new.js', count: null, unknown: true }]);
  assert.deepEqual(rec.diffCounts({ files: to }, undefined).map((x) => x.count), [5, 2, 1]);
});

test('500 normal paths fit one snapshot (the byte cap holds the file cap)', () => {
  const pairs = Array.from({ length: rec.MAX_SNAPSHOT_FILES }, (_, i) => [`src/renderer/session/some-module-${String(i).padStart(4, '0')}/index-file.js`, 12]);
  const s = rec.normalizeSnapshot(pairs);
  assert.equal(s.truncated, false);
  assert.equal(s.files.length, rec.MAX_SNAPSHOT_FILES);
  assert.ok(JSON.stringify(s.files).length < rec.MAX_SNAPSHOT_BYTES);
});

test('isCuttingPush: a partial push (moved) cuts although it is not ok', () => {
  assert.equal(rec.isCuttingPush({ ok: false, moved: true }), true);
  assert.equal(rec.isCuttingPush({ ok: false }), false);
  assert.equal(rec.normalizeChanges({ pushes: [{ ok: false, moved: true, files: [['a', 1]] }] }).pushes[0].moved, true);
});

test('D6: touchedSince and eventsSince never compare positions of two sessions', () => {
  const from = { sessionId: 'S1', position: 10 };
  assert.equal(rec.touchedSince({ sessionId: 'S1', last: 11 }, from), true);
  assert.equal(rec.touchedSince({ sessionId: 'S1', last: 10 }, from), false);
  assert.equal(rec.touchedSince({ sessionId: 'S1', last: null }, from), false);
  assert.equal(rec.touchedSince({ sessionId: 'S1', last: 11 }, { sessionId: 'S1', position: null }), false);
  assert.equal(rec.touchedSince({ sessionId: 'S2', last: 9999 }, from), null); // another session: not comparable
  assert.equal(rec.touchedSince({ last: 11 }, from), null);
  const ev = [
    { sessionId: 'S1', sha: 'a', position: 5 }, { sessionId: 'S1', sha: 'b', position: 15 }, { sessionId: 'S1', sha: 'c', position: null },
    { sessionId: 'S2', sha: 'd', position: 99999 },
  ];
  assert.deepEqual(rec.eventsSince(ev, from).map((e) => e.sha), ['b']);
  assert.deepEqual(rec.eventsSince(ev, { sessionId: 'S1', position: null }), []);
  assert.deepEqual(rec.eventsSince(ev, { position: 1 }), []);
});

test('D6 rangeSessions: the lineage is cut by entries, sessions between are whole', () => {
  const order = ['root', 'child1', 'child2', 'child3'];
  // from inside child1 (position 40) to inside child3 (position 70)
  const r = rec.rangeSessions(order, { sessionId: 'child1', position: 40 }, { sessionId: 'child3', position: 70 });
  assert.deepEqual([...r.keys()], ['child1', 'child2', 'child3']); // root is wholly before: excluded
  assert.deepEqual(r.get('child1'), { whole: false, fromPosition: 40, toPosition: null });
  assert.deepEqual(r.get('child2'), { whole: true, fromPosition: null, toPosition: null });
  assert.deepEqual(r.get('child3'), { whole: false, fromPosition: null, toPosition: 70 });
  // both boundaries in one session: cut on both sides, every other session is out
  const one = rec.rangeSessions(order, { sessionId: 'child2', position: 5 }, { sessionId: 'child2', position: 9 });
  assert.deepEqual([...one.keys()], ['child2']);
  assert.deepEqual(one.get('child2'), { whole: false, fromPosition: 5, toPosition: 9 });
  // reversed inside one session is refused like reversed across sessions
  assert.equal(rec.rangeSessions(order, { sessionId: 'child2', position: 9 }, { sessionId: 'child2', position: 5 }), null);
  // open ends: the start and the end of the lineage
  const all = rec.rangeSessions(order, null, null);
  assert.deepEqual([...all.keys()], order);
  assert.ok([...all.values()].every((v) => v.whole));
  const tail = rec.rangeSessions(order, { sessionId: 'child2', position: 5 }, null);
  assert.deepEqual([...tail.keys()], ['child2', 'child3']);
  assert.equal(tail.get('child3').whole, true);
  // unresolvable: a boundary in no session of the lineage, reversed boundaries, no lineage
  assert.equal(rec.rangeSessions(order, { sessionId: 'other', position: 1 }, null), null);
  assert.equal(rec.rangeSessions(order, { sessionId: 'child3', position: 1 }, { sessionId: 'root', position: 1 }), null);
  assert.equal(rec.rangeSessions([], null, null), null);
  assert.equal(rec.rangeSessions(undefined, null, null), null);
});

test('D6 subagentInRange: a subagent is atomic, in when its last activity falls inside the range', () => {
  const from = { sessionId: 'S', position: 1, at: 1000 };
  const to = { sessionId: 'S', position: 9, at: 2000 };
  assert.equal(rec.subagentInRange({ at: 1500 }, from, to), true);
  assert.equal(rec.subagentInRange({ at: 1000 }, from, to), true);
  assert.equal(rec.subagentInRange({ at: 2000 }, from, to), true);
  assert.equal(rec.subagentInRange({ at: 999 }, from, to), false);
  assert.equal(rec.subagentInRange({ at: 2001 }, from, to), false);
  assert.equal(rec.subagentInRange({ at: 5 }, null, to), true);           // open start
  assert.equal(rec.subagentInRange({ at: 99999 }, from, null), true);     // open end
  assert.equal(rec.subagentInRange({ at: null }, null, null), false);     // no time: out
  assert.equal(rec.subagentInRange(null, null, null), false);
  assert.equal(rec.subagentInRange({ at: 1500 }, { sessionId: 'S', position: 1, at: null }, to), true); // unknown boundary time: open
});


test('the module opens no database and loads no registry', () => {
  const { stripComments } = require('./helpers/strip-comments');
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'changes-record.js'), 'utf8'));
  const requires = [...src.matchAll(/require\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['../backends/change-events']);
});

test('cleanChangesView keeps an entry id or a push tick key as a pick end, and drops anything else', () => {
  const { cleanChangesView } = require('../src/db/changes-record');
  assert.deepEqual(cleanChangesView({ range: 'pick', view: 'split', pickFrom: 3, pickTo: 'push:sub:abc:120' }),
    { range: 'pick', view: 'split', pickFrom: 3, pickTo: 'push:sub:abc:120' });
  assert.equal(cleanChangesView({ pickTo: 'push:S:i2' }).pickTo, 'push:S:i2');
  for (const bad of ['../x', 'push:S:', 'push::4', 'push:S:4;x', 'push:' + 'a'.repeat(300) + ':1', -1, 0, 1.5, {}]) {
    assert.equal(cleanChangesView({ pickTo: bad }).pickTo, null, String(bad));
  }
  assert.equal(cleanChangesView({ pickTo: 'push:a' + String.fromCharCode(10) + 'b:1' }).pickTo, null);
  assert.equal(cleanChangesView(null), null);
});
