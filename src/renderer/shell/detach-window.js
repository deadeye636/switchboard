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
// activeSessionId (app.js, terminal-manager.js) · cleanDisplayName (lib/utils.js) · window.api.

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

// The session this window treats as "its own". It starts as the one the window was opened for and
// then FOLLOWS THE SET (#325): since #316 a window can hold several, and the opening one can move out
// while the others stay. Left pinned, the no-argument `reattachSession()` and the rekey filter would
// both track a session this window no longer has. `isDetachedWindow()` is the identity question and
// must never be asked through this value — it is the URL's answer, and it never changes.
window.__detachedSessionId = detachedSessionId;
window.isDetachedWindow = () => !!detachedSessionId;
window.isSessionDetached = (sessionId) => detachedSessions.has(sessionId);

if (detachedSessionId) document.body.classList.add('detached-window');

(function () {
  if (typeof document === 'undefined') return;

  // --- The detached window ---------------------------------------------------

  /**
   * Wait for a session's RECORD (name, project, backend) — what `openSession` takes. It arrives with
   * the scan that is part of the normal boot, so a window opened a moment ago does not have it yet.
   * Returns null once the budget is spent.
   */
  // Mounts in flight. `openSessions` only gains its entry once `openSession` has awaited its way
  // through main, and two paths can now reach for the same session in that gap — the boot reconcile
  // and an adopt that arrived while it was running. Two xterms on one PTY echo every keystroke twice.
  const mounting = new Set();

  // Sessions this window was told to let go of while a mount for them was still pending. The boot
  // reconcile works from a SNAPSHOT of what main said it owns, and a move out of this window during
  // that loop arrives as a release for a session that is not mounted yet — so `releaseSession` has
  // nothing to tear down and silently does nothing. Without this the stale loop would mount it after
  // the new owner already has, and `terminal-input` carries no ownership check: keystrokes typed into
  // the orphan still reach the live PTY.
  const cancelledMounts = new Set();

  async function mountOnce(session, show) {
    const id = session.sessionId;
    if (openSessions.has(id) || mounting.has(id) || cancelledMounts.has(id)) return;
    mounting.add(id);
    try {
      await openSession(session, undefined, { show });
      // Re-check AFTER the await: the release can land while openSession is in flight.
      if (cancelledMounts.has(id) && openSessions.has(id) && typeof destroySession === 'function') {
        destroySession(id);
      }
    } finally { mounting.delete(id); }
  }

  async function waitForSessionRecord(sessionId, tries) {
    for (let i = 0; i < tries && !sessionMap.has(sessionId); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return sessionMap.get(sessionId) || null;
  }

  async function bootDetachedWindow() {
    const session = await waitForSessionRecord(detachedSessionId, 200);
    if (!session) {
      // The session vanished between detaching and this window booting. Say so rather than showing an
      // empty frame the user cannot interpret.
      document.title = 'Switchboard — session not found';
      return;
    }
    document.title = sessionLabel(detachedSessionId);
    // The PTY is already running; this attaches to it and replays its buffer, exactly like clicking the
    // session in the main window would.
    await mountOnce(session, true);
    await adoptOwnedSessions();
    // Not just the title: a session mounted without a tab is a session the user cannot reach — this
    // window has no sidebar to pick one from. `refreshViews` is what builds the strip (and the pane
    // tree in panes mode) for the sessions the reconcile just brought in.
    refreshViews();
  }

  /**
   * Ask main what this window holds, and mount whatever is missing (#326, #331).
   *
   * The URL names ONE session — the one the window was opened for — and since #316 a window can hold
   * several. Two ways that diverges, both ending with main routing a session's bytes to a window that
   * draws it nowhere:
   *
   *   - a renderer RELOAD: the window comes back knowing only its URL, while main still has the rest
   *     registered against it (#326);
   *   - a move that lands MID-BOOT: `session-reattached` arrives before the scan has filled
   *     `sessionMap`, so `adoptSession` has no record to mount from and silently does nothing (#331).
   *
   * Running this at the end of boot answers both, because main is the authority in both cases. It is
   * additive — nothing already mounted is touched — so it is safe wherever it runs.
   */
  async function adoptOwnedSessions() {
    let owned = [];
    try { owned = (await window.api.sessionsInMyWindow()) || []; }
    catch { return; /* older main process: the URL session is all there is */ }
    for (const id of owned) {
      if (openSessions.has(id)) continue;
      const session = await waitForSessionRecord(id, 20);
      // No record after a second: the session is gone from the list. Leave it — mounting a session we
      // cannot describe is worse than a window that shows one less.
      if (!session) continue;
      // Not shown: the window keeps the session it booted on in front, and the rest arrive as tabs.
      await mountOnce(session, false);
    }
  }

  // --- The window's title ------------------------------------------------------
  //
  // Set once from the opening session, the title outlived what it described (#325): since #316 the
  // window holds a SET, and `listSessionWindows` promises windows are "named by what they show" —
  // the "Move to <window>" entries are built from `win.getTitle()`, which Electron takes from this
  // document's title. A stale one points the user at a window by a session that already left.

  function sessionLabel(sessionId) {
    const session = (openSessions.get(sessionId) || {}).session || sessionMap.get(sessionId);
    const raw = session && (session.name || session.aiTitle || session.summary);
    return (typeof cleanDisplayName === 'function' ? cleanDisplayName(raw) : '') || 'Session';
  }

  /**
   * Name the window after what it holds: its active session, plus a count of the rest. Everything a
   * detached window holds, it renders — so `openSessions` IS its set, no separate bookkeeping.
   * Doubles as the place `__detachedSessionId` follows the set, since both answer the same question.
   */
  function updateDetachedWindowTitle() {
    if (!detachedSessionId) return; // the main window titles itself
    const ids = [...openSessions.keys()];
    if (!ids.length) return; // mid-handover: keep the last name rather than flashing a generic one
    const activeId = (typeof activeSessionId !== 'undefined' && openSessions.has(activeSessionId))
      ? activeSessionId
      : ids[0];
    window.__detachedSessionId = activeId;
    const label = sessionLabel(activeId);
    document.title = ids.length > 1 ? `${label} +${ids.length - 1}` : label;
  }

  // `setActiveSession` in app.js is the choke point every focus path funnels through, and calls this.
  window.updateDetachedWindowTitle = updateDetachedWindowTitle;

  // --- Handing a session over ------------------------------------------------
  //
  // Both windows run these. Since #316 a session can move main → detached, detached → main and
  // detached → detached, and every one of those is the same pair: the window that has it lets go,
  // the window that gets it attaches. The only asymmetry is the bookkeeping — the main window tracks
  // which sessions live elsewhere so its sidebar and tabs can say so, and a detached window has
  // nothing to track: everything it holds, it renders.

  function releaseSession(sessionId) {
    if (!detachedSessionId) detachedSessions.add(sessionId);
    // Also cancels a mount that has not finished yet — see `cancelledMounts`.
    cancelledMounts.add(sessionId);
    // Let go of the terminal WITHOUT touching the process: close-terminal only clears
    // `rendererAttached` in main, so the PTY runs on and the receiving window attaches to it.
    if (openSessions.has(sessionId) && typeof destroySession === 'function') destroySession(sessionId);
    refreshViews();
  }

  async function adoptSession(sessionId, running) {
    detachedSessions.delete(sessionId);
    // An adopt is the opposite statement to a release, so it lifts the cancellation — otherwise a
    // session moved out and later moved back would never mount here again.
    cancelledMounts.delete(sessionId);
    // A record can be missing for a session that is genuinely new — started seconds ago and moved
    // before the scan caught up. Wait briefly rather than dropping the adopt (#331); the boot
    // reconcile covers the other window of time, but not this one.
    const hadRecord = sessionMap.has(sessionId);
    const session = sessionMap.get(sessionId) || await waitForSessionRecord(sessionId, 20);

    // Only a session that still HAS a process is taken back. Without this check, taking back a session
    // that had exited (or was stopped from the sidebar) would resume the CLI: openSession finds no live
    // PTY and spawns one, which is a process the user never asked for.
    //
    // Main answers this, not `activePtyIds`: that set is refreshed by a poll which backs off to 30 s in
    // an idle window, so a session started or stopped seconds ago can still read the other way. Falling
    // back to it keeps an older main process working.
    //
    // And if we WAITED above, the answer main sent is that much older than the decision it is about —
    // long enough for the user to stop the session in between, which is exactly the resume #315 exists
    // to prevent. So re-ask, from the same authority the poll uses, rather than trusting a fact that
    // has since had a second to stop being one.
    let stillRunning = typeof running === 'boolean'
      ? running
      : (typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId));
    if (stillRunning && !hadRecord) {
      try { stillRunning = ((await window.api.getActiveSessions()) || []).includes(sessionId); }
      catch { /* keep what main sent */ }
    }

    if (session && stillRunning && typeof openSession === 'function') {
      await mountOnce(session, true);
    } else if (detachedSessionId && !cancelledMounts.has(sessionId)) {
      // Nothing was mounted, and main still has this window down as the one rendering it. Give the
      // claim back rather than leaving a session routed to a window that draws it nowhere (#331) —
      // the main window's own adopt then decides whether there is a process left worth showing.
      try { await window.api.releaseSessionClaim(sessionId); }
      catch { /* older main process: nothing to hand back to */ }
    }
    refreshViews();
  }

  function refreshViews() {
    updateDetachedWindowTitle(); // the set just changed — a release or an adopt got us here
    if (typeof refreshSidebar === 'function') refreshSidebar();
    if (typeof window.refreshSessionTabs === 'function') window.refreshSessionTabs();
    if (window.panesView && window.panesView.active()) window.panesView.render();
  }

  // --- Wiring ----------------------------------------------------------------

  // Both windows answer the same two channels — see the handover comment above.
  window.api.onSessionDetached((sessionId) => releaseSession(sessionId));
  window.api.onSessionReattached((sessionId, running) => adoptSession(sessionId, running));

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
      // The window can hold several sessions (#316), and the rekeyed one need not be the one this
      // window currently calls its own — so re-derive rather than filter on a single id (#325). The
      // new id carries a new session record, hence a possibly new name in the title.
      if (fromId === window.__detachedSessionId) window.__detachedSessionId = toId;
      updateDetachedWindowTitle();
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
