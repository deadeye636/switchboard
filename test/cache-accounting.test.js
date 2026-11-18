// Spec 48 (#877): the one formula for the cache hit rate, over the descriptor's `cacheAccounting` answer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cacheHit, rateOf } = require('../src/backends/cache-accounting');
const backends = require('../src/backends');

test('additive: read over input + read + write', () => {
  assert.deepEqual(cacheHit('additive', { input: 100, cacheRead: 300, cacheCreation: 100 }), { hit: 300, base: 500 });
});

test('included: read over input, creation ignored', () => {
  assert.deepEqual(cacheHit('included', { input: 400, cacheRead: 300, cacheCreation: 50 }), { hit: 300, base: 400 });
});

test('none, a decline and an empty base contribute nothing, never 0 %', () => {
  assert.equal(cacheHit('none', { input: 5, cacheRead: 5 }), null);
  assert.equal(cacheHit(null, { input: 5, cacheRead: 5 }), null);
  assert.equal(cacheHit(undefined, { input: 5 }), null);
  assert.equal(cacheHit('additive', { input: 0, cacheRead: 0, cacheCreation: 0 }), null);
  assert.equal(cacheHit('additive', {}), null);
  assert.equal(rateOf(null), null);
  assert.equal(rateOf({ hit: 0, base: 0 }), null);
});

test('a sum of pairs is a weighted rate, not a mean of rates', () => {
  const a = cacheHit('additive', { input: 0, cacheRead: 9, cacheCreation: 1 });  // 9 / 10
  const b = cacheHit('included', { input: 90, cacheRead: 0 });                    // 0 / 90
  assert.equal(rateOf({ hit: a.hit + b.hit, base: a.base + b.base }), 0.09);
});

test('a template answers like its base, for every built-in base', () => {
  // Built from each base directly, so the assertions always run: the registry holds no template under test.
  const bases = backends.list().filter(b => !b.isProfile && !b.transcriptsOf);
  assert.ok(bases.length >= 5, 'every built-in base is checked');
  for (const base of bases) {
    const tpl = backends.profileToDescriptor({ id: `tpl-${base.id}`, name: 'Template', backendId: base.id });
    assert.equal(tpl.cacheAccounting, base.cacheAccounting, `${base.id}: cacheAccounting`);
    assert.equal(tpl.costSettled, base.costSettled, `${base.id}: costSettled is the base's own function`);
  }
});

test('included: a read above the input is clamped, so the rate stays in [0, 1]', () => {
  assert.deepEqual(cacheHit('included', { input: 100, cacheRead: 150 }), { hit: 100, base: 100 });
});
