'use strict';

let backends = null;
let shell = null;

function init(ctx) {
  backends = ctx && ctx.backends;
  shell = ctx && ctx.shell;
}

async function listResources(backendId, projectPath) {
  const backend = backends && backends.get && backends.get(backendId);
  if (!backend || typeof backend.listResources !== 'function') {
    return { ok: false, reason: 'This backend does not expose resources.' };
  }
  try {
    return await backend.listResources({ projectPath: projectPath || null });
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : 'Could not list backend resources.' };
  }
}

async function openResource(backendId, resourcePath, projectPath) {
  if (!resourcePath || !shell || typeof shell.openPath !== 'function') return { ok: false, reason: 'Cannot open resource paths here.' };
  const listed = await listResources(backendId, projectPath || null);
  if (!listed || listed.ok === false || !Array.isArray(listed.resources)) return { ok: false, reason: listed && listed.reason || 'Could not list backend resources.' };
  const allowed = listed.resources.some(r => r && r.path === resourcePath);
  if (!allowed) return { ok: false, reason: 'That path is not a discovered resource for this backend.' };
  const err = await shell.openPath(resourcePath);
  return err ? { ok: false, reason: err } : { ok: true };
}

function registerIpc(ipc) {
  ipc.handle('backend-list-resources', (_event, backendId, projectPath) => listResources(backendId, projectPath));
  ipc.handle('backend-open-resource', (_event, backendId, resourcePath, projectPath) => openResource(backendId, resourcePath, projectPath));
}

module.exports = { init, registerIpc, listResources, openResource };
