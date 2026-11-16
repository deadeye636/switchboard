'use strict';
// Pi's change extractor (#870, spec 47), through the real parser, over the T1 fixtures (test/fixtures/change-events/pi/).
// The fixtures hold no header, so every transcript here starts with one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const parser = require('../src/backends/pi/parser');
const { parseBackendSessions } = require('../src/backends/parse');

const FIXTURES = path.join(__dirname, 'fixtures', 'change-events', 'pi');
const HEAD = JSON.stringify({ type: 'session', version: 3, id: 's-1', timestamp: '2026-01-01T11:59:00.000Z', cwd: '/work/<project>' }) + '\n'
  + JSON.stringify({ type: 'message', id: 'u0', parentId: null, timestamp: '2026-01-01T11:59:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'please change things' }] } }) + '\n';

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name + '.jsonl'), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-pi-cce-'));
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const byteOffsetOfLine = (text, lineNo) => Buffer.byteLength(text.split('\n').slice(0, lineNo).join('\n') + (lineNo ? '\n' : ''));

function parseFull(text) {
  const dir = tmp();
  try {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, HEAD + text);
    return parser.parseSession({ kind: 'file', path: file }, {});
  } finally { cleanup(dir); }
}
const changesOf = (...names) => parseFull(names.map(fixture).join('')).changes;
const paths = (c) => c.files.map((f) => `${f.path}:${f.count}`).sort();
const entry = (id, parentId, second, message) => JSON.stringify({ type: 'message', id, parentId, timestamp: `2026-01-01T12:00:0${second}.000Z`, message }) + '\n';

test('an ok edit counts one edit at the result line; an error result counts none', () => {
  const text = fixture('edit-ok');
  const c = changesOf('edit-ok');
  assert.deepEqual(paths(c), ['/work/<project>/src/foo.js:1']);
  assert.equal(c.files[0].last, Buffer.byteLength(HEAD) + byteOffsetOfLine(text, 1));
  assert.equal(c.files[0].first, c.files[0].last);
  assert.equal(typeof c.files[0].at, 'number');
  const e = changesOf('edit-error');
  assert.deepEqual(e.files, []);
});

test('a write counts one edit', () => {
  assert.deepEqual(paths(changesOf('write-ok')), ['/work/<project>/src/new.js:1']);
});

test('a commit is read from the output line', () => {
  const text = fixture('bash-git-commit');
  const c = changesOf('bash-git-commit');
  assert.equal(c.commits.length, 1);
  assert.equal(c.commits[0].sha, '9f3c2ab');
  assert.equal(c.commits[0].subject, 'fix: handle empty input');
  assert.equal(c.commits[0].branch, 'main');
  assert.equal(c.commits[0].position, Buffer.byteLength(HEAD) + byteOffsetOfLine(text, 1));
  assert.equal(c.commits[0].amend, undefined);
});

test('an amend is marked; a hook failure and nothing-to-commit are no commit; a commit whose later step failed still counts', () => {
  const a = changesOf('bash-git-commit-amend').commits;
  assert.equal(a.length, 1);
  assert.equal(a[0].amend, true);
  assert.deepEqual(changesOf('bash-git-commit-hook-failed').commits, []);
  assert.deepEqual(changesOf('bash-git-commit-nothing').commits, []);
  const later = changesOf('bash-git-commit-ok-later-step-failed').commits;
  assert.equal(later.length, 1);
  assert.equal(later[0].sha, '4d5e6f7');
});

test('pushes: ok carries a snapshot of the per-file counts, rejected and up-to-date carry none, force-with-lease is marked', () => {
  const c = changesOf('edit-ok', 'bash-git-push-ok', 'bash-git-push-rejected', 'bash-git-push-uptodate', 'bash-git-push-force-with-lease');
  assert.equal(c.pushes.length, 4);
  assert.equal(c.pushes[0].ok, true);
  assert.deepEqual(c.pushes[0].files, [['/work/<project>/src/foo.js', 1]]);
  assert.equal(c.pushes[1].ok, false);
  assert.equal(c.pushes[1].files, undefined);
  assert.equal(c.pushes[2].upToDate, true);
  assert.equal(c.pushes[2].files, undefined);
  assert.equal(c.pushes[3].force, true);
  assert.equal(c.pushes[3].ok, true);
});

test('a non-git bash call, an unknown tool and a result for no known call count nothing', () => {
  const text = entry('a1', 'u0', 0, { role: 'assistant', content: [
    { type: 'toolCall', id: 'k1', name: 'bash', arguments: { command: 'ls -la' } },
    { type: 'toolCall', id: 'k2', name: 'read', arguments: { path: '/work/<project>/a.js' } },
  ] }) + entry('r1', 'a1', 1, { role: 'toolResult', toolCallId: 'k1', toolName: 'bash', content: [{ type: 'text', text: '[main abcdef1] fake' }], isError: false })
    + entry('r2', 'r1', 2, { role: 'toolResult', toolCallId: 'nope', toolName: 'edit', content: [], isError: false });
  const c = parseFull(text).changes;
  assert.deepEqual(c, { files: [], commits: [], pushes: [], truncated: false });
});

test('an edit on an abandoned branch still counts (the transcript is a tree)', () => {
  const text = entry('a1', 'u0', 0, { role: 'assistant', content: [{ type: 'toolCall', id: 'x1', name: 'edit', arguments: { path: 'src/left.js', edits: [] } }] })
    + entry('r1', 'a1', 1, { role: 'toolResult', toolCallId: 'x1', toolName: 'edit', content: [{ type: 'text', text: 'ok' }], isError: false })
    // a sibling of a1: the user went back to u0 and took another path, so the leaf is now on the other branch
    + entry('b1', 'u0', 2, { role: 'assistant', content: [{ type: 'toolCall', id: 'x2', name: 'write', arguments: { path: 'src/right.js', content: '' } }] })
    + entry('s1', 'b1', 3, { role: 'toolResult', toolCallId: 'x2', toolName: 'write', content: [{ type: 'text', text: 'ok' }], isError: false });
  const row = parseFull(text);
  assert.deepEqual(paths(row.changes), ['src/left.js:1', 'src/right.js:1']);
});

// ── Incremental reads ────────────────────────────────────────────────────────────────────────────────────────────────

const ALL = ['edit-ok', 'edit-error', 'write-ok', 'bash-git-commit', 'bash-git-commit-amend', 'bash-git-commit-hook-failed', 'bash-git-commit-nothing',
  'bash-git-commit-ok-later-step-failed', 'bash-git-push-ok', 'bash-git-push-uptodate', 'bash-git-push-rejected', 'bash-git-push-force-with-lease'].map(fixture).join('');

function incrementalAggregate(text, cuts) {
  const dir = tmp();
  try {
    const file = path.join(dir, 'session.jsonl');
    const bytes = Buffer.from(HEAD + text, 'utf8');
    let prev = null;
    let last;
    for (const to of [...cuts, bytes.length]) {
      fs.writeFileSync(file, bytes.subarray(0, to));
      const res = parser.parseSessionIncremental({ kind: 'file', path: file }, {}, prev);
      if (res.parseState) prev = res.parseState;
      if (res.row && res.row.changes) last = res.row.changes;
    }
    return last;
  } finally { cleanup(dir); }
}

test('a partial last line across two incremental reads gives the offsets of one full read', () => {
  const full = parseFull(ALL).changes;
  const total = Buffer.byteLength(HEAD + ALL);
  assert.deepEqual(incrementalAggregate(ALL, [Buffer.byteLength(HEAD) + 300]), full);
  assert.deepEqual(incrementalAggregate(ALL, [Math.floor(total / 2)]), full);
});

test('property: the aggregate after N incremental reads at random split points equals one full read', () => {
  const full = parseFull(ALL).changes;
  assert.ok(full.files.length >= 2 && full.commits.length >= 3 && full.pushes.length >= 3, 'the sample has to hold edits, commits and pushes');
  const total = Buffer.byteLength(HEAD + ALL);
  let seed = 870;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let round = 0; round < 25; round++) {
    const n = 1 + Math.floor(rnd() * 8);
    const cuts = Array.from({ length: n }, () => 1 + Math.floor(rnd() * (total - 1))).sort((a, b) => a - b);
    assert.deepEqual(incrementalAggregate(ALL, cuts), full, `cuts ${cuts.join(',')}`);
  }
});

test('an incremental read emits changes only when the aggregate moved, and forceChanges emits them anyway', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'session.jsonl');
    const handle = { kind: 'file', path: file };
    fs.writeFileSync(file, HEAD + fixture('edit-ok'));
    const first = parser.parseSessionIncremental(handle, {}, null);
    assert.equal(first.row.changes.files.length, 1);
    const idle = parser.parseSessionIncremental(handle, {}, first.parseState);
    assert.equal(idle.row.changes, undefined);
    fs.appendFileSync(file, entry('t1', 'u0', 5, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }));
    const quiet = parser.parseSessionIncremental(handle, {}, idle.parseState);
    assert.equal(quiet.row.changes, undefined);
    const forced = parser.parseSessionIncremental(handle, { forceChanges: true }, quiet.parseState);
    assert.deepEqual(forced.row.changes, first.row.changes);
    fs.appendFileSync(file, fixture('write-ok'));
    const moved = parser.parseSessionIncremental(handle, {}, forced.parseState);
    assert.equal(moved.row.changes.files.length, 2);
    // A rewrite (smaller file): a full re-read that carries the aggregate of what is there now.
    fs.writeFileSync(file, HEAD);
    const rewritten = parser.parseSessionIncremental(handle, {}, moved.parseState);
    assert.deepEqual(rewritten.row.changes.files, []);
  } finally { cleanup(dir); }
});

test('CRLF line ends, a multi-byte path and an invalid-UTF-8 line before the result give the true byte offset, full and incremental', () => {
  const call = entry('a1', 'u0', 0, { role: 'assistant', content: [{ type: 'toolCall', id: 'x1', name: 'write', arguments: { path: 'src/ünï/文.js', content: '' } }] }).trimEnd();
  const result = entry('r1', 'a1', 1, { role: 'toolResult', toolCallId: 'x1', toolName: 'write', content: [{ type: 'text', text: 'ok' }], isError: false }).trimEnd();
  const bytes = Buffer.concat([
    Buffer.from(HEAD.replace(/\n/g, '\r\n'), 'utf8'),
    Buffer.from(call + '\r\n', 'utf8'),
    Buffer.from([0xff, 0xfe, 0x7b, 0xc3, 0x28, 0x0d, 0x0a]), // not valid UTF-8, not JSON
    Buffer.from('\r\n', 'utf8'),                              // a blank line
    Buffer.from(result + '\r\n', 'utf8'),
  ]);
  const resultStart = bytes.lastIndexOf(0x0a, bytes.indexOf('"toolResult"')) + 1;
  const dir = tmp();
  try {
    const file = path.join(dir, 'session.jsonl');
    const handle = { kind: 'file', path: file };
    fs.writeFileSync(file, bytes);
    const full = parser.parseSession(handle, {}).changes;
    assert.equal(full.files.length, 1);
    assert.equal(full.files[0].path, 'src/ünï/文.js');
    assert.equal(full.files[0].last, resultStart);
    for (let cut = 1; cut < bytes.length; cut++) {
      fs.writeFileSync(file, bytes.subarray(0, cut));
      const a = parser.parseSessionIncremental(handle, {}, null);
      fs.writeFileSync(file, bytes);
      const b = parser.parseSessionIncremental(handle, {}, a.parseState);
      assert.deepEqual(b.row.changes || (a.row && a.row.changes), full, `cut ${cut}`);
    }
  } finally { cleanup(dir); }
});

// ── A row dropped while the memo lives ───────────────────────────────────────────────────────────────────────────────

test('the generic scan loop passes forceChanges for a file with no cached row and for one an older parser wrote', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, HEAD + fixture('edit-ok'));
    const b = { id: 'pi', PARSER_SCHEMA_VERSION: parser.PARSER_SCHEMA_VERSION, parseSession: parser.parseSession, parseSessionIncremental: parser.parseSessionIncremental };
    const handles = [{ kind: 'file', path: file }];
    const none = { cachedByFile: new Map(), cachedById: new Map() };
    const first = parseBackendSessions(b, { handles, ...none });
    assert.equal(first.sessions[0].changes.files.length, 1);
    // The row was dropped; the file is unchanged and the memo lives on.
    const again = parseBackendSessions(b, { handles, ...none });
    assert.deepEqual(again.sessions[0].changes, first.sessions[0].changes);
    // A row from an older parser: re-read, with changes.
    const old = new Map([[file, { sessionId: 's-1', modified: 'x', parserVersion: parser.PARSER_SCHEMA_VERSION - 1 }]]);
    const stale = parseBackendSessions(b, { handles, cachedByFile: old, cachedById: new Map() });
    assert.deepEqual(stale.sessions[0].changes, first.sessions[0].changes);
  } finally { cleanup(dir); }
});

test('the Pi descriptor declares the capability, and its pipe driver forwards it', () => {
  const pi = require('../src/backends/pi');
  assert.equal(pi.reportsChanges, true);
  assert.equal(pi.capabilities.sessionChanges.state, 'limited');
  assert.match(pi.capabilities.sessionChanges.note, /subagent tool/);
  assert.equal(require('../src/backends/pi-native').reportsChanges, true);
});
