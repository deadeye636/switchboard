// The pure half of the Stats chart (#877, T4c): the axis scale and the stack layout. No DOM here; the drawing is covered
// by the jsdom smoke tests in test/stats-view-logic.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { statsChartScale, statsChartLayout, statsBucketLabel } = require('../src/renderer/views/stats-chart.js');

test('scale: zero, a negative and a non-number give the axis 0..1', () => {
  for (const v of [0, -5, NaN, undefined, Infinity]) {
    const s = statsChartScale(v);
    assert.equal(s.max, 1);
    assert.deepEqual(s.ticks.map(t => t.value), [0, 1]);
  }
});

test('scale: one value rounds up to a 1-2-5 step and never exceeds the target steps', () => {
  const s = statsChartScale(7, { target: 5 });
  assert.equal(s.max, 8);
  assert.equal(s.step, 2);
  assert.deepEqual(s.ticks.map(t => t.value), [0, 2, 4, 6, 8]);
  assert.ok(statsChartScale(1234, { target: 5 }).ticks.length <= 7);
  assert.equal(statsChartScale(10).max, 10, 'an exact maximum is not pushed up');
});

test('scale: huge values keep a round maximum and a bounded tick count', () => {
  const s = statsChartScale(4.2e12);
  assert.equal(s.max, 5e12);
  assert.ok(s.ticks.length <= 7);
  assert.ok(s.ticks.every(t => Number.isFinite(t.value)));
});

test('scale: cost decimals carry no float noise', () => {
  const s = statsChartScale(0.0031, { format: (v) => '$' + v });
  assert.equal(s.max, 0.004);
  assert.deepEqual(s.ticks.map(t => t.value), [0, 0.001, 0.002, 0.003, 0.004]);
  assert.deepEqual(s.ticks.map(t => t.label), ['$0', '$0.001', '$0.002', '$0.003', '$0.004']);
  const c = statsChartScale(12.34, { format: (v) => '$' + v.toFixed(2) });
  assert.equal(c.max, 15);
  assert.equal(c.ticks[c.ticks.length - 1].label, '$15.00');
});

test('scale: labels come from the caller formatter, not a second one', () => {
  const s = statsChartScale(900, { format: (v) => `<${v}>` });
  assert.ok(s.ticks.every(t => /^<\d+>$/.test(t.label)));
});

// The payload carries a colour TOKEN, never a CSS colour; the page resolves it (backendIconKnownColour in the app).
const COLOUR_OF = (token) => (token === 'tok-a' ? '#111111' : null);

function series(n, over = {}) {
  const buckets = [];
  for (let i = 0; i < n; i++) {
    buckets.push({ bucket: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, start: 's', end: 'e', partial: i === n - 1, values: { a: i + 1, b: 2, __other__: 1 } });
  }
  return {
    bucket: 'day',
    keys: [
      { key: '__other__', label: 'Other', colour: null, other: true },
      { key: 'a', label: 'A', colour: 'tok-a', other: false },
      { key: 'b', label: 'B', colour: null, other: false },
    ],
    buckets, ...over,
  };
}

test('layout: stack order is the payload order from the bottom, "Other" last (on top) wherever it sat in the list', () => {
  const lay = statsChartLayout(series(3), { width: 600, height: 260, colourOf: COLOUR_OF });
  assert.deepEqual(lay.keys.map(k => k.key), ['a', 'b', '__other__']);
  const bar = lay.bars[0];
  assert.deepEqual(bar.segments.map(s => s.key), ['a', 'b', '__other__']);
  // bottom up: each segment sits directly on the one below
  assert.ok(bar.segments[0].y > bar.segments[1].y && bar.segments[1].y > bar.segments[2].y);
  assert.equal(Math.round(bar.segments[0].y + bar.segments[0].h), Math.round(lay.plot.bottom));
  assert.equal(bar.segments[2].colour, null, 'Other is drawn neutral by the page, not by a colour');
  assert.equal(bar.segments[0].colour, '#111111', 'the payload colour token is resolved by the caller');
  assert.ok(bar.segments[1].colour, 'a key without a colour takes a palette colour');
});

test('layout: a token with no resolver, or one the resolver does not know, falls back to the palette (never a raw token as a colour)', () => {
  for (const opts of [{}, { colourOf: () => null }]) {
    const lay = statsChartLayout(series(1), opts);
    const a = lay.bars[0].segments.find(x => x.key === 'a');
    assert.match(a.colour, /^#[0-9a-f]{6}$/i);
    assert.notEqual(a.colour, 'tok-a');
  }
});

test('layout: a key with no value in a bucket draws no segment; no bar rises above the plot', () => {
  const s = series(2);
  s.buckets[0].values = { a: 0, b: 5 };
  const lay = statsChartLayout(s, { width: 600 });
  assert.deepEqual(lay.bars[0].segments.map(x => x.key), ['b']);
  for (const b of lay.bars) {
    const top = Math.min(...b.segments.map(x => x.y));
    assert.ok(top >= lay.plot.top - 1e-6);
  }
  assert.equal(lay.bars[1].partial, true);
});

test('layout: 100 buckets stay inside the plot, with thinned x labels', () => {
  const lay = statsChartLayout(series(100), { width: 720, height: 260 });
  assert.equal(lay.bars.length, 100);
  for (const b of lay.bars) {
    assert.ok(b.x >= lay.plot.left - 1e-6 && b.x + b.w <= lay.plot.right + 1e-6);
    assert.ok(b.w >= 1);
  }
  const shown = lay.bars.filter(b => b.index % lay.labelEvery === 0).length;
  assert.ok(shown <= Math.floor((lay.plot.right - lay.plot.left) / 48) + 1, `${shown} labels`);
  assert.ok(lay.labelEvery > 1);
});

test('layout: no buckets, no values and negative values do not throw', () => {
  assert.equal(statsChartLayout({ keys: [], buckets: [] }).bars.length, 0);
  assert.equal(statsChartLayout(null).bars.length, 0);
  const lay = statsChartLayout({ keys: [{ key: 'a', label: 'A' }], buckets: [{ bucket: 'x', values: { a: -3 } }] });
  assert.deepEqual(lay.bars[0].segments, []);
  assert.equal(lay.scale.max, 1);
});

test('bucket labels: a day or week is MM-DD, a month keeps its key', () => {
  assert.equal(statsBucketLabel({ bucket: '2026-11-16' }, 'week'), '11-16');
  assert.equal(statsBucketLabel({ bucket: '2026-11' }, 'month'), '2026-11');
});
