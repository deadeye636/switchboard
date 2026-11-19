// The Stats page's usage-windows block (#883 step 3, spec 48 V11): a jsdom run of stats-view.js against a stubbed
// `window.api`. The click test is the real check (reflex 2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { usageLevel } = require('../src/renderer/shell/usage-status');

const FILE = path.join(__dirname, '..', 'src', 'renderer', 'views', 'stats-view.js');
const CHART_FILE = path.join(__dirname, '..', 'src', 'renderer', 'views', 'stats-chart.js');
const HTML = '<!DOCTYPE html><html><body><div id="stats-viewer-body"></div></body></html>';

function setup(api) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window, 'statsViewerBody', { value: window.document.getElementById('stats-viewer-body'), configurable: true });
  window.api = api;
  window.backendIconKnownColour = () => null;
  window.usageLevel = usageLevel;
  vm.runInContext(fs.readFileSync(CHART_FILE, 'utf8'), dom.getInternalVMContext(), { filename: CHART_FILE });
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), dom.getInternalVMContext(), { filename: FILE });
  return window;
}
const tick = () => new Promise(r => setTimeout(r, 0));

function figures() {
  return { sessions: 12, messages: 340, toolCalls: 90, input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 400, tokens: 3000, cost: null, cacheRate: 0.8, costSessions: 0, activeDays: 5 };
}
function payload(empty) {
  const p = {
    range: { kind: '30d', from: '2026-10-20', to: '2026-11-18', days: 30, prevFrom: null, prevTo: null, includesToday: true },
    keyFigures: { cur: figures(), prev: null, change: {}, cacheExcluded: [] },
    series: {}, projects: [], models: [], backends: [], sessions: [],
    heatmap: { from: '2025-11-19', to: '2026-11-18', days: [{ date: '2026-11-17', messages: 3 }] },
    grid: [{ weekday: 1, hour: 9, messages: 4, tokens: 10 }],
    sidebar: [],
  };
  if (empty) p.keyFigures.cur = { ...figures(), sessions: 0, messages: 0, tokens: 0 };
  return p;
}
const FILTER = { v: 1, range: { kind: '30d' }, backend: null, project: null, model: null };
const FACETS = { ok: true, backends: [], models: [], projects: [] };

const FUTURE = new Date(Date.now() + 3 * 3600e3).toISOString();
function win(basis, extra) {
  return {
    backendId: 'b1', backendLabel: 'Backend One', colour: 'tok', icon: 'b1', key: 'five_hour', label: '5h', percent: 40,
    resetsAt: FUTURE, startsAt: null, windowMinutes: 300, elapsedFraction: 0.4,
    projection: { ratePerHour: 8, projectedAtReset: 70, reachesLimitAt: null, basis, asOf: null },
    machine: null, ...extra,
  };
}
function api(over) {
  return {
    getStats: async () => ({ ok: true, filter: FILTER, view: {}, payload: payload() }),
    getStatsFacets: async () => FACETS,
    getUsage: async () => ({ backends: [] }),
    setStatsRhythm: async () => {},
    getStatsUsageWindows: async () => ({ ok: true, windows: [win('linear')] }),
    ...over,
  };
}
async function load(w) { await w.loadStats(); await tick(); await tick(); }
const text = (w, sel) => [...w.document.querySelectorAll(sel)].map(e => e.textContent).join('|');

test('each basis renders its line', async () => {
  const cases = [
    ['linear', /~8 %\/h · projected ~70 % at reset \(projection\)/],
    ['samples', /projected ~70 %/],
    ['too-early', /too early to project/],
    ['reached', /limit reached, resets/],
    ['expired', /window ended — waiting for a new reading/],
  ];
  for (const [basis, re] of cases) {
    const w = setup(api({ getStatsUsageWindows: async () => ({ ok: true, windows: [win(basis)] }) }));
    await load(w);
    assert.match(text(w, '.stats-window-projection'), re, basis);
  }
  const w = setup(api({ getStatsUsageWindows: async () => ({ ok: true, windows: [win('samples'), win('linear', { key: 'x' })] }) }));
  await load(w);
  const tips = [...w.document.querySelectorAll('.stats-window-projection')].map(e => e.title);
  assert.match(tips[0], /last hour/);
  assert.match(tips[1], /since the window started/);
});

test('the limit-reached time is named when the pace reaches it; the window label, percent and reset show', async () => {
  const at = new Date(Date.now() + 3600e3).toISOString();
  const w = setup(api({ getStatsUsageWindows: async () => ({ ok: true, windows: [win('linear', { projection: { ratePerHour: 30, projectedAtReset: 160, reachesLimitAt: at, basis: 'linear', asOf: null } })] }) }));
  await load(w);
  const t = text(w, '.stats-window-projection');
  assert.doesNotMatch(t, /projected ~/, 'a pace over the limit is said as a time, not as a capped percent');
  assert.match(t, /at this pace the limit is reached around .+ \(projection\)/);
  assert.match(text(w, '.stats-window-label'), /Backend One · 5h/);
  assert.match(text(w, '.usage-card-pct'), /40%/);
  assert.match(text(w, '.stats-window-reset'), /^resets /);
});

test('machine null shows no second line; a machine reading shows tokens, cost and rate; asOf is shown', async () => {
  let w = setup(api());
  await load(w);
  assert.equal(w.document.querySelector('.stats-window-machine'), null);
  assert.equal(w.document.querySelector('.stats-window-asof'), null);
  const asOf = new Date(Date.now() - 600e3).toISOString();
  w = setup(api({ getStatsUsageWindows: async () => ({ ok: true, windows: [
    win('linear', { machine: { tokens: 1500000, cost: { usd: 2.5, estimated: true }, tokensPerHour: 12000 }, projection: { ratePerHour: 8, projectedAtReset: 70, reachesLimitAt: null, basis: 'linear', asOf } }),
    win('linear', { key: 'k2', machine: { tokens: 10, cost: null, tokensPerHour: 1 } }),
  ] }) }));
  await load(w);
  const lines = [...w.document.querySelectorAll('.stats-window-machine')].map(e => e.textContent);
  assert.match(lines[0], /^this machine: 1\.5M tokens · ~\$2\.50 · ~12\.0K tok\/h$/);
  assert.match(lines[1], /tokens · — · /);
  assert.match(text(w, '.stats-window-asof'), /^as of /);
});

test('the backend filter id is passed; null for all; a model change does not re-ask', async () => {
  const asked = [];
  let filter = FILTER;
  const w = setup(api({
    getStats: async () => ({ ok: true, filter, view: {}, payload: payload() }),
    getStatsUsageWindows: async (b) => { asked.push(b); return { ok: true, windows: [win('linear')] }; },
  }));
  await load(w);
  assert.deepEqual(asked, [null]);
  filter = { ...FILTER, backend: 'b1' };
  await w.requestStats(filter);
  await tick(); await tick();
  assert.equal(asked[asked.length - 1], 'b1');
  const n = asked.length;
  filter = { ...FILTER, backend: 'b1', model: 'm' };
  await w.requestStats(filter);
  await tick(); await tick();
  assert.equal(asked.length, n);
});

test('a stale answer is dropped by generation; the newer one stays', async () => {
  const gates = [];
  const w = setup(api({ getStatsUsageWindows: () => new Promise(r => gates.push(r)) }));
  await w.loadStats();
  await tick(); await tick();
  const first = gates.length;
  w.loadStatsWindows();
  assert.equal(gates.length, first + 1);
  gates[gates.length - 1]({ ok: true, windows: [win('too-early')] });
  await tick();
  gates[0]({ ok: true, windows: [win('expired')] });
  await tick();
  assert.match(text(w, '.stats-window-projection'), /too early/);
  assert.doesNotMatch(text(w, '.stats-window-projection'), /window ended/);
});

test('a failed or empty read leaves the page intact and no block, no heading', async () => {
  for (const getStatsUsageWindows of [async () => { throw new Error('x'); }, async () => ({ ok: false, error: 'no' }), async () => ({ ok: true, windows: [] })]) {
    const w = setup(api({ getStatsUsageWindows }));
    await load(w);
    assert.equal(w.document.querySelector('.stats-windows'), null);
    assert.equal(w.document.querySelectorAll('.stats-tile').length, 6);
    assert.doesNotMatch(w.document.body.textContent, /Usage windows/);
  }
});

test('the block sits below Rhythm, and is present on the empty page', async () => {
  let w = setup(api());
  await load(w);
  const kids = [...w.document.querySelector('.stats-results').children].map(e => e.className.split(' ')[0]);
  assert.ok(kids.indexOf('stats-windows') > kids.indexOf('stats-rhythm'));
  w = setup(api({ getStats: async () => ({ ok: true, filter: FILTER, view: {}, payload: payload(true) }) }));
  await load(w);
  assert.ok(w.document.querySelector('.stats-windows .stats-window-card'));
});

test('the bar level is the shared usageLevel answer for a given percent', async () => {
  for (const percent of [10, 50, 79, 80, 94, 95, 100]) {
    const w = setup(api({ getStatsUsageWindows: async () => ({ ok: true, windows: [win('linear', { percent })] }) }));
    await load(w);
    const fill = w.document.querySelector('.stats-window-card .usage-fill');
    const level = usageLevel(percent);
    assert.equal(fill.classList.contains(`usage-fill-${level}`), level !== 'normal', `${percent}% ${level}`);
    assert.equal(fill.className.split(' ').filter(c => c.startsWith('usage-fill-')).length, level === 'normal' ? 0 : 1);
  }
});

test('a backend change always re-asks: All, a backend without windows, one with windows, All', async () => {
  let filter = FILTER;
  const byBackend = { b1: [win('linear')], none: [], null: [win('linear'), win('linear', { key: 'k2' })] };
  const w = setup(api({
    getStats: async () => ({ ok: true, filter, view: {}, payload: payload() }),
    getStatsUsageWindows: async (b) => ({ ok: true, windows: byBackend[b] || [] }),
  }));
  const cards = () => w.document.querySelectorAll('.stats-window-card').length;
  await load(w);
  assert.equal(cards(), 2, 'all');
  for (const [backend, want] of [['none', 0], ['b1', 1], [null, 2]]) {
    filter = { ...FILTER, backend };
    await w.requestStats(filter);
    await tick(); await tick();
    assert.equal(cards(), want, String(backend));
  }
});

test('a backend change with a second request and a usage reload in flight still ends with the right block', async () => {
  let filter = FILTER;
  const byBackend = { none: [], b1: [win('linear')] };
  const w = setup(api({
    getStats: async () => ({ ok: true, filter, view: {}, payload: payload() }),
    getStatsUsageWindows: async (b) => ({ ok: true, windows: byBackend[b] || [] }),
  }));
  const cards = () => w.document.querySelectorAll('.stats-window-card').length;
  await load(w);
  filter = { ...FILTER, backend: 'none' };
  await w.requestStats(filter);
  await tick(); await tick();
  assert.equal(cards(), 0);
  filter = { ...FILTER, backend: 'b1' };
  const pending = w.requestStats(filter);
  w.loadStatsWindows(); // a usage refresh landing while the request is out
  await pending;
  await w.requestStats(filter); // and a second request for the same page
  await tick(); await tick();
  assert.equal(cards(), 1);
});

test('A drawn, switch to B (read in flight), back to A: the late B answer is dropped and A stays', async () => {
  let filter = { ...FILTER, backend: 'a' };
  const gates = [];
  const w = setup(api({
    getStats: async () => ({ ok: true, filter, view: {}, payload: payload() }),
    getStatsUsageWindows: (b) => new Promise(r => gates.push({ b, r })),
  }));
  const answer = () => { for (const g of gates.splice(0)) g.r({ ok: true, windows: g.b === 'a' ? [win('linear')] : [] }); };
  const cards = () => w.document.querySelectorAll('.stats-window-card').length;
  await w.loadStats(); await tick(); await tick();
  answer(); await tick(); await tick();
  assert.equal(cards(), 1, 'A drawn');
  filter = { ...FILTER, backend: 'b' };
  await w.requestStats(filter); await tick();
  filter = { ...FILTER, backend: 'a' };
  await w.requestStats(filter); await tick();
  answer(); await tick(); await tick();
  answer(); await tick(); await tick();
  assert.equal(cards(), 1, 'A block still there after the stale B answer');
});

test('a far date carries the day; an unparseable asOf shows no line; a missing percent shows a dash and no fill', async () => {
  const w = setup(api());
  const now = Date.UTC(2026, 10, 19, 12);
  const near = w.statsWindowTime(new Date(now + 2 * 86400e3).toISOString(), now);
  const far = w.statsWindowTime(new Date(now + 7 * 86400e3).toISOString(), now);
  assert.ok(far.length > near.length, `${far} vs ${near}`);
  assert.equal(w.statsWindowLines(win('linear', { projection: { ratePerHour: 1, projectedAtReset: 5, reachesLimitAt: null, basis: 'linear', asOf: 'nonsense' } }), now).asOf, '');
  const w2 = setup(api({ getStatsUsageWindows: async () => ({ ok: true, windows: [win('too-early', { percent: null })] }) }));
  await load(w2);
  assert.equal(w2.document.querySelector('.usage-card-pct').textContent, '—');
  assert.equal(w2.document.querySelector('.usage-fill').style.width, '0%');
});
