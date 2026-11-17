'use strict';
// #870, spec 47 section 6: the Changes group of the session sidebar. The pure half (lib/session-changes-rows.js): the head
// figure, the state selection (one case per row of the spec's states table), the row model and its markup. The surface
// half runs the real sidebar in jsdom with a faked API: what a closed group reads, and where the subscription starts and ends.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');

const {
  changesHeadFigure, changesStateOf, changesRowModel, changesRowIndex, changesRowHtml, changesModelHtml, changesClearedText,
  CHANGES_LIST_CAP,
} = require('../src/renderer/lib/session-changes-rows');
const { setupSessionSidebar: setup, closeSessionSidebarWindows } = require('./helpers/session-sidebar-dom');

after(closeSessionSidebarWindows);

const fmt = (at) => `t${at}`;
const file = (over = {}) => ({ id: 'f:1', key: 'src/retry.js', count: 4, unknown: false, isNew: false, outside: false, otherSessions: 0, ...over });
const commit = (over = {}) => ({ id: 'c:aaa', sha: '5ab90e1', rawSha: '5ab90e1aaaa', subject: 'Extract the backoff', pushed: false, rewritten: false, ...over });
const view = (over = {}) => ({
  ok: true, reports: true, request: { range: 'since-review', view: 'all' }, view: 'all', state: 'edits-no-commit', notes: [],
  actions: { clear: true, setReviewPointNow: false }, files: [file()], commits: [], blocks: [], totals: { notPushed: 0 },
  figure: { files: 1, commits: 0 }, lastPush: null, lastReview: null, ...over,
});

test('the head figure counts files and commits, and says nothing rather than 0', () => {
  assert.equal(changesHeadFigure({ ok: true, reports: true, figure: { files: 2, commits: 1 } }), '2 files \u00b7 1 commit');
  assert.equal(changesHeadFigure({ ok: true, reports: true, figure: { files: 1, commits: 0 } }), '1 file');
  assert.equal(changesHeadFigure({ ok: true, reports: true, figure: { files: 0, commits: 3 } }), '3 commits');
  assert.equal(changesHeadFigure({ ok: true, reports: true, figure: null }), '');
  assert.equal(changesHeadFigure({ ok: true, reports: false, figure: { files: 2, commits: 1 } }), '', 'a CLI that does not report has no figure');
  assert.equal(changesHeadFigure({ ok: false }), '');
  assert.equal(changesHeadFigure(null), '');
});

test('state selection: every row of the spec\'s states table has its one line', () => {
  const text = (v) => changesStateOf(v).notes.map((n) => n.text);
  // Backend does not report: one sentence, no controls, no figure.
  const nr = changesStateOf({ ok: true, reports: false, state: 'not-reported', notes: [{ code: 'not-reported' }] });
  assert.equal(nr.kind, 'not-reported');
  assert.deepEqual([nr.controls, nr.details, nr.clear], [false, false, false]);
  assert.deepEqual(nr.notes.map((n) => n.text), ['This CLI does not report which files it changed.']);
  // Nothing since the last review: the sentence, the controls stay (D5), no Clear.
  const nothing = changesStateOf(view({ state: 'nothing-since-review', notes: [{ code: 'nothing-since-review' }], files: [], figure: null, actions: { clear: false } }));
  assert.deepEqual(nothing.notes.map((n) => n.text), ['Nothing since the last review.']);
  assert.deepEqual([nothing.controls, nothing.clear, nothing.lists], [true, false, false]);
  // Nothing in a wider range.
  assert.deepEqual(text(view({ state: 'nothing-in-range', files: [] })), ['Nothing in this range.']);
  // No repository, git failed, baseline gone, range start gone, truncated.
  assert.deepEqual(text(view({ notes: [{ code: 'no-repo' }] })), ['No repository: diffs are not available.']);
  assert.deepEqual(text(view({ notes: [{ code: 'vcs-failed' }] })), ['Version control could not be read. Showing the last good view.']);
  assert.match(text(view({ notes: [{ code: 'baseline-gone' }] }))[0], /review point is no longer in this repository.s history/);
  assert.match(text(view({ notes: [{ code: 'range-start-gone' }] }))[0], /start of this range is no longer/);
  assert.deepEqual(text(view({ notes: [{ code: 'truncated', limit: 500 }] })), ['Only the first 500 files are listed.']);
  // A gone review point offers Set review point to now and no Clear.
  const gone = changesStateOf(view({ notes: [{ code: 'baseline-gone' }], actions: { clear: false, setReviewPointNow: true } }));
  assert.deepEqual([gone.clear, gone.setReviewPoint], [false, true]);
  // The sentence naming the state comes first; a failure note never shows git's own text.
  assert.equal(text(view({ state: 'nothing-since-review', notes: [{ code: 'vcs-failed' }, { code: 'nothing-since-review' }] }))[0], 'Nothing since the last review.');
  assert.deepEqual(text(view({ notes: [{ code: 'something-new' }] })), [], 'an unknown code says nothing rather than throwing');
  // A failed ask is one line and no controls.
  const failed = changesStateOf({ ok: false, error: 'C:\\secret\\path' });
  assert.deepEqual(failed.notes, [{ tone: 'warn', text: 'The changes could not be read.' }]);
  assert.equal(failed.controls, false);
});

test('rows: a file is its folder dimmed and its name, with new, other sessions and edits in the meta', () => {
  const m = changesRowModel(view({
    files: [file({ isNew: true }), file({ id: 'f:2', key: 'notes.md', count: 1, otherSessions: 2 }), file({ id: 'f:3', key: '/elsewhere/x.js', outside: true, count: null, unknown: true })],
  }), { fmt });
  const [a, b, c] = m.files.rows;
  assert.deepEqual([a.dir, a.name, a.meta], ['src/', 'retry.js', 'new \u00b7 4 edits']);
  assert.deepEqual([b.dir, b.name, b.meta], ['', 'notes.md', '+2 sessions \u00b7 1 edit']);
  assert.equal(c.meta, 'outside this checkout \u00b7 edits unknown');
  assert.deepEqual(a.actions, ['open', 'copy']);
  assert.deepEqual(c.actions, ['copy'], 'a path outside the checkout is listed and never opened from here');
  assert.equal(m.files.head, 'Files \u00b7 3');
});

test('rows: a commit shows its subject, the short SHA and not pushed / pushed / rewritten', () => {
  const m = changesRowModel(view({ commits: [commit(), commit({ id: 'c:b', pushed: true }), commit({ id: 'c:c', rewritten: true })] }), { fmt });
  assert.deepEqual(m.commits.rows.map((r) => r.mark.text), ['not pushed', 'pushed', 'rewritten']);
  const r = m.commits.rows[0];
  assert.deepEqual([r.name, r.meta, r.insert, r.copy, r.actions], ['Extract the backoff', '5ab90e1', '5ab90e1', '5ab90e1', ['copy']]);
});

test('context lines and the last push footer', () => {
  const v = view({ commits: [commit()], totals: { notPushed: 1 }, lastPush: { at: 41 }, lastReview: { at: 58, sha: '2c7e4d0' } });
  const m = changesRowModel(v, { fmt });
  assert.equal(m.context, 'Since Clear t58 \u00b7 2c7e4d0');
  assert.equal(m.footer, 'Last push t41 \u00b7 1 commit not pushed');
  assert.equal(changesRowModel(view({ request: { range: 'today', view: 'all' } }), { fmt }).context, 'Today');
  const gone = view({ state: 'nothing-since-review', files: [], notes: [{ code: 'nothing-since-review' }], lastReview: { at: 63 } });
  assert.equal(changesRowModel(gone, { fmt, now: 64 }).context, 'Reviewed today t63');
  assert.match(changesRowModel(gone, { fmt, now: 3 * 86400000 }).context, /^Reviewed .+ t63$/, 'another day names the day, not "today"');
});

test('a long list is cut and says how many are left', () => {
  const many = Array.from({ length: CHANGES_LIST_CAP + 5 }, (_, i) => file({ id: `f:${i}`, key: `a/${i}.js` }));
  const m = changesRowModel(view({ files: many }), { fmt });
  assert.equal(m.files.rows.length, CHANGES_LIST_CAP);
  assert.equal(m.files.more, 5);
  assert.match(changesModelHtml(m), /5 more in Details/);
});

test('Split: the newest block is open on top, older ones fold, the user\'s choice survives a redraw', () => {
  const block = (id, kind, extra = {}) => ({ id, kind, push: kind === 'pushed' ? { at: 41 } : null, marks: [], files: [file({ id: `f:${id}` })], commits: [], totals: { files: 1, commits: 0 }, empty: false, ...extra });
  const v = view({ view: 'split', request: { range: 'today', view: 'split' }, files: [], blocks: [block('b1', 'open', { marks: [{ id: 'k', kind: 'clear', at: 58 }] }), block('b2', 'pushed'), block('b3', 'pushed')] });
  const first = changesRowModel(v, { fmt });
  assert.deepEqual(first.blocks.map((b) => b.open), [true, false, false]);
  assert.equal(first.blocks[0].title, 'Not pushed yet');
  assert.equal(first.blocks[1].title, 'Push t41');
  assert.deepEqual(first.blocks[0].edges, [{ kind: 'clear', text: 'Clear t58' }]);
  // A redraw: b1 was folded by the user, b3 opened; a block that is new is open only when it is the newest.
  const again = changesRowModel(v, { fmt, seen: new Set(['b1', 'b2', 'b3']), open: new Set(['b3']) });
  assert.deepEqual(again.blocks.map((b) => b.open), [false, false, true]);
  const html = changesModelHtml(first);
  assert.equal((html.match(/<details class="ssb-sublist ssb-block"/g) || []).length, 3);
  assert.equal((html.match(/ssb-block" data-block="b1" open/g) || []).length, 1);
  assert.equal(changesRowIndex(first).size, 3, 'every row is found by its key');
});

test('markup: text somebody else wrote is escaped, the controls reuse the sidebar\'s own classes', () => {
  const evil = '<img src=x onerror=1>';
  const m = changesRowModel(view({ files: [file({ key: `a"b/${evil}.js` })], commits: [commit({ subject: evil })], request: { range: 'whole', view: 'split' } }), { fmt });
  const html = changesModelHtml(m);
  assert.ok(!html.includes('<img'), 'no raw tag from a path or a subject');
  assert.ok(html.includes('&lt;img'));
  assert.ok(changesRowHtml(m.commits.rows[0]).includes('aria-label="Copy SHA'), 'a commit offers Copy SHA');
  assert.match(html, /<select class="ssb-sort ssb-changes-range"/);
  assert.match(html, /<option value="whole" selected>/);
  assert.match(html, /data-view="split"[^>]*aria-pressed="true"/);
  assert.match(html, /data-view="all"[^>]*aria-pressed="false"/);
  assert.ok(!/<button(?![^>]*class=)/.test(html), 'no bare button');
});

test('the buttons under the lists: Details always, Clear only with something to review, Set review point when it is gone', () => {
  const some = changesModelHtml(changesRowModel(view(), { fmt }));
  assert.match(some, /data-ssb="changes-details"/);
  assert.match(some, /data-ssb="changes-clear"(?![^>]*data-missing)/);
  const nothing = changesModelHtml(changesRowModel(view({ state: 'nothing-since-review', files: [], notes: [{ code: 'nothing-since-review' }], actions: { clear: false } }), { fmt }));
  assert.match(nothing, /changes-details/);
  assert.ok(!/changes-clear/.test(nothing));
  const gone = changesModelHtml(changesRowModel(view({ notes: [{ code: 'baseline-gone' }], actions: { clear: false, setReviewPointNow: true } }), { fmt }));
  assert.match(gone, /data-ssb="changes-clear" data-missing="1"/);
  assert.match(gone, /Set review point to now/);
  const nr = changesModelHtml(changesRowModel({ ok: true, reports: false, notes: [{ code: 'not-reported' }] }, { fmt }));
  assert.ok(!/changes-details|ssb-ctl|<select/.test(nr), 'a CLI that does not report gets one sentence');
});

test('what Clear says in the toast', () => {
  assert.equal(changesClearedText({ figure: { files: 2, commits: 1 } }), 'Marked as reviewed: 2 files, 1 commit.');
  assert.equal(changesClearedText(null), 'Marked as reviewed.');
});

// --- The surface, in jsdom. ---

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('the group is the second in the default order and closed unless the stored state opens it', () => {
  const { SESSION_SIDEBAR_GROUP_NAMES } = require('../src/renderer/lib/sidebar-groups');
  assert.deepEqual(SESSION_SIDEBAR_GROUP_NAMES.slice(0, 2).map((g) => g.id), ['repository', 'changes']);
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/session/session-sidebar.js'), 'utf8');
  assert.ok(!/SESSION_SIDEBAR_OPEN_GROUPS = \[[^\]]*changes/.test(src), 'E6: closed by default');
});

test('open and shown: one read, the subscription starts; closing, hiding and closing the sidebar end it', async () => {
  const h = setup();
  await flush(); await flush();
  assert.ok(h.calls.reads.includes('changes'), 'the open group reads');
  assert.deepEqual(h.calls.follows, ['follow']);
  const section = h.root().querySelector('.ssb-group[data-group="changes"]');
  // Closing the group.
  section.open = false;
  await flush();
  assert.deepEqual(h.calls.follows, ['follow', 'unfollow']);
  // Opening it again reads again and follows again.
  h.calls.reads.length = 0;
  section.open = true;
  await flush(); await flush();
  assert.ok(h.calls.reads.includes('changes'));
  assert.equal(h.calls.follows.at(-1), 'follow');
  // Hiding it.
  h.run('applySidebarHidden(__entry, ["changes"])');
  assert.equal(h.calls.follows.at(-1), 'unfollow');
  // Closing the sidebar while it follows.
  h.run('applySidebarHidden(__entry, [])');
  await flush(); await flush();
  assert.equal(h.calls.follows.at(-1), 'follow');
  h.run('hideSidebar(__entry)');
  assert.equal(h.calls.follows.at(-1), 'unfollow');
});

test('the toggle keeps the view per session and reads again; Clear asks main and reads again', async () => {
  const h = setup();
  await flush(); await flush();
  const kept = [];
  const cleared = [];
  h.w.api.sessionChangesView = (id, value) => { kept.push([id, JSON.parse(JSON.stringify(value))]); return Promise.resolve({ ok: true }); };
  h.w.api.sessionChangesClear = (id, opts) => { cleared.push([id, JSON.parse(JSON.stringify(opts))]); return Promise.resolve({ ok: true }); };
  h.calls.reads.length = 0;
  h.root().querySelector('[data-ssb="changes-view"][data-view="split"]').click();
  await flush(); await flush();
  assert.deepEqual(kept, [['s1', { range: 'since-review', view: 'split' }]]);
  assert.ok(h.calls.reads.includes('changes'), 'the group reads again');
  h.run('sidebarChangesClear(__entry, false)');
  await flush(); await flush();
  assert.deepEqual(cleared, [['s1', { missing: false }]]);
});

const OPEN_ANSWER = { ok: true, reports: true, state: 'nothing-since-review', request: { range: 'since-review', view: 'all' }, notes: [{ code: 'nothing-since-review' }], actions: {}, files: [], commits: [], blocks: [], figure: null };

test('a closed group reads only the header figure, from the summary; a figure of nothing is not drawn', async () => {
  const h = setup({ openGroups: ['repository'] });
  await flush();
  assert.ok(!h.calls.reads.includes('changes'), 'no state read, so no git');
  assert.deepEqual(h.calls.summaries, ['s1']);
  assert.deepEqual(h.calls.follows, []);
  assert.equal(h.root().querySelector('.ssb-group[data-group="changes"] > summary > .ssb-group-figure').textContent, '2 files · 1 commit');
});

test('a read that is still out when the group closes or hides leaves nothing followed', async () => {
  const late = deferred();
  const h = setup({ changesAnswer: () => late.promise });
  await flush();
  assert.ok(h.calls.reads.includes('changes'));
  h.root().querySelector('.ssb-group[data-group="changes"]').open = false;
  await flush();
  late.resolve(OPEN_ANSWER);
  await flush();
  assert.deepEqual(h.calls.follows, [], 'closed meanwhile: main is not asked to follow');
  // The same for hiding.
  const slow = deferred();
  const g = setup({ changesAnswer: () => slow.promise });
  await flush();
  g.run('applySidebarHidden(__entry, ["changes"])');
  slow.resolve(OPEN_ANSWER);
  await flush();
  assert.deepEqual(g.calls.follows, []);
});

test('a follow that is still out when the group closes is undone when it lands; a refused follow is not recorded', async () => {
  const out = deferred();
  const h = setup({ followAnswer: () => out.promise });
  await flush();
  assert.deepEqual(h.calls.follows, ['follow']);
  h.root().querySelector('.ssb-group[data-group="changes"]').open = false;
  await flush();
  assert.deepEqual(h.calls.follows, ['follow'], 'nothing recorded yet, so nothing to end yet');
  out.resolve({ ok: true });
  await flush();
  assert.deepEqual(h.calls.follows, ['follow', 'unfollow'], 'it lands on a closed group and is ended');
  assert.equal(h.calls.changesListener, null, 'the window\'s one subscription is given back');
  // Main refuses: the group is open and nothing is recorded, so closing it ends nothing.
  const r = setup({ followAnswer: () => ({ ok: false }) });
  await flush();
  r.root().querySelector('.ssb-group[data-group="changes"]').open = false;
  await flush();
  assert.deepEqual(r.calls.follows, ['follow']);
});

test('a re-key unfollows the old id and follows the new one; a push is matched against what main follows', async () => {
  const h = setup();
  await flush();
  assert.deepEqual(h.calls.followIds, ['s1']);
  // As `rekeySessionState` does it: the sidebar is told first, the entry and its session object move right after.
  h.run('rekeySessionSidebar("s1", "s2"); openSessions.delete("s1"); __entry.session.sessionId = "s2"; openSessions.set("s2", __entry);');
  await flush();
  assert.deepEqual(h.calls.follows, ['follow', 'unfollow', 'follow']);
  assert.deepEqual(h.calls.followIds, ['s1', 's1', 's2']);
  assert.equal(h.calls.subscriptions, 1, 'one subscription however many follows');
});

test('main\'s notice re-asks only for the followed session', async () => {
  const h = setup();
  await flush();
  h.calls.reads.length = 0;
  h.calls.changesListener({ sessionId: 'other' });
  await flush();
  assert.ok(!h.calls.reads.includes('changes'), 'another session: nothing');
  h.calls.changesListener({ sessionId: 's1' });
  await flush();
  assert.deepEqual(h.calls.reads.filter((g) => g === 'changes'), ['changes'], 'this session: one read');
});

test('a figure asked too soon is held back and one trailing ask follows; the tab teardown ends the subscription', async () => {
  const h = setup({ openGroups: ['repository'] });
  await flush();
  const asked = h.calls.summaries.length;
  h.run('sessionSidebarSessionsChanged(); sessionSidebarSessionsChanged();');
  assert.equal(h.calls.summaries.length, asked, 'held back inside the window');
  assert.ok(h.entry.sidebarChangesFigureTimer, 'one trailing ask is scheduled');
  h.run('hideSidebar(__entry)');
  assert.equal(h.entry.sidebarChangesFigureTimer, null, 'closing the sidebar cancels it');
  const fs = require('node:fs');
  const path = require('node:path');
  const tm = fs.readFileSync(path.join(__dirname, '../src/renderer/terminal/terminal-manager.js'), 'utf8');
  assert.match(tm, /sidebarUnfollowChanges\(entry\)/, 'the tab teardown ends the Changes subscription');
});

test('a sidebar out of view does not ask for the figure; it asks when it comes back', async () => {
  const h = setup({ openGroups: ['repository'] });
  await flush();
  h.calls.summaries.length = 0;
  h.element.classList.add('grid-mode');   // a grid card holds the session and hides its sidebar
  h.run('sidebarChangesFigureAt.delete(__entry); sessionSidebarSessionsChanged();');
  assert.deepEqual(h.calls.summaries, []);
  assert.equal(h.entry.sidebarChangesFigureStale, true);
});

test('a hidden group reads nothing and does not follow', async () => {
  const h = setup({ hidden: ['changes'] });
  await flush(); await flush();
  assert.ok(!h.calls.reads.includes('changes'));
  assert.deepEqual(h.calls.follows, []);
});
