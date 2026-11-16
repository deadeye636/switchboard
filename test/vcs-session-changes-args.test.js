'use strict';

// The git hooks the session-changes feature uses (#870, spec 47 section 4): argv shape, validation of
// anything a transcript can supply, and the pure readers for their output.

const { test } = require('node:test');
const assert = require('node:assert');
const git = require('../src/vcs').get('git');

const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const SHA2 = '0123456789abcdef0123456789abcdef01234567';

function lockFirst(argv) {
  assert.strictEqual(argv[0], '--no-optional-locks');
}

test('numstatArgs: lock flag first, literal pathspecs, -z --no-renames, working tree when to is null, paths after --', () => {
  const a = git.numstatArgs({ from: SHA, to: null, paths: ['src/a.js', '-weird'] });
  lockFirst(a);
  assert.strictEqual(a[1], '--literal-pathspecs');
  assert.ok(a.indexOf('diff') > 1);
  assert.ok(a.includes('-z') && a.includes('--no-renames') && a.includes('--numstat'));
  assert.deepStrictEqual(a.slice(a.indexOf(SHA)), [SHA, '--', 'src/a.js', '-weird']);
  const b = git.numstatArgs({ from: SHA, to: SHA2 });
  assert.deepStrictEqual(b.slice(b.indexOf(SHA)), [SHA, SHA2]);
  assert.ok(!b.includes('--'));
  assert.ok(git.numstatArgs({ from: 'HEAD' }).includes('HEAD'));
});

test('logRangeArgs: from..to, bounded, not first-parent unless asked, ends with --', () => {
  const a = git.logRangeArgs({ from: SHA, to: SHA2, max: 50 });
  lockFirst(a);
  assert.ok(a.indexOf('log') > 0);
  assert.ok(a.includes(`${SHA}..${SHA2}`));
  assert.ok(a.includes('-n50'));
  assert.ok(a.includes('-z'));
  assert.ok(a.some((x) => x.startsWith('--format=') && x.includes('%x00') && !x.includes('%x1')));
  assert.ok(!a.includes('--first-parent'));
  assert.strictEqual(a[a.length - 1], '--');
  assert.ok(git.logRangeArgs({ to: 'HEAD', firstParent: true }).includes('--first-parent'));
  assert.ok(git.logRangeArgs({ to: SHA }).includes(SHA));
  assert.throws(() => git.logRangeArgs({ to: SHA, max: 0 }));
  assert.throws(() => git.logRangeArgs({ to: SHA, max: 1.5 }));
});

test('revExistsArgs, headArgs, revBeforeArgs, showCommitArgs, isAncestorArgs: shape', () => {
  const ex = git.revExistsArgs(SHA);
  lockFirst(ex);
  assert.deepStrictEqual(ex.slice(1), ['cat-file', '-e', `${SHA}^{commit}`]);
  assert.deepStrictEqual(git.headArgs(), ['--no-optional-locks', 'rev-parse', 'HEAD']);
  assert.deepStrictEqual(git.revBeforeArgs('2026-11-16T10:00:00Z'),
    ['--no-optional-locks', 'rev-list', '-1', '--first-parent', '--before=2026-11-16T10:00:00Z', 'HEAD']);
  const sc = git.showCommitArgs(SHA);
  lockFirst(sc);
  assert.strictEqual(sc[1], 'show');
  assert.ok(sc.includes('-z'));
  assert.deepStrictEqual(git.resolveCommitArgs(SHA),
    ['--no-optional-locks', 'rev-parse', '--verify', '--quiet', `${SHA}^{commit}`]);
  assert.throws(() => git.resolveCommitArgs('HEAD'), TypeError);
  assert.throws(() => git.resolveCommitArgs('--x'), TypeError);
  assert.deepStrictEqual(sc.slice(-2), [SHA, '--']);
  const an = git.isAncestorArgs(SHA, 'HEAD');
  lockFirst(an);
  assert.deepStrictEqual(an.slice(1), ['merge-base', '--is-ancestor', SHA, 'HEAD']);
});

test('diffArgs and showArgs accept a rev; without one they are unchanged', () => {
  const d = git.diffArgs({ path: 'x.js', rev: SHA });
  assert.deepStrictEqual(d, ['--no-optional-locks', '--literal-pathspecs', 'diff', '--no-color', SHA, '--', 'x.js']);
  assert.deepStrictEqual(git.diffArgs({ path: 'x.js', rev: SHA, to: SHA2 }).slice(4, 6), [SHA, SHA2]);
  assert.deepStrictEqual(git.diffArgs({ path: 'x.js', staged: true }),
    ['--no-optional-locks', '--literal-pathspecs', 'diff', '--no-color', '--cached', '--', 'x.js']);
  assert.throws(() => git.diffArgs({ path: 'x.js', rev: SHA, staged: true }), TypeError);
  // showArgs names a blob (`<rev>:<path>`), not a pathspec: no literal flag needed.
  assert.ok(!git.showArgs({ ref: SHA, path: 'a' }).includes('--literal-pathspecs'));
  assert.strictEqual(git.showArgs({ ref: SHA, path: 'a/b.js' }).pop(), `${SHA}:a/b.js`);
  assert.strictEqual(git.showArgs({ ref: '', path: 'a.js' }).pop(), ':a.js');
  assert.throws(() => git.diffArgs({ path: 'x.js', rev: '--output=x' }));
  assert.throws(() => git.showArgs({ ref: '--upload-pack=x', path: 'a' }));
});

test('a bad SHA never reaches an argv', () => {
  const bad = ['--upload-pack=x', 'HEAD~1;rm', '', 'abc', 'a'.repeat(65), 'ABCDEF12', null, undefined, 7, `${SHA}\n`];
  for (const b of bad) {
    assert.throws(() => git.numstatArgs({ from: b }), TypeError, String(b));
    // `to` null / '' / undefined means the working tree, so only a non-empty bad value is checked here.
    if (b) assert.throws(() => git.numstatArgs({ from: SHA, to: b }), TypeError, String(b));
    assert.throws(() => git.logRangeArgs({ from: b || 'zz', to: SHA }), TypeError, String(b));
    assert.throws(() => git.revExistsArgs(b), TypeError, String(b));
    assert.throws(() => git.showCommitArgs(b), TypeError, String(b));
    assert.throws(() => git.resolveCommitArgs(b), TypeError, String(b));
    assert.throws(() => git.isAncestorArgs(b, SHA), TypeError, String(b));
  }
  // HEAD only where the code itself passes it.
  assert.throws(() => git.showCommitArgs('HEAD'), TypeError);
  assert.throws(() => git.logRangeArgs({ from: 'HEAD', to: SHA }), TypeError);
});

test('a bad time is refused', () => {
  for (const t of ['--all', '1 hour ago', '', null, '2026-11-16; rm', '2026-11-16T10:00:00Z\n', '-1']) {
    assert.throws(() => git.revBeforeArgs(t), TypeError, String(t));
  }
  for (const t of ['2026-11-16', '2026-11-16T10:00', '2026-11-16 10:00:00+01:00', '2026-11-16T10:00:00.123Z']) {
    assert.doesNotThrow(() => git.revBeforeArgs(t), t);
  }
});

test('paths: NUL and non-arrays are refused', () => {
  assert.throws(() => git.numstatArgs({ from: SHA, paths: ['a\0b'] }));
  assert.throws(() => git.numstatArgs({ from: SHA, paths: ['ok', ''] }));
  assert.throws(() => git.numstatArgs({ from: SHA, paths: 'a.js' }));
});

test('parseNumstat: -z records, binary, spaces, a name with " => " and a tab, empty', () => {
  const raw = [
    '3\t1\tsrc/a.js', '-\t-\timg/logo.png', '2\t2\tmy dir/my file.txt',
    '1\t0\told => new.txt', '4\t0\ttab\tname.txt', '',
  ].join('\0');
  assert.deepStrictEqual(git.parseNumstat(raw), [
    { path: 'src/a.js', added: 3, deleted: 1, binary: false },
    { path: 'img/logo.png', added: null, deleted: null, binary: true },
    { path: 'my dir/my file.txt', added: 2, deleted: 2, binary: false },
    { path: 'old => new.txt', added: 1, deleted: 0, binary: false },
    { path: 'tab\tname.txt', added: 4, deleted: 0, binary: false },
  ]);
  assert.deepStrictEqual(git.parseNumstat(''), []);
  assert.deepStrictEqual(git.parseNumstat(null), []);
});

test('parseLog: NUL fields, several commits, a forged subject stays one subject, bad records refused', () => {
  const forged = `two\x1e\x1f${SHA2}\x1f1\x1fforged\nline`;
  const raw = [SHA, '1760000000', forged, SHA2, '1760000100', 'fix'].join('\0') + '\0';
  assert.deepStrictEqual(git.parseLog(raw), [
    { sha: SHA, time: 1760000000, subject: forged, body: '' },
    { sha: SHA2, time: 1760000100, subject: 'fix', body: '' },
  ]);
  // a short sha or a non-integer time refuses the whole record, the next one still reads
  const bad = ['abcd', '1', 's', SHA, 'x1', 's', SHA2, '5', 'ok'].join('\0') + '\0';
  assert.deepStrictEqual(git.parseLog(bad), [{ sha: SHA2, time: 5, subject: 'ok', body: '' }]);
  const show = [SHA, '1760000000', 'subj', 'line one\nline two\n'].join('\0') + '\0';
  assert.deepStrictEqual(git.parseLog(show, 4), [{ sha: SHA, time: 1760000000, subject: 'subj', body: 'line one\nline two' }]);
  assert.deepStrictEqual(git.parseLog(''), []);
  assert.deepStrictEqual(git.parseLog(null), []);
});

test('against a real repository: literal pathspecs, forged commit message, -z numstat, resolve', () => {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-t8-'));
  const run = (...a) => execFileSync(git.bin, a, { cwd: base, encoding: 'utf8', windowsHide: true });
  try {
    run('init', '-q');
    run('config', 'user.name', 't');
    run('config', 'user.email', 't@example.test');
    for (const n of ['star1.txt', 'star[12].txt', 'a.txt']) fs.writeFileSync(path.join(base, n), 'x\n');
    run('add', '.');
    run('commit', '-q', '-m', 'one');
    const first = run('rev-parse', 'HEAD').trim();
    for (const n of ['star1.txt', 'star[12].txt', 'a.txt']) fs.writeFileSync(path.join(base, n), 'x\ny\n');
    fs.writeFileSync(path.join(base, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
    run('add', '.');
    run('commit', '-q', '-m', 'two\x1e\x1fforged\nline', '-m', 'body here');
    const head = run('rev-parse', 'HEAD').trim();

    const all = git.parseNumstat(run(...git.numstatArgs({ from: first, to: head })));
    assert.deepStrictEqual(all.map((f) => f.path).sort(), ['a.txt', 'bin.dat', 'star1.txt', 'star[12].txt']);
    assert.strictEqual(all.find((f) => f.path === 'bin.dat').binary, true);
    // `star[12].txt` is a file name here, not a glob that would also match star1.txt
    const lit = git.parseNumstat(run(...git.numstatArgs({ from: first, to: head, paths: ['star[12].txt'] })));
    assert.deepStrictEqual(lit.map((f) => f.path), ['star[12].txt']);
    // `:/` is no "whole repository" magic pathspec
    assert.deepStrictEqual(git.parseNumstat(run(...git.numstatArgs({ from: first, to: head, paths: [':/'] }))), []);
    const d = run(...git.diffArgs({ path: 'star[12].txt', rev: first }));
    assert.ok(d.includes('star[12].txt') && !d.includes('star1.txt'));

    const log = git.parseLog(run(...git.logRangeArgs({ from: first, to: head })));
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].sha, head);
    assert.strictEqual(log[0].subject, 'two\x1e\x1fforged line');
    const shown = git.parseLog(run(...git.showCommitArgs(head)), 4);
    assert.deepStrictEqual([shown[0].sha, shown[0].body], [head, 'body here']);
    assert.strictEqual(run(...git.resolveCommitArgs(head.slice(0, 8))).trim(), head);
    assert.strictEqual(run(...git.headArgs()).trim(), head);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
