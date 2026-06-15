const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getSpringCleaningParticleConfig,
  shouldRunSpringCleaningEffects,
} = require('../public/spring-cleaning-effects');

test('spring cleaning particle config defines lively leaves and confetti', () => {
  assert.deepEqual(getSpringCleaningParticleConfig('leaves'), {
    className: 'spring-cleaning-leaf',
    count: 32,
    durationMs: 1800,
  });
  assert.deepEqual(getSpringCleaningParticleConfig('confetti'), {
    className: 'spring-cleaning-confetti-piece',
    count: 56,
    durationMs: 2200,
  });
});

test('spring cleaning effects respect reduced motion', () => {
  assert.equal(shouldRunSpringCleaningEffects({ matches: true }), false);
  assert.equal(shouldRunSpringCleaningEffects({ matches: false }), true);
  assert.equal(shouldRunSpringCleaningEffects(null), true);
});
