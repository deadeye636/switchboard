// The Stats page's renderer half (#877, T4b): its pure helpers and a jsdom smoke test of the page against a stubbed
// `window.api`. What this guards is the shape of the claims the page makes, not pixels: the bar shows the ECHOED filter,
// a late reply never overwrites a newer one, an empty answer keeps the bar, "—" where there is nothing to compare, and
// an estimate is never drawn as a bill. The click test is the real check (CLAUDE.md reflex 2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const FILE = path.join(__dirname, '..', 'src', 'renderer', 'views', 'stats-view.js');
const CHART_FILE = path.join(__dirname, '..', 'src', 'renderer', 'views', 'stats-chart.js');
const HTML ='<!DOCTYPE html><html><body><div id="stats-viewer-body"></div></body></html>';

function setup(api) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window, 'statsViewerBody', { value: window.document.getElementById('stats-viewer-body'), configurable: true });
  window.api = api;
  // backend-icons.js's own lookup, stubbed: the payload's colour is a TOKEN and this is what turns it into a CSS colour.
  window.backendIconKnownColour = (token) => (token === 'tok-b1' ? '#d97757' : null);
  // The page loads the chart module first (index.html order); its exports land on the window like in the app.
  vm.runInContext(fs.readFileSync(CHART_FILE, 'utf8'), dom.getInternalVMContext(), { filename: CHART_FILE });
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), dom.getInternalVMContext(), { filename: FILE });
  return window;
}

const tick = () => new Promise(r => setTimeout(r, 0));

function figures(over = {}) {
  return {
    sessions: 12, messages: 340, toolCalls: 90, input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 400,
    tokens: 3000, cost: { usd: 1.5, estimated: true }, cacheRate: 0.8, costSessions: 10, activeDays: 5, ...over,
  };
}
function payload(over = {}) {
  return {
    range: { kind: '30d', from: '2026-10-20', to: '2026-11-18', days: 30, prevFrom: '2026-09-20', prevTo: '2026-10-19', includesToday: true },
    keyFigures: {
      cur: figures(), prev: figures(),
      change: { sessions: 0.2, messages: -0.05, toolCalls: 0, tokens: 0.5, activeDays: 0, cost: null, cacheRate: 0.03 },
      cacheExcluded: [],
    },
    series: {}, projects: [], models: [], backends: [{ id: 'b1', label: 'Backend One' }], sessions: [],
    heatmap: { from: '2025-11-19', to: '2026-11-18', days: [{ date: '2026-11-17', messages: 3 }] },
    grid: [{ weekday: 1, hour: 9, messages: 4, tokens: 10 }],
    sidebar: [],
    ...over,
  };
}
const FILTER = { v: 1, range: { kind: '30d' }, backend: null, project: null, model: null };
const FACETS = { ok: true, backends: [{ id: 'b1', label: 'Backend One' }], models: ['m-1'], projects: [{ path: '/p/one', name: 'One' }] };

test('statsChangeText: null is a dash, never 0%; sign and unit follow the figure', () => {
  const w = setup({});
  assert.equal(w.statsChangeText(null), '—');
  assert.equal(w.statsChangeText(undefined), '—');
  assert.equal(w.statsChangeText(NaN), '—');
  assert.equal(w.statsChangeText(0), '0%');
  assert.equal(w.statsChangeText(0.123), '+12%');
  assert.equal(w.statsChangeText(-0.05), '−5%');
  assert.equal(w.statsChangeText(0.03, 'points'), '+3 pt');
  assert.equal(w.statsChangeText(0, 'points'), '0 pt');
});

test('statsCompareText: the "all" range says it has no previous period', () => {
  const w = setup({});
  assert.match(w.statsCompareText({ prevFrom: null }), /No previous period/);
  assert.match(w.statsCompareText({ prevFrom: '2026-09-20', prevTo: '2026-10-19', includesToday: true }), /2026-09-20 – 2026-10-19.*includes today/);
});

test('statsIsEmpty: no sessions, messages or tokens is empty', () => {
  const w = setup({});
  assert.equal(w.statsIsEmpty(null), true);
  assert.equal(w.statsIsEmpty(payload({ keyFigures: { cur: figures({ sessions: 0, messages: 0, tokens: 0 }), change: {} } })), true);
  assert.equal(w.statsIsEmpty(payload()), false);
});

test('statsFilterWith changes one field and sends a range as a kind', () => {
  const w = setup({});
  const next = w.statsFilterWith(FILTER, { range: 'year', backend: 'b1' });
  assert.deepEqual(JSON.parse(JSON.stringify(next.range)), { kind: 'year' });
  assert.equal(next.backend, 'b1');
  assert.equal(w.statsFilterWith(next, { backend: '' }).backend, null);
  assert.equal(FILTER.range.kind, '30d', 'the input is not mutated');
});

test('the page draws the echoed filter, six tiles, the chart host and the Rhythm block', async () => {
  const sent = [];
  const w = setup({
    getStats: async (f) => { sent.push(f); return { ok: true, filter: { ...FILTER, range: { kind: '90d' } }, view: { measure: 'tokens' }, payload: payload() }; },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  await w.loadStats();
  await tick();
  const doc = w.document;
  assert.equal(sent[0], null, 'the first read asks for the remembered filter');
  assert.equal(doc.querySelector('.backend-filter-pill.active').dataset.range, '90d', 'the bar shows what main echoed');
  assert.equal(doc.querySelectorAll('.stats-tile').length, 6);
  assert.ok(doc.querySelector('[data-stats-chart-host]'));
  assert.ok(doc.querySelector('.stats-rhythm .heatmap-container'));
  assert.ok(doc.querySelector('.stats-rhythm .hour-grid'));
  assert.ok(doc.querySelector('.stats-filter-sticky'));
  assert.deepEqual([...doc.querySelectorAll('select.stats-select')].map(s => s.dataset.field), ['backend', 'project', 'model']);
  // facets arrive after the page and fill the selects
  assert.ok([...doc.querySelector('select[data-field="model"]').options].some(o => o.value === 'm-1'));
  assert.ok(doc.querySelector('.stats-filter-bar .stats-limits'), 'the limits strip sits in the bar');
});

test('an estimated cost is drawn with "~" and the amber class; no cost is a dash, not $0.00', async () => {
  let p = payload();
  const w = setup({
    getStats: async () => ({ ok: true, filter: FILTER, view: {}, payload: p }),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  await w.loadStats();
  const tile = () => [...w.document.querySelectorAll('.stats-tile')].find(t => t.querySelector('.stat-card-label').textContent === 'Cost');
  assert.equal(tile().querySelector('.stat-card-value').textContent, '~$1.50');
  assert.ok(tile().querySelector('.stat-card-value').classList.contains('is-estimated'));
  p = payload({ keyFigures: { cur: figures({ cost: null, cacheRate: null }), prev: null, change: {}, cacheExcluded: ['Gamma'] } });
  await w.loadStats();
  assert.equal(tile().querySelector('.stat-card-value').textContent, '—');
  const cache = [...w.document.querySelectorAll('.stats-tile')].find(t => t.querySelector('.stat-card-label').textContent === 'Cache hit rate');
  assert.equal(cache.querySelector('.stat-card-value').textContent, '—');
  assert.match(cache.title, /Gamma/, 'the excluded backends are named');
  assert.ok([...w.document.querySelectorAll('.stats-tile-change')].every(c => c.textContent === '—'), 'no previous period: every change is a dash');
});

test('an empty answer keeps the bar and shows an empty state below it', async () => {
  const w = setup({
    getStats: async () => ({ ok: true, filter: FILTER, view: {}, payload: payload({ keyFigures: { cur: figures({ sessions: 0, messages: 0, tokens: 0 }), prev: null, change: {}, cacheExcluded: [] } }) }),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  await w.loadStats();
  assert.ok(w.document.querySelector('.stats-filter-bar'));
  assert.ok(w.document.querySelector('.stats-results .plans-empty'));
  assert.equal(w.document.querySelectorAll('.stats-tile').length, 0);
  assert.ok(w.document.querySelector('.stats-results .heatmap-cell'), 'the heatmap stays as the way back');
  assert.ok(w.document.querySelector('.stats-results .stats-rhythm-toggle'));
});

test('a late reply to an older request never overwrites a newer one', async () => {
  const waits = [];
  const w = setup({
    getStats: (f) => new Promise((resolve) => waits.push({ f, resolve })),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  const first = w.loadStats();
  await tick();
  const second = w.requestStats({ ...FILTER, range: { kind: '7d' } });
  await tick();
  assert.equal(waits.length, 2);
  waits[1].resolve({ ok: true, filter: { ...FILTER, range: { kind: '7d' } }, view: {}, payload: payload() });
  await second;
  waits[0].resolve({ ok: true, filter: { ...FILTER, range: { kind: 'all' } }, view: {}, payload: payload() });
  await first;
  assert.equal(w.document.querySelector('.backend-filter-pill.active').dataset.range, '7d');
});

test('a failed read keeps the page usable: an error and a retry, no throw', async () => {
  const w = setup({
    getStats: async () => ({ ok: false, error: 'The statistics could not be read.' }),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  await w.loadStats();
  assert.match(w.document.querySelector('.stats-results').textContent, /could not be read/);
  assert.ok(w.document.querySelector('.stats-retry-btn'));
});

test('no control is a bare element: the bar reuses the existing pill, select and button classes', async () => {
  const w = setup({
    getStats: async () => ({ ok: true, filter: FILTER, view: {}, payload: payload() }),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  await w.loadStats();
  const bar = w.document.querySelector('.stats-filter-bar');
  for (const b of bar.querySelectorAll('button')) assert.ok(/backend-filter-pill|settings-action-btn/.test(b.className), b.textContent);
  for (const s of bar.querySelectorAll('select')) assert.ok(s.classList.contains('settings-select'));
  for (const b of w.document.querySelectorAll('.stats-chart-switch button')) assert.ok(b.classList.contains('backend-filter-pill'), b.textContent);
});

// --- the main chart (T4c) ------------------------------------------------------------------------------------------------

function seriesOf(over = {}) {
  return {
    measure: 'tokens', split: 'backend', bucket: 'week', estimated: null, partialLast: true,
    keys: [
      { key: 'b1', label: 'Backend One', colour: 'tok-b1', icon: null, other: false },
      { key: '__other__', label: 'Other', colour: null, icon: null, other: true },
    ],
    buckets: [
      { bucket: '2026-10-19', start: '2026-10-19', end: '2026-10-25', partial: false, values: { b1: 1000, __other__: 200 } },
      { bucket: '2026-11-16', start: '2026-11-16', end: '2026-11-22', partial: true, values: { b1: 500, __other__: 0 } },
    ],
    ...over,
  };
}

async function pageWithSeries(series, view = { measure: 'tokens', split: 'backend', sessionsBy: 'tokens' }) {
  const sent = [];
  const w = setup({
    getStats: async (f, v) => { sent.push({ f, v }); return { ok: true, filter: FILTER, view, payload: payload({ series }) }; },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  await w.loadStats();
  await tick();
  return { w, sent };
}

test('the chart draws a bar per bucket, the resolved payload colour token, a neutral Other, and a title and labels for assistive tech', async () => {
  const { w } = await pageWithSeries(seriesOf());
  const doc = w.document;
  const bars = doc.querySelectorAll('.stats-chart-bar');
  assert.equal(bars.length, 2);
  assert.match(doc.querySelector('.stats-chart-svg title').textContent, /Tokens per week, split by backend/);
  assert.match(bars[0].getAttribute('aria-label'), /2026-10-19 – 2026-10-25: 1\.2K/);
  assert.equal(bars[0].querySelector('rect[data-key="b1"]').style.fill, 'rgb(217, 119, 87)');
  assert.ok(bars[0].querySelector('rect[data-key="__other__"]').classList.contains('stats-chart-other'));
  assert.deepEqual([...doc.querySelectorAll('.chart-legend-item')].map(i => i.textContent), ['Backend One', 'Other']);
});

test('the partial bucket is lighter and says "so far"', async () => {
  const { w } = await pageWithSeries(seriesOf());
  const bars = w.document.querySelectorAll('.stats-chart-bar');
  assert.ok(!bars[0].classList.contains('is-partial'));
  assert.ok(bars[1].classList.contains('is-partial'));
  assert.match(bars[1].getAttribute('aria-label'), /\(so far\)/);
  assert.equal(w.document.querySelectorAll('.stats-chart-sofar').length, 1);
});

test('the tooltip names the bucket range, each key and the total; it follows the pointer and hides on leave', async () => {
  const { w } = await pageWithSeries(seriesOf());
  const bar = w.document.querySelector('.stats-chart-bar');
  const tip = w.document.querySelector('.stats-chart-tip');
  assert.equal(tip.hidden, true);
  bar.dispatchEvent(new w.Event('mouseenter'));
  assert.equal(tip.hidden, false);
  assert.match(tip.textContent, /2026-10-19 – 2026-10-25/);
  assert.match(tip.textContent, /Backend One.*1\.0K/);
  assert.match(tip.textContent, /Other.*200/);
  assert.match(tip.textContent, /Total.*1\.2K/);
  bar.dispatchEvent(new w.Event('mouseleave'));
  assert.equal(tip.hidden, true);
});

test('a click on a bar sets the range to that bucket, cut to the range on screen', async () => {
  const { w, sent } = await pageWithSeries(seriesOf());
  w.document.querySelector('.stats-chart-bar').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const f = JSON.parse(JSON.stringify(sent[sent.length - 1].f));
  assert.deepEqual(f.range, { kind: 'custom', from: '2026-10-20', to: '2026-10-25' }, 'the week starts before the range: cut to it');
});

test('statsBucketSpan: a day bucket is "day", an outside bucket is nothing', () => {
  const w = setup({});
  const range = { from: '2026-10-20', to: '2026-11-18' };
  assert.deepEqual(JSON.parse(JSON.stringify(w.statsBucketSpan({ start: '2026-11-01', end: '2026-11-01' }, range))), { kind: 'day', from: '2026-11-01', to: '2026-11-01' });
  assert.equal(w.statsBucketSpan({ start: '2026-09-01', end: '2026-09-07' }, range), null);
  assert.deepEqual(JSON.parse(JSON.stringify(w.statsBucketSpan({ start: '2026-11-16', end: '2026-11-22' }, range))), { kind: 'custom', from: '2026-11-16', to: '2026-11-18' });
});

test('the measure and split switches ask main again with the changed view, keeping the filter', async () => {
  const { w, sent } = await pageWithSeries(seriesOf());
  assert.equal(w.document.querySelector('.stats-chart-switch .backend-filter-pill.active').dataset.value, 'tokens');
  w.document.querySelector('.stats-chart-switch button[data-value="cost"]').click();
  await tick();
  assert.equal(sent[sent.length - 1].v.measure, 'cost');
  assert.equal(sent[sent.length - 1].v.split, 'backend');
  assert.equal(sent[sent.length - 1].f.range.kind, '30d', 'the filter is the echoed one');
  w.document.querySelectorAll('.stats-chart-switch')[1].querySelector('button[data-value="model"]').click();
  await tick();
  assert.equal(sent[sent.length - 1].v.split, 'model');
});

test('an estimated cost chart says so: "~" in the tooltip and "(estimated)" on the axis; no cost at all says so in words', async () => {
  const { w } = await pageWithSeries(seriesOf({ measure: 'cost', estimated: true }), { measure: 'cost', split: 'backend', sessionsBy: 'tokens' });
  assert.match(w.document.querySelector('.stats-chart-unit').textContent, /estimated/);
  w.document.querySelector('.stats-chart-bar').dispatchEvent(new w.Event('mouseenter'));
  assert.match(w.document.querySelector('.stats-chart-tip').textContent, /Total.*~\$/);
  const none = { bucket: '2026-10-19', start: '2026-10-19', end: '2026-10-25', partial: false, values: { b1: 0 } };
  const empty = await pageWithSeries(seriesOf({ buckets: [none] }), { measure: 'cost', split: 'backend', sessionsBy: 'tokens' });
  assert.match(empty.w.document.querySelector('.stats-chart-none').textContent, /reports a cost/);
});

test('a colour token the page does not know falls back to the palette instead of a raw token or the neutral grey', async () => {
  const { w } = await pageWithSeries(seriesOf({ keys: [{ key: 'b1', label: 'Backend One', colour: 'no-such-token', icon: null, other: false }] }));
  assert.equal(w.document.querySelector('.stats-chart-seg[data-key="b1"]').style.fill, 'rgb(128, 136, 255)');
});

test('the active day or custom range is shown as a non-button pill', async () => {
  const w = setup({
    getStats: async () => ({ ok: true, filter: { ...FILTER, range: { kind: 'custom', from: '2026-10-20', to: '2026-10-25' } }, view: {}, payload: payload() }),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  await w.loadStats();
  const cur = w.document.querySelector('.stats-range-current');
  assert.ok(cur && cur.tagName !== 'BUTTON' && cur.classList.contains('backend-filter-pill'));
});

function deferred() {
  const waits = [];
  const api = {
    getStats: (f, v) => new Promise((resolve) => waits.push({ f, v, resolve })),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  };
  return { waits, api };
}
const reply = (filter, view) => ({ ok: true, filter, view, payload: payload({ series: seriesOf() }) });
const VIEW = { measure: 'tokens', split: 'backend', sessionsBy: 'tokens' };

test('two changes made before the first reply both reach main: the second builds on what was sent, not on the old echo', async () => {
  const { waits, api } = deferred();
  const w = setup(api);
  const first = w.loadStats();
  await tick();
  waits[0].resolve(reply(FILTER, VIEW));
  await first;
  await tick();
  w.document.querySelector('.backend-filter-pill[data-range="7d"]').click();
  await tick();
  // The reply to 7d has not come; the chart on screen is still the old one.
  w.document.querySelector('.stats-chart-switch button[data-value="cost"]').click();
  await tick();
  assert.equal(waits.length, 3);
  const last = JSON.parse(JSON.stringify(waits[2]));
  assert.equal(last.f.range.kind, '7d', 'the first change is not dropped');
  assert.equal(last.v.measure, 'cost');
  // A model change made after both still carries both.
  waits[2].resolve(reply({ ...FILTER, range: { kind: '7d' } }, { ...VIEW, measure: 'cost' }));
  await tick();
  w.document.querySelector('select[data-field="model"]').value = 'm-1';
  w.document.querySelector('select[data-field="model"]').onchange();
  await tick();
  const next = JSON.parse(JSON.stringify(waits[3]));
  assert.equal(next.f.range.kind, '7d');
  assert.equal(next.f.model, 'm-1');
  assert.equal(next.v.measure, 'cost');
});

test('a stale reply after a measure change is dropped', async () => {
  const { waits, api } = deferred();
  const w = setup(api);
  const first = w.loadStats();
  await tick();
  waits[0].resolve(reply(FILTER, VIEW));
  await first;
  await tick();
  w.document.querySelector('.stats-chart-switch button[data-value="messages"]').click();
  await tick();
  w.document.querySelectorAll('.stats-chart-switch')[1].querySelector('button[data-value="model"]').click();
  await tick();
  assert.equal(waits.length, 3);
  waits[2].resolve(reply(FILTER, { ...VIEW, measure: 'messages', split: 'model' }));
  await tick();
  waits[1].resolve(reply(FILTER, { ...VIEW, measure: 'messages' }));
  await tick();
  const active = [...w.document.querySelectorAll('.stats-chart-switch .backend-filter-pill.active')].map(p => p.dataset.value);
  assert.deepEqual(active, ['messages', 'model'], 'the older reply did not overwrite the newer one');
});

test('a stale facets reply is dropped', async () => {
  const facetWaits = [];
  const w = setup({
    getStats: async (f) => reply(f || FILTER, VIEW),
    getStatsFacets: () => new Promise((resolve) => facetWaits.push(resolve)),
    getUsage: async () => ({ backends: [] }),
  });
  await w.loadStats();
  await tick();
  assert.equal(facetWaits.length, 1);
  await w.requestStats({ ...FILTER, range: { kind: '7d' } });
  await tick();
  assert.equal(facetWaits.length, 2);
  facetWaits[1]({ ok: true, backends: [], models: ['new-model'], projects: [] });
  await tick();
  facetWaits[0]({ ok: true, backends: [], models: ['old-model'], projects: [] });
  await tick();
  const values = [...w.document.querySelector('select[data-field="model"]').options].map(o => o.value);
  assert.ok(values.includes('new-model') && !values.includes('old-model'));
});

test('Reset asks main with an empty filter, which main turns into the defaults', async () => {
  const sent = [];
  const w = setup({
    getStats: async (f) => { sent.push(f); return reply(FILTER, VIEW); },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  await w.loadStats();
  w.document.querySelector('.stats-reset-btn').click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(sent[sent.length - 1])), {});
});

test('the chart observer is disconnected when the page is rebuilt or reloaded', async () => {
  const observers = [];
  const w = setup({
    getStats: async (f) => reply(f || FILTER, VIEW),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  w.ResizeObserver = class {
    constructor() { this.live = false; observers.push(this); }
    observe() { this.live = true; }
    disconnect() { this.live = false; }
  };
  await w.loadStats();
  await tick();
  assert.equal(observers.filter(o => o.live).length, 1);
  await w.requestStats({ ...FILTER, range: { kind: '7d' } });
  assert.equal(observers.filter(o => o.live).length, 1, 'the rebuilt page replaced the old observer, it did not add one');
  assert.equal(observers[0].live, false);
  await w.loadStats();
  await tick();
  assert.equal(observers.filter(o => o.live).length, 1, 'a reload keeps exactly one');
});

test('the first draw measures the attached host: no draw at the fallback width comes before it', async () => {
  const w = setup({
    getStats: async (f) => reply(f || FILTER, VIEW),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.classList && this.classList.contains('stats-chart-host') && this.isConnected ? 640 : 0; },
  });
  const widths = [];
  const make = w.document.createElementNS.bind(w.document);
  w.document.createElementNS = (ns, name) => { const el = make(ns, name); if (name === 'svg') widths.push(el); return el; };
  await w.loadStats();
  await tick();
  assert.equal(widths.length, 1, 'one draw, not a fallback draw and a second one');
  assert.equal(widths[0].getAttribute('width'), '640');
});

test('a hidden host (width 0) does not redraw; a host that really resized does', async () => {
  let width = 640;
  const observers = [];
  const w = setup({
    getStats: async (f) => reply(f || FILTER, VIEW),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.classList && this.classList.contains('stats-chart-host') ? width : 0; },
  });
  w.requestAnimationFrame = (fn) => { fn(); return 0; };
  w.ResizeObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() {}
  };
  await w.loadStats();
  await tick();
  const svgs = () => w.document.querySelectorAll('.stats-chart-svg');
  const first = svgs()[0];
  width = 0;
  observers[0].cb();
  assert.equal(svgs()[0], first, 'hidden: nothing redrawn');
  width = 500;
  observers[0].cb();
  assert.notEqual(svgs()[0], first, 'resized: redrawn');
  assert.equal(svgs()[0].getAttribute('width'), '500');
});

test('after a failed reply the next change builds on the last echo, not on what the failed request sent', async () => {
  const { waits, api } = deferred();
  const w = setup(api);
  const first = w.loadStats();
  await tick();
  waits[0].resolve(reply(FILTER, VIEW));
  await first;
  await tick();
  const model = w.document.querySelector('select[data-field="model"]');
  model.value = 'm-1';
  model.onchange();
  await tick();
  w.document.querySelector('.backend-filter-pill[data-range="7d"]').click();
  await tick();
  assert.equal(waits.length, 3);
  assert.equal(JSON.parse(JSON.stringify(waits[2].f)).model, 'm-1', 'the second change builds on the first');
  waits[2].resolve({ ok: false, error: 'The statistics could not be read.' });
  await tick();
  w.document.querySelector('.backend-filter-pill[data-range="90d"]').click();
  await tick();
  assert.equal(waits.length, 4);
  const third = JSON.parse(JSON.stringify(waits[3]));
  assert.equal(third.f.range.kind, '90d');
  assert.equal(third.f.model, null, 'the failed chain is gone: the third change starts from the last echo');
  assert.equal(third.v.measure, 'tokens');
});

// --- the left sidebar's project list (V7, T6) -----------------------------------------------------------------------------

const SIDE = [
  { projectPath: '/p/one', name: 'One', selectable: true, total: 3000, points: [0, 5, 10] },
  { projectPath: '', name: '(no project)', selectable: false, total: 40, points: [0, 0, 0] },
];

test('statsSparkPoints: the largest value is the top edge, zeros and an empty list are safe', () => {
  const w = setup({});
  assert.equal(w.statsSparkPoints([0, 5, 10], 60, 16), '0,15 30,8 60,1');
  assert.equal(w.statsSparkPoints([0, 0], 60, 16), '0,15 60,15');
  assert.equal(w.statsSparkPoints([], 60, 16), '');
  assert.equal(w.statsSparkPoints([7], 60, 16), '30,1');
});

test('buildStatsSpark: one point is a dot, two or more a polyline, both in currentColor', () => {
  const w = setup({});
  const one = w.buildStatsSpark([7]);
  assert.equal(one.querySelectorAll('polyline').length, 0);
  const dot = one.querySelector('circle');
  assert.ok(dot);
  assert.equal(dot.getAttribute('fill'), 'currentColor');
  const two = w.buildStatsSpark([1, 5]);
  assert.equal(two.querySelectorAll('circle').length, 0);
  assert.equal(two.querySelector('polyline').getAttribute('stroke'), 'currentColor');
});

test('statsSidebarShown: only a host that is on screen is built into', () => {
  const w = setup({});
  const host = w.document.createElement('div');
  assert.equal(w.statsSidebarShown(null), false);
  host.style.display = 'none';
  assert.equal(w.statsSidebarShown(host), false);
  host.style.display = '';
  assert.equal(w.statsSidebarShown(host), true);
});

test('the sidebar list builds nothing while its host is hidden, lists the rows when shown, and a click sets and clears the project', async () => {
  const sent = [];
  const w = setup({
    getStats: async (f, v) => { sent.push(f); return { ok: true, filter: f || FILTER, view: VIEW, payload: payload({ sidebar: SIDE }) }; },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  const host = w.document.createElement('div');
  host.id = 'stats-content';
  host.innerHTML = '<div class="plans-empty">placeholder</div>';
  host.style.display = 'none';
  w.document.body.appendChild(host);

  await w.loadStats();
  await tick();
  assert.equal(host.querySelector('.stats-side-row'), null, 'hidden: nothing was built');
  assert.match(host.textContent, /placeholder/);

  host.style.display = '';
  await w.requestStats(FILTER);
  await tick();
  const rows = [...host.querySelectorAll('.stats-side-row')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tagName, 'BUTTON');
  assert.equal(rows[0].querySelector('.stats-side-name').textContent, 'One');
  assert.equal(rows[0].querySelector('.stats-side-total').textContent, '3.0K');
  assert.ok(rows[0].querySelector('svg.stats-spark polyline'));
  assert.equal(rows[1].tagName, 'DIV', 'a row main did not flag selectable is no control');

  rows[0].click();
  await tick();
  assert.equal(JSON.parse(JSON.stringify(sent[sent.length - 1])).project, '/p/one');

  // The echo now names the project: the row is the active one and a second click clears it.
  await w.requestStats({ ...FILTER, project: '/p/one' });
  await tick();
  const active = host.querySelector('.stats-side-row.is-active');
  assert.equal(active.dataset.path, '/p/one');
  active.click();
  await tick();
  assert.equal(JSON.parse(JSON.stringify(sent[sent.length - 1])).project, null);
});

function failingSetup(answers) {
  const sent = [];
  const w = setup({
    getStats: async (f) => { sent.push(f); const a = answers.shift(); return a === 'fail' ? { ok: false, error: 'x' } : { ok: true, filter: f || FILTER, view: VIEW, payload: payload({ sidebar: SIDE }) }; },
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
  });
  const host = w.document.createElement('div');
  host.id = 'stats-content';
  host.innerHTML = '<div class="plans-empty">Reading projects…</div>';
  w.document.body.appendChild(host);
  return { w, host, sent };
}

test('a failed answer after a success puts a notice above the unchanged list; the next success removes it', async () => {
  const { w, host } = failingSetup(['ok', 'fail', 'ok']);
  await w.loadStats();
  await tick();
  assert.equal(host.querySelectorAll('.stats-side-row').length, 2);
  await w.requestStats(FILTER);
  await tick();
  const notice = host.querySelector('.stats-side-notice');
  assert.ok(notice);
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.textContent, 'Could not refresh. Showing the last list.');
  assert.equal(notice.nextElementSibling, host.querySelector('.stats-side-list'));
  assert.equal(host.querySelectorAll('.stats-side-row').length, 2, 'rows kept');
  await w.requestStats(FILTER);
  await tick();
  assert.equal(host.querySelector('.stats-side-notice'), null);
  assert.equal(host.querySelectorAll('.stats-side-row').length, 2);
});

test('a failed first answer replaces the placeholder with the message and offers Reset filter with a non-null default', async () => {
  const { w, host, sent } = failingSetup(['fail', 'ok']);
  await w.loadStats();
  await tick();
  assert.equal(host.textContent, 'The projects could not be read.');
  assert.equal(host.querySelector('.stats-side-notice').getAttribute('role'), 'status');
  const btn = [...w.document.querySelectorAll('.stats-results button')].find(b => b.textContent === 'Reset filter');
  assert.ok(btn, 'a first-load failure has a way out');
  assert.ok(btn.classList.contains('settings-action-btn'));
  btn.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(sent[sent.length - 1])), {});
  assert.equal(host.querySelector('.stats-side-notice'), null);
});

test('a failed answer leaves a hidden sidebar host alone', async () => {
  const { w, host } = failingSetup(['fail']);
  host.style.display = 'none';
  await w.loadStats();
  await tick();
  assert.equal(host.textContent, 'Reading projects…');
});
