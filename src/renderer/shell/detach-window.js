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

  // --- The main window -------------------------------------------------------

  function releaseToDetachedWindow(sessionId) {
    detachedSessions.add(sessionId);
    // Let go of the terminal WITHOUT touching the process: close-terminal only clears
    // `rendererAttached` in main, so the PTY runs on and the new window reattaches to it.
    if (openSessions.has(sessionId) && typeof destroySession === 'function') destroySession(sessionId);
    refreshViews();
  }

  async function takeBackFromDetachedWindow(sessionId) {
    detachedSessions.delete(sessionId);
    const session = sessionMap.get(sessionId);
    // Only a session that still HAS a process comes back on its own. Without this check, closing the
    // window of a session that had exited (or was stopped from the sidebar) would resume the CLI:
    // openSession finds no live PTY and spawns one, which is a process the user never asked for.
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

  if (detachedSessionId) {
    // A detached window renders exactly one session. Its own detach action is off (it is already in a
    // window of its own) and the launch restore must not reopen the whole set here — that would mount
    // every session a second time, each one fighting the main window for the same PTY.
    window.__suppressLaunchRestore = true;
    window.addEventListener('DOMContentLoaded', () => { bootDetachedWindow(); });
    // The session was re-keyed under this window (a fork, an accepted plan): follow the new id, or the
    // next reattach names a session that no longer exists.
    window.api.onDetachedSessionRekeyed((fromId, toId) => {
      if (fromId !== window.__detachedSessionId) return;
      window.__detachedSessionId = toId;
    });
    // Closing the window hands the session back; main sees the `closed` event and tells the main window.
    return;
  }

  window.api.onSessionDetached((sessionId) => releaseToDetachedWindow(sessionId));
  window.api.onSessionReattached((sessionId) => takeBackFromDetachedWindow(sessionId));
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

  // Bring a detached session back into this window.
  window.reattachSession = async (sessionId) => {
    await window.api.reattachSession(sessionId);
  };
})();
