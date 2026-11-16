'use strict';
// Codex's change extractor (#870, spec 47), through the real parser, over the T1 fixtures
// (test/fixtures/change-events/codex/). The fixtures hold no header, so every rollout here starts with one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const parser = require('../src/backends/codex/parser');
const { patchPathsIn } = require('../src/backends/codex/change-events');
const { parseBackendSessions } = require('../src/backends/parse');

const FIXTURES = path.join(__dirname, 'fixtures', 'change-events', 'codex');
const HEAD = JSON.stringify({ timestamp: '2026-01-01T11:59:00.000Z', type: 'session_meta', payload: { id: 's-1', cwd: '/work/<project>', timestamp: '2026-01-01T11:59:00.000Z' } }) + '\n'
  + JSON.stringify({ timestamp: '2026-01-01T11:59:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'please change things' }] } }) + '\n';

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name + '.jsonl'), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-codex-cce-'));
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const byteOffsetOfLine = (text, lineNo) => Buffer.byteLength(text.split('\n').slice(0, lineNo).join('\n') + (lineNo ? '\n' : ''));

function parseFull(text) {
  const dir = tmp();
  try {
    const file = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(file, HEAD + text);
    return parser.parseSession({ kind: 'file', path: file }, {});
  } finally { cleanup(dir); }
}
const changesOf = (...names) => parseFull(names.map(fixture).join('')).changes;
const paths = (c) => c.files.map((f) => `${f.path}:${f.count}`).sort();
const line = (type, payload, second) => JSON.stringify({ timestamp: `2026-01-01T12:00:0${second}.000Z`, type, payload }) + '\n';

test('an added file counts one edit at the output line', () => {
  const text = fixture('apply-patch-add');
  const c = changesOf('apply-patch-add');
  assert.deepEqual(paths(c), ['src/new.js:1']);
  assert.equal(c.files[0].last, Buffer.byteLength(HEAD) + byteOffsetOfLine(text, 1));
  assert.equal(c.files[0].first, c.files[0].last);
  assert.equal(typeof c.files[0].at, 'number');
});

test('an update and a delete in one patch each count one edit on their own path', () => {
  assert.deepEqual(paths(changesOf('apply-patch-update-delete')), ['src/foo.js:1', 'src/old.js:1']);
});

test('a move counts the source once (its Update File line) and the destination once (its Move to line)', () => {
  assert.deepEqual(paths(changesOf('apply-patch-move')), ['src/a.js:1', 'src/b.js:1']);
});

test('a patch whose script failed is not counted, and a full parse still carries an empty aggregate', () => {
  const c = changesOf('apply-patch-failed');
  assert.deepEqual(c.files, []);
  assert.deepEqual(c.commits, []);
});

test('a patch in a function call counts on the output, and an Exit code other than 0 does not', () => {
  const call = (id, patch) => line('response_item', { type: 'function_call', name: 'shell', call_id: id, arguments: JSON.stringify({ command: ['apply_patch', patch] }) }, 0);
  const out = (id, code) => line('response_item', { type: 'function_call_output', call_id: id, output: `Exit code: ${code}\nWall time: 0.1 seconds\nOutput:\n` }, 1);
  const patch = '*** Begin Patch\n*** Update File: src/x.js\n@@\n-a\n+b\n*** End Patch';
  const c = parseFull(call('c1', patch) + out('c1', 0) + call('c2', patch) + out('c2', 1)).changes;
  assert.deepEqual(paths(c), ['src/x.js:1']);
});

test('patchPathsIn reads a patch text, and only a marker at the start of a REAL line', () => {
  assert.deepEqual(patchPathsIn('*** Begin Patch\n*** Add File: a b.js\n+x\n*** Delete File: c.js\n*** End Patch'), ['a b.js', 'c.js']);
  // A marker inside an added line, a removed line, a quoted mention or after an escaped (not real) newline is content.
  assert.deepEqual(patchPathsIn('*** Add File: real.js\n+ "*** Add File: src/ghost.js"\n+*** Delete File: ghost2.js\n- *** Update File: ghost3.js\n'), ['real.js']);
  assert.deepEqual(patchPathsIn('*** Add File: real.js\n+x = "*** Begin Patch\\n*** Add File: src/ghost.js\\n"\n'), ['real.js']);
});

test('a patch that adds escaped patch text (plain and as a JS literal) yields only the real target file', () => {
  // The added file's CONTENT spells a whole patch with escaped newlines; written in the script literal that is a doubled backslash.
  const plain = 'const patch = "*** Begin Patch\\n*** Add File: src/real.js\\n+const t = \\"*** Begin Patch\\\\n*** Add File: src/ghost.js\\\\n*** End Patch\\";\\n*** End Patch";\ntext(await tools.apply_patch(patch));\n';
  assert.deepEqual(paths(parseFull(execCall('e1', plain) + execOut('e1', OK)).changes), ['src/real.js:1']);
  const single = "text(await tools.apply_patch('*** Begin Patch\\n*** Add File: src/real.js\\n+x = \\'*** Add File: src/ghost.js\\'\\n*** End Patch'));\n";
  assert.deepEqual(paths(parseFull(execCall('e2', single) + execOut('e2', OK)).changes), ['src/real.js:1']);
  const tmpl = 'const p = `*** Begin Patch\n*** Add File: src/real.js\n+y\n*** End Patch`;\ntext(await tools.apply_patch(p));\n';
  assert.deepEqual(paths(parseFull(execCall('e3', tmpl) + execOut('e3', OK)).changes), ['src/real.js:1']);
  // A template with an interpolation, or an escape the reader does not know, is given up: nothing is read.
  const interp = 'const p = `*** Begin Patch\n*** Add File: src/${name}.js\n*** End Patch`;\ntext(await tools.apply_patch(p));\n';
  assert.deepEqual(parseFull(execCall('e4', interp) + execOut('e4', OK)).changes.files, []);
  // The apply_patch function call: the argument is JSON, unescaped before it is read.
  const added = '*** Begin Patch\n*** Add File: src/real.js\n+x = "*** Begin Patch\\n*** Add File: src/ghost.js\\n"\n*** End Patch';
  const tool = line('response_item', { type: 'function_call', name: 'apply_patch', call_id: 't9', arguments: JSON.stringify({ input: added }) }, 0)
    + line('response_item', { type: 'function_call_output', call_id: 't9', output: 'Exit code: 0\nOutput:\n' }, 1);
  assert.deepEqual(paths(parseFull(tool).changes), ['src/real.js:1']);
});

const execCall = (id, input, second = 0) => line('response_item', { type: 'custom_tool_call', name: 'exec', call_id: id, input }, second);
const execOut = (id, head, second = 1) => line('response_item', { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text: head }, { type: 'input_text', text: '{}' }] }, second);
const OK = 'Script completed\nWall time 0.3 seconds\nOutput:\n';

test('a patch that adds a line spelling a marker does not make a ghost file (through the parser)', () => {
  const input = 'const patch = "*** Begin Patch\\n*** Add File: src/real.js\\n+x\\n+ \\"*** Add File: src/ghost.js\\"\\n*** End Patch";\ntext(await tools.apply_patch(patch));\n';
  assert.deepEqual(paths(parseFull(execCall('g1', input) + execOut('g1', OK)).changes), ['src/real.js:1']);
});

test('markers in a heredoc, a grep and echo, or a comment are not edits; only the argument of tools.apply_patch is read', () => {
  const heredoc = 'const r = await tools.exec_command({"cmd":"cat > x.patch <<\'EOF\'\\n*** Begin Patch\\n*** Add File: src/h.js\\nEOF"});\ntext(r.output);\n';
  const grep = 'const r = await tools.exec_command({"cmd":"grep -n \'*** Add File: src/g.js\' x.patch && echo apply_patch"});\ntext(r.output);\n';
  const comment = '// apply_patch would add\n// *** Begin Patch\n// *** Add File: src/c.js\ntext("done");\n';
  for (const [i, input] of [heredoc, grep, comment].entries()) {
    assert.deepEqual(parseFull(execCall(`p${i}`, input) + execOut(`p${i}`, OK)).changes.files, [], `probe ${i}`);
  }
  // The same markers handed to the patch tool do count, as a literal argument and through a variable.
  const direct = 'text(await tools.apply_patch("*** Begin Patch\\n*** Add File: src/d.js\\n+x\\n*** End Patch"));\n';
  assert.deepEqual(paths(parseFull(execCall('d1', direct) + execOut('d1', OK)).changes), ['src/d.js:1']);
});

test('a shell function call reads a patch only when apply_patch is the command word', () => {
  const patch = '*** Begin Patch\n*** Add File: src/s.js\n+x\n*** End Patch';
  const call = (id, command) => line('response_item', { type: 'function_call', name: 'shell', call_id: id, arguments: JSON.stringify({ command }) }, 0)
    + line('response_item', { type: 'function_call_output', call_id: id, output: 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\n' }, 1);
  assert.deepEqual(paths(parseFull(call('a1', ['apply_patch', patch])).changes), ['src/s.js:1']);
  assert.deepEqual(paths(parseFull(call('a2', ['bash', '-lc', `apply_patch <<'EOF'\n${patch}\nEOF`])).changes), ['src/s.js:1']);
  assert.deepEqual(parseFull(call('a3', ['bash', '-lc', `cat > x.patch <<'EOF'\n${patch}\nEOF`])).changes.files, []);
  assert.deepEqual(parseFull(call('a4', ['bash', '-lc', `grep -n 'Add File' x.patch; echo apply_patch`])).changes.files, []);
  // A call named apply_patch is the patch tool itself.
  const tool = line('response_item', { type: 'function_call', name: 'apply_patch', call_id: 't1', arguments: JSON.stringify({ input: patch }) }, 0)
    + line('response_item', { type: 'function_call_output', call_id: 't1', output: 'Exit code: 0\n' }, 1);
  assert.deepEqual(paths(parseFull(tool).changes), ['src/s.js:1']);
});

test('an edit counts only on a positive signal: no signal, a rejection or an abort count nothing', () => {
  const input = 'const patch = "*** Begin Patch\\n*** Add File: src/p.js\\n+x\\n*** End Patch";\ntext(await tools.apply_patch(patch));\n';
  const fn = (id, output) => line('response_item', { type: 'function_call', name: 'shell', call_id: id, arguments: JSON.stringify({ command: ['apply_patch', '*** Begin Patch\n*** Add File: src/p.js\n+x\n*** End Patch'] }) }, 0)
    + line('response_item', { type: 'function_call_output', call_id: id, output }, 1);
  const count = (text) => parseFull(text).changes.files.length;
  assert.equal(count(execCall('n1', input) + execOut('n1', OK)), 1);
  assert.equal(count(execCall('n2', input) + execOut('n2', 'Wall time 0.3 seconds\n')), 0, 'no Script completed header');
  assert.equal(count(execCall('n3', input) + execOut('n3', 'Script failed\nError: Failed to write file')), 0);
  assert.equal(count(execCall('n4', input) + line('response_item', { type: 'custom_tool_call_output', call_id: 'n4', output: 'patch rejected by user' }, 1)), 0);
  assert.equal(count(execCall('n5', input) + line('response_item', { type: 'custom_tool_call_output', call_id: 'n5', output: [{ type: 'input_text', text: OK }, { type: 'input_text', text: 'aborted\nnothing to abort' }] }, 1)), 1, 'a completed script that prints aborted still ran');
  assert.equal(count(fn('f1', 'Exit code: 0\nOutput:\n')), 1);
  assert.equal(count(fn('f2', JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } }))), 1);
  assert.equal(count(fn('f3', 'done')), 0, 'no exit code');
  assert.equal(count(fn('f4', 'Exit code: 1\n')), 0);
  assert.equal(count(fn('f5', 'patch rejected by user')), 0);
  assert.equal(count(fn('f6', 'Exit code: 0\nOutput:\npatch rejected by user')), 0, 'refusal as the first output line');
  assert.equal(count(fn('f7', 'Exit code: 0\nOutput:\nsaved\naborted a retry')), 1, 'a later line does not cancel');
  // `cd <dir> &&` before the command word is read; the paths stay as written (relative to that directory).
  const cd = (id, payload) => line('response_item', { type: 'function_call', name: 'shell', call_id: id, arguments: JSON.stringify({ command: ['bash', '-lc', payload] }) }, 0)
    + line('response_item', { type: 'function_call_output', call_id: id, output: 'Exit code: 0\nOutput:\n' }, 1);
  const patch = '*** Begin Patch\n*** Add File: src/c.js\n+x\n*** End Patch';
  assert.deepEqual(paths(parseFull(cd('c1', `cd sub && apply_patch <<'EOF'\n${patch}\nEOF`)).changes), ['src/c.js:1']);
  assert.deepEqual(paths(parseFull(cd('c2', `cd "my dir" && apply_patch <<'EOF'\n${patch}\nEOF`)).changes), ['src/c.js:1']);
  assert.deepEqual(parseFull(cd('c3', `cd sub && cat > x.patch <<'EOF'\n${patch}\nEOF`)).changes.files, []);
  assert.deepEqual(parseFull(cd('c4', `cd sub && ls && apply_patch <<'EOF'\n${patch}\nEOF`)).changes.files, [], 'only a lone cd precedes the command word');
});

test('a commit in a one-command script is read from the output, a failed one is not', () => {
  const text = fixture('exec-git-commit');
  const c = changesOf('exec-git-commit');
  assert.equal(c.commits.length, 1);
  assert.equal(c.commits[0].sha, '9f3c2ab');
  assert.equal(c.commits[0].subject, 'fix: handle empty input');
  assert.equal(c.commits[0].branch, 'main');
  assert.equal(c.commits[0].position, Buffer.byteLength(HEAD) + byteOffsetOfLine(text, 1));
  assert.equal(changesOf('exec-git-commit-failed').commits.length, 0);
});

test('a push: ok is an event with a snapshot of the per-file counts, rejected is an event with none', () => {
  const c = changesOf('apply-patch-add', 'exec-git-push-ok', 'exec-git-push-rejected');
  assert.equal(c.pushes.length, 2);
  assert.equal(c.pushes[0].ok, true);
  assert.deepEqual(c.pushes[0].files, [['src/new.js', 1]]);
  assert.equal(c.pushes[1].ok, false);
  assert.equal(c.pushes[1].files, undefined);
});

test('a two-command script attributes no commit and no push', () => {
  const c = changesOf('exec-two-commands');
  assert.deepEqual(c.commits, []);
  assert.deepEqual(c.pushes, []);
});

test('a bash -lc function call reads the payload (argv[2]), not the joined argv', () => {
  const c = changesOf('function-call-shell-commit');
  assert.equal(c.commits.length, 1);
  assert.equal(c.commits[0].sha, '9f3c2ab');
  // A shell wrapper around a command that merely quotes the words is not a commit.
  const echo = line('response_item', { type: 'function_call', name: 'shell', call_id: 'e1', arguments: JSON.stringify({ command: ['bash', '-lc', 'echo "git commit -m x"'] }) }, 0)
    + line('response_item', { type: 'function_call_output', call_id: 'e1', output: 'Exit code: 0\nOutput:\n[main 1a2b3c4] x\n' }, 1);
  assert.deepEqual(parseFull(echo).changes.commits, []);
});

test('a quoted commit command in a script is data, not a commit', () => {
  const input = 'const r = await tools.exec_command({"cmd":"echo \\"git commit -m x\\"","workdir":"/w"});\ntext(r.output);\n';
  const lines = line('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'z1', input }, 0)
    + line('response_item', { type: 'custom_tool_call_output', call_id: 'z1', output: [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: '[main 1a2b3c4] x\n' }] }, 1);
  assert.deepEqual(parseFull(lines).changes.commits, []);
});

// ── Incremental reads ────────────────────────────────────────────────────────────────────────────────────────────────

const ALL = ['apply-patch-add', 'apply-patch-update-delete', 'apply-patch-failed', 'apply-patch-move', 'exec-git-commit', 'exec-git-commit-failed',
  'exec-git-push-ok', 'exec-git-push-rejected', 'exec-two-commands', 'function-call-shell-commit'].map(fixture).join('');

function incrementalAggregate(text, cuts) {
  const dir = tmp();
  try {
    const file = path.join(dir, 'rollout.jsonl');
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
  assert.ok(full.files.length >= 4 && full.commits.length >= 1 && full.pushes.length >= 2, 'the sample has to hold edits, commits and pushes');
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
    const file = path.join(dir, 'rollout.jsonl');
    const handle = { kind: 'file', path: file };
    fs.writeFileSync(file, HEAD + fixture('apply-patch-add'));
    const first = parser.parseSessionIncremental(handle, {}, null);
    assert.equal(first.row.changes.files.length, 1);
    const idle = parser.parseSessionIncremental(handle, {}, first.parseState);
    assert.equal(idle.row.changes, undefined);
    fs.appendFileSync(file, line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }, 5));
    const quiet = parser.parseSessionIncremental(handle, {}, idle.parseState);
    assert.equal(quiet.row.changes, undefined);
    const forced = parser.parseSessionIncremental(handle, { forceChanges: true }, quiet.parseState);
    assert.deepEqual(forced.row.changes, first.row.changes);
    fs.appendFileSync(file, fixture('apply-patch-move'));
    const moved = parser.parseSessionIncremental(handle, {}, forced.parseState);
    assert.equal(moved.row.changes.files.length, 3);
    // A rewrite (smaller file): a full re-read that carries the aggregate of what is there now.
    fs.writeFileSync(file, HEAD);
    const rewritten = parser.parseSessionIncremental(handle, {}, moved.parseState);
    assert.deepEqual(rewritten.row.changes.files, []);
  } finally { cleanup(dir); }
});

test('CRLF line ends, a multi-byte path and an invalid-UTF-8 line before the result give the true byte offset, full and incremental', () => {
  const input = 'const patch = "*** Add File: src/ünï/文.js\\n+x\\n*** End Patch";\ntext(await tools.apply_patch(patch));\n';
  const call = line('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'x1', input }, 0).trimEnd();
  const result = line('response_item', { type: 'custom_tool_call_output', call_id: 'x1', output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: '{}' }] }, 1).trimEnd();
  const bytes = Buffer.concat([
    Buffer.from(HEAD.replace(/\n/g, '\r\n'), 'utf8'),
    Buffer.from(call + '\r\n', 'utf8'),
    Buffer.from([0xff, 0xfe, 0x7b, 0xc3, 0x28, 0x0d, 0x0a]), // not valid UTF-8, not JSON
    Buffer.from('\r\n', 'utf8'),                              // a blank line
    Buffer.from(result + '\r\n', 'utf8'),
  ]);
  const resultStart = bytes.lastIndexOf(0x0a, bytes.indexOf('custom_tool_call_output')) + 1;
  const dir = tmp();
  try {
    const file = path.join(dir, 'rollout.jsonl');
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
    const file = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(file, HEAD + fixture('apply-patch-add'));
    const b = { id: 'codex', PARSER_SCHEMA_VERSION: parser.PARSER_SCHEMA_VERSION, parseSession: parser.parseSession, parseSessionIncremental: parser.parseSessionIncremental };
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

test('the Codex descriptor declares the limited capability and says which half is missing', () => {
  const codex = require('../src/backends/codex');
  assert.equal(codex.reportsChanges, true);
  const row = codex.capabilities.sessionChanges;
  assert.equal(row.state, 'limited');
  assert.match(row.note, /apply-patch/);
  assert.match(row.note, /exactly one command/);
  assert.match(row.note, /catches a failed patch/);
});
