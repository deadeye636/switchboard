'use strict';
// The context window of a stored session, asked the way the launch would (#620, #826).
//
// The health badge (`contextFillFor` in `projects-view.js`) and the Flow tab (`app/session-flow.js`, the reader's
// window hint) both need "which window did this session's last turn run against". The descriptor answers it
// (`contextWindow`), but only when it is asked with what the launch applies: the user's per-backend variables
// (an `ANTHROPIC_MODEL=...[1m]` set in Switchboard is what made a session 1M) and the launch options stored for
// the backend in the project. That layering lives here ONCE, so the two cannot disagree.
//
// A leaf: no database and no Electron (settings arrive as `getSetting`), so `src/app/` and a test can require it.
// One instance serves one pass (one sidebar build, one Flow request): the variables are resolved once per
// backend and the launch options memoised per project owner, because the badge asks once per ROW
// (`.claude/rules/db.md`, "projects-view.js asks descriptor hooks once per ROW").

const { resolveEnv } = require('../backends/env-refs');
const { settingsOwnerPath } = require('../shared/worktree-path');

// A row with no explicit backendId predates the multi-LLM era and is Claude by definition.
const LEGACY_SESSION_BACKEND = 'claude';

/**
 * @param {(key: string) => any} getSetting   `getSetting('global')` and `getSetting('project:<owner>')`, or undefined.
 * @returns {{ envFor, launchOptionsFor, windowOf, windowOfAsync }}
 */
function createContextWindowResolver(getSetting) {
  // The user's per-backend variables, resolved like the spawn resolves them: a `$VAR` that names a set variable
  // becomes its value, one that does not is DROPPED, so the process's own variable shows through. Resolved against
  // this process's environment only; a reference to one of Switchboard's saved variables is not followed here.
  const globalSettings = typeof getSetting === 'function' ? getSetting('global') : null;
  const backendEnvs = (globalSettings && typeof globalSettings === 'object' && globalSettings.backendEnv) || {};
  const resolvedEnvs = new Map();
  const envFor = (key) => {
    if (!resolvedEnvs.has(key)) resolvedEnvs.set(key, resolveEnv(backendEnvs[key] || {}));
    return resolvedEnvs.get(key);
  };
  // The launch options a session of this backend in this project starts with, as stored (#620, O5) - the cascade
  // the launch dialog resolves (`storedDefaultsFor` in the renderer): the base backend's global default, the
  // project's own override, the legacy template entry, then the template record itself. Only what is stored: a
  // one-off Configure override is not kept anywhere, and that limit is decided (O2).
  const globalDefaults = (globalSettings && typeof globalSettings === 'object' && globalSettings.backendDefaults) || {};
  const projectDefaultsByOwner = new Map();
  const launchOptionsMemo = new Map();
  const launchOptionsFor = (row, backend, baseKey) => {
    const owner = row.projectPath ? settingsOwnerPath(row.projectPath) : '';
    const memoKey = owner + '|' + backend.id;
    if (launchOptionsMemo.has(memoKey)) return launchOptionsMemo.get(memoKey);
    if (!projectDefaultsByOwner.has(owner)) {
      const blob = owner && typeof getSetting === 'function' ? getSetting('project:' + owner) : null;
      projectDefaultsByOwner.set(owner, (blob && typeof blob === 'object' && blob.backendDefaults) || {});
    }
    const projectDefaults = projectDefaultsByOwner.get(owner);
    const layer = (defaults, id) => {
      const opts = defaults && defaults[id];
      if (!opts || typeof opts !== 'object') return {};
      const out = {};
      for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== null) out[k] = v;
      return out;
    };
    const options = {
      ...layer(globalDefaults, baseKey),
      ...layer(projectDefaults, baseKey),
      ...(backend.isProfile ? { ...layer(globalDefaults, backend.id), ...layer(projectDefaults, backend.id) } : {}),
      ...(backend.isProfile && backend.templateOptions && typeof backend.templateOptions === 'object' ? backend.templateOptions : {}),
    };
    launchOptionsMemo.set(memoKey, options);
    return options;
  };
  // The descriptor's answer for a row, `{ windowTokens, ... }` or null. A throw is a null: a window that cannot be
  // read is "unknown", never an error on the sidebar or in the Flow tab.
  const windowOf = (row, backend) => {
    if (!row || !backend || typeof backend.contextWindow !== 'function') return null;
    const envKey = backend.isProfile ? (backend.baseId || LEGACY_SESSION_BACKEND) : backend.id;
    try {
      return backend.contextWindow(row, { env: envFor(envKey), launchOptions: launchOptionsFor(row, backend, envKey) }) || null;
    } catch { return null; }
  };
  // The same answer for a caller on the main thread's request path (the Flow tab): a descriptor that declares
  // `contextWindowAsync` is asked that way, so its settings read never blocks. Any other backend answers `null`
  // here: its plain hook may read files synchronously (Pi's model catalog does), which this path must not do.
  const windowOfAsync = async (row, backend) => {
    if (!row || !backend) return null;
    if (typeof backend.contextWindowAsync !== 'function') return null;
    const envKey = backend.isProfile ? (backend.baseId || LEGACY_SESSION_BACKEND) : backend.id;
    try {
      return (await backend.contextWindowAsync(row, { env: envFor(envKey), launchOptions: launchOptionsFor(row, backend, envKey) })) || null;
    } catch { return null; }
  };
  return { envFor, launchOptionsFor, windowOf, windowOfAsync };
}

module.exports = { createContextWindowResolver };
