'use strict';
// #870 T2: the neutral accumulator. Driven by the Claude change-event fixtures where a shape exists (the extracted call
// ids, paths and result flags; no backend parser is involved).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ce = require('../src/backends/change-events');

const { createAccumulator } = ce;
const DIR = path.join(__dirname, 'fixtures', 'change-events', 'claude');
// Byte offset of the start of each line of a fixture, with the parsed line.
function offsets(name) {
  const text = fs.readFileSync(path.join(DIR, name), 'utf8');
  const out = [];
  let at = 0;
  for (const line of text.split('\n')) {
    if (line) out.push({ position: at, json: JSON.parse(line) });
    at += Buffer.byteLength(line) + 1;
  }
  return out;
}
function editFrom(name) {
  const [call, result] = offsets(name);
  const use = call.json.message.content[0];
  const res = result.json.message.content[0];
  return { path: use.input.file_path, callId: use.id, resultId: res.tool_use_id, position: result.position, error: res.is_error === true };
}

test('an edit counts when its result arrives without an error', () => {
  const acc = createAccumulator();
  const e = editFrom('edit-ok.jsonl');
  acc.noteEdit(e.path, { callId: e.callId, position: 1 });
  assert.equal(acc.toRow().files.length, 0); // the call alone proves nothing
  assert.equal(acc.revision, 0);
  assert.equal(acc.resolve(e.resultId, { error: e.error, position: e.position }), true);
  assert.deepEqual(acc.toRow().files, [{ path: e.path, count: 1, first: e.position, last: e.position, at: null }]);
  assert.equal(acc.revision, 1);
});

test('a failed edit is not counted (error result, permission denied, failed write)', () => {
  for (const name of ['edit-error.jsonl', 'edit-permission-denied.jsonl', 'write-error.jsonl']) {
    const acc = createAccumulator();
    const e = editFrom(name);
    assert.equal(e.error, true, name);
    acc.noteEdit(e.path, { callId: e.callId });
    acc.resolve(e.resultId, { error: e.error, position: e.position });
    assert.deepEqual(acc.toRow().files, [], name);
    assert.equal(acc.revision, 0, name);
    assert.equal(acc.pendingSize, 0, name);
  }
});

test('repeated edits sum, first stays, last and at move', () => {
  const acc = createAccumulator();
  acc.noteEdit('a.js', { position: 10, at: 1 });
  acc.noteEdit('a.js', { position: 50, at: 2 });
  acc.noteEdit('b.js', { position: 60, at: 3 });
  assert.deepEqual(acc.toRow().files, [
    { path: 'a.js', count: 2, first: 10, last: 50, at: 2 },
    { path: 'b.js', count: 1, first: 60, last: 60, at: 3 },
  ]);
});

test('resolve: unknown, already resolved and bad ids answer false', () => {
  const acc = createAccumulator();
  assert.equal(acc.resolve('nope', {}), false);
  assert.equal(acc.resolve(undefined, {}), false);
  acc.noteEdit('a.js', { callId: 'c1' });
  assert.equal(acc.resolve('c1', {}), true);
  assert.equal(acc.resolve('c1', {}), false);
  assert.equal(acc.toRow().files[0].count, 1);
});

test('the pending map is bounded: the oldest call is evicted and its result is ignored', () => {
  const acc = createAccumulator();
  for (let i = 0; i < ce.MAX_PENDING + 5; i++) acc.noteEdit(`f${i}.js`, { callId: `c${i}` });
  assert.equal(acc.pendingSize, ce.MAX_PENDING);
  assert.equal(acc.resolve('c0', {}), false); // evicted
  assert.equal(acc.resolve('c4', {}), false); // evicted
  assert.equal(acc.resolve('c5', {}), true);  // the oldest survivor
  assert.equal(acc.resolve(`c${ce.MAX_PENDING + 4}`, {}), true);
  assert.deepEqual(acc.toRow().files.map((f) => f.path), ['f5.js', `f${ce.MAX_PENDING + 4}.js`]);
});

test('a re-sent call id refreshes its age instead of duplicating', () => {
  const acc = createAccumulator();
  acc.noteEdit('a.js', { callId: 'x' });
  acc.noteEdit('a.js', { callId: 'x' });
  assert.equal(acc.pendingSize, 1);
  acc.resolve('x', {});
  assert.equal(acc.toRow().files[0].count, 1);
});

test('files over the cap set truncated; known files keep counting', () => {
  const acc = createAccumulator();
  for (let i = 0; i < ce.MAX_FILES; i++) acc.noteEdit(`f${i}.js`, { position: i });
  assert.equal(acc.toRow().truncated, false);
  const before = acc.revision;
  acc.noteEdit('extra.js', { position: 9999 });
  const row = acc.toRow();
  assert.equal(row.truncated, true);
  assert.equal(row.files.length, ce.MAX_FILES);
  assert.equal(acc.revision, before + 1); // the flag flipped: that is a change
  acc.noteEdit('another.js', {});
  assert.equal(acc.revision, before + 1); // nothing new to say
  acc.noteEdit('f0.js', { position: 5 });
  assert.equal(acc.toRow().files[0].count, 2);
});

test('commits: recorded once per sha, capped, never decided by an error flag', () => {
  const acc = createAccumulator();
  assert.equal(acc.noteCommit({ sha: '9f3c2ab', subject: 'fix: x', branch: 'main', position: 7, at: 1 }), true);
  assert.equal(acc.noteCommit({ sha: '9f3c2ab', subject: 'again' }), false); // same sha
  assert.equal(acc.noteCommit({ sha: 'not-a-sha' }), false);
  assert.equal(acc.noteCommit({ sha: '4d5e6f7', subject: 's', amend: true }), true);
  assert.equal(acc.revision, 2);
  const { commits } = acc.toRow();
  assert.deepEqual(commits[0], { sha: '9f3c2ab', subject: 'fix: x', branch: 'main', position: 7, at: 1 });
  assert.equal(commits[1].amend, true);
  const many = createAccumulator();
  for (let i = 0; i < ce.MAX_COMMITS + 3; i++) many.noteCommit({ sha: (1000000 + i).toString(16).padStart(8, '0') });
  assert.equal(many.toRow().commits.length, ce.MAX_COMMITS);
  assert.equal(many.toRow().truncated, true);
});

test('a long subject is cut', () => {
  const acc = createAccumulator();
  acc.noteCommit({ sha: 'abcdef1', subject: 'x'.repeat(5000) });
  assert.equal(acc.toRow().commits[0].subject.length, ce.MAX_SUBJECT_CHARS);
});

test('a successful push snapshots the per-file counts at its position (D4)', () => {
  const acc = createAccumulator();
  acc.noteEdit('a.js', { position: 1 });
  acc.noteEdit('a.js', { position: 2 });
  acc.noteEdit('b.js', { position: 3 });
  acc.notePush({ ok: true, summary: 'updated main', position: 10, at: 5 });
  acc.noteEdit('a.js', { position: 20 });
  acc.notePush({ ok: true, summary: 'updated main', position: 30 });
  const { pushes } = acc.toRow();
  assert.deepEqual(pushes[0].files, [['a.js', 2], ['b.js', 1]]);
  assert.deepEqual(pushes[1].files, [['a.js', 3], ['b.js', 1]]); // not the same array: the first one stays what it was
  assert.equal(pushes[0].position, 10);
});

test('a failed or up-to-date push carries no snapshot; force is kept', () => {
  const acc = createAccumulator();
  acc.noteEdit('a.js', {});
  acc.notePush({ ok: false, summary: 'rejected main (fetch first)', position: 1 });
  acc.notePush({ ok: true, upToDate: true, summary: 'up-to-date', position: 2 });
  acc.notePush({ ok: true, force: true, summary: 'forced update x', position: 3 });
  const { pushes } = acc.toRow();
  assert.equal(pushes[0].ok, false);
  assert.equal(pushes[0].files, undefined);
  assert.equal(pushes[1].files, undefined);
  assert.equal(pushes[1].upToDate, true);
  assert.deepEqual(pushes[2].files, [['a.js', 1]]);
  assert.equal(pushes[2].force, true);
});

test('a snapshot holds every file the row holds (G3): the snapshot cap is the file cap', () => {
  assert.equal(ce.MAX_SNAPSHOT_FILES, ce.MAX_FILES);
  const acc = createAccumulator();
  for (let i = 0; i < ce.MAX_FILES + 10; i++) acc.noteEdit(`f${i}.js`, {});
  acc.notePush({ ok: true, summary: 's', position: 1 });
  const { pushes, files, truncated } = acc.toRow();
  assert.equal(pushes[0].files.length, files.length);
  assert.equal(pushes[0].truncated, undefined); // the snapshot lost nothing; the row's own cap is what `truncated` reports
  assert.equal(truncated, true);
});

test('a partial push (moved) cuts: it carries a snapshot although it is not ok', () => {
  const acc = createAccumulator();
  acc.noteEdit('a.js', {});
  acc.notePush({ ok: false, moved: true, summary: 'rejected main +1 more', position: 1 });
  acc.notePush({ ok: false, summary: 'push failed', position: 2 });
  const { pushes } = acc.toRow();
  assert.equal(pushes[0].moved, true);
  assert.deepEqual(pushes[0].files, [['a.js', 1]]);
  assert.equal(pushes[1].moved, undefined);
  assert.equal(pushes[1].files, undefined);
});

test('evicting a pending call sets truncated (its edit may be lost) and moves the revision once', () => {
  const acc = createAccumulator();
  for (let i = 0; i < ce.MAX_PENDING; i++) acc.noteEdit(`f${i}.js`, { callId: `c${i}` });
  assert.equal(acc.toRow().truncated, false);
  assert.equal(acc.revision, 0);
  acc.noteEdit('over.js', { callId: 'over' });
  assert.equal(acc.toRow().truncated, true);
  assert.equal(acc.revision, 1);
  acc.noteEdit('over2.js', { callId: 'over2' }); // already truncated: nothing new to say
  assert.equal(acc.revision, 1);
});

test('pushes over the cap set truncated', () => {
  const acc = createAccumulator();
  for (let i = 0; i < ce.MAX_PUSHES + 2; i++) acc.notePush({ ok: false, position: i });
  assert.equal(acc.toRow().pushes.length, ce.MAX_PUSHES);
  assert.equal(acc.toRow().truncated, true);
});

test('revision moves only when the aggregate changed', () => {
  const acc = createAccumulator();
  assert.equal(acc.revision, 0);
  acc.noteEdit('a.js', { callId: 'p' });          // pending: nothing changed yet
  assert.equal(acc.revision, 0);
  acc.resolve('p', { error: true });              // dropped: still nothing
  assert.equal(acc.revision, 0);
  acc.noteEdit('', {});                           // invalid input
  acc.noteEdit(42, {});
  acc.noteCommit(null);
  acc.notePush(null);
  assert.equal(acc.revision, 0);
  acc.noteEdit('a.js', {});
  assert.equal(acc.revision, 1);
  const seen = acc.revision;
  acc.toRow();                                    // reading changes nothing
  assert.equal(acc.revision, seen);
  acc.noteCommit({ sha: 'abcdef1' });
  acc.noteCommit({ sha: 'abcdef1' });             // duplicate
  assert.equal(acc.revision, seen + 1);
});

test('toRow hands out copies: mutating the row does not touch the accumulator', () => {
  const acc = createAccumulator();
  acc.noteEdit('a.js', {});
  acc.noteEdit('a.js', {});
  acc.notePush({ ok: true, position: 1 });
  const row = acc.toRow();
  row.files[0].count = 99;
  row.pushes[0].files[0][1] = 99;
  assert.equal(acc.toRow().files[0].count, 2);
  assert.equal(acc.toRow().pushes[0].files[0][1], 2);
});

test('an over-long path is ignored, a non-finite position becomes null', () => {
  const acc = createAccumulator();
  assert.equal(acc.noteEdit('x'.repeat(ce.MAX_PATH_CHARS + 1), {}), false);
  acc.noteEdit('a.js', { position: NaN, at: 'soon' });
  assert.deepEqual(acc.toRow().files[0], { path: 'a.js', count: 1, first: null, last: null, at: null });
});

test('the module requires nothing (a worker and the registry can load it)', () => {
  const { stripComments } = require('./helpers/strip-comments');
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'backends', 'change-events.js'), 'utf8'));
  assert.doesNotMatch(src, /require\s*\(/);
});
