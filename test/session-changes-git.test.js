'use strict';
// The version-control side of `src/app/session-changes.js` (#870, spec 47 section 4) with a fake provider and a fake
// `execFile`: argv order, timeouts, one read in flight with a dirty flag, the baseline-gone path (E2), a repository
// without commits (G7), a short SHA that resolves to a branch tip (G4), a builder that refuses (TypeError), a path
// outside the checkout (E10), and a shared tree where another session's file is not listed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sc = require('../src/app/session-changes');
const { makeCheckout, makeProvider, makeExec, makeStore, makeCtx, FULL } = require('./helpers/session-changes-fakes');

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const START = '2026-11-16T08:00:00.000Z';
function setup({ answers, files, commits = [], pushes = [], status, delay, providerOverrides, sessions: extraSessions = [], others } = {}) {
  const root = makeCheckout();
  roots.push(root);
  const provider = makeProvider(root, providerOverrides);
  const { exec, calls } = makeExec(answers || {}, { delay });
  const store = makeStore();
  const sessions = [{ sessionId: 'S', folder: 'F', projectPath: root, backendId: 'x', startedAt: START }, ...extraSessions];
  store.changes.set('S', { files: files || [{ path: path.join(root, 'src', 'a.js'), count: 2, first: 1, last: 10, at: Date.UTC(2026, 10, 16, 9) }], commits, pushes, truncated: false });
  sc.init(makeCtx({ root, sessions, provider, exec, store, status, others }));
  return { root, calls, store, provider };
}

const sub = (c) => c.args.find((a, i) => i > 0 && !a.startsWith('--'));
const ok = (out) => ({ out });

test('argv: the provider spells every call, global flag first, checkout as cwd, a timeout and an output cap', async () => {
  const { root, calls, store } = setup({
    answers: {
      'rev-list': ok(FULL('a') + '\n'), 'cat-file': ok(''), log: ok(''),
      diff: ok('3\t1\tsrc/a.js\0'),
    },
  });
  const st = await sc.state('S', {});
  assert.equal(st.ok, true);
  assert.deepEqual(calls.map(sub), ['rev-list', 'cat-file', 'log', 'diff']);
  for (const c of calls) {
    assert.equal(c.args[0], '--no-optional-locks');
    assert.equal(c.opts.cwd, root);
    assert.ok(c.opts.timeout > 0 && c.opts.maxBuffer > 0);
    assert.ok(path.isAbsolute(c.bin));
  }
  assert.ok(calls[0].args.includes(`--before=${START}`));
  assert.equal(store.entries[0].kind, 'start');
  assert.equal(store.entries[0].sha, FULL('a'));
  assert.equal(store.entries[0].how, 'before-start');
  assert.deepEqual(st.files.map((f) => [f.key, f.count, f.added, f.deleted]), [['src/a.js', 2, 3, 1]]);
  assert.equal(JSON.stringify(st).includes(root), false, 'no absolute checkout path in the answer');
});

test('E1 fallback: no commit before the start answers HEAD', async () => {
  const { store } = setup({ answers: { 'rev-list': ok(''), 'rev-parse': ok(FULL('c') + '\n'), 'cat-file': ok(''), log: ok(''), diff: ok('') } });
  await sc.state('S', {});
  assert.equal(store.entries[0].sha, FULL('c'));
  assert.equal(store.entries[0].how, 'head');
});

test('G7: a repository without commits has no baseline, recorded as such, and nothing throws', async () => {
  const { store, calls } = setup({ answers: { 'rev-list': { code: 128 }, 'rev-parse': { code: 128 } } });
  const st = await sc.state('S', {});
  assert.equal(st.ok, true);
  assert.equal(store.entries[0].sha, null);
  assert.equal(store.entries[0].how, 'no-commits');
  assert.equal(st.files.length, 1);
  assert.equal(calls.some((c) => sub(c) === 'diff'), false, 'no numstat without a baseline');
});

test('a timeout is a failed read: the note, the last good view kept, no throw', async () => {
  let numstat = ok('5\t0\tsrc/a.js\0');
  setup({ answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: () => numstat } });
  const good = await sc.state('S', {});
  assert.equal(good.files[0].added, 5);
  numstat = { killed: true };
  const bad = await sc.state('S', {});
  assert.ok(bad.notes.some((n) => n.code === 'vcs-failed'));
  assert.equal(bad.files[0].added, 5, 'the last good counts stay');
});

test('one read in flight per session and request: the same request coalesces, another runs with its own range', async () => {
  const { calls } = setup({ delay: true, answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: ok('') } });
  const a = sc.state('S', { range: 'whole' });
  const b = sc.state('S', { range: 'whole' });
  const c = sc.state('S', { range: 'since-review', view: 'split' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  const [ra, rc] = await Promise.all([a, c]);
  assert.equal(ra.range.kind, 'whole');
  assert.equal(rc.range.kind, 'since-review');
  assert.equal(rc.view, 'split');
  assert.equal(calls.filter((x) => sub(x) === 'cat-file').length, 3, 'whole twice (one coalesced rerun), since-review once');
});

test('E2: a baseline that is gone yields the note and Set review point to now, which records from = missing', async () => {
  const { store } = setup({ answers: { 'rev-list': ok(FULL('a')), 'cat-file': { code: 128 }, log: ok(''), 'rev-parse': ok(FULL('d')) } });
  const st = await sc.state('S', {});
  assert.ok(st.notes.some((n) => n.code === 'baseline-gone'));
  assert.equal(st.actions.setReviewPointNow, true);
  assert.equal(st.files.length, 1, 'the transcript list stays');
  const r = await sc.clear('S', { missing: true });
  assert.equal(r.ok, true);
  const e = store.entries.find((x) => x.kind === 'clear');
  assert.equal(e.fromSha, null);
  assert.equal(e.toSha, FULL('d'));
});

test('G4: a short SHA that resolves to something not starting with it (a branch named like it) is not accepted', async () => {
  const { calls } = setup({
    commits: [{ sha: 'deadbee', subject: 's', branch: 'main', position: 5, at: Date.UTC(2026, 10, 16, 9) }],
    answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: ok(''), 'rev-parse': ok(FULL('e') + '\n') },
  });
  const st = await sc.state('S', {});
  assert.equal(st.commits[0].rewritten, true);
  assert.equal(calls.some((c) => sub(c) === 'merge-base'), false, 'the refused answer is never used');
  const resolve = calls.find((c) => sub(c) === 'rev-parse');
  assert.ok(resolve.args.includes('deadbee^{commit}'));
});

test('a recorded SHA that is in history is matched by prefix and needs no lookup', async () => {
  const full = 'abc1234' + '0'.repeat(33);
  const { calls } = setup({
    commits: [{ sha: 'abc1234', subject: 's', branch: 'main', position: 5, at: Date.UTC(2026, 10, 16, 9) }],
    answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(`${full}\0${1763283600}\0s\0`), diff: ok('') },
  });
  const st = await sc.state('S', {});
  assert.equal(st.commits[0].rewritten, false);
  assert.equal(calls.some((c) => sub(c) === 'rev-parse'), false);
  assert.equal(st.totals.otherCommits, 0);
});

test('a builder that refuses an untrusted value (TypeError) is "not available", never a throw', async () => {
  setup({
    commits: [{ sha: 'abcdef1', subject: 's', branch: 'main', position: 5, at: Date.UTC(2026, 10, 16, 9) }],
    providerOverrides: { isAncestorArgs: () => { throw new TypeError('not a commit SHA'); } },
    answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: ok(''), 'rev-parse': ok('abcdef1' + '9'.repeat(33)) },
  });
  const st = await sc.state('S', {});
  assert.equal(st.ok, true);
  assert.equal(st.commits[0].rewritten, false, 'unknown: no mark rather than a guess');
});

test('a commit row’s detail carries its time in milliseconds, as every other time the page formats', async () => {
  const full = 'abcdef1' + '9'.repeat(33);
  const EPOCH_S = 1794910496;       // git prints `%at` in seconds
  setup({
    commits: [{ sha: 'abcdef1', subject: 's', branch: 'main', position: 5, at: Date.UTC(2026, 10, 16, 9) }],
    answers: {
      'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: ok(''), 'rev-parse': ok(full),
      show: ok(`${full}\0${EPOCH_S}\0The subject\0The body\n\0`),
    },
  });
  const st = await sc.state('S', { range: 'whole' });
  const d = await sc.diff('S', st.commits[0].id);
  assert.equal(d.ok, true);
  assert.equal(d.commit.time, EPOCH_S * 1000);
  assert.equal(new Date(d.commit.time).getTime(), Date.UTC(2026, 10, 17, 10, 14, 56));
  assert.equal(d.commit.subject, 'The subject');
});

test('E10: a path outside the checkout is listed as outside and never reaches version control', async () => {
  const outsideDir = makeCheckout();
  roots.push(outsideDir);
  const out = path.join(outsideDir, 'x.js');
  const { calls } = setup({
    files: [{ path: out, count: 1, first: 1, last: 2, at: Date.UTC(2026, 10, 16, 9) }],
    answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: ok('') },
  });
  const st = await sc.state('S', {});
  assert.equal(st.files[0].outside, true);
  const before = calls.length;
  const d = await sc.diff('S', st.files[0].id);
  assert.equal(d.ok, false);
  assert.match(d.error, /outside/i);
  assert.equal(calls.length, before, 'no call for an outside path');
  assert.equal(calls.some((c) => c.args.some((a) => a.includes(outsideDir))), false);
});

test('shared tree: another session\'s file in the numstat is not listed, and counts toward E7 only', async () => {
  const { root } = setup({
    status: { files: [{ path: 'src/a.js', kind: 'modified' }, { path: 'src/theirs.js', kind: 'modified' }], truncated: false },
    answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: ok('1\t0\tsrc/a.js\x002\t2\tsrc/theirs.js\0') },
  });
  assert.ok(root);
  const st = await sc.state('S', {});
  assert.deepEqual(st.files.map((f) => f.key), ['src/a.js']);
  assert.equal(st.otherChanged, 1);
});

test('E8: another session of the project that edited the same file since the range start marks the row', async () => {
  const root = makeCheckout();
  roots.push(root);
  const provider = makeProvider(root);
  const { exec } = makeExec({ 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: ok('') });
  const store = makeStore();
  const sessions = [{ sessionId: 'S', folder: 'F', projectPath: root, startedAt: START }];
  const others = [{ sessionId: 'O', folder: 'F', projectPath: root, modified: Date.UTC(2026, 10, 16, 10) }];
  const at = Date.UTC(2026, 10, 16, 9);
  store.changes.set('S', { files: [{ path: 'src/a.js', count: 1, first: 1, last: 2, at }], commits: [], pushes: [], truncated: false });
  store.changes.set('O', { files: [{ path: path.join(root, 'src', 'a.js'), count: 4, first: 1, last: 2, at: Date.UTC(2026, 10, 16, 10) }], commits: [], pushes: [], truncated: false });
  sc.init(makeCtx({ root, sessions, provider, exec, store, others }));
  const st = await sc.state('S', {});
  assert.equal(st.files[0].otherSessions, 1);
});

test('a file diff runs the provider diff against the cut\'s baseline, by row id', async () => {
  const { calls } = setup({ answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: (args) => (args.includes('--numstat') ? ok('1\t0\tsrc/a.js\0') : ok('+x\n')) } });
  const st = await sc.state('S', {});
  const d = await sc.diff('S', st.files[0].id);
  assert.equal(d.ok, true);
  assert.equal(d.text, '+x\n');
  const last = calls[calls.length - 1];
  assert.deepEqual(last.args.slice(-3), [FULL('a'), '--', 'src/a.js']);
});

// --- the fix round of the T9 verify ---

const UNC = String.fromCharCode(92, 92) + 'evil-host' + String.fromCharCode(92) + 'share' + String.fromCharCode(92) + 'x.js';

const at9 = Date.UTC(2026, 10, 16, 9);
const entry = (o) => ({ lineageId: 'S', sessionId: 'S', fromSha: null, toSha: null, fromPosition: null, files: null, repoRoot: null, how: null, ...o });

// A reopened review ends at the HEAD a Clear recorded: the app's own SHA, used without a lookup, so it has to be ASKED about.
function reviewSetup(catFile) {
  const s = setup({
    files: [{ path: 'src/a.js', count: 3, first: 1, last: 50, at: at9 }],
    answers: { 'rev-list': ok(FULL('a')), 'cat-file': catFile, log: ok(''), diff: ok('') },
  });
  s.store.entries.push(entry({ id: 1, kind: 'start', position: null, at: 1, sha: FULL('a') }));
  s.store.entries.push(entry({ id: 2, kind: 'clear', position: 20, at: 2, toSha: FULL('b'), files: { files: [['src/a.js', 1]], truncated: false } }));
  return s;
}

test('a reopened review whose recorded end the repository no longer holds says the commits are gone', async () => {
  const { calls } = reviewSetup((args) => (args.includes(FULL('b') + '^{commit}') || args.some((a) => a.includes(FULL('b'))) ? { code: 128 } : ok('')));
  const st = await sc.state('S', { range: 'pick', pickFrom: 1, pickTo: 2 });
  assert.equal(st.review.n, 1);
  assert.equal(st.review.gone, true);
  assert.ok(st.notes.some((n) => n.code === 'review-gone'));
  assert.ok(calls.some((c) => sub(c) === 'cat-file' && c.args.some((a) => a.includes(FULL('b')))), 'the end was asked about');
});

test('a reopened review whose recorded end is still held is not reported gone', async () => {
  reviewSetup(ok(''));
  const st = await sc.state('S', { range: 'pick', pickFrom: 1, pickTo: 2 });
  assert.equal(st.review.gone, false);
  assert.equal(st.notes.some((n) => n.code === 'review-gone'), false);
});

test('row ids are content-derived: a Details id of range B diffs B\'s file after the sidebar asked range A', async () => {
  const { store, calls } = setup({
    files: [{ path: 'src/a.js', count: 3, first: 1, last: 50, at: at9 }],
    answers: { 'cat-file': ok(''), log: ok(''), diff: (args) => (args.includes('--numstat') ? ok('1\t0\tsrc/a.js\0') : ok('+x\n')) },
  });
  store.entries.push(entry({ id: 1, kind: 'start', position: null, at: 1, sha: FULL('a') }));
  store.entries.push(entry({ id: 2, kind: 'clear', position: 20, at: 2, toSha: FULL('b'), files: { files: [['src/a.js', 1]], truncated: false } }));
  const details = await sc.state('S', { range: 'whole' });        // B
  const sidebar = await sc.state('S', { range: 'since-review' }); // A, asked after
  assert.notEqual(details.files[0].id, sidebar.files[0].id);
  const d = await sc.diff('S', details.files[0].id);
  assert.equal(d.ok, true);
  assert.deepEqual(calls[calls.length - 1].args.slice(-3), [FULL('a'), '--', 'src/a.js'], 'B starts at the start entry');
  const a = await sc.diff('S', sidebar.files[0].id);
  assert.equal(a.ok, true);
  assert.deepEqual(calls[calls.length - 1].args.slice(-3), [FULL('b'), '--', 'src/a.js'], 'A starts at the Clear');
  const before = calls.length;
  for (const forged of ['f:' + '0'.repeat(20), 'c:deadbee', 'f0']) assert.equal((await sc.diff('S', forged)).ok, false);
  assert.equal(calls.length, before);
});

test('spawns are bounded: 120 recorded commits not in history cost at most SPAWN_BOUND calls; in history they cost none', async () => {
  const commits = [];
  for (let i = 0; i < 120; i++) commits.push({ sha: 'a' + (0x100000 + i).toString(16), subject: 's' + i, branch: 'm', position: i + 1, at: at9 });
  const uniq = commits.filter((c, i, l) => l.findIndex((x) => x.sha === c.sha) === i);
  assert.equal(uniq.length, 120);
  const { calls } = setup({
    commits: uniq,
    answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: ok(''), 'rev-parse': ok(FULL('e')) },
  });
  const st = await sc.state('S', { range: 'whole' });
  assert.equal(st.commits.length, uniq.length);
  // A FIRST refresh: the bound includes the timeline's baseline calls.
  // 2 baseline + 1 check + 1 history + 2 * (8 cut + 16 mark lookups, each with one ancestry check) + 12 numstat reads
  // + 1 for the end of a range that stops at a recorded SHA (a reopened review; this whole-session range has none).
  assert.equal(sc.SPAWN_BOUND, 65);
  assert.ok(calls.length <= sc.SPAWN_BOUND, `${calls.length} calls, bound ${sc.SPAWN_BOUND}`);
  assert.ok(calls.filter((c) => sub(c) === 'rev-parse').length <= 16);
  // The same commits all in history: matched by the history read, no lookup at all.
  const log = uniq.map((c) => `${c.sha}${'0'.repeat(33)}\0${1763283600}\0${c.subject}\0`).join('');
  const second = setup({ commits: uniq, answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(log), diff: ok('') } });
  const st2 = await sc.state('S', { range: 'whole' });
  assert.equal(st2.commits.every((c) => !c.rewritten), true);
  assert.equal(second.calls.filter((c) => sub(c) === 'rev-parse' || sub(c) === 'merge-base').length, 0);
});

test('a network path from a transcript is outside, decided lexically: nothing on the filesystem is asked about it', async () => {
  const touched = [];
  const spy = (obj, name) => {
    const orig = obj[name];
    obj[name] = function (p, ...rest) { if (/host/i.test(String(p))) touched.push(`${name}:${p}`); return orig.call(this, p, ...rest); };
    return () => { obj[name] = orig; };
  };
  const restore = [spy(fs.realpathSync, 'native'), spy(fs, 'statSync'), spy(fs, 'lstatSync'), spy(fs, 'existsSync')];
  try {
    setup({
      files: [
        { path: UNC, count: 1, first: 1, last: 2, at: at9 },
        { path: '//other-host/share/y.js', count: 1, first: 1, last: 3, at: at9 },
        { path: 'src/a.js', count: 1, first: 1, last: 4, at: at9 },
      ],
      answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: ok('') },
    });
    const st = await sc.state('S', {});
    const byKey = new Map(st.files.map((f) => [f.key, f]));
    assert.equal(byKey.get(UNC).outside, true);
    assert.equal(byKey.get('//other-host/share/y.js').outside, true);
    assert.equal(byKey.get('src/a.js').outside, false);
    const d = await sc.diff('S', byKey.get('//other-host/share/y.js').id);
    assert.equal(d.ok, false);
  } finally { for (const r of restore) r(); }
  assert.deepEqual(touched, []);
});

test('the numstat cap reads All and the NEWEST blocks: with 15 pushes the open block has counts', async () => {
  const commits = [];
  const pushes = [];
  let log = '';
  for (let i = 1; i <= 15; i++) {
    const sha = (0xabc0000 + i).toString(16);
    commits.push({ sha, subject: 's' + i, branch: 'm', position: i * 10, at: at9 });
    pushes.push({ ok: true, summary: 'm', position: i * 10 + 5, at: at9 + i, files: [['src/a.js', i]] });
    log += `${sha}${'0'.repeat(33)}\0${1763283600}\0s${i}\0`;
  }
  const { calls } = setup({
    files: [{ path: 'src/a.js', count: 16, first: 1, last: 200, at: at9 + 100 }], commits, pushes,
    answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(log), diff: ok('1\t0\tsrc/a.js\0') },
  });
  const st = await sc.state('S', { range: 'whole', view: 'split' });
  assert.equal(st.blocks.length, 16);
  assert.equal(st.blocks[0].kind, 'open');
  assert.equal(st.blocks[0].files[0].added, 1, 'the open block is measured');
  assert.equal(st.blocks[1].files[0].added, 1, 'so is the newest pushed block');
  assert.equal(st.blocks[15].files[0].added, null, 'the oldest is over the cap');
  assert.ok(calls.filter((c) => c.args.includes('--numstat')).length <= 12);
});

test('last good counts stand in only for the same request; an over-cap read is "counts not available", not a failure', async () => {
  let numstat = ok('5\t0\tsrc/a.js\0');
  setup({ files: [{ path: 'src/a.js', count: 1, first: 1, last: 2, at: at9 }], answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: () => numstat } });
  assert.equal((await sc.state('S', { range: 'whole' })).files[0].added, 5);
  numstat = { killed: true };
  const other = await sc.state('S', { range: 'since-review', view: 'split' });
  assert.ok(other.notes.some((n) => n.code === 'vcs-failed'));
  assert.equal(other.files[0].added, null, 'the counts of another request are not reused');
  numstat = { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' };
  const big = await sc.state('S', { range: 'whole' });
  assert.ok(big.notes.some((n) => n.code === 'counts-unavailable'));
  assert.equal(big.notes.some((n) => n.code === 'vcs-failed'), false);
});

test('what is kept is bounded: the least recently used session falls out', async () => {
  const root = makeCheckout();
  roots.push(root);
  const { exec } = makeExec({ 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), diff: ok('') });
  const store = makeStore();
  const sessions = [];
  for (let i = 0; i < 33; i++) {
    sessions.push({ sessionId: 'S' + i, folder: 'F' + i, projectPath: root, startedAt: START });
    store.changes.set('S' + i, { files: [{ path: 'src/a.js', count: 1, first: 1, last: 2, at: at9 }], commits: [], pushes: [], truncated: false });
  }
  sc.init(makeCtx({ root, sessions, provider: makeProvider(root), exec, store }));
  const first = await sc.state('S0', {});
  for (let i = 1; i < 33; i++) await sc.state('S' + i, {});
  assert.match((await sc.diff('S0', first.files[0].id)).error, /no longer listed/, 'S0 was the least recently used');
  const last = await sc.state('S32', {});
  assert.doesNotMatch(String((await sc.diff('S32', last.files[0].id)).error), /no longer listed/);
});

test('the cut SHAs have their own lookup budget: with the budget of the marks spent, every Split block keeps its counts', async () => {
  const commits = [];
  for (let i = 1; i <= 20; i++) commits.push({ sha: 'c' + (0x100000 + i).toString(16), subject: 's' + i, branch: 'm', position: i * 10, at: at9 });
  const pushes = [
    { ok: true, summary: 'm', position: 35, at: at9 + 1, files: [['src/a.js', 1]] },
    { ok: true, summary: 'm', position: 45, at: at9 + 2, files: [['src/a.js', 2]] },
  ];
  const resolveAnswer = (args) => {
    const arg = args.find((a) => a.endsWith('^{commit}'));
    return arg ? ok(arg.slice(0, -'^{commit}'.length).padEnd(40, '0')) : { code: 1 };
  };
  const { calls } = setup({
    files: [{ path: 'src/a.js', count: 3, first: 1, last: 300, at: at9 + 5 }], commits, pushes,
    answers: { 'rev-list': ok(FULL('a')), 'cat-file': ok(''), log: ok(''), 'rev-parse': resolveAnswer, 'merge-base': ok(''), diff: ok('1\t0\tsrc/a.js\0') },
  });
  const st = await sc.state('S', { range: 'whole', view: 'split' });
  assert.equal(st.blocks.length, 3);
  for (const b of st.blocks) assert.equal(b.files[0].added, 1, `block ${b.kind} is measured`);
  assert.ok(calls.length <= sc.SPAWN_BOUND);
});
