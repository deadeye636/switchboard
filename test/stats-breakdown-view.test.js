// The Stats page's breakdown tables (#877, T5, V4): sorting, the drill-down click, the Sessions table's open path, and the
// per-viewer memory of the tab. Same jsdom harness shape as test/stats-view-logic.test.js (page scripts run against a stubbed
// `window.api`). The click test is the real check (CLAUDE.md reflex 2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const VIEWS = path.join(__dirname, '..', 'src', 'renderer', 'views');
const HTML = '<!DOCTYPE html><html><body><div id="stats-viewer-body"></div></body></html>';

function setup(api, stored) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window, 'statsViewerBody', { value: window.document.getElementById('stats-viewer-body'), configurable: true });
  window.api = api;
  // What an earlier run left in localStorage, in place BEFORE the page script reads it.
  if (stored !== undefined) window.localStorage.setItem('statsTable', stored);
  for (const f of ['stats-chart.js', 'stats-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(VIEWS, f), 'utf8'), dom.getInternalVMContext(), { filename: f });
  }
  return { window, run: (code) => vm.runInContext(code, dom.getInternalVMContext()) };
}

const tick = () => new Promise(r => setTimeout(r, 0));
const FILTER = { v: 1, range: { kind: '30d' }, backend: null, project: null, model: null };
const FACETS = { ok: true, backends: [], models: [], projects: [] };

const FIG = { sessions: 12, messages: 340, toolCalls: 90, input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 400, tokens: 3000, cost: null, cacheRate: null, costSessions: 0, activeDays: 5 };
const payload = () => ({
  range: { kind: '30d', from: '2026-10-20', to: '2026-11-18', days: 30, prevFrom: null, prevTo: null, includesToday: true },
  keyFigures: { cur: FIG, prev: null, change: {}, cacheExcluded: [] },
  series: {},
  projects: [
    { projectPath: '/p/one', name: 'One', selectable: true, sessions: 3, messages: 30, tokens: 900, cost: { usd: 1.5, estimated: true } },
    { projectPath: '/p/two', name: 'Two', selectable: true, sessions: 1, messages: 5, tokens: 100, cost: null },
    { projectPath: '', name: 'Other', other: true, selectable: false, sessions: 2, messages: 4, tokens: 50, cost: null },
  ],
  models: [{ model: 'm-1', selectable: true, sessions: 2, input: 10, output: 20, cacheRead: 0, cacheWrite: 0, tokens: 30, cost: { usd: 2, estimated: false } }],
  backends: [
    { id: 'b1', label: 'Backend One', selectable: true, colour: null, icon: null, sessions: 2, messages: 3, tokens: 40, input: 10, output: 30, cacheRate: null, cost: null },
    { id: 'off', label: 'Switched-off CLI', selectable: false, colour: null, icon: null, sessions: 1, messages: 1, tokens: 5, input: 1, output: 4, cacheRate: 0.5, cost: null },
  ],
  sessions: [
    { sessionId: 's-a', title: 'Alpha work', projectPath: '/p/one', openPath: '/p/one/.wt/a', openable: true, projectName: 'One', backend: { id: 'b1', label: 'Backend One' }, created: '2026-11-01T10:00:00Z', lastDate: '2026-11-02', lastModel: 'm-1', messages: 4, tokens: 70, cost: null },
    { sessionId: 's-b', title: null, projectPath: '/p/two', openPath: '/p/two/.wt/b', openable: true, projectName: 'Two', backend: { id: 'b1', label: 'Backend One' }, created: null, lastDate: null, lastModel: null, messages: 9, tokens: 20, cost: { usd: 0.5, estimated: false } },
  ],
  heatmap: { from: '2025-11-19', to: '2026-11-18', days: [] },
  grid: [],
  sidebar: [],
});

async function page(stored, initialView) {
  const sent = [];
  // Like main: the echo is the filter that was sent (null = the remembered one), the view keeps what it was asked for.
  const h = setup({
    getStats: async (f, v) => { sent.push({ f, v }); return { ok: true, filter: f || FILTER, view: { measure: 'tokens', split: 'backend', sessionsBy: 'tokens', ...(initialView || {}), ...(v || {}) }, payload: payload() }; },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  }, stored);
  await h.window.loadStats();
  await tick();
  return { ...h, sent };
}
const pills = (w) => [...w.document.querySelectorAll('.stats-breakdown .backend-filter-pill')];
const firstCol = (w) => [...w.document.querySelectorAll('.stats-table tbody tr')].map(tr => tr.firstElementChild.textContent);

test('statsSortRows: numbers numerically, strings by locale, missing values last in both directions', () => {
  const { window: w } = setup({});
  const vals = (rows, dir) => w.statsSortRows(rows, r => r.v, dir).map(r => (Number.isNaN(r.v) ? 'nan' : r.v));
  const rows = [{ v: 5 }, { v: null }, { v: 20 }, { v: NaN }, { v: 1 }];
  assert.deepEqual(vals(rows, 'desc'), [20, 5, 1, null, 'nan']);
  assert.deepEqual(vals(rows, 'asc'), [1, 5, 20, null, 'nan']);
  const names = [{ v: 'beta' }, { v: 'Alpha' }, { v: '' }, { v: 'gamma' }];
  assert.deepEqual(vals(names, 'asc'), ['Alpha', 'beta', 'gamma', '']);
  assert.deepEqual(vals(names, 'desc'), ['gamma', 'beta', 'Alpha', '']);
  assert.deepEqual(vals([{ v: 'x10' }, { v: 'x9' }], 'asc'), ['x9', 'x10']);
});

test('the tabs sit between the chart and Rhythm, reuse the pill and table classes; Sessions has nine columns', async () => {
  const { window: w } = await page();
  const doc = w.document;
  assert.deepEqual(pills(w).map(b => b.textContent), ['Projects', 'Models', 'Backends', 'Sessions']);
  assert.ok(pills(w).every(b => b.tagName === 'BUTTON'));
  const order = [...doc.querySelector('.stats-results').children].map(c => c.className.split(' ')[0]);
  assert.ok(order.indexOf('stats-chart-section') < order.indexOf('stats-breakdown') && order.indexOf('stats-breakdown') < order.indexOf('stats-rhythm'));
  assert.equal(doc.querySelector('.stats-table').className, 'pa-table stats-table');
  pills(w)[3].click();
  assert.equal(doc.querySelectorAll('.stats-table thead th').length, 9);
});

test('cost: "~" on an estimate, a dash where none is reported', async () => {
  const { window: w } = await page();
  const cells = [...w.document.querySelectorAll('.stats-table tbody tr')].map(tr => tr.lastElementChild.textContent);
  assert.deepEqual(cells, ['~$1.50', '—', '—']);
});

test('a project row sets the filter; a second click on the active row clears it', async () => {
  const { window: w, sent } = await page();
  w.document.querySelector('.stats-table tbody tr').click();
  await tick();
  assert.equal(sent.at(-1).f.project, '/p/one');
  const active = w.document.querySelector('.stats-table tr.is-active');
  assert.equal(active.firstElementChild.textContent, 'One', 'the echoed filter marks the row');
  active.click();
  await tick();
  assert.equal(sent.at(-1).f.project, null);
  assert.equal(w.document.querySelector('.stats-table tr.is-active'), null);
});

test('the Other row and a backend main does not mark selectable are not clickable; a backend row sets the backend filter', async () => {
  const { window: w, sent } = await page();
  const doc = w.document;
  const other = [...doc.querySelectorAll('.stats-table tbody tr')].find(tr => tr.firstElementChild.textContent === 'Other');
  const before = sent.length;
  other.click();
  await tick();
  assert.equal(sent.length, before);
  assert.equal(other.classList.contains('stats-row'), false);
  pills(w)[2].click();
  const rows = [...doc.querySelectorAll('.stats-table tbody tr')];
  assert.equal(rows.find(tr => tr.firstElementChild.textContent.includes('Switched-off')).classList.contains('stats-row'), false);
  rows.find(tr => tr.firstElementChild.textContent.includes('Backend One')).click();
  await tick();
  assert.equal(sent.at(-1).f.backend, 'b1');
});

test('a model row sets the model filter', async () => {
  const { window: w, sent } = await page();
  pills(w)[1].click();
  w.document.querySelector('.stats-table tbody tr').click();
  await tick();
  assert.equal(sent.at(-1).f.model, 'm-1');
});

test('a header click sorts locally, nulls stay last, and nothing is sent to main', async () => {
  const { window: w, sent } = await page();
  const doc = w.document;
  const before = sent.length;
  doc.querySelector('th[data-sort="name"]').click();
  assert.deepEqual(firstCol(w), ['One', 'Other', 'Two'].sort((a, b) => a.localeCompare(b)));
  doc.querySelector('th[data-sort="name"]').click();
  assert.deepEqual(firstCol(w), ['Two', 'Other', 'One']);
  doc.querySelector('th[data-sort="cost"]').click();
  assert.equal(firstCol(w)[0], 'One', 'the only priced row leads, unpriced rows follow');
  assert.equal(doc.querySelector('th[data-sort="cost"]').getAttribute('aria-sort'), 'descending');
  doc.querySelector('th[data-sort="cost"]').click();
  assert.equal(firstCol(w)[0], 'One', 'ascending still leaves the unpriced rows last');
  assert.equal(sent.length, before);
});

test('Sessions: a different measure asks main through sessionsBy, any other column sorts locally', async () => {
  const { window: w, sent } = await page();
  const doc = w.document;
  pills(w)[3].click();
  const before = sent.length;
  doc.querySelector('th[data-sort="title"]').click();
  assert.equal(sent.length, before);
  assert.equal(firstCol(w)[0], 'Alpha work');
  doc.querySelector('th[data-sort="messages"]').click();
  await tick();
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).v.sessionsBy, 'messages');
  assert.deepEqual(sent.at(-1).f, FILTER, 'the filter the page held goes along unchanged');
});

test('a session row opens through openSession, with the row the app already holds when there is one', async () => {
  const { window: w, run } = await page();
  const opened = [];
  const held = { sessionId: 's-a', projectPath: '/real/checkout' };
  // openSession and sessionMap are app.js globals: set them where the page script reads them.
  w.__opened = opened;
  w.__held = held;
  run('var openSession = async (s) => { __opened.push(s); }; var sessionMap = new Map([["s-a", __held]]);');
  pills(w)[3].click();
  const rows = [...w.document.querySelectorAll('.stats-table tbody tr')];
  rows.find(tr => tr.firstElementChild.textContent === 'Alpha work').click();
  rows.find(tr => tr.firstElementChild.textContent === '(untitled)').click();
  assert.equal(opened[0], held);
  assert.deepEqual(JSON.parse(JSON.stringify(opened[1])), { sessionId: 's-b', projectPath: '/p/two/.wt/b' }, 'the own path of the session, not the owner project');
});

test('the tab and the sort are kept per viewer in localStorage, not in the filter', async () => {
  const { window: w, sent } = await page();
  pills(w)[1].click();
  const saved = JSON.parse(w.localStorage.getItem('statsTable'));
  assert.equal(saved.tab, 'models');
  assert.ok(sent.every(s => !s.f || !('tab' in s.f)));
});

test('opening leaves the Stats view first and reports a failure', async () => {
  const { window: w, run } = await page();
  w.__calls = [];
  run(`var closeAdminView = () => __calls.push('admin'); var hideAllViewers = () => __calls.push('hide');
       var toast = (m) => __calls.push(m); var openSession = async () => { __calls.push('open'); throw new Error('boom'); };`);
  pills(w)[3].click();
  w.document.querySelector('.stats-table tbody tr').click();
  await tick();
  assert.deepEqual(w.__calls, ['admin', 'hide', 'open', 'Could not open session: boom']);
});

test('the highlight follows the echoed filter, not what was last sent', async () => {
  const { window: w, run } = await page();
  w.document.querySelector('.stats-table tbody tr').click();
  await tick();
  assert.equal(w.document.querySelector('.stats-table tr.is-active').firstElementChild.textContent, 'One');
  // main echoes the project away: the row is no longer lit even though the pending filter still names it
  run('statsState.filter = { ...statsState.filter, project: null }; renderStatsBreakdownBody();');
  assert.equal(w.document.querySelector('.stats-table tr.is-active'), null);
});

test('a corrupt or hostile remembered value falls back to the defaults', async () => {
  for (const stored of ['{not json', 'null', '"x"', '[1,2]', JSON.stringify({ tab: 5, sort: 'zzz' }), JSON.stringify({ tab: '__proto__', sort: { projects: null, models: { key: 'nope', dir: 7 } } }), JSON.stringify({ tab: 'sessions', sort: { sessions: { key: {} } } })]) {
    const { window: w } = await page(stored);
    assert.ok(w.document.querySelector('.stats-table tbody tr'), 'a table is drawn for ' + stored);
    assert.ok(w.document.querySelector('.stats-breakdown .backend-filter-pill.active'), 'one tab is lit for ' + stored);
  }
});

test('a remembered sort is restored', async () => {
  const { window: w } = await page(JSON.stringify({ tab: 'projects', sort: { projects: { key: 'name', dir: 'asc' } } }));
  assert.equal(w.document.querySelector('th[data-sort="name"]').getAttribute('aria-sort'), 'ascending');
  assert.deepEqual(firstCol(w), ['One', 'Other', 'Two']);
});

test('a remembered Sessions measure that differs from the top 50 on screen asks main once', async () => {
  const { window: w, sent } = await page(JSON.stringify({ tab: 'sessions', sort: { sessions: { key: 'cost', dir: 'desc' } } }));
  const asks = sent.filter(s => s.v && s.v.sessionsBy === 'cost');
  assert.equal(asks.length, 1, 'one ask for the saved measure, no loop');
  assert.equal(w.document.querySelector('th[data-sort="cost"]').getAttribute('aria-sort'), 'descending');
  // the same when the user switches to the tab later
  const second = await page(JSON.stringify({ tab: 'projects', sort: { sessions: { key: 'messages', dir: 'desc' } } }));
  assert.equal(second.sent.filter(s => s.v && s.v.sessionsBy).length, 0, 'not on the Sessions tab: no ask');
  pills(second.window)[3].click();
  await tick();
  assert.equal(second.sent.filter(s => s.v && s.v.sessionsBy === 'messages').length, 1);
});

test('panes mode keeps the Stats tab: no admin close, no hideAllViewers, the session is still opened', async () => {
  const { window: w, run } = await page();
  w.__calls = [];
  w.panesView = { active: () => true };
  run(`var closeAdminView = () => __calls.push('admin'); var hideAllViewers = () => __calls.push('hide'); var openSession = async () => { __calls.push('open'); };`);
  pills(w)[3].click();
  w.document.querySelector('.stats-table tbody tr').click();
  await tick();
  assert.deepEqual(w.__calls, ['open']);
  w.panesView = { active: () => false };
  w.__calls.length = 0;
  w.document.querySelector('.stats-table tbody tr').click();
  await tick();
  assert.deepEqual(w.__calls, ['admin', 'hide', 'open'], 'single and grid view leave the admin view first');
});

test('a session main marks not openable is not clickable and says why', async () => {
  const h = setup({
    getStats: async () => { const p = payload(); p.sessions[0].openable = false; p.sessions[0].openPath = null; return { ok: true, filter: FILTER, view: { sessionsBy: 'tokens' }, payload: p }; },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  await h.window.loadStats();
  await tick();
  pills(h.window)[3].click();
  const rows = [...h.window.document.querySelectorAll('.stats-table tbody tr')];
  const dead = rows.find(tr => tr.firstElementChild.textContent === 'Alpha work');
  assert.equal(dead.classList.contains('stats-row'), false);
  assert.match(dead.title, /no project folder/);
  assert.equal(rows.find(tr => tr.firstElementChild.textContent === '(untitled)').classList.contains('stats-row'), true);
});

test('a failed re-ask of the remembered measure may be tried again; until it lands the header names the measure that ranked the rows', async () => {
  const stored = JSON.stringify({ tab: 'sessions', sort: { sessions: { key: 'cost', dir: 'desc' } } });
  const sent = [];
  let fail = true;
  const h = setup({
    getStats: async (f, v) => {
      sent.push(v || null);
      if (v && v.sessionsBy === 'cost' && fail) return { ok: false, error: 'nope' };
      return { ok: true, filter: f || FILTER, view: { sessionsBy: 'tokens', ...(v || {}) }, payload: payload() };
    },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  }, stored);
  const w = h.window;
  await w.loadStats();
  await tick();
  assert.equal(sent.filter(v => v && v.sessionsBy === 'cost').length, 1);
  assert.ok(w.document.querySelector('.stats-retry-btn'), 'the failure is shown');
  fail = false;
  w.document.querySelector('.stats-retry-btn').click();
  await tick();
  await tick();
  assert.equal(sent.filter(v => v && v.sessionsBy === 'cost').length, 2, 'the latch was reset by the failure');
  assert.equal(w.document.querySelector('th[data-sort="cost"]').getAttribute('aria-sort'), 'descending');
  // and before it landed (a reply that never changes the measure) the header stays on the measure that ranked the rows
  const stuck = setup({
    getStats: async (f, v) => ({ ok: true, filter: f || FILTER, view: { sessionsBy: 'tokens' }, payload: payload() }),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  }, stored);
  await stuck.window.loadStats();
  await tick();
  assert.equal(stuck.window.document.querySelector('th[data-sort="tokens"]').getAttribute('aria-sort'), 'descending');
  assert.equal(stuck.window.document.querySelector('th[data-sort="cost"]').getAttribute('aria-sort'), 'none');
});
