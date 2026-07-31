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

// What this window was opened as. Read from the URL: the window knows what it is before any IPC
// round trip, so nothing has to wait for an answer.
//
// Three facts, and they used to be one. `detached=<id>` names the session it opens on and is null in
// the main window — which made it the identity answer too, for as long as every window of ours had a
// session. A window holding nothing but a view (#370) has none, so the identity is its own marker
// (`win=detached`) and `view=<kind>` says what it opens on instead. The legacy `detached` alone still
// counts as the marker, so nothing depends on both being present.
const detachParams = (() => {
  try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); }
})();
const detachedSessionId = detachParams.get('detached') || null;
const detachedViewKind = detachParams.get('view') || null;
const isOwnWindow = detachParams.get('win') === 'detached' || !!detachedSessionId;

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
window.isDetachedWindow = () => isOwnWindow;
window.isSessionDetached = (sessionId) => detachedSessions.has(sessionId);

if (isOwnWindow) document.body.classList.add('detached-window');

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
      clearDormantState(); // something is running here now — whatever it was, the placeholder is stale
      // Re-check AFTER the await: the release can land while openSession is in flight.
      if (cancelledMounts.has(id) && openSessions.has(id) && typeof destroySession === 'function') {
        destroySession(id);
      }
    } finally { mounting.delete(id); }
  }

  /** Does this session have a process, asked of main — the authority, not the renderer's poll. */
  async function isRunning(sessionId) {
    try { return ((await window.api.getActiveSessions()) || []).includes(sessionId); }
    catch { return typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId); }
  }

  /**
   * What a detached window shows for a session that is not running (#319).
   *
   * Panes mode already has this: a pane whose tab has no mounted session draws the placeholder with
   * the Launch button (#318), and `loadTree` gives this window that tab. Tabs mode never needed one —
   * a detached window meant one session, mounted on boot — so the app's own `#placeholder` is hidden
   * here by CSS and says "select a session in the sidebar", which this window does not have.
   *
   * Same wording and the same classes as the pane's, because it is the same statement: nothing is
   * running, and starting it is a button the user presses, not a side effect of opening a window.
   */
  function showDormantState(session) {
    if (window.panesView && window.panesView.active()) return; // the pane draws its own
    const host = document.getElementById('terminals');
    if (!host || document.getElementById('detached-dormant')) return;
    const empty = document.createElement('div');
    empty.id = 'detached-dormant';
    empty.className = 'pane-empty';
    // Name it. A pane's dormant tab carries the session name (`buildTab` reads sessionMap, not
    // openSessions), but the tab strip in this mode only lists MOUNTED sessions — so without this the
    // only thing identifying the window is its OS title bar, which is nothing to go on with several
    // detached windows open.
    const name = document.createElement('div');
    name.className = 'pane-empty-title';
    name.textContent = sessionLabel(session.sessionId);
    empty.appendChild(name);
    const text = document.createElement('div');
    text.textContent = 'This session is not running. Launching it starts the CLI again; its history stays either way.';
    empty.appendChild(text);
    const launch = document.createElement('button');
    launch.type = 'button';
    launch.className = 'new-session-secondary-btn pane-empty-launch';
    launch.textContent = 'Launch';
    launch.addEventListener('click', async () => {
      launch.disabled = true;
      // Starts HERE: main already has this window down as the session's, so the PTY it spawns sends
      // its bytes to this renderer rather than to the window the session was detached from.
      await mountOnce(session, true);
      refreshViews();
    });
    empty.appendChild(launch);
    host.appendChild(empty);
  }

  function clearDormantState() {
    document.getElementById('detached-dormant')?.remove();
  }

  /**
   * Show a session that has no process as a dormant tab, and say whether that worked (#332).
   *
   * Panes mode is the only place with somewhere to put one: a pane renders a tab whose session is not
   * mounted as the "not running / Launch" placeholder (#318), and nothing else in the renderer can put
   * an UNMOUNTED session into a strip — the tabs-mode one is built from `openSessions`.
   *
   * So the answer differs per window, and both halves are deliberate. In the MAIN window a `false` is
   * fine: the sidebar lists the session, which is the way back the move existed for. In a DETACHED
   * window there is no sidebar, so a `false` would mean holding a session it shows nowhere — which is
   * why `moveSessionToWindow` refuses that combination before it starts, and why the caller falls
   * through to handing the claim back if it ever gets here anyway.
   */
  function showDormantTab(sessionId, opts) {
    if (!window.panesView || !window.panesView.active()) return false;
    return !!window.panesView.openDormantTab?.(sessionId, opts);
  }

  async function waitForSessionRecord(sessionId, tries) {
    for (let i = 0; i < tries && !sessionMap.has(sessionId); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return sessionMap.get(sessionId) || null;
  }

  /**
   * Put back what this window held when the app last quit (#371).
   *
   * Answers whether it had anything to put back. The sessions are MOUNTED, which resumes their CLI —
   * that is what restoring a session means, and it is what the main window has always done with its
   * own set. It is deliberately not what an ADOPT does: a session moving between windows must never
   * start a process the user stopped, because there the user asked to move a window, not to launch.
   * Here they asked for their windows back.
   */
  async function restoreThisWindow() {
    let payload = null;
    try { payload = await window.api.myWindowRestore?.(); } catch { payload = null; }
    if (!payload) return false;
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    const views = Array.isArray(payload.views) ? payload.views : [];

    // The arrangement goes back FIRST (#372), so everything below lands in the pane it was in: a
    // mount and an `openViewTab` both look for an existing tab before making one, and this is what
    // puts those tabs there. It waits for panes mode the way an arriving view does — the window is
    // still booting and the mode is applied a few frames in. A window that never turns panes on has
    // no arrangement to restore, and its sessions simply come back as they always did.
    if (payload.layout) {
      await whenPanesActive();
      window.panesView?.applyRestoredLayout?.(payload.layout.tree, payload.layout.activeLeafId);
    }

    let first = null;
    for (const id of sessions) {
      // The same budget the boot path gives its own session: the index is being scanned while this
      // window loads, and a record that has not arrived yet is not a record that is missing.
      const session = await waitForSessionRecord(id, 200);
      if (!session) {
        // The session is gone from the index — deleted, or its store is not there any more. Main
        // still has this window down as the one rendering it, so hand the claim back rather than
        // leaving it routed at a window that shows it nowhere.
        try { await window.api.releaseSessionClaim(id); } catch { /* nothing to hand back to */ }
        continue;
      }
      await mountOnce(session, !first);
      if (!first) first = id;
    }

    // Only what another window could have filled comes back. That is the same rule a view crossing
    // windows obeys (#364): a kind with no loader would arrive blank, and an instanced preview or
    // diff is built by the window that opened it and cannot be rebuilt from a kind and a ref alone.
    for (const view of views) {
      if (window.panesView?.viewCanLeaveWindow?.(view.kind) === false) continue;
      acceptView(view.kind, view.ref == null ? null : view.ref, view.file || null);
    }
    refreshViews();
    return !!(sessions.length || views.length);
  }

  async function bootDetachedWindow() {
    // A window opened on a VIEW has no session to wait for (#370). What fills it arrives as an
    // `open-view` message a moment later, and `acceptView` waits for the pane tree on its own — so
    // there is nothing to do here but title the frame after what it is going to show. Waiting for a
    // session record we know is not coming would spend ten seconds and then title the window
    // "session not found".
    if (!detachedSessionId) {
      const kindTitle = detachedViewKind && window.panesView?.viewKindTitle?.(detachedViewKind);
      if (kindTitle) document.title = kindTitle;
      // …or on nothing at all, because it is a window the last run left behind (#371). What it held
      // is main's answer, not the URL's — the URL would have to carry a whole window's contents.
      await restoreThisWindow();
      await adoptOwnedSessions(); // a reload of a view window main has since given a session to
      refreshViews();
      return;
    }
    const session = await waitForSessionRecord(detachedSessionId, 200);
    if (!session) {
      // The session vanished between detaching and this window booting. Say so rather than showing an
      // empty frame the user cannot interpret.
      document.title = 'Switchboard — session not found';
      return;
    }
    document.title = sessionLabel(detachedSessionId);
    // A session with no process is SHOWN, not started (#319). Mounting is what would start it:
    // `openSession` calls openTerminal, which spawns when it finds no live PTY — so the act of
    // opening the window would launch a CLI the user did not ask for. Ask main rather than the
    // renderer's polled set, which in a window this young has not run once.
    if (await isRunning(detachedSessionId)) {
      // The PTY is already running; this attaches to it and replays its buffer, exactly like clicking
      // the session in the main window would.
      await mountOnce(session, true);
    } else {
      showDormantState(session);
    }
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
    if (!owned.length) return;
    // Mounting a session with no process STARTS one (#319) — `openSession` falls through to the spawn
    // branch. This loop must not do that on its own: what the user asked for was a window, and the
    // Launch button is where a CLI begins.
    let live = [];
    try { live = (await window.api.getActiveSessions()) || []; } catch { return; }
    for (const id of owned) {
      if (openSessions.has(id)) continue;
      const session = await waitForSessionRecord(id, 20);
      // No record after a second: the session is gone from the list. Leave it — mounting a session we
      // cannot describe is worse than a window that shows one less.
      if (!session) continue;
      if (!live.includes(id)) {
        // Owned, with no process. It cannot be mounted — that is what would spawn — but it must not be
        // dropped either: main still records this window as the one rendering it, so a reload that
        // silently skipped it left the session unreachable again, which is the bug #332 is about. It
        // gets the dormant tab a move gives it, behind whatever the boot path is showing.
        if (showDormantTab(id, { activate: false })) continue;
        // Nowhere to put one: tabs mode lists only mounted sessions and this window has no sidebar.
        // That is exactly what `release-session-claim` states, so main takes it back instead of
        // recording this window as the owner of something it draws nowhere.
        try { await window.api.releaseSessionClaim(id); }
        catch { /* older main process: nothing to hand back to */ }
        continue;
      }
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
   * Which sessions does THIS window hold? One answer, because it was derived twice and the second
   * caller (#394) got it subtly wrong.
   *
   * In panes mode the layout is the authority and `openSessions` is not (#366). That map holds mounted
   * terminals only, so a session that is not running is missing from it entirely — its tab is in the
   * window, drawn with a Launch placeholder, and the user can select it. Naming the window from
   * `openSessions` skipped straight past the selected tab to whichever running session happened to be
   * first; scoping the next-attention shortcut with it made a dormant tab unreachable, although a
   * stopped session can very much still be flagged (the flags outlive a pty exit, #259). Outside panes
   * mode there are no dormant tabs, so `openSessions` IS the set and stays the answer.
   */
  function sessionIdsInThisWindow() {
    const panes = (window.panesView && window.panesView.active()) ? window.panesView : null;
    return panes ? panes.sessionIdsInLayout() : [...openSessions.keys()];
  }
  window.sessionIdsInThisWindow = sessionIdsInThisWindow;

  /**
   * Name the window after what it holds: the session it is SHOWING, plus a count of the rest.
   * Doubles as the place `__detachedSessionId` follows the set, since both answer the same question.
   */
  function updateDetachedWindowTitle() {
    if (!isOwnWindow) return; // the main window titles itself
    const panes = (window.panesView && window.panesView.active()) ? window.panesView : null;
    const ids = sessionIdsInThisWindow();
    if (!ids.length) {
      // No session at all. Either this window holds only views (#370) — name it after them, the same
      // shape a session set is named with — or it is mid-handover, and there the last name is a
      // better answer than a generic one.
      const labels = panes ? panes.viewTabLabels() : [];
      if (!labels.length) return;
      window.__detachedSessionId = null;
      const shown = (panes.shownViewLabel && panes.shownViewLabel()) || labels[0];
      document.title = labels.length > 1 ? `${shown} +${labels.length - 1}` : shown;
      return;
    }
    const shown = panes ? panes.shownSessionId() : null;
    // A view tab is selected (`shown` is null) or the layout has not caught up: fall back to the
    // focused session, then to the first tab. Never to a session this window does not hold.
    const activeId = (shown && ids.includes(shown)) ? shown
      : (typeof activeSessionId !== 'undefined' && ids.includes(activeSessionId)) ? activeSessionId
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
    if (!isOwnWindow) detachedSessions.add(sessionId); // the main window is the one that tracks this
    // Also cancels a mount that has not finished yet — see `cancelledMounts`.
    cancelledMounts.add(sessionId);
    // Let go of the terminal WITHOUT touching the process: close-terminal only clears
    // `rendererAttached` in main, so the PTY runs on and the receiving window attaches to it.
    if (openSessions.has(sessionId) && typeof destroySession === 'function') destroySession(sessionId);
    // Nothing mounted, but a pane can still hold a TAB for it — a dormant one, from a saved layout or
    // from a dormant session moved in (#332). `destroySession` is what normally takes the tab with it,
    // so without this the window keeps a tab for a session another window now renders: clicking it
    // does nothing the user can interpret, because `openSession` raises that window instead of
    // mounting. The adopt puts the tab back if the session ever comes here again.
    else if (window.panesView && window.panesView.active()) window.panesView.dropSession(sessionId);
    refreshViews();
  }

  async function adoptSession(sessionId, running, placement, busy) {
    detachedSessions.delete(sessionId);
    // A session that is busy and STAYS busy sends no new edge, so without this the window taking one
    // mid-turn would draw a visibly working session as idle until the turn happened to end (#395).
    //
    // Through `setActivity`, NOT the record half directly: this file runs in EVERY window, main
    // included, and main is the one that marks sessions ready. The busy carried here comes from the
    // title-spinner latch, which is exactly what the ready-guard exists to disbelieve — writing past it
    // would recreate the busy-AND-ready state that nothing short of the PTY dying could clear (#252).
    // On a busy edge `setActivity` raises nothing anyway; it only refuses when the session is ready.
    if (busy === true) setActivity(sessionId, true);
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

    // Dropped ON this window, at a place it highlighted itself (#375). The tab is made FIRST, so the
    // mount below finds it already home — `adoptOrphans` only places a session that has no tab, and
    // the pane the user aimed at is exactly what that fallback would overwrite with "the active one".
    // It also covers the dormant case on its own: the tab is drawn as the Launch placeholder, so the
    // `showDormantTab` branch below has nothing left to do.
    let placed = false;
    if (placement && !cancelledMounts.has(sessionId) && window.panesView?.active?.()) {
      try { placed = !!window.panesView.applyPlacement(sessionId, placement, { mount: false }); }
      catch { placed = false; }
    }

    if (session && stillRunning && typeof openSession === 'function') {
      await mountOnce(session, true);
    } else if (placed) {
      // Nothing to mount, and it is already where the drop said — see above.
    } else if (session && !cancelledMounts.has(sessionId) && showDormantTab(sessionId)) {
      // Nothing to mount, but this window can SHOW it (#332). The claim stays here on purpose: handing
      // it back would undo the move the user just made, and `release-session-claim` states "I cannot
      // render this one", which is the opposite of what just happened.
    } else if (isOwnWindow && !cancelledMounts.has(sessionId)) {
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
    if (window.panesView && window.panesView.active()) window.panesView.render();
  }

  // --- Wiring ----------------------------------------------------------------

  // Both windows answer the same two channels — see the handover comment above.
  window.api.onSessionDetached((sessionId) => releaseSession(sessionId));
  window.api.onSessionReattached((sessionId, running, placement, busy) => adoptSession(sessionId, running, placement, busy));

  // --- Answering for a drag held over this window (#375) -----------------------
  //
  // Every window answers this, the main one included: a drag can be held over any of them, and the
  // one under the pointer is the only thing that knows where its panes are.
  //
  // The conversion is the inverse of `toScreenPoint` in app/detach.js, done HERE because only this
  // renderer knows its own zoom: `outerWidth / bounds.width` is CSS pixels per DIP, and `screenX` is
  // where this viewport starts in the same screen coordinates the point is given in.
  //
  // A point main asks us about is a point inside our bounds, so "no pane of mine" is never "not
  // here" — it is this window taking the drop into its active pane (#377). Answering null let that
  // landing happen with nothing drawn: the session appeared in a window that had highlighted
  // nothing, which is the one thing no other application that moves tabs between windows does. So
  // the answer names the window instead, and the hint below is what that answer looks like.
  const WINDOW_PLACEMENT = { kind: 'window' };

  // Drawn HERE rather than in panes-view: this is the hint for a window that has no pane to offer,
  // which includes a window in grid mode, where that view is not running at all.
  let windowDropHint = null;
  function showWindowDropHint() {
    if (!windowDropHint) {
      windowDropHint = document.createElement('div');
      windowDropHint.className = 'window-drop-hint';
    }
    if (windowDropHint.parentElement !== document.body) document.body.appendChild(windowDropHint);
  }
  function clearWindowDropHint() { if (windowDropHint) windowDropHint.remove(); }

  window.api.onProbeDropPoint?.((id, at, bounds) => {
    let placement = null;
    try {
      const zx = (Number(window.outerWidth) || bounds.width) / Math.max(1, bounds.width);
      const zy = (Number(window.outerHeight) || bounds.height) / Math.max(1, bounds.height);
      const clientX = (at.x * zx) - (Number(window.screenX) || 0);
      const clientY = (at.y * zy) - (Number(window.screenY) || 0);
      placement = window.panesView?.dropTargetAt?.(clientX, clientY) || null;
      window.panesView?.showPlacementHint?.(placement);
    } catch { placement = null; }
    if (placement) clearWindowDropHint();
    else { placement = WINDOW_PLACEMENT; showWindowDropHint(); }
    try { window.api.answerProbeDropPoint(id, placement); } catch { /* main stopped waiting */ }
  });

  window.api.onClearDropHint?.(() => {
    clearWindowDropHint();
    try { window.panesView?.showPlacementHint?.(null); } catch { /* nothing drawn */ }
  });

  // …and both can move a session (#316), so these three are defined before the split below. A detached
  // window needs them as much as the main one does: detached → detached is a move like any other.

  // Where a session can go: the main window plus every detached one, named by what they show. Main
  // marks the window that already holds it, so the caller does not have to guess.
  window.listSessionWindows = async (sessionId) => {
    try { return (await window.api.listSessionWindows(sessionId)) || []; } catch { return []; }
  };

  /**
   * The whole "where does this session render" block of a context menu (#316, #327): the way out or
   * back by name, then one "Move to <window>" entry per window it is not in.
   *
   * Both menus that offer this — the tab strip's and the pane's — used to build the block themselves
   * and only shared the last step. That left the decision above it (which direction to offer, and
   * whether a session without a process may go at all) copied verbatim in two files, which is exactly
   * the pair that drifts. This owns all of it; what stays with the caller is `addItem` — the menus
   * style and disable their items differently, and that difference is real.
   *
   * `addItem(label, handler, { disabled, before })` must return the created element, because the
   * window list arrives from the main process AFTER the menu is on screen, and each late entry is
   * inserted next to the one before it rather than at the end of the menu.
   * `isOpen()` lets the result be dropped if the user closed the menu in the meantime.
   */
  window.appendWindowItems = async (sessionId, addItem, isOpen) => {
    if (typeof addItem !== 'function') return;
    const live = !!sessionId && typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId);
    const detached = !!window.isDetachedWindow?.();
    // A window of its own is only worth offering in the direction the user is not already in: from a
    // detached window the useful move is back (#314). Listing "main" twice — once by name here, once
    // as a move target below — reads as two different actions.
    //
    // A session with no process may take either of those two (#332): a window of its own identifies it
    // and offers Launch (#319), and the window it returns to has the sidebar. What is still gated is
    // narrower — an EXISTING detached window can only take a dormant session in panes mode, where a
    // pane draws a dormant tab (#318). The tabs-mode strip lists only what is mounted, and a detached
    // window has no sidebar, so there it would arrive nowhere at all.
    const anchor = detached
      ? addItem('Return to main window', () => { window.reattachSession?.(sessionId); }, { disabled: !sessionId })
      : addItem('Move to new window', () => { window.detachSession?.(sessionId); }, { disabled: !sessionId });
    if (!anchor) return;

    const canTakeDormant = !!window.panesView?.active();
    const targets = (await window.listSessionWindows(sessionId))
      .filter((w) => !w.current && !(detached && w.isMain))
      .filter((w) => live || w.isMain || canTakeDormant);
    if (!targets.length || (typeof isOpen === 'function' && !isOpen())) return;
    let cursor = anchor;
    for (const target of targets) {
      const label = target.isMain ? 'Move to main window' : `Move to “${target.title}”`;
      cursor = addItem(label, () => window.moveSessionToWindow(sessionId, target.id),
        { before: cursor.nextSibling }) || cursor;
    }
  };

  window.moveSessionToWindow = async (sessionId, windowId, placement) => {
    // The one combination a move still cannot serve (#332): a session with no process into an EXISTING
    // detached window outside panes mode. There is no dormant tab in that strip and no sidebar beside
    // it, so the session would be held by a window that shows it nowhere — and the adopt would hand the
    // claim straight back, which looks like a move that silently undid itself. Refuse it by name.
    // Asked of main rather than `activePtyIds`, which backs off to 30 s in an idle window: refusing on a
    // stale answer would block a move that is perfectly fine.
    if (String(windowId) !== 'main' && !window.panesView?.active() && !(await isRunning(sessionId))) {
      window.showControlToast?.({
        message: 'That window cannot show a session that is not running',
        timeoutMs: 3000,
      });
      return false;
    }
    // `placement` (#375) is where inside that window it goes, when the drop said so.
    const res = await window.api.moveSessionToWindow(sessionId, windowId, placement);
    if (!res || !res.ok) {
      window.showControlToast?.({ message: 'Could not move this session', timeoutMs: 3000 });
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

  // Move a session into a window of its own. A session without a process may go as well (#319) — the
  // window identifies it and offers Launch rather than starting a CLI by opening.
  //
  // Answers with the new window's ID rather than a bare `true` (#340): moving a whole PANE is this
  // call for its first tab and `moveSessionToWindow` for every one after it, and the id is the only
  // way to name the window that was just made. Titles cannot serve — a window is named after a
  // session, and two sessions can carry the same name.
  //
  // `at` (#362) is where the user aimed, when the caller knows: a tear-off drag passes its drop point
  // so the window opens on that display. A menu entry passes nothing and main falls back to the
  // pointer's display, which is where the menu was clicked anyway.
  //
  // Defined ABOVE the detached-window return on purpose (#363): dropping a tab on empty space has to
  // mean the same thing in every window, and while this lived below, a detached window had no
  // `detachSession` at all — so the gesture there fell back to "send it to the main window", wherever
  // it had actually been dropped. Nothing in here is main-window-specific; `sessionMap` is app.js's
  // and both windows load it, and a session it does not know simply gets the generic title.
  window.detachSession = async (sessionId, at) => {
    const session = typeof sessionMap !== 'undefined' ? sessionMap.get(sessionId) : null;
    const title = (typeof cleanDisplayName === 'function'
      ? cleanDisplayName(session && (session.name || session.aiTitle || session.summary)) : '') || 'Session';
    const res = await window.api.detachSession(sessionId, title, at);
    if (!res || !res.ok) {
      window.showControlToast?.({ message: 'Could not detach this session', timeoutMs: 3000 });
      return null;
    }
    return res.windowId || null;
  };

  /**
   * The "Move to <window>" block for one of the app's own VIEWS (#364).
   *
   * Deliberately not `appendWindowItems`: that one decides things a view has no answer to — whether
   * the session is running, whether the target can take a dormant one, which direction is the useful
   * one. A view has none of those states. What it shares is the shape: the window list arrives from
   * main after the menu is on screen, so each late entry is inserted next to the one before it.
   *
   * "Move to new window" leads, the way the session block leads with its own (#370). It used to be
   * absent because a window boots around a session and one holding nothing but a view could not
   * exist; now it can, and this is the only way to ask for one that does not involve dragging.
   */
  window.appendViewWindowItems = async (tab, moveTo, addItem, isOpen) => {
    if (typeof addItem !== 'function' || typeof moveTo !== 'function') return;
    let windows = [];
    try { windows = (await window.listSessionWindows(null)) || []; }
    catch { return; }
    // Every window except this one, which main marks: a window has no id of its own to compare with,
    // and the answer it used to derive — "the window holding a session I hold" — is no answer at all
    // in a window that holds none (#370).
    const others = windows.filter((w) => !w.isSelf);
    if (typeof isOpen === 'function' && !isOpen()) return;
    let cursor = addItem('Move to new window', () => moveTo(null), {}) || null;
    for (const target of others) {
      const label = target.isMain ? 'Move to main window' : `Move to “${target.title}”`;
      const created = addItem(label, () => moveTo(target.id), cursor ? { before: cursor.nextSibling } : {});
      cursor = created || cursor;
    }
  };

  // A file picked in the MAIN window's sidebar, for a view that lives here (#364). This window has no
  // sidebar of its own — spec 17 puts it in the main window on purpose — so this is how these three
  // views are steered at all once they have been moved. The opener is the same function the sidebar
  // calls locally; nothing about showing the file differs, only who asked.
  const VIEW_FILE_OPENERS = { memory: 'openMemory', plan: 'openPlan', workFiles: 'openWorkFile' };
  window.api.onOpenViewFile((kind, payload) => {
    const name = VIEW_FILE_OPENERS[kind];
    const open = name && window[name];
    if (typeof open !== 'function' || !payload) return;
    try { open(payload); } catch { /* a file that will not open must not take the window with it */ }
  });

  // A view arriving from another window (#364). Nothing was handed over — the sender closed its own
  // tab and this window opens its own element, which it has had all along.
  //
  // It can arrive before this window is ready for it. A window created by the same drag is still
  // booting, and panes mode enables a few frames later; dropping the request there loses the view
  // outright, because the sender has already let go of its own. So it waits for the pane tree, on a
  // bounded budget — a window that never turns panes on cannot show a view tab at all, and retrying
  // for ever would leave a timer running in every grid-mode window.
  //
  // A restored arrangement waits on exactly the same thing (#372), so it is one wait, not two.
  const VIEW_ARRIVAL_TRIES = 40;      // ~4 s at the interval below, well past a cold window's boot
  const VIEW_ARRIVAL_INTERVAL_MS = 100;
  function whenPanesActive(tries = VIEW_ARRIVAL_TRIES) {
    return new Promise((resolve) => {
      const tick = (left) => {
        if (window.panesView && window.panesView.active()) return resolve(true);
        if (left <= 0) return resolve(false); // grid mode, or a window that never came up
        setTimeout(() => tick(left - 1), VIEW_ARRIVAL_INTERVAL_MS);
      };
      tick(tries);
    });
  }

  async function acceptView(kind, ref, file) {
    if (!(await whenPanesActive())) return;
    window.panesView.openViewTab(kind, { ref: ref == null ? null : ref, load: true });
    // The file the view was showing when it left (#364). Opened after the tab exists, through the
    // same opener the relay uses — a moved view that arrives blank reads as a move that half worked.
    if (file) {
      const name = VIEW_FILE_OPENERS[kind];
      const open = name && window[name];
      if (typeof open === 'function') { try { open(file); } catch { /* the tab is there either way */ } }
    }
  }
  window.api.onOpenView((kind, ref, file) => acceptView(kind, ref, file));

  // The identity, not the session (#370, #371). A window of ours can open on a view, or on nothing at
  // all until main hands back what it held — and asking `detachedSessionId` here left exactly those
  // two falling through to the MAIN window's wiring: no boot, and no `__suppressLaunchRestore`, so
  // the launch restore would have reopened the main window's whole set in a second window.
  if (isOwnWindow) {
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
      // This is this window's `session-forked` (#348). That event is addressed to the MAIN window
      // alone, by design — the sidebar and the badges live there — so nothing else was moving this
      // window's own `openSessions`, `sessionMap` and pane tab onto the new id. Output arrives under
      // the new id from this moment on and would have found no entry here at all.
      if (typeof window.rekeySessionState === 'function') window.rekeySessionState(fromId, toId);
      refreshViews(); // updates the title too, and repaints the tab strip / pane onto the new id
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

})();
