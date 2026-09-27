// session-view.js — which view a session opens in, as a write that is not a spawn (#670).
//
// A session of an owner/driver pair (a CLI in a terminal, the same CLI driven over its pipe in the GUI) opens
// where the user last put it: `session_meta.opener`. Putting it somewhere is always an OPEN — the spawn stores
// the choice once it succeeded (`openerChoice` in `src/app/terminal/spawn.js`) — so the only write left over
// is taking a choice back: "Use the default view" in the command palette, after which `openerFor` routes the
// row the automatic way again (the transcript marker while the driver can launch, otherwise the owner).
//
// Its own module rather than a handler in main.js (reflex 4), and the home of the running-session switch that
// follows in step S3 of #670, which is the same subject.
//
// The meta store arrives through ctx, never a top-level require of `../db/db` (test/main-modules-no-db.test.js):
// that require resolves DATA_DIR at load, before main.js has set it.
'use strict';

let ctx = null;

// A session id is a short opaque string; anything else is not one, and a clear keyed by it would write a
// row nobody can ever read back.
const MAX_SESSION_ID_LENGTH = 512;

function init(context) {
  ctx = context || null;
}

function validSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim() !== '' && sessionId.length <= MAX_SESSION_ID_LENGTH;
}

/**
 * Take back the view the user chose for a session, so it opens the automatic way again.
 *
 * Answers `{ ok: true, cleared }` — `cleared` is false when no choice was stored, which is still the state
 * the caller asked for — or `{ ok: false, error }` for an input that is not a session id. The sidebar is told
 * the projects changed, because the row's effective view is derived in main (`openerFor`) and the renderer
 * cannot re-derive it: without the push the row would keep its old symbol until the next unrelated refresh.
 */
function resetView(sessionId) {
  if (!validSessionId(sessionId)) return { ok: false, error: 'No session was named.' };
  if (!ctx || typeof ctx.setOpener !== 'function') return { ok: false, error: 'The session store is not ready.' };
  let had = false;
  try {
    had = typeof ctx.getOpener === 'function' ? !!ctx.getOpener(sessionId) : true;
    if (had) ctx.setOpener(sessionId, null);
  } catch (err) {
    if (ctx.log) ctx.log.warn(`[session-view] ${sessionId}: clearing the stored view failed: ${err && err.message}`);
    return { ok: false, error: 'The stored view could not be cleared.' };
  }
  if (had && typeof ctx.notifyRendererProjectsChanged === 'function') {
    try { ctx.notifyRendererProjectsChanged(); } catch { /* the next refresh draws it */ }
  }
  if (had && ctx.log) ctx.log.info(`[session-view] ${sessionId}: stored view cleared, the default applies`);
  return { ok: true, cleared: had };
}

function registerIpc(ipc) {
  ipc.handle('session-view:reset', (_event, sessionId) => resetView(sessionId));
}

module.exports = { init, registerIpc, resetView };
