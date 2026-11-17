'use strict';

// The Details page's key paths (#870, spec 47 section 7) in jsdom against a fake `window.api`: what it draws from a view
// model, that every text is escaped, that a row click reads its diff by row id, that a large diff offers the side-by-side
// window by row id, that "Pick entries" is two clicks on the strip, where it lands when opened at a row, and that it follows
// its session and lets go when the page goes. The window's own lifecycle is `test/session-changes-window.test.js`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const plain = (x) => JSON.parse(JSON.stringify(x));   // jsdom's arrays and objects live in another realm
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i++) await flush(); }

const TICKS = [
  { id: 'start', kind: 'start', at: Date.now() - 3 * 3600e3, sha: 'aaaaaaa', implicit: false },
  { id: 'push:S:10', kind: 'push', at: Date.now() - 2 * 3600e3, sha: 'bbbbbbb', implicit: false },
  { id: 'e:7', kind: 'clear', at: Date.now() - 3600e3, sha: 'ccccccc', implicit: false },
];

function viewModel(extra = {}) {
  return {
    ok: true, reports: true, request: { range: 'whole', view: 'all', pickFrom: null, pickTo: null },
    range: { kind: 'whole', empty: false, fromId: 'start', toId: null, approxStart: false },
    view: 'all', state: 'commits-not-pushed', notes: [], actions: { clear: true, setReviewPointNow: false },
    figure: { files: 2, commits: 1 },
    files: [
      { id: 'f:1', key: 'src/<b>x</b>.js', count: 3, unknown: false, isNew: false, outside: false, otherSessions: 1, added: 5, deleted: 2, binary: false },
      { id: 'f:2', key: 'notes.md', count: 1, unknown: false, isNew: true, outside: false, otherSessions: 0, added: null, deleted: null, binary: false },
    ],
    commits: [{ id: 'c:abc', sha: 'abc1234', subject: 'Fix <img src=x onerror=1>', at: Date.now(), pushed: false, rewritten: false }],
    blocks: [], totals: { files: 2, commits: 1, notPushed: 1, edits: 4, added: 5, deleted: 2, otherCommits: 2 },
    lastPush: null, lastReview: null, otherChanged: 3, footer: { baseSha: 'aaaaaaa' }, ticks: TICKS, ...extra,
  };
}

function load({ at = {}, view = viewModel(), diff = { ok: true, kind: 'file', text: '@@ -1 +1 @@\n-a\n+b\n' } } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(RENDERER, 'session-changes.html'), 'utf8'), {
    url: 'http://localhost/session-changes.html?session=S&label=proj&at=' + encodeURIComponent(JSON.stringify(at)),
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = { view: [], details: [], diff: [], open: [], follow: [], unfollow: [], clear: [] };
  const listeners = { updated: null, at: null };
  let kept = { range: 'whole', view: 'all', pickFrom: null, pickTo: null };
  window.api = {
    sessionChangesView: async (id, value) => { if (value === undefined) return kept; calls.view.push(value); kept = value; return { ok: true }; },
    sessionChangesDetails: async (id, opts) => { calls.details.push(opts); return typeof view === 'function' ? view(opts) : view; },
    sessionChangesDiff: async (id, row) => { calls.diff.push(row); return typeof diff === 'function' ? diff(row) : diff; },
    sessionChangesOpenDiffWindow: async (id, row) => { calls.open.push([id, row]); return { ok: true }; },
    sessionChangesClear: async (id, o) => { calls.clear.push(o); return { ok: true }; },
    sessionChangesFollow: async (id) => { calls.follow.push(id); return { ok: true }; },
    sessionChangesUnfollow: (id) => { calls.unfollow.push(id); },
    onSessionChangesUpdated: (cb) => { listeners.updated = cb; return () => { listeners.updated = null; }; },
    onSessionChangesDetailsAt: (cb) => { listeners.at = cb; return () => {}; },
  };
  for (const file of ['lib/session-changes-rows.js', 'diff-render.js', 'session-changes.js']) {
    window.eval(fs.readFileSync(path.join(RENDERER, file), 'utf8'));
  }
  return { window, document: window.document, calls, listeners };
}

test('draws the sections, the strip and the notes of the view model, escaped', async () => {
  const { document } = load();
  await settle();
  const body = document.getElementById('body');
  assert.equal(body.querySelectorAll('.file').length, 2);
  assert.equal(body.querySelectorAll('.commit').length, 1);
  assert.ok(!body.innerHTML.includes('<b>x</b>') && !body.innerHTML.includes('<img'), 'paths and subjects are text, not markup');
  assert.match(body.textContent, /Fix <img src=x onerror=1>/);
  assert.match(body.textContent, /\+ 2 other commits in this range, not made by this session/);
  assert.match(body.textContent, /3 other files changed in this working tree, not by this session/);
  assert.equal(document.querySelectorAll('.strip .tick').length, TICKS.length + 1, 'one tick per entry plus the present');
  assert.equal(document.getElementById('clear').hidden, false);
  assert.match(document.getElementById('foot').textContent, /aaaaaaa/);
});

test('a state with nothing to draw says its sentence and offers no Clear', async () => {
  const { document } = load({ view: { ok: true, reports: false, request: { range: 'since-review', view: 'all' }, notes: [{ code: 'not-reported' }] } });
  await settle();
  assert.match(document.getElementById('body').textContent, /does not report which files/);
  assert.equal(document.getElementById('clear').hidden, true);
  assert.equal(document.getElementById('strip-host').innerHTML, '');
});

test('a row click reads the diff by row id; a large diff offers the window, by row id', async () => {
  const big = Array.from({ length: 250 }, (_, i) => '+line ' + i).join('\n');
  const { document, calls } = load({ diff: { ok: true, kind: 'file', text: big } });
  await settle();
  document.querySelector('.file[data-id="f:1"]').click();
  await settle();
  assert.deepEqual(plain(calls.diff), ['f:1']);
  const pane = document.querySelector('.diff-pane[data-for="f:1"]');
  assert.ok(pane.querySelector('.diff-pre'), 'coloured diff drawn');
  pane.querySelector('button.diff-expand').click();
  await settle();
  assert.deepEqual(plain(calls.open), [['S', 'f:1']]);
  document.querySelector('.file[data-id="f:1"]').click();     // closing it again
  await settle();
  assert.equal(document.querySelector('.diff-pane'), null);
});

test('a commit row shows the commit, a refusal shows main’s sentence', async () => {
  const { document } = load({ diff: (row) => (row.startsWith('c:')
    ? { ok: true, kind: 'commit', commit: { sha: 'abc1234', time: Date.now(), subject: 'S<1>', body: 'why' } }
    : { ok: false, error: 'This item is no longer listed. Refresh and try again.' }) });
  await settle();
  document.querySelector('.commit').click();
  await settle();
  assert.match(document.querySelector('.diff-pane').textContent, /S<1>/);
  document.querySelector('.file[data-id="f:2"]').click();
  await settle();
  assert.match(document.querySelector('.diff-pane[data-for="f:2"]').textContent, /no longer listed/);
});

test('opened at a row (at.id): that row is selected and its diff read', async () => {
  const { document, calls } = load({ at: { id: 'f:2' } });
  await settle();
  const row = document.querySelector('.file[data-id="f:2"]');
  assert.ok(row.classList.contains('selected'));
  assert.deepEqual(plain(calls.diff), ['f:2']);
});

test('opened with at.pick starts in pick mode; two ticks keep a picked range and ask again', async () => {
  const { document, calls } = load({ at: { pick: true } });
  await settle();
  assert.match(document.getElementById('strip-host').textContent, /click the first and then the last entry/);
  const tick = (id) => document.querySelector('.tick[data-tick="' + id + '"]');
  tick('push:S:10').click();
  await settle();
  assert.match(document.getElementById('strip-host').textContent, /other end/);
  tick('e:7').click();
  await settle();
  assert.deepEqual(plain(calls.view.at(-1)), { range: 'pick', view: 'all', pickFrom: 'push:S:10', pickTo: 'e:7' });
  assert.equal(calls.details.at(-1).range, 'pick', 'asked again with the pick');
  assert.doesNotMatch(document.getElementById('strip-host').textContent, /other end/);
});

test('the present is the open end of a pick, whichever order the two clicks come in', async () => {
  const { document, calls } = load();
  await settle();
  const tick = (id) => document.querySelector('.tick[data-tick="' + id + '"]');
  tick('__now__').click();
  await settle();
  tick('push:S:10').click();
  await settle();
  assert.deepEqual(plain(calls.view.at(-1)), { range: 'pick', view: 'all', pickFrom: 'push:S:10', pickTo: null });
});

test('the range select and the All / Split toggle are kept through sessionChangesView and read again', async () => {
  const { window, document, calls } = load();
  await settle();
  const select = document.getElementById('range');
  select.value = 'today';
  select.dispatchEvent(new window.Event('change'));
  await settle();
  assert.deepEqual(plain(calls.view.at(-1)), { range: 'today', view: 'all', pickFrom: null, pickTo: null });
  document.querySelector('#views button[data-view="split"]').click();
  await settle();
  assert.equal(calls.view.at(-1).view, 'split');
  assert.equal(calls.details.at(-1).view, 'split');
});

test('it follows its session, reads again on a notice for that session only, and lets go with the page', async () => {
  const { window, calls, listeners } = load();
  await settle();
  assert.deepEqual(plain(calls.follow), ['S']);
  const before = calls.details.length;
  listeners.updated({ sessionId: 'other' });
  await settle();
  assert.equal(calls.details.length, before);
  listeners.updated({ sessionId: 'S' });
  await settle();
  assert.equal(calls.details.length, before + 1);
  window.dispatchEvent(new window.Event('pagehide'));
  assert.deepEqual(plain(calls.unfollow), ['S']);
  assert.equal(listeners.updated, null, 'the subscription is given back');
});

test('a pick keeps the entries’ own ids: a stored entry’s id is a number, and the DOM only hands back text', async () => {
  const numeric = [
    { id: 1, kind: 'start', at: Date.now() - 4 * 3600e3, sha: 'aaaaaaa' },
    { id: 3, kind: 'clear', at: Date.now() - 3 * 3600e3, sha: 'bbbbbbb' },
    { id: 4, kind: 'clear', at: Date.now() - 2 * 3600e3, sha: 'ccccccc' },
  ];
  const { document, calls } = load({ view: viewModel({ ticks: numeric, range: { kind: 'whole', empty: false, fromId: 1, toId: null } }) });
  await settle();
  const tick = (id) => document.querySelector('.tick[data-tick="' + id + '"]');
  tick('4').click();
  await settle();
  assert.ok(document.querySelector('.tick.picked'), 'the first tick stays marked as picked');
  tick('1').click();
  await settle();
  const written = plain(calls.view.at(-1));
  assert.deepEqual(written, { range: 'pick', view: 'all', pickFrom: 1, pickTo: 4 });
  assert.equal(typeof written.pickFrom, 'number');
});

test('the derived "today" tick is a marker, not something to pick', async () => {
  const view = viewModel({ range: { kind: 'today', empty: false, fromId: 'push:S:10', toId: null, todayAt: TICKS[1].at - 1000 } });
  const { document, calls } = load({ view });
  await settle();
  const marker = document.querySelector('.tick.marker');
  assert.ok(marker);
  assert.equal(marker.tagName, 'SPAN');
  assert.equal(marker.dataset.tick, undefined);
  marker.click();
  await settle();
  assert.equal(document.querySelector('.tick.picked'), null);
  assert.equal(calls.view.length, 0);
});

test('a window already open is pointed at an item or into pick mode by main’s notice', async () => {
  const { document, calls, listeners } = load();
  await settle();
  listeners.at({ id: 'f:2' });
  await settle();
  assert.ok(document.querySelector('.file[data-id="f:2"]').classList.contains('selected'));
  assert.deepEqual(plain(calls.diff), ['f:2']);
  listeners.at({ pick: true });
  await settle();
  assert.match(document.getElementById('strip-host').textContent, /click the first and then the last entry/);
});

test('an id that is not listed is dropped after the read, so a later refresh does not land on it', async () => {
  const { document, calls, listeners } = load({ at: { id: 'f:gone' } });
  await settle();
  assert.equal(document.querySelector('.selected'), null);
  assert.deepEqual(plain(calls.diff), []);
  listeners.updated({ sessionId: 'S' });
  await settle();
  assert.equal(document.querySelector('.selected'), null);
});

test('at.pick is ignored in a state with no strip (a backend that does not report)', async () => {
  const { document } = load({ at: { pick: true }, view: { ok: true, reports: false, request: { range: 'since-review', view: 'all' }, notes: [{ code: 'not-reported' }] } });
  await settle();
  assert.equal(document.querySelector('.strip-note.picking'), null);
});

function loadDiffWindow(query, answer) {
  const dom = new JSDOM(fs.readFileSync(path.join(RENDERER, 'diff-window.html'), 'utf8'), {
    url: 'http://localhost/diff-window.html?' + query, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const asked = { versions: [], file: [] };
  window.api = {
    sessionChangesVersions: async (id, row) => { asked.versions.push([id, row]); return answer; },
    vcsFileVersions: async (req) => { asked.file.push(req); return answer; },
  };
  window.eval(fs.readFileSync(path.join(RENDERER, 'diff-window.js'), 'utf8'));
  return { document: window.document, asked };
}

test('the diff window opened from Details asks for its two sides by session and row id, never by a path', async () => {
  const { document, asked } = loadDiffWindow('session=S&row=f%3A1&label=a.js', { ok: true, note: 'Binary file — use Open.' });
  await settle();
  assert.deepEqual(plain(asked.versions), [['S', 'f:1']]);
  assert.deepEqual(asked.file, []);
  assert.match(document.getElementById('diff').textContent, /Binary file/);
  assert.equal(document.getElementById('path').textContent, 'a.js');
});

test('the diff window of the changes window still asks by working directory and path', async () => {
  const { asked } = loadDiffWindow('cwd=%2Frepo&path=src%2Fa.js&kind=unstaged', { ok: true, note: 'x' });
  await settle();
  assert.deepEqual(asked.versions, []);
  assert.deepEqual(plain(asked.file), [{ cwd: '/repo', path: 'src/a.js', kind: 'unstaged', staged: false }]);
});

test('Clear marks the review and reads again', async () => {
  const { document, calls } = load();
  await settle();
  const before = calls.details.length;
  document.getElementById('clear').click();
  await settle();
  assert.deepEqual(plain(calls.clear), [{ missing: false }]);
  assert.ok(calls.details.length > before);
});
