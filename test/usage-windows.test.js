'use strict';
// #883 (spec 48 V11): the window model, the projection and the sampler (pure), and the stats-usage-windows answer (fake ctx and db).
const test = require('node:test');
const assert = require('node:assert/strict');
const uw = require('../src/app/usage-windows');
const stats = require('../src/app/stats');

const MIN = 60000;
const HOUR = 3600000;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

function reading(over = {}, bucket = {}) {
  return {
    backendId: 'alpha', live: true, reportsWindows: true,
    buckets: [{ key: 'session', label: '5h', percent: 30, bar: true, resetsAt: iso(T0 + 3 * HOUR), windowMinutes: 300, ...bucket }],
    ...over,
  };
}
const first = (r, ref) => uw.windowsOf(r, ref)[0];

test('windowsOf: only bar buckets with a reset and a length, from a reporting backend', () => {
  const r = reading();
  r.buckets.push({ key: 'weekSonnet', label: 'Sonnet', percent: 5, bar: false, resetsAt: iso(T0 + HOUR), windowMinutes: 10080 });
  r.buckets.push({ key: 'x', label: 'x', percent: 5, bar: true, resetsAt: null, windowMinutes: 300 });
  r.buckets.push({ key: 'y', label: 'y', percent: 5, bar: true, resetsAt: iso(T0 + HOUR), windowMinutes: null });
  const ws = uw.windowsOf(r, T0);
  assert.deepEqual(ws.map(w => w.key), ['session']);
  assert.equal(ws[0].startsAt, iso(T0 - 2 * HOUR));
  assert.equal(ws[0].elapsedFraction, 0.4);
  assert.deepEqual(uw.windowsOf({ ...r, reportsWindows: false }, T0), []);
  assert.deepEqual(uw.windowsOf({ ...r, _error: true }, T0), []);
});

test('projection: linear from the elapsed fraction', () => {
  const w = first(reading(), T0);   // 40 % elapsed (2 h of 5 h), 30 %
  const p = uw.projectWindow(w, [], T0);
  assert.equal(p.basis, 'linear');
  assert.ok(Math.abs(p.ratePerHour - 15) < 1e-9);
  assert.ok(Math.abs(p.projectedAtReset - 75) < 1e-9);
  assert.equal(p.reachesLimitAt, null);
  const hot = uw.projectWindow(first(reading({}, { percent: 60 }), T0), [], T0);   // 30 %/h, 3 h left -> 150
  assert.ok(Math.abs(hot.projectedAtReset - 150) < 1e-9);
  assert.equal(hot.reachesLimitAt, iso(T0 + (40 / 30) * HOUR));
});

test('projection: too early under 5 % of the window', () => {
  const r = reading({}, { resetsAt: iso(T0 + 299 * MIN), percent: 2 });   // 1 of 300 minutes elapsed
  const p = uw.projectWindow(first(r, T0), [], T0);
  assert.equal(p.basis, 'too-early');
  assert.equal(p.projectedAtReset, null);
});

test('projection: reached and expired carry no projection', () => {
  const reached = uw.projectWindow(first(reading({}, { percent: 100 }), T0), [], T0);
  assert.equal(reached.basis, 'reached');
  assert.equal(reached.projectedAtReset, null);
  const w = first(reading(), T0);
  assert.equal(uw.projectWindow(w, [], T0 + 4 * HOUR).basis, 'expired');
});

test('projection: the recent slope once 30 minutes of samples lie in the window', () => {
  const w = first(reading(), T0);
  const samples = [];
  for (let i = 0; i <= 40; i++) samples.push({ t: T0 - (40 - i) * MIN, percent: 10 + Math.floor(i / 2) });   // +30 % per hour
  const p = uw.projectWindow({ ...w, percent: 30 }, samples, T0);
  assert.equal(p.basis, 'samples');
  assert.ok(Math.abs(p.ratePerHour - 30) < 2, 'rate ' + p.ratePerHour);
  assert.ok(p.projectedAtReset > 100);
  assert.ok(p.reachesLimitAt);
  // 20 minutes of samples is not enough: linear applies
  assert.equal(uw.projectWindow(w, samples.slice(-21), T0).basis, 'linear');
  // samples from before the window start do not count
  const old = samples.map(s => ({ ...s, t: s.t - 4 * HOUR }));
  assert.equal(uw.projectWindow(w, old, T0).basis, 'linear');
  // a flat series projects the percent itself, never below it
  const flat = samples.map(s => ({ ...s, percent: 30 }));
  const f = uw.projectWindow(w, flat, T0);
  assert.equal(f.ratePerHour, 0);
  assert.equal(f.projectedAtReset, 30);
});

test('stale readings project as of their own time', () => {
  const r = reading({ _stale: true, _cachedAt: iso(T0 - HOUR) });
  const { refMs, asOf } = uw.referenceOf(r, T0);
  assert.equal(refMs, T0 - HOUR);
  assert.equal(asOf, iso(T0 - HOUR));
  const w = first(r, refMs);
  const p = uw.projectWindow(w, [], refMs, asOf);
  assert.equal(p.asOf, asOf);
  assert.equal(w.elapsedFraction, 0.2);
  const codex = uw.referenceOf({ live: false, observedAt: iso(T0 - 5 * MIN) }, T0);
  assert.equal(codex.asOf, iso(T0 - 5 * MIN));
  assert.equal(uw.referenceOf({ live: true }, T0).asOf, null);
});

test('sampler: a percent drop or a moved reset starts a new series; a stale reading adds no sample', () => {
  const s = uw.createSampler();
  s.record(reading({}, { percent: 10 }), T0);
  s.record(reading({}, { percent: 12 }), T0 + MIN);
  assert.equal(s.samplesOf('alpha', 'session').length, 2);
  s.record(reading({ _stale: true, _cachedAt: iso(T0) }, { percent: 50 }), T0 + 2 * MIN);
  assert.equal(s.samplesOf('alpha', 'session').length, 2);
  s.record(reading({}, { percent: 3 }), T0 + 3 * MIN);   // fell: new window
  assert.deepEqual(s.samplesOf('alpha', 'session'), [{ t: T0 + 3 * MIN, percent: 3 }]);
  s.record(reading({}, { percent: 4, resetsAt: iso(T0 + 3 * HOUR + 30 * MIN) }), T0 + 4 * MIN);   // reset moved
  assert.equal(s.samplesOf('alpha', 'session').length, 1);
  s.record({ backendId: 'alpha', _error: true }, T0);
  assert.equal(s.latest().length, 1);
});

test('sampler: bounded by count and age; a non-live observation is sampled once', () => {
  const s = uw.createSampler({ maxSamples: 5, maxAgeMs: 10 * MIN });
  for (let i = 0; i < 20; i++) s.record(reading({}, { percent: 10 + i }), T0 + i * MIN);
  const got = s.samplesOf('alpha', 'session');
  assert.ok(got.length <= 5);
  assert.ok(got[got.length - 1].t - got[0].t <= 10 * MIN);
  const c = uw.createSampler();
  const obs = reading({ live: false, observedAt: iso(T0 - MIN) });
  c.record(obs, T0); c.record(obs, T0 + MIN); c.record(obs, T0 + 2 * MIN);
  assert.equal(c.samplesOf('alpha', 'session').length, 1);
  assert.equal(uw.MAX_SAMPLES, 120);
});

// --- the handler ---------------------------------------------------------------------------------------------------------

const D = (over) => ({ status: 'ready', enabled: true, colour: 'c', icon: 'i', costSettled: () => false, ...over });
const DESCRIPTORS = [
  D({ id: 'alpha', label: 'Alpha', colour: 'alpha' }),
  D({ id: 'alpha-gui', label: 'Alpha GUI', transcriptsOf: 'alpha' }),
  D({ id: 'tmpl', label: 'Template', isProfile: true, baseId: 'alpha' }),
  D({ id: 'beta', label: 'Beta' }),
];

function setup({ readings = [], rows = [], nowMs = T0, figures } = {}) {
  const sampler = uw.createSampler();
  for (const r of readings) sampler.record(r, nowMs);
  const queries = [];
  stats.init({
    now: () => new Date(nowMs), log: { debug() {}, warn() {}, error() {} }, usageSampler: sampler,
    backends: { list: () => DESCRIPTORS, rowOwnerOf: (id) => (DESCRIPTORS.find(x => x.id === id) || {}).transcriptsOf || id },
    db: { getUsageWindowFigures: figures || ((ids, date, hour, toDate, toHour) => { queries.push({ ids, date, hour, toDate, toHour }); return rows; }) },
  });
  return { queries };
}

const WEEK = { key: 'weekAll', label: '7d', windowMinutes: 10080, resetsAt: iso(T0 + 2 * 24 * HOUR), percent: 40 };
const weekly = (over = {}) => reading(over, WEEK);

test('handler: a 5 h window has no machine figures (E4), a weekly one asks one query', () => {
  const none = setup({ readings: [reading()] });
  let res = stats.getUsageWindows(null);
  assert.equal(res.ok, true);
  assert.equal(res.windows.length, 1);
  assert.equal(res.windows[0].machine, null);
  assert.equal(res.windows[0].backendLabel, 'Alpha');
  assert.equal(none.queries.length, 0);

  const q = setup({ readings: [weekly()], rows: [{ costBackendId: 'alpha', costStatus: null, tokens: 1000, estimatedCostUsd: 2, actualCostUsd: null }] });
  res = stats.getUsageWindows(null);
  assert.equal(q.queries.length, 1);
  const m = res.windows[0].machine;
  assert.equal(m.tokens, 1000);
  assert.deepEqual(m.cost, { usd: 2, estimated: true });
  assert.ok(Math.abs(m.tokensPerHour - 1000 / (5 * 24)) < 1e-6);   // 5 of 7 days elapsed
});

test('handler: templates are not in the id list, a driver is (E7); the hour bound is the local start hour', () => {
  const { queries } = setup({ readings: [weekly()] });
  stats.getUsageWindows(null);
  assert.deepEqual(queries[0].ids.slice().sort(), ['alpha', 'alpha-gui']);
  const start = new Date(T0 + 2 * 24 * HOUR - 10080 * MIN);
  const p = (n) => String(n).padStart(2, '0');
  assert.equal(queries[0].date, start.getFullYear() + '-' + p(start.getMonth() + 1) + '-' + p(start.getDate()));
  assert.equal(queries[0].hour, start.getHours());
});

test('handler: backend filter, nothing sampled, a backend without windows, a failing query', () => {
  setup({ readings: [reading(), reading({ backendId: 'beta' })] });
  assert.deepEqual(stats.getUsageWindows('beta').windows.map(w => w.backendId), ['beta']);
  assert.deepEqual(stats.getUsageWindows('nope').windows, []);
  setup({ readings: [reading({ reportsWindows: false })] });
  assert.deepEqual(stats.getUsageWindows(null).windows, []);
  setup({});
  assert.deepEqual(stats.getUsageWindows(null), { ok: true, windows: [] });
  setup({ readings: [weekly()], figures: () => { throw new Error('boom /secret/path'); } });
  const res = stats.getUsageWindows(null);
  assert.equal(res.ok, true);
  assert.equal(res.windows[0].machine, null);
  assert.ok(!JSON.stringify(res).includes('secret'));
});

test('handler: a disabled backend shows nothing', () => {
  setup({ readings: [reading()] });
  DESCRIPTORS[0].enabled = false;
  try { assert.deepEqual(stats.getUsageWindows(null).windows, []); } finally { DESCRIPTORS[0].enabled = true; }
});

test('the hour bound is read from local fields of the window start, whatever the zone does on that day', () => {
  // A window starting in the hour a spring-forward skips or an autumn fall-back repeats: the bound is still that Date's
  // local (date, hour), never a UTC hour or a fixed offset.
  for (const [y, m, d, h] of [[2026, 2, 29, 3], [2026, 9, 25, 2], [2026, 2, 8, 2], [2026, 10, 1, 1]]) {
    const startMs = new Date(y, m, d, h, 30).getTime();
    const resetMs = startMs + 10080 * MIN;
    const { queries } = setup({
      readings: [reading({}, { ...WEEK, resetsAt: iso(resetMs) })], nowMs: resetMs - HOUR,
    });
    stats.getUsageWindows('alpha');
    const s = new Date(resetMs - 10080 * MIN);
    assert.equal(queries[0].hour, s.getHours());
    assert.equal(queries[0].date, stats.localDayKey(s));
  }
});

test('G1: a live reading is true when it was recorded, and says so once it is older than 2 poll intervals', () => {
  const r = reading();
  const fresh = uw.referenceOf(r, T0 + 60000, T0);
  assert.equal(fresh.refMs, T0);
  assert.equal(fresh.asOf, null);
  const old = uw.referenceOf(r, T0 + 3 * HOUR, T0);
  assert.equal(old.refMs, T0);
  assert.equal(old.asOf, iso(T0));
  assert.equal(uw.referenceOf(r, T0 + uw.AS_OF_AFTER_MS, T0).asOf, null);
  assert.equal(uw.referenceOf(r, T0 + uw.AS_OF_AFTER_MS + 1, T0).asOf, iso(T0));
  // describeAll projects from the recorded moment, not from now
  const s = uw.createSampler();
  s.record(reading({}, { percent: 30, resetsAt: iso(T0 + 3 * HOUR) }), T0);
  const [d] = uw.describeAll(s, T0 + 2 * HOUR);
  assert.equal(d.projection.asOf, iso(T0));
  assert.equal(d.window.elapsedFraction, 0.4);
  assert.equal(d.projection.basis, 'linear');
  assert.equal(uw.describeAll(s, T0 + MIN)[0].projection.asOf, null);
});

test('G3: the query is bound at the local reset hour (exclusive), and an expired window has no machine figures', () => {
  const { queries } = setup({ readings: [weekly()] });
  stats.getUsageWindows(null);
  const end = new Date(T0 + 2 * 24 * HOUR);
  assert.equal(queries[0].toDate, stats.localDayKey(end));
  assert.equal(queries[0].toHour, end.getHours());
  // a reading recorded long ago whose reset has passed by its own time: expired
  const q = setup({ readings: [reading({ live: false, observedAt: iso(T0 + 4 * HOUR) }, { ...WEEK, windowMinutes: 1440, resetsAt: iso(T0 + 3 * HOUR) })], nowMs: T0 + 5 * HOUR });
  const res = stats.getUsageWindows(null);
  assert.equal(res.windows[0].projection.basis, 'expired');
  assert.equal(res.windows[0].machine, null);
  assert.equal(q.queries.length, 0);
});
