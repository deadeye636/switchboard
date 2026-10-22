'use strict';
// Per-spawn MCP prune (spec 36, "Prune"): when a project asks that a session see ONLY the servers Switchboard
// gives it, the backend's `buildMcpPrune` hook says how its CLI is told so. Electron-free and db-free:
// everything arrives as arguments, so `node --test` loads it. It names no backend; whether a CLI can be
// pruned at all is a descriptor declaration (`providesMcpPrune`), and a backend that cannot declines.
//
// There is no release half: a prune is launch arguments and environment, never a file or a registration.
// The answer is `null` whenever this launch gets no prune: not asked for, a backend that declines, a hook
// that answers nothing, or a hook that throws. Never an error.

const noop = () => {};

// `backend` is the descriptor. `enabled` is the project's `externalMcpPrune` flag (only `true` counts).
// `injectedNames` are the server names the injection gave this launch (a hook may keep them).
function composeMcpPrune({ backend, enabled, injectedNames, env, cwd, options, log: logIn } = {}) {
  const log = { debug: noop, info: noop, warn: noop, ...(logIn || {}) };
  if (enabled !== true || !backend) return null;
  if (backend.providesMcpPrune !== true || typeof backend.buildMcpPrune !== 'function') {
    log.info(`[mcp-prune] ${backend.id || 'this backend'} cannot prune a session's MCP servers; starting it without`);
    return null;
  }
  try {
    const built = backend.buildMcpPrune({
      injectedNames: Array.isArray(injectedNames) ? injectedNames : [], options, env, cwd, log,
    });
    if (!built || typeof built !== 'object') return null;
    const args = Array.isArray(built.args) ? built.args : [];
    const outEnv = built.env && typeof built.env === 'object' ? built.env : null;
    if (!args.length && !outEnv) return null;
    return { args, env: outEnv };
  } catch (err) {
    log.warn(`[mcp-prune] could not set up: ${err && err.message}`);
    return null;
  }
}

module.exports = { composeMcpPrune };
