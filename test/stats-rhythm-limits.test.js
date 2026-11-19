// The Stats page's Rhythm block and rate-limit strip (#877 T7, spec 48 V6 and V8): the pure helpers, the remembered fold on
// the main side, and a jsdom run of the page against a stubbed `window.api`. The click test is the real check (reflex 2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const stats = require('../src/app/stats');

const FILE = path.join(__dirname, '..', 'src', 'renderer', 'views', 'stats-view.js');
const CHART_FILE = path.join(__dirname, '..', 'src', 'renderer', 'views', 'stats-chart.js');
const HTML = '<!DOCTYPE html><html><body><div id="stats-viewer-body"></div></body></html>';

function setup(api, cardsOf) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window, 'statsViewerBody', { value: window.document.getElementById('stats-viewer-body'), configurable: true });
  window.api = api;
  window.backendIconKnownColour = () => null;
  if (cardsOf) window.getUsageLimitCards = cardsOf;
  vm.runInContext(fs.readFileSync(CHART_FILE, 'utf8'), dom.getInternalVMContext(), { filename: CHART_FILE });
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), dom.getInternalVMContext(), { filename: FILE });
  return window;
}
const tick = () => new Promise(r => setTimeout(r, 0));

function figures() {
  return { sessions: 12, messages: 340, toolCalls: 90, input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 400, tokens: 3000, cost: null, cacheRate: 0.8, costSessions: 0, activeDays: 5 };
}
function payload() {
  return {
    range: { kind: '30d', from: '2026-10-20', to: '2026-11-18', days: 30, prevFrom: null, prevTo: null, includesToday: true },
    keyFigures: { cur: figures(), prev: null, change: {}, cacheExcluded: [] },
    series: {}, projects: [], models: [], backends: [], sessions: [],
    heatmap: { from: '2025-11-19', to: '2026-11-18', days: [{ date: '2026-11-17', messages: 3 }] },
    grid: [{ weekday: 1, hour: 9, messages: 4, tokens: 10 }],
    sidebar: [],
  };
}
const FILTER = { v: 1, range: { kind: '30d' }, backend: null, project: null, model: null };
const FACETS = { ok: true, backends: [], models: [], projects: [] };

const cardsOf = (u) => u.cards || [];
const USAGE = {
  backends: [
    { backendId: 'b1', label: 'Backend One', cards: [{ label: '5h', percent: 20, level: 'normal' }, { label: '7d', percent: 81, level: 'high' }] },
    { backendId: 'b2', label: 'Backend Two', cards: [] },
    { backendId: 'b3', label: 'Backend Three', _rateLimited: true, cards: [{ label: '5h', percent: 99, level: 'critical' }] },
  ],
};

test('statsTightestLimit picks the fullest window, the first of equals; none is null', () => {
  const w = setup({});
  assert.equal(w.statsTightestLimit([]), null);
  assert.equal(w.statsTightestLimit(null), null);
  assert.equal(w.statsTightestLimit([{ label: 'a', percent: 10 }, { label: 'b', percent: 70 }, { label: 'c', percent: 70 }]).label, 'b');
});

test('statsLimitChips: a chip per backend with a window; no limit, a failure or a rate limit shows none (not a zero)', () => {
  const w = setup({});
  const chips = w.statsLimitChips(USAGE.backends, cardsOf);
  assert.equal(chips.length, 2, 'b2 (no window) has none; b3 (rate limited) keeps a chip without a percentage');
  assert.equal(chips[0].usage.backendId, 'b1');
  assert.equal(chips[0].tight.label, '7d');
  assert.equal(chips[1].usage.backendId, 'b3');
  assert.equal(chips[1].tight, null);
  assert.equal(w.statsLimitChips([{ backendId: 'x', _noData: true }], cardsOf).length, 0);
  assert.match(w.statsUsageNotice({ _rateLimited: true, retryAfterSeconds: 130 }), /~3 mins/);
  assert.equal(w.statsUsageNotice({ _rateLimited: true, message: 'Limit reached' }), 'Limit reached');
  assert.equal(w.statsUsageNotice({ _error: true }), 'Could not fetch usage data.');
  assert.equal(w.statsUsageNotice({}), null);
  assert.equal(w.statsLimitChips(null, cardsOf).length, 0);
});

test('statsDaySpan is one day; anything else is null. statsRhythmCollapsed reads the flag', () => {
  const w = setup({});
  assert.deepEqual(JSON.parse(JSON.stringify(w.statsDaySpan('2026-11-03'))), { kind: 'day', from: '2026-11-03', to: '2026-11-03' });
  assert.equal(w.statsDaySpan('11/03/2026'), null);
  assert.equal(w.statsDaySpan(undefined), null);
  assert.equal(w.statsRhythmCollapsed({ rhythmCollapsed: true }), true);
  assert.equal(w.statsRhythmCollapsed({ rhythmCollapsed: 'yes' }), false);
  assert.equal(w.statsRhythmCollapsed(null), false);
});

test('main: the fold is sanitised (only true survives), the default shape is unchanged, and it is remembered without a payload', () => {
  const know = { backends: new Set(['alpha']), projects: new Map(), keyOf: (p) => p };
  assert.equal(stats.sanitiseFilter({ rhythmCollapsed: true }, know).rhythmCollapsed, true);
  for (const bad of [false, 'true', 1, {}, null]) {
    assert.equal('rhythmCollapsed' in stats.sanitiseFilter({ rhythmCollapsed: bad }, know), false);
  }
  assert.deepEqual(stats.sanitiseFilter(null, know), stats.defaultFilter());

  const store = new Map();
  stats.init({ getSetting: (k) => store.get(k), setSetting: (k, v) => store.set(k, v), log: { warn() {} }, db: { getStatsPayload() { throw new Error('no query'); } } });
  assert.deepEqual(stats.setRhythmCollapsed(true), { ok: true });
  assert.equal(store.get(stats.FILTER_KEY).rhythmCollapsed, true);
  assert.equal(store.get(stats.FILTER_KEY).range.kind, '30d', 'the rest of the filter is kept');
  store.set(stats.FILTER_KEY, { ...store.get(stats.FILTER_KEY), range: { kind: '7d' } });
  stats.setRhythmCollapsed(false);
  assert.equal('rhythmCollapsed' in store.get(stats.FILTER_KEY), false);
  assert.equal(store.get(stats.FILTER_KEY).range.kind, '7d');
});

test('folded: neither grid is built; opening builds from the held payload, asks main for nothing and remembers the fold', async () => {
  const asked = [];
  const remembered = [];
  const w = setup({
    getStats: async (f) => { asked.push(f); return { ok: true, filter: { ...FILTER, rhythmCollapsed: true }, view: {}, payload: payload() }; },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
    setStatsRhythm: async (c) => { remembered.push(c); },
  });
  await w.loadStats();
  await tick();
  const doc = w.document;
  assert.ok(doc.querySelector('.stats-rhythm'));
  assert.equal(doc.querySelector('.stats-rhythm .heatmap-container'), null);
  assert.equal(doc.querySelector('.stats-rhythm .hour-grid'), null);
  assert.equal(doc.querySelector('.stats-rhythm-toggle').getAttribute('aria-expanded'), 'false');

  doc.querySelector('.stats-rhythm-toggle').click();
  assert.ok(doc.querySelector('.stats-rhythm .heatmap-container'));
  assert.ok(doc.querySelector('.stats-rhythm .hour-grid'));
  assert.equal(asked.length, 1, 'no new query to open it');
  assert.deepEqual(remembered, [false]);

  doc.querySelector('.stats-rhythm-toggle').click();
  assert.equal(doc.querySelector('.stats-rhythm .heatmap-container'), null);
  assert.deepEqual(remembered, [false, true]);
});

test('a heatmap day click sets the range to that day through a new request; the heatmap runs to the range end', async () => {
  const asked = [];
  const w = setup({
    getStats: async (f) => { asked.push(f); return { ok: true, filter: FILTER, view: {}, payload: payload() }; },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
    setStatsRhythm: async () => {},
  });
  await w.loadStats();
  await tick();
  const cells = [...w.document.querySelectorAll('.heatmap-cell')];
  assert.equal(cells[cells.length - 1].dataset.date, '2026-11-18', 'the last cell is the range end, not today');
  w.document.querySelector('.heatmap-cell[data-date="2026-11-17"]').click();
  await tick();
  assert.equal(asked.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(asked[1].range)), { kind: 'day', from: '2026-11-17', to: '2026-11-17' });
});

test('the strip never holds the stats up: a hanging or failing usage read leaves the page drawn and no chip', async () => {
  for (const getUsage of [() => new Promise(() => {}), async () => { throw new Error('offline'); }]) {
    const w = setup({
      getStats: async () => ({ ok: true, filter: FILTER, view: {}, payload: payload() }),
      getStatsFacets: async () => FACETS,
      getUsage,
      setStatsRhythm: async () => {},
    }, cardsOf);
    await w.loadStats();
    await tick();
    assert.equal(w.document.querySelectorAll('.stats-tile').length, 6);
    assert.equal(w.document.querySelectorAll('.stats-limit-chip').length, 0);
    assert.equal(w.document.querySelector('.stats-limits').hidden, true);
  }
});

test('the strip: a chip with the tightest window and the plain tooltip; it opens the detail, Escape and an outside click close it', async () => {
  let release;
  const usageIn = new Promise(r => { release = r; });
  const w = setup({
    getStats: async () => ({ ok: true, filter: FILTER, view: {}, payload: payload() }),
    getStatsFacets: async () => FACETS,
    getUsage: () => usageIn,
    setStatsRhythm: async () => {},
  }, cardsOf);
  await w.loadStats();
  await tick();
  assert.equal(w.document.querySelectorAll('.stats-tile').length, 6, 'the stats are drawn before the usage answers');
  release(USAGE);
  await tick();
  const doc = w.document;
  const chips = doc.querySelectorAll('.stats-filter-bar .stats-limit-chip');
  assert.equal(chips.length, 2);
  assert.match(chips[0].textContent, /7d 81%/);
  assert.match(doc.querySelector('.stats-limits').title, /not affected by the filter/);
  assert.equal(doc.querySelector('.stats-limits-pop'), null);

  chips[0].click();
  assert.ok(doc.querySelector('.stats-limits-pop .usage-card'), 'the detail uses the existing usage cards');
  assert.equal(doc.querySelectorAll('.stats-limits-pop .usage-card').length, 2);
  assert.equal(chips[0].getAttribute('aria-expanded'), 'true');
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector('.stats-limits-pop'), null);
  assert.equal(chips[0].getAttribute('aria-expanded'), 'false');

  chips[0].click();
  assert.ok(doc.querySelector('.stats-limits-pop'));
  doc.body.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(doc.querySelector('.stats-limits-pop'), null);
});

test('an echo of a request that left before the fold click does not undo it, and the next request sends the new fold', async () => {
  const sent = [];
  const remembered = [];
  let resolveSecond;
  let call = 0;
  const w = setup({
    getStats: (f) => {
      sent.push(f);
      call++;
      if (call === 2) return new Promise(r => { resolveSecond = r; });
      return Promise.resolve({ ok: true, filter: JSON.parse(JSON.stringify(f || FILTER)), view: {}, payload: payload() });
    },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
    setStatsRhythm: async (c) => { remembered.push(c); },
  });
  await w.loadStats();
  await tick();
  const doc = w.document;
  assert.ok(doc.querySelector('.stats-rhythm .hour-grid'), 'open to start with');
  const inflight = w.applyFilter({ range: '7d' });           // the request leaves with the OLD (open) fold
  doc.querySelector('.stats-rhythm-toggle').click();         // folded while it is out
  assert.equal(doc.querySelector('.stats-rhythm .hour-grid'), null);
  resolveSecond({ ok: true, filter: { ...FILTER, range: { kind: '7d' } }, view: {}, payload: payload() });   // the echo says "open"
  await inflight;
  await tick();
  assert.equal(doc.querySelector('.stats-rhythm .hour-grid'), null, 'the block stays folded');
  assert.equal(doc.querySelector('.stats-rhythm-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(remembered[remembered.length - 1], true, 'main is told again after the echo');
  await w.applyFilter({ range: '90d' });
  assert.equal(sent[sent.length - 1].rhythmCollapsed, true, 'the next request carries the folded state');
});

test('a rate-limited backend gets a warning chip without a percentage, titled with its message, and the popover shows the notice', async () => {
  const w = setup({
    getStats: async () => ({ ok: true, filter: FILTER, view: {}, payload: payload() }),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [{ backendId: 'b3', label: 'Backend Three', _rateLimited: true, message: 'Weekly limit reached', cards: [] }, { backendId: 'b4', label: 'Backend Four', _noData: true }] }),
    setStatsRhythm: async () => {},
  }, cardsOf);
  await w.loadStats();
  await tick();
  const chips = w.document.querySelectorAll('.stats-limit-chip');
  assert.equal(chips.length, 1, 'a backend that exposes no limit has none');
  assert.ok(chips[0].classList.contains('is-critical'));
  assert.equal(chips[0].textContent.includes('%'), false);
  assert.match(chips[0].title, /Weekly limit reached/);
  chips[0].click();
  assert.match(w.document.querySelector('.stats-limits-pop .usage-rate-limited').textContent, /Weekly limit reached/);
});

test('an open popover is closed when the page is rebuilt, so its Escape listener does not swallow the key', async () => {
  const w = setup({
    getStats: async () => ({ ok: true, filter: FILTER, view: {}, payload: payload() }),
    getStatsFacets: async () => FACETS,
    getUsage: async () => USAGE,
    setStatsRhythm: async () => {},
  }, cardsOf);
  await w.loadStats();
  await tick();
  w.document.querySelector('.stats-limit-chip').click();
  assert.ok(w.document.querySelector('.stats-limits-pop'));
  await w.loadStats();
  await tick();
  const ev = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  w.document.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false);
});

test('heatmap cells before the window main sent are outside it: blank and not clickable', async () => {
  const w = setup({
    getStats: async () => ({ ok: true, filter: FILTER, view: {}, payload: payload() }),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
    setStatsRhythm: async () => {},
  });
  await w.loadStats();
  await tick();
  const outside = [...w.document.querySelectorAll('.heatmap-cell.is-outside')];
  assert.ok(outside.length > 0 && outside.length < 7);
  assert.ok(outside.every(c => !c.dataset.date && !c.title));
  assert.equal(w.document.querySelector('.heatmap-cell:not(.is-outside)').dataset.date, '2025-11-19');
});

// --- Monday-first weeks and the keyboard (#877, spec 48 O8) -----------------------------------------------------------------

async function drawn(extra) {
  const asked = [];
  const w = setup({
    getStats: async (f) => { asked.push(f); return { ok: true, filter: FILTER, view: {}, payload: { ...payload(), ...(extra || {}) } }; },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
    setStatsRhythm: async () => {},
  });
  await w.loadStats();
  await tick();
  return { w, asked };
}
const key = (w, el, k, init) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...(init || {}) }));

test('heatmap weeks run Monday to Sunday: first column starts on a Monday, labels sit on rows 0/2/4, the last column ends at the range end', async () => {
  const { w } = await drawn();
  const doc = w.document;
  const cells = [...doc.querySelectorAll('.heatmap-cell')];
  assert.equal(cells.length % 7, 3, 'the range end 2026-11-18 is a Wednesday: the last column holds Mon, Tue, Wed');
  assert.equal(cells[cells.length - 1].dataset.date, '2026-11-18');
  assert.equal(cells[cells.length - 3].dataset.date, '2026-11-16', 'the last column starts on a Monday');
  assert.equal(new Date(2026, 10, 16).getDay(), 1);
  // row 0 of every column is a Monday: the two cells before the window (2025-11-17 and -18) are outside, so the first drawn day is the 19th
  assert.equal(cells[0].classList.contains('is-outside'), true);
  assert.equal(cells[2].dataset.date, '2025-11-19');
  assert.deepEqual([...doc.querySelectorAll('.heatmap-day-label')].map(l => l.textContent), ['Mon', '', 'Wed', '', 'Fri', '', '']);
  const months = [...doc.querySelectorAll('.heatmap-month-label')];
  assert.equal(months[0].textContent, 'Nov');
  assert.equal(months[1].textContent, 'Dec', 'Dec starts on the column whose Monday is 2025-12-01');
  assert.equal(months[1].style.left, '32px', 'keyed on the Monday that starts column 2');
});

test('hour grid rows run Monday to Sunday: Sunday data lands in the last row', async () => {
  const { w } = await drawn({ grid: [{ weekday: 0, hour: 5, messages: 7, tokens: 1 }, { weekday: 1, hour: 9, messages: 4, tokens: 1 }] });
  const doc = w.document;
  assert.deepEqual([...doc.querySelectorAll('.hour-grid-day-label')].map(l => l.textContent), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  const cells = [...doc.querySelectorAll('.hour-grid-cell')];
  assert.equal(cells.length, 7 * 24);
  const lit = cells.map((c, i) => [i, c]).filter(([, c]) => !c.classList.contains('heatmap-level-0')).map(([i]) => i);
  assert.deepEqual(lit, [0 * 24 + 9, 6 * 24 + 5]);
  assert.match(cells[6 * 24 + 5].title, /^Sun 05:00/);
});

test('statsHeatmapKeyTarget: Up/Down step a day, Left/Right a week, PageUp/PageDown four weeks, Home/End the edges; clamped; other keys are not owned', () => {
  const w = setup({});
  const t = (k, i, n) => w.statsHeatmapKeyTarget(k, i, n);
  assert.equal(t('ArrowUp', 15, 100), 14);
  assert.equal(t('ArrowDown', 15, 100), 16);
  assert.equal(t('ArrowLeft', 15, 100), 8);
  assert.equal(t('ArrowRight', 15, 100), 22);
  assert.equal(t('PageUp', 50, 100), 22);
  assert.equal(t('PageDown', 50, 100), 78);
  assert.equal(t('ArrowUp', 0, 10), 0);
  assert.equal(t('ArrowDown', 9, 10), 9);
  assert.equal(t('ArrowLeft', 3, 10), 0, 'a week back past the start clamps to the first in-window day');
  assert.equal(t('ArrowRight', 6, 10), 9, 'a week on past the end clamps to the last day');
  assert.equal(t('PageUp', 3, 30), 0);
  assert.equal(t('PageDown', 27, 30), 29);
  assert.equal(t('Home', 5, 10), 0);
  assert.equal(t('End', 5, 10), 9);
  assert.equal(t('a', 5, 10), null);
  assert.equal(t('Tab', 5, 10), null);
  assert.equal(t('ArrowLeft', -1, 10), null);
  assert.equal(t('ArrowLeft', 0, 0), null);
});

test('heatmap roving tabindex: one tab stop on the range end, arrows move it and never onto an outside cell', async () => {
  const { w } = await drawn();
  const doc = w.document;
  const stops = () => [...doc.querySelectorAll('.heatmap-cell[tabindex="0"]')];
  assert.equal(stops().length, 1);
  assert.equal(stops()[0].dataset.date, '2026-11-18');
  assert.equal(doc.querySelectorAll('.heatmap-cell.is-outside[tabindex]').length, 0, 'outside cells are not focusable');
  assert.equal(doc.querySelector('.heatmap-cell[data-date="2026-11-17"]').getAttribute('aria-label'), 'Nov 17, 2026: 3 messages');

  key(w, stops()[0], 'ArrowUp');
  assert.equal(doc.activeElement.dataset.date, '2026-11-17');
  assert.equal(stops().length, 1);
  assert.equal(stops()[0].dataset.date, '2026-11-17');
  key(w, doc.activeElement, 'Home');
  assert.equal(doc.activeElement.dataset.date, '2025-11-19', 'the first day in the window, not the outside cells before it');
  key(w, doc.activeElement, 'ArrowLeft');
  assert.equal(doc.activeElement.dataset.date, '2025-11-19');
  key(w, doc.activeElement, 'ArrowRight');
  assert.equal(doc.activeElement.dataset.date, '2025-11-26', 'a week on: same weekday, next column');
  key(w, doc.activeElement, 'PageDown');
  assert.equal(doc.activeElement.dataset.date, '2025-12-24');
  key(w, doc.activeElement, 'End');
  assert.equal(doc.activeElement.dataset.date, '2026-11-18');
  key(w, doc.activeElement, 'ArrowRight');
  assert.equal(doc.activeElement.dataset.date, '2026-11-18', 'a week past the end clamps to the last day');
  assert.equal(stops().length, 1);
  const ev = new w.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
  doc.activeElement.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false);
});

test('Enter and Space apply the day like a click, skip a range that already is that day, and focus returns to the cell after the redraw', async () => {
  const { w, asked } = await drawn();
  const doc = w.document;
  const cell = () => doc.querySelector('.heatmap-cell[data-date="2026-11-17"]');
  cell().focus();
  key(w, cell(), 'Enter');
  await tick();
  assert.equal(asked.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(asked[1].range)), { kind: 'day', from: '2026-11-17', to: '2026-11-17' });
  assert.equal(doc.activeElement.dataset.date, '2026-11-17', 'the redraw gave the focus back to the same day');
  assert.equal(doc.activeElement.tabIndex, 0);

  key(w, doc.activeElement, ' ');
  await tick();
  assert.equal(asked.length, 3, 'Space applies the day too');

  // a page that already shows that day: applying it again asks nothing
  const same = await drawn({ range: { kind: 'day', from: '2026-11-17', to: '2026-11-17', days: 1, prevFrom: null, prevTo: null, includesToday: false } });
  const c = same.w.document.querySelector('.heatmap-cell[data-date="2026-11-17"]');
  key(same.w, c, 'Enter');
  await tick();
  assert.equal(same.asked.length, 1);
});

// --- the refocus belongs to the request the heatmap started ------------------------------------------------------------------

function scripted(answers) {
  const asked = [];
  const w = setup({
    getStats: (f) => { asked.push(f); const a = answers[asked.length - 1]; return a ? a() : Promise.resolve({ ok: true, filter: FILTER, view: {}, payload: payload() }); },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
    setStatsRhythm: async () => {},
  });
  return { w, asked };
}
const okAnswer = (extra) => () => Promise.resolve({ ok: true, filter: FILTER, view: {}, payload: { ...payload(), ...(extra || {}) } });
const onHeatmapCell = (w) => !!(w.document.activeElement && w.document.activeElement.classList && w.document.activeElement.classList.contains('heatmap-cell'));

test('refocus (a): a second request from the bar before the first answer leaves focus alone', async () => {
  let releaseFirst;
  const { w, asked } = scripted([okAnswer(), () => new Promise(r => { releaseFirst = r; }), okAnswer()]);
  await w.loadStats();
  await tick();
  const doc = w.document;
  const cell = doc.querySelector('.heatmap-cell[data-date="2026-11-17"]');
  cell.focus();
  key(w, cell, 'Enter');                      // request 2 (the day), answer pending
  const second = w.applyFilter({ range: '7d' }); // request 3 from the bar, before the first answer
  doc.querySelector('#stats-viewer-body').focus();
  releaseFirst({ ok: true, filter: FILTER, view: {}, payload: payload() });
  await second;
  await tick();
  assert.equal(asked.length, 3);
  assert.equal(onHeatmapCell(w), false, 'the dropped answer and the later one do not pull focus back to the old day');
});

test('an empty answer keeps the Rhythm block: the heatmap and the fold, and focus lands on the empty day\'s cell', async () => {
  const empty = { keyFigures: { cur: { sessions: 0, messages: 0, tokens: 0 } }, grid: [] };
  const { w } = scripted([okAnswer(), okAnswer(empty)]);
  await w.loadStats();
  await tick();
  const doc = w.document;
  const cell = doc.querySelector('.heatmap-cell[data-date="2026-11-17"]');
  cell.focus();
  key(w, cell, 'Enter');
  await tick();
  assert.ok(doc.querySelector('.stats-results .plans-empty'), 'the empty message stays');
  assert.ok(doc.querySelector('.stats-rhythm-toggle'), 'the fold toggle is drawn');
  assert.ok(doc.querySelector('.stats-rhythm .heatmap-cell'), 'the heatmap is the way back');
  assert.equal(doc.activeElement.dataset.date, '2026-11-17', 'focus lands on the empty day\'s cell');
});

test('refocus (b): an empty answer to a request that was not the heatmap\'s does not move focus', async () => {
  const empty = { keyFigures: { cur: { sessions: 0, messages: 0, tokens: 0 } } };
  const { w } = scripted([okAnswer(), okAnswer(empty)]);
  await w.loadStats();
  await tick();
  const doc = w.document;
  doc.querySelector('.stats-rhythm-toggle').focus();
  await w.applyFilter({ range: '7d' });
  await tick();
  assert.ok(doc.querySelector('.heatmap-cell'));
  assert.equal(onHeatmapCell(w), false);
});

test('refocus (b2): after an empty day the next unrelated draw does not move focus', async () => {
  const empty = { keyFigures: { cur: { sessions: 0, messages: 0, tokens: 0 } } };
  const { w, asked } = scripted([okAnswer(), okAnswer(empty), okAnswer()]);
  await w.loadStats();
  await tick();
  const doc = w.document;
  const cell = doc.querySelector('.heatmap-cell[data-date="2026-11-17"]');
  cell.focus();
  key(w, cell, 'Enter');
  await tick();
  assert.ok(doc.querySelector('.heatmap-cell'), 'the empty page keeps its heatmap');
  await w.applyFilter({ range: '90d' });
  await tick();
  assert.equal(asked.length, 3);
  assert.equal(onHeatmapCell(w), false, 'a later unrelated draw leaves focus where it is');
});

test('refocus (c): the answer to the heatmap\'s own request gives focus back; a user who moved to the bar keeps their place', async () => {
  const { w } = scripted([okAnswer(), okAnswer(), okAnswer(), okAnswer()]);
  await w.loadStats();
  await tick();
  const doc = w.document;
  let cell = doc.querySelector('.heatmap-cell[data-date="2026-11-17"]');
  cell.focus();
  key(w, cell, 'Enter');
  await tick();
  assert.equal(doc.activeElement.dataset.date, '2026-11-17');

  // focus on something else when the answer is drawn: not taken back
  cell = doc.querySelector('.heatmap-cell[data-date="2026-11-17"]');
  cell.focus();
  const pending = new Promise(r => setTimeout(r, 0));
  key(w, cell, 'Enter');
  const btn = doc.querySelector('.stats-rhythm-toggle');
  btn.focus();
  await pending;
  await tick();
  assert.equal(onHeatmapCell(w), false);
});
