'use strict';
// Claude's change extractor (#870, spec 47), through the real session reader, over the T1 fixtures
// (test/fixtures/change-events/claude/). The fixtures hold no user prompt, so every transcript here starts with one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSessionFile, readSessionFileIncremental } = require('../src/backends/claude/session-reader');
const { createLineCursor } = require('../src/backends/claude/change-events');

const FIXTURES = path.join(__dirname, 'fixtures', 'change-events', 'claude');
const PROMPT = JSON.stringify({ type: 'user', uuid: 'p0', timestamp: '2026-01-01T11:59:00.000Z', sessionId: 's-1', cwd: '/work/<project>', message: { role: 'user', content: 'please change things' } }) + '\n';

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name + '.jsonl'), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-cce-'));
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** Parse `text` (prompt prepended) through the full reader; returns `{ row, offsetOf }`. */
function parseFull(text, opts) {
  const dir = tmp();
  try {
    const file = path.join(dir, 's-1.jsonl');
    fs.writeFileSync(file, PROMPT + text);
    const row = readSessionFile(file, 'f', '/work/<project>', opts || {});
    return { row, offsetOf: (needle) => Buffer.byteLength((PROMPT + text).slice(0, (PROMPT + text).indexOf(needle))) };
  } finally { cleanup(dir); }
}

const changesOf = (name) => parseFull(fixture(name)).row.changes;
const byteOffsetOfLine = (text, lineNo) => Buffer.byteLength(text.split('\n').slice(0, lineNo).join('\n') + (lineNo ? '\n' : ''));

test('Edit, Write, MultiEdit and NotebookEdit each count one edit on their file, at the result line', () => {
  for (const [name, file] of [['edit-ok', '/work/<project>/src/foo.js'], ['write-ok', '/work/<project>/src/new.js'], ['multiedit-ok', '/work/<project>/src/foo.js'], ['notebookedit-ok', '/work/<project>/analysis.ipynb']]) {
    const text = fixture(name);
    const { row } = parseFull(text);
    assert.equal(row.changes.files.length, 1, name);
    const f = row.changes.files[0];
    assert.equal(f.path, file, name);
    assert.equal(f.count, 1, name);
    // The result is the second fixture line, behind the prompt line.
    assert.equal(f.last, Buffer.byteLength(PROMPT) + byteOffsetOfLine(text, 1), name);
    assert.equal(f.first, f.last, name);
    assert.equal(typeof f.at, 'number', name);
  }
});

test('a failed or denied edit is not counted, and a full parse still carries an empty aggregate', () => {
  for (const name of ['edit-error', 'edit-permission-denied', 'write-error']) {
    const c = changesOf(name);
    assert.deepEqual(c.files, [], name);
    assert.deepEqual(c.commits, [], name);
  }
});

test('a git commit is read from the output line, not from the error flag', () => {
  const c = changesOf('bash-git-commit');
  assert.equal(c.commits.length, 1);
  assert.equal(c.commits[0].sha, '9f3c2ab');
  assert.equal(c.commits[0].subject, 'fix: handle empty input');
  assert.equal(c.commits[0].branch, 'main');
  assert.equal(c.commits[0].position, Buffer.byteLength(PROMPT) + byteOffsetOfLine(fixture('bash-git-commit'), 1));
  assert.equal(changesOf('bash-git-commit-hook-failed').commits.length, 0);
  assert.equal(changesOf('bash-git-commit-nothing').commits.length, 0);
  assert.equal(changesOf('bash-git-commit-tail-cut').commits.length, 0);
  assert.equal(changesOf('bash-echo-git-commit').commits.length, 0);
  assert.equal(changesOf('bash-git-commit-amend').commits[0].amend, true);
  assert.equal(changesOf('powershell-git-commit').commits[0].sha, '5b6c7d8');
});

test('a chained commit and push give one commit and one push at the same result line', () => {
  const c = changesOf('bash-commit-then-push');
  assert.equal(c.commits.length, 1);
  assert.equal(c.pushes.length, 1);
  assert.equal(c.pushes[0].ok, true);
  assert.equal(c.pushes[0].position, c.commits[0].position);
});

test('a commit that went through while its push was refused is still a commit; the refused push cuts nothing', () => {
  const c = changesOf('bash-commit-ok-push-refused');
  assert.equal(c.commits.length, 1);
  assert.equal(c.commits[0].sha, '8c9d0e1');
  assert.equal(c.pushes.length, 1);
  assert.equal(c.pushes[0].ok, false);
  assert.equal(c.pushes[0].files, undefined);
});

test('pushes: ok keeps a snapshot of the per-file counts, up-to-date and rejected do not', () => {
  const edit = fixture('edit-ok');
  const dir = tmp();
  try {
    const file = path.join(dir, 's-1.jsonl');
    fs.writeFileSync(file, PROMPT + edit + fixture('bash-git-push-ok') + fixture('bash-git-push-uptodate') + fixture('bash-git-push-rejected') + fixture('bash-git-push-force-with-lease'));
    const c = readSessionFile(file, 'f', '/work/<project>', {}).changes;
    assert.equal(c.pushes.length, 4);
    assert.deepEqual(c.pushes[0].files, [['/work/<project>/src/foo.js', 1]]);
    assert.equal(c.pushes[1].upToDate, true);
    assert.equal(c.pushes[1].files, undefined);
    assert.equal(c.pushes[2].ok, false);
    assert.equal(c.pushes[3].force, true);
  } finally { cleanup(dir); }
});

test('an api-request-blob line repeating a result does not count twice', () => {
  const c = changesOf('api-request-blob');
  assert.equal(c.files.length, 1);
  assert.equal(c.files[0].count, 1);
});

test('a subagent file is its own row with its own aggregate', () => {
  const dir = tmp();
  try {
    const sub = path.join(dir, 'parent-1', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    const file = path.join(sub, 'agent-a1b2c3.jsonl');
    const prompt = JSON.stringify({ type: 'user', uuid: 'sp', timestamp: '2026-01-01T12:00:40.000Z', sessionId: 's-1', isSidechain: true, agentId: 'a1b2c3', message: { role: 'user', content: 'do the thing' } }) + '\n';
    fs.writeFileSync(file, prompt + fixture('subagent-edit'));
    const row = readSessionFile(file, 'f', '/work/<project>', { parentSessionId: 'parent-1' });
    assert.equal(row.sessionId, 'sub:parent-1:a1b2c3');
    assert.equal(row.changes.files[0].count, 1);
    // The main file of the same session has its own aggregate, which does not see this edit.
    const main = path.join(dir, 'parent-1.jsonl');
    fs.writeFileSync(main, PROMPT);
    assert.deepEqual(readSessionFile(main, 'f', '/work/<project>', {}).changes.files, []);
  } finally { cleanup(dir); }
});

test('the line cursor gives the byte offset of the n-th non-empty line, skipping blank lines and counting multi-byte text', () => {
  const text = 'a\n\nbé\n\n\nccc\ndd';
  const buf = Buffer.from(text, 'utf8');
  const expected = [0, 3, 9, 13].map((n) => 100 + n); // a, bé (é is two bytes), ccc, dd
  const cursor = createLineCursor(buf, 100);
  for (let i = 0; i < expected.length; i++) {
    cursor.index = i;
    assert.equal(cursor.offset(), expected[i], `line ${i}`);
  }
});

// ── Incremental reads ────────────────────────────────────────────────────────────────────────────────────────────────

const ALL = ['edit-ok', 'write-ok', 'edit-error', 'multiedit-ok', 'bash-git-commit', 'bash-commit-then-push', 'bash-git-commit-amend', 'powershell-git-commit', 'api-request-blob', 'notebookedit-ok', 'bash-git-push-ok']
  .map(fixture).join('');

function incrementalAggregate(text, cuts) {
  const dir = tmp();
  try {
    const file = path.join(dir, 's-1.jsonl');
    const bytes = Buffer.from(PROMPT + text, 'utf8');
    let prev = null;
    let last;
    let from = 0;
    for (const to of [...cuts, bytes.length]) {
      fs.writeFileSync(file, bytes.subarray(0, to));
      const res = readSessionFileIncremental(file, 'f', '/work/<project>', {}, prev);
      if (res) {
        prev = res.next;
        if (res.session.changes) last = res.session.changes;
      }
      from = to;
    }
    return last;
  } finally { cleanup(dir); }
}

test('a partial last line across two incremental reads gives the offsets of one full read', () => {
  const full = parseFull(ALL).row.changes;
  const total = Buffer.byteLength(PROMPT + ALL);
  // Cut in the middle of the third fixture line, then every few bytes around a result line.
  assert.deepEqual(incrementalAggregate(ALL, [Buffer.byteLength(PROMPT) + 400]), full);
  assert.deepEqual(incrementalAggregate(ALL, [Math.floor(total / 2)]), full);
});

test('property: the aggregate after N incremental reads at random split points equals one full read', () => {
  const full = parseFull(ALL).row.changes;
  assert.ok(full.files.length >= 3 && full.commits.length >= 3 && full.pushes.length >= 2, 'the sample has to hold edits, commits and pushes');
  const total = Buffer.byteLength(PROMPT + ALL);
  let seed = 870;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let round = 0; round < 25; round++) {
    const n = 1 + Math.floor(rnd() * 8);
    const cuts = Array.from({ length: n }, () => 1 + Math.floor(rnd() * (total - 1))).sort((a, b) => a - b);
    assert.deepEqual(incrementalAggregate(ALL, cuts), full, `cuts ${cuts.join(',')}`);
  }
});

test('an incremental read emits changes only when the aggregate moved, a full re-read after a rewrite always does', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 's-1.jsonl');
    fs.writeFileSync(file, PROMPT + fixture('edit-ok'));
    const first = readSessionFileIncremental(file, 'f', '/work/<project>', {}, null);
    assert.equal(first.session.changes.files[0].count, 1);
    // Nothing appended: the row is rebuilt, the aggregate did not move.
    const idle = readSessionFileIncremental(file, 'f', '/work/<project>', {}, first.next);
    assert.equal(idle.session.changes, undefined);
    // A line that is no event: still nothing to say.
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T12:05:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) + '\n');
    const quiet = readSessionFileIncremental(file, 'f', '/work/<project>', {}, idle.next);
    assert.equal(quiet.session.changes, undefined);
    // An event: the cumulative aggregate, not a delta.
    fs.appendFileSync(file, fixture('write-ok'));
    const moved = readSessionFileIncremental(file, 'f', '/work/<project>', {}, quiet.next);
    assert.equal(moved.session.changes.files.length, 2);
    // A rewrite (smaller file): a full re-read, which carries the aggregate of what is there now.
    fs.writeFileSync(file, PROMPT);
    const rewritten = readSessionFileIncremental(file, 'f', '/work/<project>', {}, moved.next);
    assert.deepEqual(rewritten.session.changes.files, []);
    assert.deepEqual(rewritten.session.changes, readSessionFile(file, 'f', '/work/<project>', {}).changes);
  } finally { cleanup(dir); }
});

// ── Bytes that are not plain ASCII ──────────────────────────────────────────────────────────────────────────────────

test('CRLF line ends, a multi-byte path and an invalid-UTF-8 line before the result give the true byte offset, full and incremental', () => {
  const edit = JSON.stringify({ type: 'assistant', uuid: 'u-x1', timestamp: '2026-01-01T12:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x1', name: 'Edit', input: { file_path: '/work/<project>/src/ünï/文.js', old_string: 'a', new_string: 'b' } }] } });
  const result = JSON.stringify({ type: 'user', uuid: 'r-x1', timestamp: '2026-01-01T12:00:01.000Z', message: { role: 'user', content: [{ tool_use_id: 'toolu_x1', type: 'tool_result', content: 'updated ✓' }] } });
  const bytes = Buffer.concat([
    Buffer.from(PROMPT.replace('\n', '\r\n'), 'utf8'),
    Buffer.from(edit + '\r\n', 'utf8'),
    Buffer.from([0xff, 0xfe, 0x7b, 0xc3, 0x28, 0x0d, 0x0a]), // not valid UTF-8, not JSON
    Buffer.from('\r\n', 'utf8'),                                // a blank line
    Buffer.from(result + '\r\n', 'utf8'),
  ]);
  const resultStart = bytes.lastIndexOf(0x0a, bytes.indexOf('r-x1')) + 1;
  const dir = tmp();
  try {
    const file = path.join(dir, 's-1.jsonl');
    fs.writeFileSync(file, bytes);
    const full = readSessionFile(file, 'f', '/work/<project>', {}).changes;
    assert.equal(full.files.length, 1);
    assert.equal(full.files[0].path, '/work/<project>/src/ünï/文.js');
    assert.equal(full.files[0].last, resultStart);
    // Every split point, including inside a multi-byte character and between the CR and the LF.
    for (let cut = 1; cut < bytes.length; cut++) {
      fs.writeFileSync(file, bytes.subarray(0, cut));
      const a = readSessionFileIncremental(file, 'f', '/work/<project>', {}, null);
      fs.writeFileSync(file, bytes);
      const b = a ? readSessionFileIncremental(file, 'f', '/work/<project>', {}, a.next) : readSessionFileIncremental(file, 'f', '/work/<project>', {}, null);
      const last = (b.session.changes || (a && a.session.changes));
      assert.deepEqual(last, full, `cut ${cut}`);
    }
  } finally { cleanup(dir); }
});

// ── A row dropped while the memo lives (#870 G1) ────────────────────────────────────────────────────────────────────

test('forceChanges puts the cumulative aggregate into an unchanged re-read; without it the memo says nothing new', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 's-1.jsonl');
    fs.writeFileSync(file, PROMPT + fixture('edit-ok'));
    const first = readSessionFileIncremental(file, 'f', '/work/<project>', {}, null);
    const quiet = readSessionFileIncremental(file, 'f', '/work/<project>', {}, first.next);
    assert.equal(quiet.session.changes, undefined);
    const forced = readSessionFileIncremental(file, 'f', '/work/<project>', { forceChanges: true }, quiet.next);
    assert.deepEqual(forced.session.changes, first.session.changes);
  } finally { cleanup(dir); }
});

test('the folder re-read of a file with no cached row carries changes even when its memo already sent them', () => {
  const { parseClaudeFolder, _fileReadState } = require('../src/backends/claude/folder-parse');
  const dir = tmp();
  try {
    const file = path.join(dir, 's-1.jsonl');
    fs.writeFileSync(file, PROMPT + fixture('edit-ok'));
    const args = { folder: 'f', folderPath: dir, exists: true, projectPath: '/work/<project>', removed: false, cachedMap: new Map(), cachedByFilePath: new Map(), indexMtimeMs: 1 };
    const first = parseClaudeFolder(args);
    assert.equal(first.sessions[0].changes.files.length, 1);
    assert.ok(_fileReadState.has(file));
    // The row was dropped (delete-diff, wipe, removal); the file is unchanged and the memo lives on.
    const again = parseClaudeFolder(args);
    assert.equal(again.sessions.length, 1);
    assert.deepEqual(again.sessions[0].changes, first.sessions[0].changes);
  } finally { _fileReadState.delete(path.join(dir, 's-1.jsonl')); cleanup(dir); }
});
