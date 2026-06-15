(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const PARTICLE_CONFIGS = {
    leaves: {
      className: 'spring-cleaning-leaf',
      count: 32,
      durationMs: 1800,
    },
    confetti: {
      className: 'spring-cleaning-confetti-piece',
      count: 56,
      durationMs: 2200,
    },
  };

  function getSpringCleaningParticleConfig(type) {
    return PARTICLE_CONFIGS[type] || PARTICLE_CONFIGS.leaves;
  }

  function shouldRunSpringCleaningEffects(reducedMotionQuery) {
    return !reducedMotionQuery?.matches;
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function createParticleElement(type, index, count) {
    const config = getSpringCleaningParticleConfig(type);
    const particle = document.createElement('span');
    particle.className = `spring-cleaning-particle ${config.className}`;
    particle.style.setProperty('--particle-delay', `${randomBetween(0, 260).toFixed(0)}ms`);
    particle.style.setProperty('--particle-duration', `${randomBetween(config.durationMs * 0.78, config.durationMs * 1.2).toFixed(0)}ms`);
    particle.style.setProperty('--particle-x', `${randomBetween(-45, 45).toFixed(1)}vw`);
    particle.style.setProperty('--particle-y', `${randomBetween(45, 95).toFixed(1)}vh`);
    particle.style.setProperty('--particle-rotate', `${randomBetween(-360, 360).toFixed(0)}deg`);
    particle.style.setProperty('--particle-hue', `${Math.round((index / Math.max(1, count)) * 300 + randomBetween(0, 60))}`);
    particle.style.left = `${randomBetween(8, 92).toFixed(1)}vw`;
    particle.style.top = type === 'leaves'
      ? `${randomBetween(-8, 22).toFixed(1)}vh`
      : `${randomBetween(38, 58).toFixed(1)}vh`;
    if (type === 'leaves') {
      particle.textContent = Math.random() > 0.45 ? '🍃' : '🍂';
    }
    return particle;
  }

  function playSpringCleaningParticles(type, parent = document.body) {
    if (!parent || typeof document === 'undefined') return null;
    if (!shouldRunSpringCleaningEffects(window.matchMedia?.('(prefers-reduced-motion: reduce)'))) return null;
    const config = getSpringCleaningParticleConfig(type);
    const layer = document.createElement('div');
    layer.className = `spring-cleaning-particles spring-cleaning-particles-${type}`;
    layer.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < config.count; index++) {
      layer.appendChild(createParticleElement(type, index, config.count));
    }
    parent.appendChild(layer);
    setTimeout(() => layer.remove(), config.durationMs + 700);
    return layer;
  }

  return {
    getSpringCleaningParticleConfig,
    shouldRunSpringCleaningEffects,
    playSpringCleaningParticles,
  };
});
