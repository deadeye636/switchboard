'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseGitStatus } = require('../src/vcs/parse-git-status');

// A representative porcelain v2 --branch working tree, as NUL-separated records (`-z`, the form the
// git provider uses). Note the rename record's original path is the record RIGHT AFTER it.
const NUL_RECORDS = [
  '# branch.oid abc123',
  '# branch.head main',
  '# branch.ab +1 -0',
  '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/app/vcs.js',
  '1 MM N... 100644 100644 100644 aaaaaaa bbbbbbb src/renderer/shell/sidebar.js',
  '2 R. N... 100644 100644 100644 ccccccc ddddddd R100 src/renderer/vcs-chip.css',
  'src/renderer/chip.css',
  'u UU N... 100644 100644 100644 100644 eeeeeee fffffff ggggggg docs/conflict.md',
  '? test/vcs-parity.test.js',
];
const NUL_SAMPLE = NUL_RECORDS.join('\0');

test('NUL mode: branch, ahead/behind, counts', () => {
  const s = parseGitStatus(NUL_SAMPLE);
  assert.strictEqual(s.branch, 'main');
  assert.strictEqual(s.state, null);
  assert.strictEqual(s.ahead, 1);
  assert.strictEqual(s.behind, 0);
  // staged rows: vcs.js (M.), sidebar.js staged side (MM), the rename (R.)
  assert.strictEqual(s.staged, 3);
  // unstaged rows: sidebar.js unstaged side (MM)
  assert.strictEqual(s.unstaged, 1);
  assert.strictEqual(s.untracked, 1);
  assert.strictEqual(s.conflicted, 1);
  // one file per group-membership: 3 staged + 1 unstaged + 1 untracked + 1 conflicted
  assert.strictEqual(s.files.length, 6);
});

test('NUL mode: MM counts on both sides and appears once per group', () => {
  const s = parseGitStatus(NUL_SAMPLE);
  const sidebarRows = s.files.filter(f => f.path === 'src/renderer/shell/sidebar.js');
  assert.strictEqual(sidebarRows.length, 2);
  assert.deepStrictEqual(sidebarRows.map(r => r.kind).sort(), ['staged', 'unstaged']);
});

test('NUL mode: rename carries origPath and the new path', () => {
  const s = parseGitStatus(NUL_SAMPLE);
  const ren = s.files.find(f => f.path === 'src/renderer/vcs-chip.css');
  assert.ok(ren, 'rename row present');
  assert.strictEqual(ren.kind, 'staged');
  assert.strictEqual(ren.origPath, 'src/renderer/chip.css');
});

test('NUL mode: conflict and untracked classified', () => {
  const s = parseGitStatus(NUL_SAMPLE);
  assert.ok(s.files.some(f => f.kind === 'conflicted' && f.path === 'docs/conflict.md'));
  assert.ok(s.files.some(f => f.kind === 'untracked' && f.path === 'test/vcs-parity.test.js'));
});

test('newline mode: same counts, rename tab-separated', () => {
  const nl = [
    '# branch.oid abc123',
    '# branch.head main',
    '# branch.ab +2 -3',
    '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb a.js',
    '1 MM N... 100644 100644 100644 aaaaaaa bbbbbbb b.js',
    '2 R. N... 100644 100644 100644 ccccccc ddddddd R100 new-name.js\told-name.js',
    '? untracked.txt',
  ].join('\n');
  const s = parseGitStatus(nl);
  assert.strictEqual(s.branch, 'main');
  assert.strictEqual(s.ahead, 2);
  assert.strictEqual(s.behind, 3);
  assert.strictEqual(s.staged, 3);   // a.js, b.js(staged), rename
  assert.strictEqual(s.unstaged, 1); // b.js(unstaged)
  assert.strictEqual(s.untracked, 1);
  const ren = s.files.find(f => f.path === 'new-name.js');
  assert.strictEqual(ren.origPath, 'old-name.js');
});

test('newline mode: C-quoted path with escaped tab is unquoted', () => {
  const nl = [
    '# branch.head main',
    '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb "spa\\tce.txt"',
  ].join('\n');
  const s = parseGitStatus(nl);
  const f = s.files.find(x => x.kind === 'unstaged');
  assert.strictEqual(f.path, 'spa\tce.txt');
});

test('detached HEAD → branch null, state detached', () => {
  const s = parseGitStatus(['# branch.oid abc', '# branch.head (detached)'].join('\n'));
  assert.strictEqual(s.branch, null);
  assert.strictEqual(s.state, 'detached');
});

test('initial commit (no branch.ab) → branch set, ahead/behind null', () => {
  const s = parseGitStatus(['# branch.oid (initial)', '# branch.head main'].join('\n'));
  assert.strictEqual(s.branch, 'main');
  assert.strictEqual(s.ahead, null);
  assert.strictEqual(s.behind, null);
});

test('clean tree → all zero, no files', () => {
  const s = parseGitStatus(['# branch.head main', '# branch.ab +0 -0'].join('\n'));
  assert.strictEqual(s.staged, 0);
  assert.strictEqual(s.unstaged, 0);
  assert.strictEqual(s.untracked, 0);
  assert.strictEqual(s.conflicted, 0);
  assert.strictEqual(s.files.length, 0);
});

test('empty input → safe zeros', () => {
  const s = parseGitStatus('');
  assert.strictEqual(s.branch, null);
  assert.strictEqual(s.files.length, 0);
});

test('cap truncates the file list and flags it', () => {
  const s = parseGitStatus(NUL_SAMPLE, { cap: 2 });
  assert.strictEqual(s.files.length, 2);
  assert.strictEqual(s.truncated, true);
});

test('ignored (!) entries are skipped', () => {
  const s = parseGitStatus(['# branch.head main', '! node_modules/x', '? real.txt'].join('\n'));
  assert.strictEqual(s.untracked, 1);
  assert.strictEqual(s.files.length, 1);
});

test('countUntracked:false → untracked is null (not 0), distinct from a measured zero', () => {
  // -uno emits no `?` rows; the caller signals the mode so the segment is null.
  const off = parseGitStatus(['# branch.head main', '1 M. N... 100644 100644 100644 a b x.js'].join('\n'), { countUntracked: false });
  assert.strictEqual(off.untracked, null);
  assert.strictEqual(off.staged, 1);
  // default (measured) with no untracked files → a real 0
  const on = parseGitStatus(['# branch.head main'].join('\n'));
  assert.strictEqual(on.untracked, 0);
});

test('paths with spaces parse (ordinary and rename)', () => {
  const nl = [
    '# branch.head main',
    '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb my file name.txt',
    '2 R. N... 100644 100644 100644 ccccccc ddddddd R100 new dir/new file.txt\told dir/old file.txt',
  ].join('\n');
  const s = parseGitStatus(nl);
  assert.ok(s.files.some(f => f.path === 'my file name.txt' && f.kind === 'unstaged'));
  const ren = s.files.find(f => f.path === 'new dir/new file.txt');
  assert.ok(ren, 'rename with spaces present');
  assert.strictEqual(ren.origPath, 'old dir/old file.txt');
});
