// live-sessions.js — what main knows about a running session, for a window that has no other source (#461).
//
// Almost everything the renderer draws about a session comes from the session INDEX: the sidebar list and
// `sessionMap` are both built from the projects payload. That is fine for a session with a transcript on
// disk, and it is exactly wrong for one whose backend never recorded it — Hermes in its degraded mode
// writes plain JSON when it cannot open its own database, and the database is what the index reads.
//
// Such a session is drawn anyway while the window that launched it lives, out of `pendingSessions` and its
// pane tab. Both are renderer memory. Reload the window and they are gone while the process is still
// running: a live PTY main knows about, and nothing on screen. `get-active-sessions` answers with ids
// alone, so the renderer cannot even name what it is looking at.
//
// So this says what main already holds. It is deliberately NOT part of the projects payload: the index
// has not seen these sessions, and putting them in its mouth would hand synthesised rows to search, stats
// and every counter that expects an indexed one. "A process is alive" is a fact about now, which is why
// it travels on its own channel beside `get-active-sessions` rather than inside the list of what exists.
'use strict';

let ctx = null;

function init(context) {
  ctx = context;
}

/**
 * Every live session, named the way the renderer draws it.
 *
 * The id is the LIVE one: a backend that names its own sessions is adopted onto its id (`realSessionId`),
 * and the row on screen is drawn for that. Both keys can be in `activeSessions` at once around an
 * adoption, so the list is deduplicated by the id it reports rather than by the key it was found under —
 * two entries for one process would become two rows.
 *
 * `startedAt` is the spawn time, and it is the only timestamp such a session has: with no transcript there
 * is nothing to read a modification time from, and a row with no time at all sorts to the bottom of the
 * sidebar as if it were the oldest thing there.
 */
function snapshot() {
  const out = [];
  const seen = new Set();
  const sessions = (ctx && ctx.activeSessions) || new Map();
  for (const [sessionId, session] of sessions) {
    if (!session || session.exited) continue;
    const liveId = session.realSessionId || sessionId;
    if (seen.has(liveId)) continue;
    seen.add(liveId);
    const mapped = ctx.sessionBackends ? ctx.sessionBackends.get(liveId) : null;
    out.push({
      sessionId: liveId,
      projectPath: session.projectPath || '',
      backendId: (mapped && mapped.backendId) || '',
      isPlainTerminal: !!session.isPlainTerminal,
      startedAt: session._openedAt || 0,
    });
  }
  return out;
}

function registerIpc(ipc) {
  ipc.handle('live-sessions:get', () => snapshot());
}

module.exports = { init, registerIpc, snapshot };
