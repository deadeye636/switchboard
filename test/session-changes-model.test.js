'use strict';
// The pure view model of the Changes group and Details (#870, spec 47): the states table, V1, the ranges (D3, V3), All and
// Split (D2), snapshot differences (D4), D6 across a lineage, the fork rule (G3), E3, E7, E8, E10 and truncation.
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/app/session-changes-model');

const day = (h, min = 0) => new Date(2026, 10, 16, h, min).getTime();
const yesterday = (h) => new Date(2026, 10, 15, h).getTime();
const NOW = day(12);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const row = (o = {}) => ({ files: o.files || [], commits: o.commits || [], pushes: o.pushes || [], truncated: !!o.truncated });
const file = (path, count, last, at) => ({ path, count, first: 0, last, at });
const commit = (sha, position, at, extra = {}) => ({ sha, subject: 'msg ' + sha, branch: 'main', position, at, ...extra });
const push = (position, at, files, extra = {}) => ({ ok: true, summary: 'main', position, at, files, ...extra });
const start = (o = {}) => ({ id: 1, kind: 'start', sessionId: 'S', position: null, at: yesterday(9), sha: SHA_A, files: null, ...o });
const clearE = (id, position, at, files, o = {}) => ({ id, kind: 'clear', sessionId: 'S', position, at, fromSha: SHA_A, toSha: SHA_B, files: { files, truncated: false }, ...o });

function input(o = {}) {
  return {
    reports: true, sessionId: 'S', order: o.order || ['S'], rows: new Map(Object.entries(o.rows || {})),
    subagents: o.subagents || [], entries: o.entries || [start()], request: o.request || {}, now: NOW,
    startedAt: yesterday(9), paths: o.paths || new Map(), facts: o.facts || {}, vcs: o.vcs === undefined ? null : o.vcs,
  };
}
const keys = (files) => files.map((f) => `${f.key}:${f.count === null ? '?' : f.count}`).sort();

test('backend does not report: one state, no figure, no rows', () => {
  const v = m.buildModel({ reports: false });
  assert.equal(v.reports, false);
  assert.equal(v.state, 'not-reported');
  assert.equal(v.figure, null);
  assert.deepEqual(v.files, []);
  assert.deepEqual(m.summaryOf({ reports: false }), { reports: false, figure: null });
});

test('nothing since the last review: no figure, no Clear, the note', () => {
  const v = m.buildModel(input({
    rows: { S: row({ files: [file('a.js', 2, 100, day(9))] }) },
    entries: [start(), clearE(2, 100, day(10), [['a.js', 2]])],
  }));
  assert.equal(v.state, 'nothing-since-review');
  assert.equal(v.figure, null);
  assert.equal(v.actions.clear, false);
  assert.ok(v.notes.some((n) => n.code === 'nothing-since-review'));
  assert.deepEqual(v.lastReview, { at: day(10), sha: SHA_B.slice(0, 7) });
});

test('edits, no commit: files with counts, no commits', () => {
  const v = m.buildModel(input({ rows: { S: row({ files: [file('a.js', 3, 50, day(9)), file('b.js', 1, 60, day(9))] }) } }));
  assert.equal(v.state, 'edits-no-commit');
  assert.deepEqual(keys(v.files), ['a.js:3', 'b.js:1']);
  assert.equal(v.commits.length, 0);
  assert.deepEqual(v.figure, { files: 2, commits: 0 });
  assert.equal(v.actions.clear, true);
});

test('commits none pushed, then pushed with the time of the last push', () => {
  const r1 = row({ files: [file('a.js', 1, 10, day(9))], commits: [commit('abc1234', 20, day(9))] });
  const v1 = m.buildModel(input({ rows: { S: r1 } }));
  assert.equal(v1.state, 'commits-not-pushed');
  assert.equal(v1.commits[0].pushed, false);
  assert.equal(v1.totals.notPushed, 1);
  const r2 = row({ ...r1, pushes: [push(30, day(10), [['a.js', 1]])] });
  const v2 = m.buildModel(input({ rows: { S: r2 }, request: { range: 'whole' } }));
  assert.equal(v2.state, 'commits-pushed');
  assert.equal(v2.commits[0].pushed, true);
  assert.equal(v2.commits[0].pushedAt, day(10));
  assert.deepEqual(v2.lastPush, { at: day(10) });
});

test('no repository, baseline gone, vcs failed and truncated are notes over the transcript list', () => {
  const rows = { S: row({ files: [file('a.js', 2, 10, day(9))], truncated: true }) };
  const noRepo = m.buildModel(input({ rows, vcs: { noRepo: true } }));
  assert.ok(noRepo.notes.some((n) => n.code === 'no-repo'));
  assert.equal(noRepo.files.length, 1);
  assert.equal(noRepo.files[0].added, null);
  const gone = m.buildModel(input({ rows, vcs: { baselineGone: true } }));
  assert.ok(gone.notes.some((n) => n.code === 'baseline-gone'));
  assert.equal(gone.actions.setReviewPointNow, true);
  assert.equal(gone.actions.clear, false);
  assert.equal(gone.files.length, 1);
  const failed = m.buildModel(input({ rows, vcs: { failed: true } }));
  assert.ok(failed.notes.some((n) => n.code === 'vcs-failed'));
  assert.ok(noRepo.notes.some((n) => n.code === 'truncated' && n.limit > 0));
});

test('V1: the figure counts since the last review whatever range is picked', () => {
  const rows = { S: row({ files: [file('a.js', 5, 100, day(11)), file('old.js', 1, 10, day(8))] }) };
  const entries = [start(), clearE(2, 50, day(9), [['a.js', 2], ['old.js', 1]])];
  const v = m.buildModel(input({ rows, entries, request: { range: 'whole' } }));
  assert.deepEqual(v.figure, { files: 1, commits: 0 });
  assert.deepEqual(keys(v.files), ['a.js:5', 'old.js:1']);
  assert.deepEqual(m.summaryOf(input({ rows, entries })).figure, { files: 1, commits: 0 });
});

test('D4: counts since a Clear are snapshot differences; a truncated snapshot leaves a file unknown', () => {
  const rows = { S: row({ files: [file('a.js', 5, 100, day(11)), file('b.js', 2, 90, day(11))] }) };
  const v = m.buildModel(input({ rows, entries: [start(), clearE(2, 50, day(10), [['a.js', 3]])] }));
  assert.deepEqual(keys(v.files), ['a.js:2', 'b.js:2']);
  const t = m.buildModel(input({ rows, entries: [start(), { ...clearE(2, 50, day(10), []), files: { files: [['a.js', 3]], truncated: true } }] }));
  assert.deepEqual(keys(t.files), ['a.js:2', 'b.js:?']);
  assert.equal(t.files.find((f) => f.key === 'b.js').unknown, true);
});

test('ranges: since-push starts at the last cutting push; whole from the start', () => {
  const rows = { S: row({
    files: [file('a.js', 4, 200, day(11))],
    commits: [commit('1111111', 20, day(8)), commit('2222222', 120, day(10))],
    pushes: [push(30, day(8, 30), [['a.js', 1]]), push(130, day(10, 30), [['a.js', 3]], { ok: false, upToDate: false })],
  }) };
  const sp = m.buildModel(input({ rows, request: { range: 'since-push' } }));
  assert.deepEqual(keys(sp.files), ['a.js:3']);
  assert.deepEqual(sp.commits.map((c) => c.sha), ['2222222']);
  const whole = m.buildModel(input({ rows, request: { range: 'whole' } }));
  assert.deepEqual(keys(whole.files), ['a.js:4']);
  assert.equal(whole.commits.length, 2);
});

test('V3: today snaps to the first entry of today, else back to the tick holding the first edit, else empty', () => {
  const rows = { S: row({ files: [file('a.js', 4, 200, day(11))], pushes: [push(30, yesterday(20), [['a.js', 1]])] }) };
  // No entry today, an edit today: snap to the last tick before it (the push of yesterday).
  const v = m.buildModel(input({ rows, request: { range: 'today' } }));
  assert.equal(v.range.fromId, 'push:S:30');
  assert.equal(v.range.todayAt, day(11));
  assert.deepEqual(keys(v.files), ['a.js:3']);
  // An entry today before the edit: start there.
  const v2 = m.buildModel(input({ rows, request: { range: 'today' }, entries: [start(), clearE(2, 100, day(9), [['a.js', 2]])] }));
  assert.equal(v2.range.fromId, 2);
  assert.deepEqual(keys(v2.files), ['a.js:2']);
  // Nothing today: empty.
  const quiet = { S: row({ files: [file('a.js', 4, 200, yesterday(11))] }) };
  const v3 = m.buildModel(input({ rows: quiet, request: { range: 'today' } }));
  assert.equal(v3.range.empty, true);
  assert.equal(v3.files.length, 0);
});

test('pick: two tick ids in either order; a pick of one tick is empty', () => {
  const rows = { S: row({ files: [file('a.js', 6, 300, day(11))] }) };
  const entries = [start(), clearE(2, 100, day(9), [['a.js', 2]]), clearE(3, 200, day(10), [['a.js', 5]])];
  const v = m.buildModel(input({ rows, entries, request: { range: 'pick', pickFrom: 3, pickTo: 2 } }));
  assert.equal(v.range.fromId, 2);
  assert.equal(v.range.toId, 3);
  assert.deepEqual(keys(v.files), ['a.js:3']);
  const one = m.buildModel(input({ rows, entries, request: { range: 'pick', pickFrom: 2, pickTo: 2 } }));
  assert.equal(one.range.empty, true);
});

test('Split: blocks end at cutting pushes (a partial push cuts, failed and up-to-date do not), newest first, Clear as a mark', () => {
  const rows = { S: row({
    files: [file('a.js', 6, 400, day(11)), file('b.js', 2, 250, day(10))],
    commits: [commit('1111111', 50, day(8)), commit('2222222', 210, day(10)), commit('3333333', 390, day(11))],
    pushes: [
      push(100, day(8, 30), [['a.js', 2]]),
      push(150, day(9), null, { ok: false }),                     // rejected: cuts nothing
      push(160, day(9, 10), null, { upToDate: true }),            // up to date: cuts nothing
      push(300, day(10, 30), [['a.js', 4], ['b.js', 2]], { ok: false, moved: true }), // partial: cuts
    ],
  }) };
  const entries = [start(), clearE(2, 200, day(9, 30), [['a.js', 3]])];
  const v = m.buildModel(input({ rows, entries, request: { range: 'whole', view: 'split' } }));
  assert.deepEqual(v.blocks.map((b) => b.kind), ['open', 'pushed', 'pushed']);
  const [open, mid, first] = v.blocks;
  assert.deepEqual(keys(open.files), ['a.js:2']);
  assert.deepEqual(open.commits.map((c) => c.sha), ['3333333']);
  assert.deepEqual(keys(mid.files), ['a.js:2', 'b.js:2']);
  assert.deepEqual(mid.marks.map((x) => x.kind), ['clear']);
  assert.deepEqual(mid.commits.map((c) => c.sha), ['2222222']);
  assert.equal(mid.commits[0].pushed, true);
  assert.deepEqual(keys(first.files), ['a.js:2']);
  // All over the same range sums them.
  const all = m.buildModel(input({ rows, entries, request: { range: 'whole', view: 'all' } }));
  assert.deepEqual(keys(all.files), ['a.js:6', 'b.js:2']);
  assert.deepEqual(all.blocks, []);
  // The pushed block is measured between the commits the pushes carried.
  const cuts = v.plan.cuts;
  assert.ok(cuts.some((c) => c.fromSha === '1111111' && c.toSha === '2222222' && !c.working));
  assert.ok(cuts.some((c) => c.fromSha === '2222222' && c.toSha === null && c.working));
});

test('a push\'s recorded SHA is the block end; a push without one falls back to the newest commit before it (#870)', () => {
  const rows = { S: row({
    files: [file('a.js', 2, 300, day(10))],
    commits: [commit('1111111', 50, day(8)), commit('2222222', 210, day(10))],
    pushes: [
      push(100, day(8, 30), [['a.js', 1]], { sha: '9999999' }), // pushed a commit this session did not record
      push(300, day(10, 30), [['a.js', 2]]),                    // no sha (new branch): the tip rule
    ],
  }) };
  const v = m.buildModel(input({ rows, request: { range: 'whole', view: 'split' } }));
  const cuts = v.plan.cuts;
  assert.ok(cuts.some((c) => c.toSha === '9999999' && !c.working));
  assert.ok(cuts.some((c) => c.fromSha === '9999999' && c.toSha === '2222222' && !c.working));
  assert.ok(cuts.some((c) => c.fromSha === '2222222' && c.toSha === null && c.working));
  // A push's SHA or tip came out of a transcript: never trusted, so the app resolves it whatever its length.
  for (const c of cuts) {
    if (c.toSha === '9999999' || c.toSha === '2222222') assert.equal(c.toTrusted, false);
    if (c.fromSha === '9999999' || c.fromSha === '2222222') assert.equal(c.fromTrusted, false);
  }
});

test('D6: a parent, its /clear child and a subagent are one timeline; a Clear in the child cuts only the child', () => {
  const rows = {
    P: row({ files: [file('a.js', 3, 100, day(8)), file('p.js', 1, 50, day(8))], commits: [commit('aaaaaaa', 90, day(8))] }),
    C: row({ files: [file('a.js', 4, 40, day(11)), file('c.js', 2, 30, day(10))] }),
    SUB_OLD: row({ files: [file('x.js', 1, 5, day(8))] }),
    SUB_NEW: row({ files: [file('a.js', 2, 9, day(11))] }),
  };
  const entries = [
    start({ sessionId: 'P' }),
    { id: 2, kind: 'cli-clear', sessionId: 'C', position: null, at: day(9), files: null },
    { id: 3, kind: 'clear', sessionId: 'C', position: 20, at: day(10, 30), toSha: SHA_B, files: { files: [['a.js', 1], ['c.js', 2]], truncated: false } },
  ];
  const subagents = [{ sessionId: 'SUB_OLD', at: day(8) }, { sessionId: 'SUB_NEW', at: day(11) }];
  const base = { order: ['P', 'C'], rows, entries, subagents };
  const review = m.buildModel(input({ ...base }));
  // Since the Clear in C: C's a.js 4-1 plus the newer subagent's 2 = 5 (E4: one row, summed); P is before, out.
  assert.deepEqual(keys(review.files), ['a.js:5']);
  const whole = m.buildModel(input({ ...base, request: { range: 'whole' } }));
  assert.deepEqual(keys(whole.files), ['a.js:9', 'c.js:2', 'p.js:1', 'x.js:1']);
  // A pick from the start to the /clear entry is the parent alone.
  const parent = m.buildModel(input({ ...base, request: { range: 'pick', pickFrom: 1, pickTo: 2 } }));
  assert.deepEqual(keys(parent.files), ['a.js:3', 'p.js:1', 'x.js:1']);
  assert.deepEqual(parent.commits.map((c) => c.sha), ['aaaaaaa']);
});

test('G3: a fork starts at its first own position, so inherited edits and commits stay out', () => {
  const rows = { F: row({
    files: [file('inherited.js', 2, 100, day(8)), file('own.js', 1, 300, day(11))],
    commits: [commit('1234567', 90, day(8)), commit('7654321', 250, day(11))],
  }) };
  const entries = [{ id: 1, kind: 'start', sessionId: 'F', position: 150, at: day(9), sha: SHA_A, files: { files: [['inherited.js', 2]], truncated: false } }];
  const v = m.buildModel(input({ order: ['F'], rows, entries, request: { range: 'whole' } }));
  assert.deepEqual(keys(v.files), ['own.js:1']);
  assert.deepEqual(v.commits.map((c) => c.sha), ['7654321']);
});

test('E3: a recorded commit not in history is marked rewritten; an amend replaces the commit before it', () => {
  const rows = { S: row({ commits: [commit('1111111', 10, day(9)), commit('2222222', 20, day(9), { amend: true }), commit('3333333', 30, day(10))] }) };
  const v = m.buildModel(input({ rows, vcs: { inHistory: new Map([['2222222', true], ['3333333', false]]) } }));
  assert.deepEqual(v.commits.map((c) => [c.sha, c.rewritten]), [['3333333', true], ['2222222', false]]);
  assert.equal(v.totals.notPushed, 1);
});

test('E8, E10, E7 and line counts attach to the file rows by key', () => {
  const rows = { S: row({ files: [file('/repo/src/a.js', 2, 10, day(9)), file('src/a.js', 1, 20, day(9)), file('/elsewhere/x.js', 1, 30, day(9))] }) };
  const paths = new Map([
    ['/repo/src/a.js', { key: 'src/a.js', outside: false }],
    ['src/a.js', { key: 'src/a.js', outside: false }],
    ['/elsewhere/x.js', { key: '../elsewhere/x.js', outside: true }],
  ]);
  const facts = {
    outside: new Set(['../elsewhere/x.js']), untracked: new Set(), editedByOthers: new Map([['src/a.js', 1]]),
    statusKeys: ['src/a.js', 'README.md', 'other.txt'],
  };
  const first = m.buildModel(input({ rows, paths, facts }));
  const allId = first.plan.cuts[0].id;
  const numstat = new Map([[allId, new Map([['src/a.js', { added: 7, deleted: 2, binary: false }], ['README.md', { added: 1, deleted: 0 }]])]]);
  const v = m.buildModel(input({ rows, paths, facts, vcs: { numstat, otherCommits: 1 } }));
  const a = v.files.find((f) => f.key === 'src/a.js');
  assert.equal(a.count, 3);
  assert.equal(a.otherSessions, 1);
  assert.equal(a.added, 7);
  const x = v.files.find((f) => f.key === '../elsewhere/x.js');
  assert.equal(x.outside, true);
  assert.equal(x.added, null);
  assert.equal(v.otherChanged, 2);           // README.md and other.txt: nobody in this lineage edited them
  assert.equal(v.totals.otherCommits, 1);
  assert.equal(v.files.some((f) => f.key === 'README.md'), false);   // a shared tree lists only this session's files
});

test('timeline: one tick per entry and cutting push, a derived today tick, now; the range is marked', () => {
  const rows = { S: row({ files: [file('a.js', 3, 200, day(11))], pushes: [push(100, day(10), [['a.js', 1]])] }) };
  const t = m.timeline(input({ rows, entries: [start(), clearE(2, 150, day(10, 30), [['a.js', 2]])] }));
  assert.deepEqual(t.ticks.map((x) => x.kind), ['start', 'today', 'push', 'clear', 'now']);
  assert.equal(t.ticks.find((x) => x.kind === 'today').at, day(10));
  assert.deepEqual(t.ticks.filter((x) => x.inRange).map((x) => x.kind), ['clear', 'now']);
});

test('cleanRequest falls back to Since last review and All (V4)', () => {
  assert.deepEqual(m.cleanRequest({ range: 'bogus', view: 'x' }), { range: 'since-review', view: 'all', pickFrom: null, pickTo: null });
  assert.deepEqual(m.cleanRequest({ range: 'pick', pickFrom: 3, pickTo: 'push:S:4' }).pickTo, 'push:S:4');
});

test('V3 to the letter: a tick today starts the range even when an edit came first; no tick today flags an approximate start', () => {
  const rows = { S: row({ files: [file('a.js', 4, 200, day(11))], pushes: [push(30, yesterday(20), [['a.js', 1]])] }) };
  const withTick = m.buildModel(input({ rows, request: { range: 'today' }, entries: [start(), clearE(2, 100, day(11, 30), [['a.js', 2]])] }));
  assert.equal(withTick.range.fromId, 2);
  assert.equal(withTick.range.approxStart, false);
  assert.deepEqual(keys(withTick.files), ['a.js:2']);
  const noTick = m.buildModel(input({ rows, request: { range: 'today' } }));
  assert.equal(noTick.range.fromId, 'push:S:30');
  assert.equal(noTick.range.approxStart, true);
});

test('a gone start of a range other than "Since last review" has its own note and no Set review point to now', () => {
  const rows = { S: row({ files: [file('a.js', 2, 10, day(9))] }) };
  const v = m.buildModel(input({ rows, request: { range: 'whole' }, vcs: { baselineGone: true } }));
  assert.ok(v.notes.some((n) => n.code === 'range-start-gone'));
  assert.equal(v.notes.some((n) => n.code === 'baseline-gone'), false);
  assert.equal(v.actions.setReviewPointNow, false);
  const c = m.buildModel(input({ rows, vcs: { countsCapped: true } }));
  assert.ok(c.notes.some((n) => n.code === 'counts-unavailable'));
});

test('row ids are content-derived: the same file in the same cut keeps its id; the plan reads All, then the newest blocks', () => {
  const rows = { S: row({
    files: [file('a.js', 3, 300, day(11))], commits: [commit('1111111', 50, day(8)), commit('2222222', 150, day(9))],
    pushes: [push(100, day(8, 30), [['a.js', 1]]), push(200, day(9, 30), [['a.js', 2]])],
  }) };
  const a = m.buildModel(input({ rows, request: { range: 'whole', view: 'split' } }));
  const b = m.buildModel(input({ rows, request: { range: 'whole', view: 'split' }, entries: [start(), clearE(9, 300, day(12), [['a.js', 3]])] }));
  assert.equal(a.blocks[1].files[0].id, b.blocks[1].files[0].id, 'a later tick does not rename an older cut');
  assert.notEqual(a.files[0].id, a.blocks[0].files[0].id);
  assert.equal(a.commits[0].id, 'c:2222222');
  assert.deepEqual(a.plan.cuts.map((c) => c.id), ['1..now', 'push:S:200..now', 'push:S:100..push:S:200', '1..push:S:100']);
});
