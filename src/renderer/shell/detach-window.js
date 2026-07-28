// Detached session windows, renderer half (#2).
//
// One file for both sides of the feature, because they are the same three facts seen from two windows:
//
//   the DETACHED window   — `index.html?detached=<id>`: same renderer, chrome hidden, one session shown.
//                           It inherits every terminal fix instead of growing a second renderer.
//   the MAIN window       — releases its terminal for a detached session (the PTY keeps running, main
//                           just stops rendering it) and takes it back when the window closes.
//   both                  — a detached session must never be mounted twice: two xterms on one PTY echo
//                           every keystroke twice and fight over the size.
//
// Loaded early (before app.js runs) so the body class is set before the first paint — a detached window
// must not flash the sidebar it is about to hide.
//
// Depends on renderer globals: openSessions, sessionMap, openSession, destroySession, showSession,
// activeSessionId (app.js, terminal-manager.js) · window.api.

// The session this window exists for, or null in the main window. Read from the URL: the window knows
// what it is before any IPC round trip, so nothing has to wait for an answer.
const detachedSessionId = (() => {
  try {
    return new URLSearchParams(window.location.search).get('detached') || null;
  } catch {
    return null;
  }
})();

// Sessions currently living in a window of their own. Mirrors the main process's map; the main window
// keeps it so its tabs and its sidebar can say so, and so a click sends focus there instead of mounting
// a second copy.
const detachedSessions = new Set();

window.__detachedSessionId = detachedSessionId;
window.isDetachedWindow = () => !!detachedSessionId;
window.isSessionDetached = (sessionId) => detachedSessions.has(sessionId);

if (detachedSessionId) document.body.classList.add('detached-window');

(function () {
  if (typeof document === 'undefined') return;

  // --- The detached window ---------------------------------------------------

  async function bootDetachedWindow() {
    // Wait for the session list: the window needs the session record (name, project, backend) that
    // openSession takes, and the scan that fills sessionMap is part of the normal boot.
    for (let i = 0; i < 200 && !sessionMap.has(detachedSessionId); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const session = sessionMap.get(detachedSessionId);
    if (!session) {
      // The session vanished between detaching and this window booting. Say so rather than showing an
      // empty frame the user cannot interpret.
      document.title = 'Switchboard — session not found';
      return;
    }
    document.title = (typeof cleanDisplayName === 'function'
      ? cleanDisplayName(session.name || session.aiTitle || session.summary) : '') || 'Switchboard — Session';
    // The PTY is already running; this attaches to it and replays its buffer, exactly like clicking the
    // session in the main window would.
    await openSession(session, undefined, { show: true });
  }

  // --- Handing a session over ------------------------------------------------
  //
  // Both windows run these. Since #316 a session can move main → detached, detached → main and
  // detached → detached, and every one of those is the same pair: the window that has it lets go,
  // the window that gets it attaches. The only asymmetry is the bookkeeping — the main window tracks
  // which sessions live elsewhere so its sidebar and tabs can say so, and a detached window has
  // nothing to track: everything it holds, it renders.

  function releaseSession(sessionId) {
    if (!detachedSessionId) detachedSessions.add(sessionId);
    // Let go of the terminal WITHOUT touching the process: close-terminal only clears
    // `rendererAttached` in main, so the PTY runs on and the receiving window attaches to it.
    if (openSessions.has(sessionId) && typeof destroySession === 'function') destroySession(sessionId);
    refreshViews();
  }

  async function adoptSession(sessionId) {
    detachedSessions.delete(sessionId);
    const session = sessionMap.get(sessionId);
    // Only a session that still HAS a process is taken back. Without this check, closing the window of
    // a session that had exited (or was stopped from the sidebar) would resume the CLI: openSession
    // finds no live PTY and spawns one, which is a process the user never asked for.
    const stillRunning = typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId);
    if (session && stillRunning && !openSessions.has(sessionId) && typeof openSession === 'function') {
      await openSession(session, undefined, { show: true });
    }
    refreshViews();
  }

  function refreshViews() {
    if (typeof refreshSidebar === 'function') refreshSidebar();
    if (typeof window.refreshSessionTabs === 'function') window.refreshSessionTabs();
    if (window.panesView && window.panesView.active()) window.panesView.render();
  }

  // --- Wiring ----------------------------------------------------------------

  // Both windows answer the same two channels — see the handover comment above.
  window.api.onSessionDetached((sessionId) => releaseSession(sessionId));
  window.api.onSessionReattached((sessionId) => adoptSession(sessionId));

  // …and both can move a session (#316), so these three are defined before the split below. A detached
  // window needs them as much as the main one does: detached → detached is a move like any other.

  // Where a session can go: the main window plus every detached one, named by what they show. Main
  // marks the window that already holds it, so the caller does not have to guess.
  window.listSessionWindows = async (sessionId) => {
    try { return (await window.api.listSessionWindows(sessionId)) || []; } catch { return []; }
  };

  /**
   * Menu helper (#316). Appends one "Move to <window>" entry per window the session is NOT in, to a
   * menu that is already on screen — the window list lives in the main process, so it cannot be part
   * of the synchronous build. `addItem(label, handler)` is the menu's own item builder; `isOpen()`
   * lets the caller drop the result if the user closed the menu in the meantime.
   */
  window.appendWindowMoveItems = async (sessionId, addItem, isOpen, opts = {}) => {
    if (!sessionId || typeof addItem !== 'function') return;
    const windows = await window.listSessionWindows(sessionId);
    // `skipMain` is for a caller that already offers the way back by name ("Return to main window",
    // #314) — listing it twice under two labels reads as two different actions.
    const targets = windows.filter((w) => !w.current && !(opts.skipMain && w.isMain));
    if (!targets.length || (typeof isOpen === 'function' && !isOpen())) return;
    for (const target of targets) {
      const label = target.isMain
        ? 'Move to main window'
        : `Move to “${target.title}”`;
      addItem(label, () => window.moveSessionToWindow(sessionId, target.id));
    }
  };

  window.moveSessionToWindow = async (sessionId, windowId) => {
    const res = await window.api.moveSessionToWindow(sessionId, windowId);
    if (!res || !res.ok) {
      window.showControlToast?.({
        message: (res && res.error === 'session is not running')
          ? 'Only a running session can move between windows'
          : 'Could not move this session',
        timeoutMs: 3000,
      });
      return false;
    }
    return true;
  };

  // Bring a session back to the main window — from the main window's side this is "fetch it" (#315),
  // from a detached window's it is "give it back" (#314). Same move either way. The window it leaves
  // closes if that was its last session; main decides that, since only it knows what else it holds.
  window.reattachSession = async (sessionId) => {
    const id = sessionId || window.__detachedSessionId;
    if (!id) return false;
    return window.moveSessionToWindow(id, 'main');
  };

  if (detachedSessionId) {
    // A detached window opens on one session; since #316 it can be given more. The launch restore must
    // not reopen the whole set here — that would mount every session a second time, each one fighting
    // the main window for the same PTY.
    window.__suppressLaunchRestore = true;
    window.addEventListener('DOMContentLoaded', () => { bootDetachedWindow(); });
    // The session was re-keyed under this window (a fork, an accepted plan): follow the new id, or the
    // next reattach names a session that no longer exists.
    window.api.onDetachedSessionRekeyed((fromId, toId) => {
      if (fromId !== window.__detachedSessionId) return;
      window.__detachedSessionId = toId;
    });
    // Closing the window hands its sessions back; main sees the `closed` event and tells the main window.
    return;
  }

  window.api.onSessionDetachRekeyed((fromId, toId) => {
    if (!detachedSessions.delete(fromId)) return;
    detachedSessions.add(toId);
    refreshViews();
  });

  // Catch up on boot: a renderer reload leaves the detached windows standing, and this window has to
  // know about them before it renders a single tab.
  window.api.detachedSessionIds().then((ids) => {
    for (const id of ids || []) detachedSessions.add(id);
    if (ids && ids.length) refreshViews();
  }).catch(() => { /* older main process — nothing detached */ });

  // Move a session into a window of its own. Returns false when it has no live process: there is
  // nothing to render over there, and the caller says so rather than opening an empty window.
  window.detachSession = async (sessionId) => {
    const session = sessionMap.get(sessionId);
    const title = (typeof cleanDisplayName === 'function'
      ? cleanDisplayName(session && (session.name || session.aiTitle || session.summary)) : '') || 'Session';
    const res = await window.api.detachSession(sessionId, title);
    if (!res || !res.ok) {
      window.showControlToast?.({
        message: (res && res.error === 'session is not running')
          ? 'Only a running session can move to its own window'
          : 'Could not detach this session',
        timeoutMs: 3000,
      });
      return false;
    }
    return true;
  };

})();
