// The VCS provider REGISTRY (#277) — the neutral seam mirroring `src/backends/index.js`.
//
// The core (`src/app/vcs.js`) never names a VCS: it calls `detect(cwd)` to find the owning provider,
// then drives that provider's hooks. git is the only shipped provider; a Mercurial/Subversion provider
// would be a sibling file registered here, with no core change (#277 E1).
'use strict';

const git = require('./git');

const registry = new Map();

function register(provider) {
  if (!provider || typeof provider.id !== 'string' || provider.id === '') {
    throw new Error('vcs provider needs a non-empty string id');
  }
  registry.set(provider.id, provider);
  return provider;
}

register(git);

function get(id) {
  return registry.get(id) || null;
}

function list() {
  return [...registry.values()];
}

// Which provider owns this working directory? First match wins. Returns the provider or null (not a
// repo under any known VCS → no chip).
function detect(cwd) {
  for (const p of registry.values()) {
    try { if (p.detect(cwd)) return p; } catch { /* provider detect must never throw the poll down */ }
  }
  return null;
}

module.exports = { get, list, detect, register };
