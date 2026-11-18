'use strict';
// src/app/stats.js (#877, spec 48): the Stats page's main-process side, driven with a fake ctx and a fake db.
const test = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../src/app/stats');

const D = (over) => ({ status: 'ready', enabled: true, colour: 'c', icon: 'i', cacheAccounting: 'additive', costSettled: () => false, ...over });
const DESCRIPTORS = [
  D({ id: 'alpha', label: 'Alpha', colour: 'alpha', icon: 'a-icon' }),
  D({ id: 'alpha-gui', label: 'Alpha GUI', transcriptsOf: 'alpha' }),
  D({ id: 'beta', label: 'Beta', cacheAccounting: 'included' }),
  D({ id: 'gamma', label: 'Gamma', cacheAccounting: 'none' }),
  D({ id: 'delta', label: 'Delta', costSettled: (s) => s === 'actual' }),
  D({ id: 'off', label: 'Off', enabled: false }),
  D({ id: 'tmpl-beta', label: 'My template', isProfile: true, baseId: 'beta', cacheAccounting: 'included' }),
  D({ id: 'tmpl-gui', label: 'GUI template', isProfile: true, baseId: 'alpha-gui' }),
];

const UNC_PREFIX = '\\\\';
const UNC = UNC_PREFIX + 'nas' + '\\' + 'share' + '\\' + 'proj';
const ROOT = '/work/proj-a';
const WT = '/work/proj-a/.claude/worktrees/wt1';
const OTHER = '/work/proj-b';

function makeCtx(over = {}) {
  const store = new Map();
  const calls = { payload: [], facets: [], refresh: 0, sets: [], foreign: [] };
  const ctx = {
    getSetting: (k) => store.get(k),
    setSetting: (k, v) => { calls.sets.push([k, v]); store.set(k, v); },
    log: { debug() {}, warn() {}, error() {} },
    now: () => new Date(2026, 10, 18, 12, 0, 0),   // local 2026-11-18
    backends: {
      list: () => DESCRIPTORS,
      rowOwnerOf: (id) => { const d = DESCRIPTORS.find(x => x.id === id); return d && d.transcriptsOf ? d.transcriptsOf : id; },
    },
    refreshKnownWorktrees: () => { calls.refresh++; },
    isForeignNetworkFile: (p) => { calls.foreign.push(p); return String(p).startsWith(UNC_PREFIX); },
    db: {
      getStatsFirstDate: () => '2026-09-01',
      getStatsProjectPaths: () => [ROOT, WT, OTHER],
      getProjectStates: () => new Map([[ROOT, { registered: true }], ['/work/gone', { removedAt: 5 }]]),
      getProjectDisplayNames: () => new Map([[ROOT, 'Project A']]),
      getStatsPayload: (req) => { calls.payload.push(req); return over.raw ? over.raw(req) : emptyRaw(); },
      getStatsFacets: (f) => { calls.facets.push(f); return { models: ['m2', 'm1'], backends: ['alpha', 'beta', 'off', 'tmpl-gui'] }; },
    },
    ...over.ctx,
  };
  stats.init(ctx);
  return { ctx, calls, store };
}

function emptyRaw() {
  return { keyFigures: [], periodCounts: [], series: [], projects: [], models: [], backends: [], sessions: [], heatmap: [], grid: [], sidebar: [] };
}

const know = {
  backends: new Set(['alpha', 'beta']),
  projects: new Map(),
};

test('range: unknown falls back, day and custom are checked', () => {
  assert.deepEqual(stats.sanitiseRange('nope'), { kind: '30d' });
  assert.deepEqual(stats.sanitiseRange({ kind: '90d' }), { kind: '90d' });
  assert.deepEqual(stats.sanitiseRange({ day: '2026-02-03' }), { kind: 'day', from: '2026-02-03', to: '2026-02-03' });
  assert.deepEqual(stats.sanitiseRange({ kind: 'day', from: '2026-02-30' }), { kind: '30d' });
  assert.deepEqual(stats.sanitiseRange({ kind: 'custom', from: '2026-01-02', to: '2026-01-09' }), { kind: 'custom', from: '2026-01-02', to: '2026-01-09' });
  assert.deepEqual(stats.sanitiseRange({ kind: 'custom', from: '2026-01-09', to: '2026-01-02' }), { kind: '30d' });
});

test('filter: backend and project that are not known are dropped, model is capped', () => {
  makeCtx();
  const f = stats.sanitiseFilter({ range: '7d', backend: 'gone', project: '/nowhere', model: 'x'.repeat(500) }, know);
  assert.equal(f.backend, null);
  assert.equal(f.project, null);
  assert.equal(f.model.length, 200);
  assert.equal(stats.sanitiseFilter({ backend: 'beta' }, know).backend, 'beta');
  assert.deepEqual(stats.sanitiseFilter(null, know), { v: 1, range: { kind: '30d' }, backend: null, project: null, model: null });
});

test('range resolution: 7d, year, all, previous period', () => {
  const r7 = stats.resolveRange({ kind: '7d' }, '2026-11-18', null);
  assert.deepEqual([r7.from, r7.to, r7.days, r7.prevFrom, r7.prevTo], ['2026-11-12', '2026-11-18', 7, '2026-11-05', '2026-11-11']);
  const y = stats.resolveRange({ kind: 'year' }, '2026-11-18', null);
  assert.equal(y.days, 365);
  assert.equal(y.from, '2025-11-19');
  const all = stats.resolveRange({ kind: 'all' }, '2026-11-18', '2026-09-01');
  assert.deepEqual([all.from, all.to, all.prevFrom], ['2026-09-01', '2026-11-18', null]);
  assert.equal(stats.resolveRange({ kind: 'all' }, '2026-11-18', null).from, '2026-11-18');
  const day = stats.resolveRange({ kind: 'day', from: '2026-03-01', to: '2026-03-01' }, '2026-11-18', null);
  assert.deepEqual([day.days, day.prevFrom, day.prevTo, day.includesToday], [1, '2026-02-28', '2026-02-28', false]);
});

test('the local clock decides today, not UTC', () => {
  assert.equal(stats.localDayKey(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
});

test('backend fold: template, driver and template-on-driver join the CLI (#752)', () => {
  const { ctx } = makeCtx();
  const idx = { list: ctx.backends.list(), byId: new Map(ctx.backends.list().map(b => [b.id, b])) };
  assert.deepEqual(stats.backendIds('alpha', idx).sort(), ['alpha', 'alpha-gui', 'tmpl-gui']);
  assert.deepEqual(stats.backendIds('beta', idx).sort(), ['beta', 'tmpl-beta']);
  assert.equal(stats.bucketOf('tmpl-gui', idx), 'alpha');
  assert.equal(stats.bucketOf('removed-template', idx), 'removed', 'an id the registry no longer lists shares one neutral bucket');
});

test('get: remembers the sanitised filter, refreshes worktrees first, folds the project filter', () => {
  const { calls, store } = makeCtx();
  const res = stats.getStats({ range: '7d', backend: 'alpha', project: WT, model: ' m1 ' }, { measure: 'cost', split: 'bogus' });
  assert.equal(res.ok, true);
  assert.ok(calls.refresh >= 1);
  assert.equal(res.filter.backend, 'alpha');
  assert.equal(res.filter.model, 'm1');
  assert.equal(res.view.split, 'backend');
  assert.equal(res.view.measure, 'cost');
  assert.deepEqual(store.get(stats.FILTER_KEY), res.filter);
  const req = calls.payload[0];
  assert.deepEqual(req.filter.backend.slice().sort(), ['alpha', 'alpha-gui', 'tmpl-gui']);
  assert.equal(req.filter.from, '2026-11-12');
  assert.equal(req.prevFrom, '2026-11-05');
  assert.equal(req.heatmap.to, '2026-11-18');
  assert.equal(req.heatmap.from, '2025-11-19');
  assert.equal(new Set(req.filter.projects).has(ROOT), true);
  assert.equal(new Set(req.filter.projects).has(WT), true);
  assert.equal(new Set(req.filter.projects).has(OTHER), false);
  assert.equal(res.filter.project, ROOT, 'a worktree asked for is echoed as its owner');
});

test('get: no filter argument reads the remembered one; a removed project is dropped', () => {
  const { store } = makeCtx();
  store.set(stats.FILTER_KEY, { v: 1, range: { kind: '90d' }, backend: 'off', project: '/work/gone', model: null });
  const res = stats.getStats(null);
  assert.equal(res.filter.range.kind, '90d');
  assert.equal(res.filter.backend, null, 'a disabled backend falls back to all');
  assert.equal(res.filter.project, null);
});

test('get: a failure answers a fixed sentence, not the raw error', () => {
  makeCtx({ raw: () => { throw new Error('ENOENT /secret/path'); } });
  const res = stats.getStats(null);
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.error, /secret|ENOENT/);
});

test('key figures: previous period, change, weighted cache rate, excluded backends named', () => {
  makeCtx({
    raw: () => ({
      ...emptyRaw(),
      keyFigures: [
        // additive: input 100, read 300 -> base 400, hit 300
        { backendId: 'alpha', costStatus: null, cur: 1, messages: 10, toolCalls: 2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheCreationTokens: 0, estimatedCostUsd: 1, actualCostUsd: null },
        // included: input 200 holds the 100 cached -> base 200, hit 100; shown input 100
        { backendId: 'tmpl-beta', costStatus: null, cur: 1, messages: 5, toolCalls: 0, inputTokens: 200, outputTokens: 20, cacheReadTokens: 100, cacheCreationTokens: 0, estimatedCostUsd: null, actualCostUsd: null },
        // none: contributes nothing, named
        { backendId: 'gamma', costStatus: null, cur: 1, messages: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: null, actualCostUsd: null },
        { backendId: 'alpha', costStatus: null, cur: 0, messages: 20, toolCalls: 0, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: 2, actualCostUsd: null },
      ],
      periodCounts: [
        { cur: 1, sessions: 4, costSessions: 2, activeDays: 3 },
        { cur: 0, sessions: 2, costSessions: 1, activeDays: 6 },
      ],
    }),
  });
  const kf = stats.getStats({ range: '7d' }).payload.keyFigures;
  assert.equal(kf.cur.sessions, 4);
  assert.equal(kf.cur.messages, 16);
  assert.equal(kf.cur.input, 100 + 100 + 10, 'included input is shown without the cached part');
  assert.equal(kf.cur.tokens, 100 + 50 + 200 + 20 + 15, 'tokens stay input + output as stored');
  assert.equal(kf.cur.cacheRate, 400 / 600);
  assert.deepEqual(kf.cacheExcluded, ['Gamma']);
  assert.equal(kf.prev.messages, 20);
  assert.equal(kf.change.messages, (16 - 20) / 20);
  assert.equal(kf.change.cost, (1 - 2) / 2);
  assert.equal(kf.prev.cacheRate, 0, 'a real base with no cache read is 0 %, which is not the same as no answer');
});

test('key figures: all has no previous period; no reporting backend is null, not 0 %', () => {
  makeCtx({
    raw: () => ({
      ...emptyRaw(),
      keyFigures: [{ backendId: 'gamma', costStatus: null, cur: 1, messages: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: null, actualCostUsd: null }],
      periodCounts: [{ cur: 1, sessions: 1, costSessions: 0, activeDays: 1 }],
    }),
  });
  const kf = stats.getStats({ range: 'all' }).payload.keyFigures;
  assert.equal(kf.prev, null);
  assert.equal(kf.change.messages, null);
  assert.equal(kf.cur.cacheRate, null);
  assert.equal(kf.cur.cost, null);
});

test('cost is settled only when the status AND an actual figure say so', () => {
  const { ctx } = makeCtx();
  const idx = { list: ctx.backends.list(), byId: new Map(ctx.backends.list().map(b => [b.id, b])) };
  const settled = stats.costFold([{ backendId: 'delta', costStatus: 'actual', actualCostUsd: 2, estimatedCostUsd: null }], idx);
  assert.deepEqual(settled, { usd: 2, estimated: false });
  // a settled status word with no actual figure: only an estimate exists
  assert.deepEqual(stats.costFold([{ backendId: 'delta', costStatus: 'actual', actualCostUsd: null, estimatedCostUsd: 1 }], idx), { usd: 1, estimated: true });
  // an actual under an unsettled status is an estimate
  assert.deepEqual(stats.costFold([{ backendId: 'delta', costStatus: 'estimated', actualCostUsd: 3, estimatedCostUsd: null }], idx), { usd: 3, estimated: true });
  // any estimated part makes the sum one
  assert.equal(stats.costFold([
    { backendId: 'delta', costStatus: 'actual', actualCostUsd: 2, estimatedCostUsd: null },
    { backendId: 'alpha', costStatus: null, actualCostUsd: null, estimatedCostUsd: 1 },
  ], idx).estimated, true);
  assert.equal(stats.costFold([{ backendId: 'delta', costStatus: null, actualCostUsd: null, estimatedCostUsd: null }], idx), null);
});

test('backends table folds a template and a driver onto the CLI and carries label, colour, icon', () => {
  makeCtx({
    raw: () => ({
      ...emptyRaw(),
      backends: [
        { backendId: 'alpha', costStatus: null, sessions: 2, messages: 3, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: 1, actualCostUsd: null },
        { backendId: 'tmpl-gui', costStatus: null, sessions: 1, messages: 1, inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: null, actualCostUsd: null },
      ],
    }),
  });
  const rows = stats.getStats({ range: '7d' }).payload.backends;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].label, rows[0].colour, rows[0].icon, rows[0].sessions, rows[0].tokens], ['alpha', 'Alpha', 'alpha', 'a-icon', 3, 20]);
});

test('series: backend split folds onto the CLI, top 8 plus Other, partial last bucket', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ bucket: '2026-11-17', key: `m${i}`, value: 100 - i });
  makeCtx({ raw: () => ({ ...emptyRaw(), series: rows }) });
  const s = stats.getStats({ range: '30d' }, { split: 'model' }).payload.series;
  assert.equal(s.bucket, 'day');
  assert.equal(s.keys.length, 9);
  assert.equal(s.keys[8].other, true);
  const b = s.buckets.find(x => x.bucket === '2026-11-17');
  assert.equal(b.values.__other__, 92 + 91);
  assert.equal(s.buckets.length, 30);

  makeCtx({
    raw: () => ({ ...emptyRaw(), series: [{ bucket: '2026-11-18', key: 'alpha', value: 5 }, { bucket: '2026-11-18', key: 'tmpl-gui', value: 7 }, { bucket: '2026-11-18', key: 'alpha-gui', value: 1 }] }),
  });
  const s2 = stats.getStats({ range: '30d' }, { split: 'backend' }).payload.series;
  assert.deepEqual(s2.keys.map(k => [k.key, k.label]), [['alpha', 'Alpha']]);
  assert.equal(s2.buckets[s2.buckets.length - 1].values.alpha, 13);
});

test('series: a week bucket that is not over yet is flagged partial', () => {
  makeCtx();
  const s = stats.getStats({ range: 'year' }).payload.series;
  assert.equal(s.bucket, 'week');
  assert.equal(s.partialLast, true);
  assert.equal(s.buckets[s.buckets.length - 1].bucket, '2026-11-16');
  const done = stats.enumerateBuckets('2026-01-01', '2026-03-31', 'month');
  assert.deepEqual(done.map(b => b.key), ['2026-01', '2026-02', '2026-03']);
});

test('projects: a worktree folds into its owner, with the display name; a long tail becomes Other', () => {
  makeCtx({
    raw: () => ({
      ...emptyRaw(),
      projects: [
        { projectPath: ROOT, costBackendId: 'alpha', costStatus: null, sessions: 1, messages: 2, tokens: 10, estimatedCostUsd: 1, actualCostUsd: null },
        { projectPath: WT, costBackendId: 'delta', costStatus: 'actual', sessions: 2, messages: 3, tokens: 5, estimatedCostUsd: null, actualCostUsd: 2 },
        { projectPath: OTHER, costBackendId: 'alpha', costStatus: null, sessions: 1, messages: 1, tokens: 1, estimatedCostUsd: null, actualCostUsd: null },
      ],
    }),
  });
  const rows = stats.getStats({ range: '7d' }).payload.projects;
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].name, rows[0].sessions, rows[0].tokens, rows[0].projectPath], ['Project A', 3, 15, ROOT]);
  // an estimate part (alpha) makes the sum an estimate; the worktree's settled actual alone would not
  assert.deepEqual(rows[0].cost, { usd: 3, estimated: true });
  assert.equal(rows[1].name, 'proj-b');
  assert.equal(rows[1].cost, null);

  const many = [];
  for (let i = 0; i < 53; i++) many.push({ projectPath: `/work/p${i}`, costBackendId: 'alpha', costStatus: null, sessions: 1, messages: 1, tokens: 100 - i, estimatedCostUsd: null, actualCostUsd: null });
  makeCtx({ raw: () => ({ ...emptyRaw(), projects: many }) });
  const capped = stats.getStats({ range: '7d' }).payload.projects;
  assert.equal(capped.length, 51);
  assert.equal(capped[50].other, true);
  assert.equal(capped[50].sessions, 3);
});

test('facets: backends folded onto launchable CLIs, models, projects', () => {
  makeCtx();
  const f = stats.getFacets({ range: '7d' });
  assert.equal(f.ok, true);
  assert.deepEqual(f.backends.map(b => b.id), ['alpha', 'beta']);
  assert.deepEqual(f.models, ['m1', 'm2']);
  assert.deepEqual(f.projects.map(p => p.path).sort(), [ROOT, OTHER].sort());
});

test('registerIpc binds the two channels', () => {
  makeCtx();
  const seen = [];
  stats.registerIpc({ handle: (name) => seen.push(name) });
  assert.deepEqual(seen, ['stats-get', 'stats-facets']);
});

test('tables: a fully settled backend row is not an estimate, an unsettled actual is', () => {
  const m = (model, b, st, est, act) => ({ model, sessions: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costBackendId: b, costStatus: st, estimatedCostUsd: est, actualCostUsd: act });
  makeCtx({
    raw: () => ({
      ...emptyRaw(),
      models: [m('m1', 'delta', 'actual', null, 2), m('m2', 'delta', 'estimated', null, 3), m('m2', 'alpha', null, 1, null)],
      sessions: [
        { sessionId: 'a', backendId: 'delta', costStatus: 'actual', estimatedCostUsd: null, actualCostUsd: 4, messages: 1, tokens: 1, projectPath: ROOT },
        { sessionId: 'b', backendId: 'gone-template', costStatus: null, estimatedCostUsd: 1, actualCostUsd: null, messages: 1, tokens: 1, projectPath: ROOT },
      ],
      series: [{ bucket: '2026-11-18', key: 'delta', value: 2, costBackendId: 'delta', costStatus: 'actual', estimatedCostUsd: null, actualCostUsd: 2 }],
    }),
  });
  const res = stats.getStats({ range: '7d' }, { measure: 'cost' }).payload;
  const byModel = Object.fromEntries(res.models.map(x => [x.model, x]));
  assert.deepEqual(byModel.m1.cost, { usd: 2, estimated: false });
  assert.deepEqual(byModel.m2.cost, { usd: 4, estimated: true });
  assert.equal(byModel.m2.sessions, 2, 'rows of one model add');
  assert.deepEqual(res.sessions[0].cost, { usd: 4, estimated: false });
  assert.equal(res.sessions[1].backend.id, 'removed');
  assert.equal(res.series.estimated, false);
});

test('a backend id the registry no longer lists goes to one neutral bucket', () => {
  const row = (id) => ({ backendId: id, costStatus: null, sessions: 1, messages: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: null, actualCostUsd: null });
  makeCtx({ raw: () => ({ ...emptyRaw(), backends: [row('dead-template-1'), row('dead-template-2')] }) });
  const res = stats.getStats({ range: '7d' }).payload;
  assert.equal(res.backends.length, 1);
  assert.deepEqual([res.backends[0].id, res.backends[0].label, res.backends[0].sessions], ['removed', 'Removed backend or template', 2]);
});

test('project filter: capped, matched lexically first, a foreign network path is refused', () => {
  const { calls } = makeCtx();
  const huge = stats.getStats({ range: '7d', project: 'x'.repeat(100000) });
  assert.equal(huge.filter.project, null);
  assert.equal(calls.foreign.includes('x'.repeat(100000)), false, 'over the cap it is refused before anything else');

  // Under the length cap but deep: the real-path walk is quadratic in segments, so depth is capped too.
  const deep = '/a'.repeat(2000);
  const deepRes = stats.getStats({ range: '7d', project: deep });
  assert.equal(deepRes.filter.project, null);
  assert.equal(calls.foreign.includes(deep), false, 'too deep is refused before the network guard');

  const exact = stats.getStats({ range: '7d', project: ROOT });
  assert.equal(exact.filter.project, ROOT);

  const unc = stats.getStats({ range: '7d', project: UNC });
  assert.equal(unc.filter.project, null);
  assert.equal(calls.foreign.includes(UNC), true);
});

test('a network path among the known project paths is keyed lexically and can be filtered on', () => {
  const { ctx } = makeCtx();
  ctx.db.getStatsProjectPaths = () => [ROOT, UNC];
  const res = stats.getStats({ range: '7d', project: UNC });
  assert.equal(res.ok, true);
  assert.equal(res.filter.project, UNC);
});

test('prototype keys and odd values never become a filter', () => {
  const know = { backends: new Set(['alpha']), projects: new Map(), exact: new Map() };
  const f = stats.sanitiseFilter(JSON.parse('{"__proto__":{"x":1},"range":{"kind":"__proto__"},"backend":"constructor","project":"__proto__","model":"toString"}'), know);
  assert.deepEqual(f.range, { kind: '30d' });
  assert.equal(f.backend, null);
  assert.equal(f.project, null);
  assert.equal(f.model, 'toString', 'a model is just a string');
  assert.deepEqual(stats.sanitiseView({ measure: '__proto__', split: 'constructor' }), { measure: 'tokens', split: 'backend', sessionsBy: 'tokens' });
  assert.deepEqual(stats.sanitiseFilter({ range: 5, backend: 7, project: ['x'], model: {} }, know), stats.defaultFilter());
});

test('the filter is written once, not again on a repeat', () => {
  const { calls } = makeCtx();
  stats.getStats({ range: '90d' });
  stats.getStats({ range: '90d' });
  stats.getStats(null);
  assert.equal(calls.sets.length, 1);
  stats.getStats({ range: '7d' });
  assert.equal(calls.sets.length, 2);
});

test('display names are found under the registered spelling, which also names the project', () => {
  const REG = '/work/proj-c';
  const { ctx } = makeCtx();
  ctx.db.getStatsProjectPaths = () => [REG + '/'];
  ctx.db.getProjectStates = () => new Map([[REG, { registered: true }]]);
  ctx.db.getProjectDisplayNames = () => new Map([[REG, 'Named C']]);
  ctx.db.getStatsPayload = () => ({ ...emptyRaw(), projects: [{ projectPath: REG + '/', costBackendId: 'alpha', costStatus: null, sessions: 1, messages: 1, tokens: 1, estimatedCostUsd: null, actualCostUsd: null }] });
  const rows = stats.getStats({ range: '7d' }).payload.projects;
  assert.equal(rows[0].name, 'Named C');
  assert.equal(rows[0].projectPath, REG, 'the registered spelling is the owner path');
});

test('range resolution across a month edge, a leap day and a DST change', () => {
  const r = stats.resolveRange({ kind: '30d' }, '2026-03-01', null);
  assert.deepEqual([r.from, r.days, r.prevFrom, r.prevTo], ['2026-01-31', 30, '2026-01-01', '2026-01-30']);
  const leap = stats.resolveRange({ kind: '7d' }, '2028-03-01', null);
  assert.deepEqual([leap.from, leap.prevFrom, leap.prevTo], ['2028-02-24', '2028-02-17', '2028-02-23']);
  assert.equal(stats.resolveRange({ kind: 'custom', from: '2028-02-28', to: '2028-03-01' }, '2028-06-01', null).days, 3);
  assert.equal(stats.resolveRange({ kind: 'custom', from: '2027-02-28', to: '2027-03-01' }, '2028-06-01', null).days, 2);
  assert.equal(stats.resolveRange({ kind: 'custom', from: '2026-03-28', to: '2026-03-30' }, '2026-06-01', null).days, 3, 'across the spring clock change');
  const autumn = stats.resolveRange({ kind: '7d' }, '2026-11-02', null);
  assert.deepEqual([autumn.from, autumn.prevFrom], ['2026-10-27', '2026-10-20']);
  const yr = stats.resolveRange({ kind: 'year' }, '2028-03-01', null);
  assert.deepEqual([yr.days, yr.from], [365, '2027-03-03']);
});
