'use strict';
// Backend-owned model discovery IPC. Kept out of main.js: the core only asks the descriptor whether it can
// list models; each backend owns how it shells out, caches, parses and fails.

let ctx = null;

function init(context) {
  ctx = context || {};
}

async function listModels(backendId, search) {
  const registry = ctx && ctx.backends;
  const backend = registry && typeof registry.get === 'function' ? registry.get(backendId) : null;
  if (!backend || typeof backend.listModels !== 'function') {
    return { ok: false, reason: 'This backend does not support model discovery.' };
  }
  try {
    return await backend.listModels({ search });
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

function registerIpc(ipc) {
  ipc.handle('backend-list-models', (_event, backendId, search) => listModels(backendId, search));
}

module.exports = { init, registerIpc, listModels };
