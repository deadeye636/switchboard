// vm.runInContext tests for shell/sidebar.js's canonical ordering (#218 opt4).
//
// WHY THIS EXISTS:
//   filterSidebarSessions / sortSidebarSessions / processProjectSessions ARE the sidebar's session order
//   — the running/pinned priority, the recency tiebreak, the filter toggles, the slug grouping and the
//   age/count truncation. It is the first thing a user sees and it had zero coverage: a green suite only
//   ever said "the main process still loads". This loads the REAL shell/sidebar.js into a jsdom vm context
//   (its only parse-time statement is a pure array literal, so the whole file loads clean) and drives the
//   three functions through their rules, so a change that reorders the sidebar shows up here.
//
//   The module globals they read (the toggle flags, activePtyIds, sortedOrder, …) are injected per test;
//   buildSessionItem / buildSlugGroup are stubbed to id-bearing elements, since the ORDER is the subject,
//   not the row markup (opt3 covers that). Source is untouched — this is test-only.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

// Build a context with the real sidebar.js loaded and the module globals the ordering functions read set
// to sane defaults; `g` overrides them per test. In a jsdom vm context the global object IS window, so a
// property set on window resolves as the bare identifier the source reads.
function setup(g = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  const defaults = {
    showArchived: false,
    showStarredOnly: false,
    showRunningOnly: false,
    showTodayOnly: false,
    searchMatchIds: null,
    activePtyIds: new Set(),
    // #290: the sidebar asks app.js's predicate rather than reading pendingSessions itself — a pending
    // entry whose PTY has already exited must stop sorting and grouping with the running ones.
    launchPending: () => false,
    sortedOrder: [],
    visibleSessionCount: 0, // 0 = no count limit
    sessionMaxAgeDays: 0,   // 0 = no age limit
    // buildSessionItem lives in sidebar-session-row.js (not loaded here), so this window stub is the one
    // that runs. buildSlugGroup, by contrast, IS declared in sidebar.js — a function declaration shadows
    // any window property — so the REAL one runs and needs its own small deps, supplied below.
    buildSessionItem: (s) => {
      const el = window.document.createElement('div');
      el.id = 'si-' + s.sessionId;
      el.className = 'session-item'; // the class the fold tests count by (#516)
      el.dataset.sessionId = s.sessionId;
      return el;
    },
    // Deps the real buildSlugGroup reaches for (utils / app.js in the browser).
    getExpandedSlugs: () => new Set(),
    lastActivityTime: new Map(),
    cleanDisplayName: (s) => s || '',
    formatDate: () => 'just now',
    escapeHtml: (s) => s,
    ICONS: { archive: () => '<svg/>' },
    // Which sessions have a tab open — buildSessionsList asks before it folds rows away (#516).
    openSessions: new Map(),
  };
  Object.assign(window, defaults, g);

  // Real a11y-utils so ariaButton (called by the builders) resolves exactly as in the browser.
  vm.runInContext(fs.readFileSync(path.join(REN, 'lib/a11y-utils.js'), 'utf8'), ctx, { filename: 'lib/a11y-utils.js' });
  // Real project-name so getSessionProjectLabel picks its label through the same helper the app gives it
  // — stubbing that one would test the stub's rule instead of the shipped one (#435).
  vm.runInContext(fs.readFileSync(path.join(REN, 'lib/project-name.js'), 'utf8'), ctx, { filename: 'lib/project-name.js' });
  vm.runInContext(fs.readFileSync(path.join(REN, 'shell/sidebar.js'), 'utf8'), ctx, { filename: 'shell/sidebar.js' });

  const call = (name, ...args) => vm.runInContext(name, ctx)(...args);
  return { window, call, destroy: () => window.close() };
}

// A session at a fixed modified time (ms since epoch → ISO) with optional flags.
function sess(id, modifiedMs, extra = {}) {
  return { sessionId: id, modified: new Date(modifiedMs).toISOString(), ...extra };
}

const DAY = 86400000;
const T = Date.UTC(2026, 6, 17); // a fixed "now" reference for recency assertions

// --- sortSidebarSessions: the canonical priority + recency order ---

test('sortSidebarSessions ranks pinned+running > running > pinned > neither', () => {
  const running = new Set(['run', 'both']);
  const { call, destroy } = setup({ activePtyIds: running });
  try {
    const input = [
      sess('plain', T - 4 * DAY),
      sess('both', T - 3 * DAY, { starred: true }),
      sess('pin', T - 2 * DAY, { starred: true }),
      sess('run', T - 1 * DAY),
    ];
    const out = call('sortSidebarSessions', input);
    // Spread the vm-realm result into a host array so deepStrictEqual's constructor check passes.
    assert.deepEqual([...out].map(s => s.sessionId), ['both', 'run', 'pin', 'plain']);
  } finally { destroy(); }
});

test('sortSidebarSessions breaks ties by recency (newer first)', () => {
  const { call, destroy } = setup();
  try {
    const out = call('sortSidebarSessions', [
      sess('old', T - 5 * DAY),
      sess('new', T - 1 * DAY),
      sess('mid', T - 3 * DAY),
    ]);
    assert.deepEqual([...out].map(s => s.sessionId), ['new', 'mid', 'old']);
  } finally { destroy(); }
});

test('sortSidebarSessions counts a pending session as running', () => {
  const { call, destroy } = setup({ launchPending: (id) => id === 'pending' });
  try {
    const out = call('sortSidebarSessions', [
      sess('idle', T - 1 * DAY),
      sess('pending', T - 9 * DAY),
    ]);
    // Older, but pending → running priority beats the fresher idle one.
    assert.deepEqual([...out].map(s => s.sessionId), ['pending', 'idle']);
  } finally { destroy(); }
});

// #290: a pending entry survives its process on purpose (it is the row the user relaunches from), and for
// a backend that never records the session it survives for ever. It must not keep the row pinned to the
// top as if something were starting — launchPending() is what says the difference.
test('a pending session whose PTY exited no longer sorts as running (#290)', () => {
  const { call, destroy } = setup({ launchPending: () => false });
  try {
    const out = call('sortSidebarSessions', [
      sess('idle', T - 1 * DAY),
      sess('ghost', T - 9 * DAY),
    ]);
    assert.deepEqual([...out].map(s => s.sessionId), ['idle', 'ghost'], 'pure recency, no running promotion');
  } finally { destroy(); }
});

test('sortSidebarSessions does not mutate its input', () => {
  const { call, destroy } = setup();
  try {
    const input = [sess('a', T - 1 * DAY), sess('b', T - 2 * DAY)];
    const snapshot = input.map(s => s.sessionId);
    call('sortSidebarSessions', input);
    assert.deepEqual(input.map(s => s.sessionId), snapshot);
  } finally { destroy(); }
});

// --- filterSidebarSessions: the toggle filters ---

test('filterSidebarSessions hides archived unless the archive toggle is on', () => {
  const input = [sess('live', T), sess('gone', T, { archived: true })];
  let r = setup();
  try {
    assert.deepEqual(r.call('filterSidebarSessions', input).map(s => s.sessionId), ['live']);
  } finally { r.destroy(); }
  r = setup({ showArchived: true });
  try {
    assert.deepEqual(r.call('filterSidebarSessions', input).map(s => s.sessionId), ['live', 'gone']);
  } finally { r.destroy(); }
});

test('filterSidebarSessions keeps archived while searching (searchMatchIds set)', () => {
  const { call, destroy } = setup({ searchMatchIds: new Set(['gone']) });
  try {
    const out = call('filterSidebarSessions', [sess('live', T), sess('gone', T, { archived: true })]);
    assert.deepEqual(out.map(s => s.sessionId), ['live', 'gone']);
  } finally { destroy(); }
});

test('filterSidebarSessions: showStarredOnly and showRunningOnly narrow the list', () => {
  const input = [
    sess('star', T, { starred: true }),
    sess('runner', T),
    sess('plain', T),
  ];
  let r = setup({ showStarredOnly: true });
  try {
    assert.deepEqual(r.call('filterSidebarSessions', input).map(s => s.sessionId), ['star']);
  } finally { r.destroy(); }
  r = setup({ showRunningOnly: true, activePtyIds: new Set(['runner']) });
  try {
    assert.deepEqual(r.call('filterSidebarSessions', input).map(s => s.sessionId), ['runner']);
  } finally { r.destroy(); }
});

test('filterSidebarSessions: showTodayOnly keeps only sessions modified today', () => {
  const { call, destroy } = setup({ showTodayOnly: true });
  try {
    const now = new Date();
    const today = sess('today', now.getTime());
    const old = sess('old', now.getTime() - 3 * DAY);
    const out = call('filterSidebarSessions', [today, old]);
    assert.deepEqual(out.map(s => s.sessionId), ['today']);
  } finally { destroy(); }
});

// --- processProjectSessions: filter → sort → group → truncate ---

test('processProjectSessions orders render items and reports the id order', () => {
  const { call, destroy } = setup({ activePtyIds: new Set(['runner']) });
  try {
    const project = {
      projectPath: '/p',
      sessions: [
        sess('plain', T - 1 * DAY),
        sess('runner', T - 5 * DAY),      // running → floats to the top despite being older
        sess('pin', T - 2 * DAY, { starred: true }),
      ],
    };
    const result = call('processProjectSessions', project, true);
    assert.notEqual(result, null);
    // running > pinned > plain
    assert.deepEqual([...result.sortOrderEntry.itemIds], ['si-runner', 'si-pin', 'si-plain']);
    assert.equal(result.visible.length, 3);
    assert.equal(result.older.length, 0);
  } finally { destroy(); }
});

test('processProjectSessions truncates past the visible count into "older"', () => {
  const { call, destroy } = setup({ visibleSessionCount: 1, sessionMaxAgeDays: 0 });
  try {
    const project = {
      projectPath: '/p',
      sessions: [
        sess('a', T - 1 * DAY),
        sess('b', T - 2 * DAY),
        sess('c', T - 3 * DAY),
      ],
    };
    const result = call('processProjectSessions', project, true);
    // Count limit 1, none running/pinned → first visible, rest older.
    assert.equal(result.visible.length, 1);
    assert.equal(result.older.length, 2);
    assert.equal(result.visible[0].id, 'si-a');
  } finally { destroy(); }
});

test('processProjectSessions keeps running/pinned visible even past the count limit', () => {
  // Two running sessions with a count limit of 1: the FIRST is within the limit anyway, so it proves
  // nothing. The SECOND is past the cutoff and only the running/pinned exception keeps it visible —
  // delete that clause and it drops to "older". A plain third session confirms the limit still bites.
  const { call, destroy } = setup({ visibleSessionCount: 1, activePtyIds: new Set(['run1', 'run2']) });
  try {
    const project = {
      projectPath: '/p',
      sessions: [
        sess('run1', T - 1 * DAY),   // running, freshest → visible within the limit
        sess('run2', T - 2 * DAY),   // running, past the count cutoff → visible ONLY via the exception
        sess('plain', T - 3 * DAY),  // not running/pinned, past the cutoff → truncated to older
      ],
    };
    const result = call('processProjectSessions', project, true);
    const visibleIds = [...result.visible].map(i => i.id);
    const olderIds = [...result.older].map(i => i.id);
    assert.ok(visibleIds.includes('si-run1'), 'the in-limit running session is visible');
    assert.ok(visibleIds.includes('si-run2'), 'a running session past the cutoff must stay visible (the exception)');
    assert.deepEqual(olderIds, ['si-plain'], 'the plain session past the limit is truncated to older');
  } finally { destroy(); }
});

test('processProjectSessions collapses same-slug sessions into one group element', () => {
  const { call, destroy } = setup();
  try {
    const project = {
      projectPath: '/p',
      sessions: [
        sess('g1', T - 1 * DAY, { slug: 'feat' }),
        sess('g2', T - 2 * DAY, { slug: 'feat' }),
        sess('solo', T - 3 * DAY),
      ],
    };
    const result = call('processProjectSessions', project, true);
    const ids = result.sortOrderEntry.itemIds;
    assert.ok(ids.includes('slug-feat'), 'the two feat sessions collapse into a slug group');
    assert.ok(ids.includes('si-solo'), 'the ungrouped session renders as a row');
    assert.equal(ids.length, 2);
  } finally { destroy(); }
});

// --- getSessionProjectLabel: what the attention inbox calls a project (#435) ---
//
// sidebar.js carries its OWN derivation of this (two trailing path segments, where session-tabs.js takes
// one), so the unit test over that file's copy says nothing about this one. Same rule, second
// implementation — which is exactly the pair that drifts.

test('getSessionProjectLabel prefers the name the user gave the project', () => {
  const { call, destroy } = setup({ projectDisplayNameForSession: () => 'Alpha Service' });
  try {
    assert.equal(call('getSessionProjectLabel', { sessionId: 's1', projectPath: '/srv/work/switchboard' }),
      'Alpha Service');
  } finally { destroy(); }
});

test('getSessionProjectLabel keeps the two-segment tail where there is no such name', () => {
  const { call, destroy } = setup({ projectDisplayNameForSession: () => '' });
  try {
    // Two segments, not one — the inbox has always shown that much and this must not quietly become the
    // session bar's shorter form.
    assert.equal(call('getSessionProjectLabel', { sessionId: 's1', projectPath: '/srv/work/switchboard' }),
      'work/switchboard');
    assert.equal(call('getSessionProjectLabel', { sessionId: 's1', projectPath: '/only' }), 'only');
  } finally { destroy(); }
});

test('getSessionProjectLabel treats whitespace as no name at all', () => {
  const { call, destroy } = setup({ projectDisplayNameForSession: () => '   ' });
  try {
    assert.equal(call('getSessionProjectLabel', { sessionId: 's1', projectPath: '/srv/work/switchboard' }),
      'work/switchboard');
  } finally { destroy(); }
});

test('a session with no project path is still Other', () => {
  const { call, destroy } = setup({ projectDisplayNameForSession: () => 'Alpha Service' });
  try {
    assert.equal(call('getSessionProjectLabel', { sessionId: 's1' }), 'Other');
  } finally { destroy(); }
});

// A window that never got the lookup (it lives in app.js) must fall back, not throw.
test('getSessionProjectLabel survives a window without the lookup', () => {
  const { call, destroy } = setup();
  try {
    assert.equal(call('getSessionProjectLabel', { sessionId: 's1', projectPath: '/srv/work/switchboard' }),
      'work/switchboard');
  } finally { destroy(); }
});

// --- #516: the rows behind a fold nobody opened ---
//
// 65 of the 74 rows in the measured instance sat inside a collapsed "N older" list, built and then
// hidden. They are built on demand now, and these pin the three cases that decide it.

function olderCase(g = {}) {
  const h = setup({ visibleSessionCount: 1, sessionMaxAgeDays: 0, ...g });
  const project = {
    projectPath: '/p',
    sessions: [sess('a', T - 1 * DAY), sess('b', T - 2 * DAY), sess('c', T - 3 * DAY)],
  };
  const result = h.call('processProjectSessions', project, true);
  const fId = h.call('folderId', '/p');
  const list = h.call('buildSessionsList', fId, result.visible, result.older, null, '/p', new Set());
  return { ...h, fId, list, older: list.querySelector('.sessions-older') };
}

test('#516: a fold nobody opened builds no rows and stamps the ids it would have shown', () => {
  const { list, older, destroy } = olderCase();
  try {
    assert.equal(list.querySelectorAll('.session-item').length, 1, 'only the visible row is built');
    assert.equal(older.querySelectorAll('.session-item').length, 0);
    assert.equal(older.dataset.deferred, '1');
    assert.deepEqual(String(older.dataset.deferredSessionIds).split(' '), ['b', 'c'],
      'the archive-all button reads these instead of the rows');
    assert.equal(list.querySelector('.sessions-more-toggle').dataset.olderCount, '2',
      'the count is the same one the label shows — it never came from the DOM');
  } finally { destroy(); }
});

test('#516: a fold holding an OPEN session is built in full', () => {
  // Session navigation and the grid read their order off the sidebar's rows, folded ones included.
  // Dropping a row for a session with a tab open would silently reorder both.
  const { list, older, destroy } = olderCase({ openSessions: new Map([['c', { closed: false }]]) });
  try {
    assert.equal(older.querySelectorAll('.session-item').length, 2);
    assert.equal(older.dataset.deferred, undefined);
  } finally { destroy(); }
});

test('#516: a closed tab does not keep the fold built', () => {
  const { older, destroy } = olderCase({ openSessions: new Map([['c', { closed: true }]]) });
  try {
    assert.equal(older.querySelectorAll('.session-item').length, 0);
    assert.equal(older.dataset.deferred, '1');
  } finally { destroy(); }
});

test('#516: a fold the user opened is built again on the next render', () => {
  // The live list is where the fold state lives — the toggle writes it and preserveSidebarState carries
  // it across the morph. A render that read anything else would close a list while it is being read.
  const h = setup({ visibleSessionCount: 1, sessionMaxAgeDays: 0 });
  try {
    const fId = h.call('folderId', '/p');
    const live = h.window.document.createElement('div');
    live.id = 'older-list-' + fId;
    live.className = 'sessions-older';
    live.style.display = '';
    h.window.document.body.appendChild(live);

    const project = {
      projectPath: '/p',
      sessions: [sess('a', T - 1 * DAY), sess('b', T - 2 * DAY), sess('c', T - 3 * DAY)],
    };
    const result = h.call('processProjectSessions', project, true);
    const list = h.call('buildSessionsList', fId, result.visible, result.older, null, '/p', new Set());
    const older = list.querySelector('.sessions-older');
    assert.equal(older.querySelectorAll('.session-item').length, 2);
    assert.equal(older.dataset.deferred, undefined);
  } finally { h.destroy(); }
});
