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
    pendingSessions: new Set(),
    sortedOrder: [],
    visibleSessionCount: 0, // 0 = no count limit
    sessionMaxAgeDays: 0,   // 0 = no age limit
    // buildSessionItem lives in sidebar-session-row.js (not loaded here), so this window stub is the one
    // that runs. buildSlugGroup, by contrast, IS declared in sidebar.js — a function declaration shadows
    // any window property — so the REAL one runs and needs its own small deps, supplied below.
    buildSessionItem: (s) => {
      const el = window.document.createElement('div');
      el.id = 'si-' + s.sessionId;
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
  };
  Object.assign(window, defaults, g);

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
  const { call, destroy } = setup({ pendingSessions: new Set(['pending']) });
  try {
    const out = call('sortSidebarSessions', [
      sess('idle', T - 1 * DAY),
      sess('pending', T - 9 * DAY),
    ]);
    // Older, but pending → running priority beats the fresher idle one.
    assert.deepEqual([...out].map(s => s.sessionId), ['pending', 'idle']);
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
    assert.equal(result.visible[0].element.id, 'si-a');
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
    const visibleIds = [...result.visible].map(i => i.element.id);
    const olderIds = [...result.older].map(i => i.element.id);
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
