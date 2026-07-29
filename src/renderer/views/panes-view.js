// --- Panes view: the DOM half of display mode `panes` (#309) ---
//
// VS-Code-style editor groups. `#terminals` becomes the host for a split tree
// (the model is views/pane-tree.js, pure and tested); every leaf renders as a
// pane with its own strip and body, and a session's terminal container is MOVED
// into the body of the pane that owns its tab. Moving the live container is what
// grid mode already does (grid-view.js `wrapInGridCard` / `unwrapGridCards`), so
// no terminal is ever rebuilt or reattached — it changes parent and gets refitted.
//
// Inside one pane the containers stack exactly as tabs mode stacks them: all
// mounted and painted, the active one raised by z-index (see the CSS). That is
// what keeps a switch free of the hidden→visible repaint that made text
// staircase in #20.
//
// The strip carries the session tools too (#309 O13/H2): messages, tasks,
// variables, the IDE-emulation chip and stop sit left of a separator, the pane's
// own `…` menu right of it (#309 O6/A). `#terminal-header` — the singleton those
// tools live in for the other modes — is hidden while panes mode is on.
//
// Depends on renderer globals: openSessions, sessionMap, activeSessionId,
// activePtyIds, terminalsEl, placeholder, terminalHeader (app.js) · showSession,
// openSession, destroySession, safeFit, flushTerminalBuffer, drainReplayBuffer,
// restoreTerminalWebgl, suspendTerminalWebgl, forceRepaint (terminal-manager.js) ·
// getSessionStatus, getSessionRuntimeState, SESSION_STATUS_CLASSES,
// subagentActiveSessions (session-status.js, app.js) · cleanDisplayName
// (utils.js) · confirmAndStopSession, showJsonlViewer, openTasksView (app.js) ·
// PaneTree (views/pane-tree.js) · and four hooks the file panel exposes for the
// view-tab half (#310): window.isMcpActiveForSession, window.filePanelTabLabel,
// window.closeFilePanel, window.filePanelRelayout (views/file-panel.js).

// The drag payload type for a pane tab. It is a LAYOUT drag, so every other drop
// target has to be able to recognise and ignore it — the terminal container reads
// this too (`isPaneTabDrag` in terminal-manager.js), otherwise it would claim the
// drop and paste the payload into the shell.
const PANE_TAB_MIME = 'application/x-switchboard-pane-tab';

(function () {
  if (typeof document === 'undefined') return; // node test context

  const STORE_KEY = 'paneTree';
  const PERSIST_DEBOUNCE_MS = 400;
  // Below this the tools would crowd out the tabs, so they fold into the `…` menu.
  // One rule for the whole group — collapsing icon by icon reads as a glitch.
  const TOOLS_MIN_PANE_WIDTH = 420;

  let enabled = false;
  let tree = null;               // PaneTree node, null while the mode is off
  let activeLeafId = null;
  // Where the session tools sit (#310): 'bar' gives them a row of their own under
  // the tab strip, with the session's name and id beside them; 'strip' folds them
  // into the tab strip to save the 33 px. Both show the same actions.
  let toolsPlacement = 'bar';
  let closeBehavior = 'closeView';     // closeView | stopSession (agent sessions)
  let terminalCloseBehavior = 'kill';  // kill | keep (plain terminals)
  let middleClickCloses = true;
  let persistTimer = 0;

  // A terminal tab's id is derived from its session, never generated: the same
  // session always maps to the same tab, so a reload rebinds the stored tree to
  // the reopened sessions without a lookup table.
  const tabIdFor = (sessionId) => 'term:' + sessionId;
  const sessionOfTab = (tab) => (tab && tab.kind === 'terminal' ? tab.ref : null);
  const makeTerminalTab = (sessionId) => ({ id: tabIdFor(sessionId), kind: 'terminal', ref: sessionId });

  // --- View tabs (#310) ------------------------------------------------------
  // Everything that is not a terminal. Each of these kinds is a SINGLE element
  // the app already owns and shows full-area in the other modes; here the tab
  // hosts that element inside its pane instead. One element means one tab per
  // kind in the whole tree — the tab moves to the pane you opened it from rather
  // than being duplicated, which is what the underlying view can actually do.
  // `display` is how the takeover viewers announce themselves: their show
  // functions set it (and hide the terminal area, which the CSS neutralises in
  // this mode), `hideAllViewers` clears it. Watching that one property adopts all
  // of them without editing a show path in every viewer file. The file panel is
  // the exception — it toggles a class and a width, so showPanel/hidePanel call in
  // directly (`watched: false`).
  const VIEW_KINDS = {
    preview: { hostId: 'file-panel', title: 'Preview', watched: false },
    jsonl: { hostId: 'jsonl-viewer', title: 'Messages', watched: true },
    plan: { hostId: 'plan-viewer', title: 'Plan', watched: true },
    stats: { hostId: 'stats-viewer', title: 'Activity', watched: true },
    memory: { hostId: 'memory-viewer', title: 'Memory', watched: true },
  };
  const viewTabId = (kind) => 'view:' + kind;
  const isViewTab = (tab) => !!(tab && VIEW_KINDS[tab.kind]);
  const hostElementFor = (kind) => document.getElementById(VIEW_KINDS[kind].hostId);

  // Where each view element came from, remembered the first time it is adopted.
  // Guessing a home is not good enough: #file-panel lives inside #terminal-split
  // (file-panel.js builds that container at startup), and putting it back one
  // level up leaves the side-panel layout with nothing to size.
  const viewHomes = new Map(); // kind → { parent, next }

  function rememberHome(kind, host) {
    if (viewHomes.has(kind) || !host.parentElement) return;
    viewHomes.set(kind, { parent: host.parentElement, next: host.nextElementSibling });
  }

  // Leaf ids are `pane-N`, N one past the highest in the tree — deterministic, so
  // nothing here needs a random source and the tests can predict every id.
  function nextLeafId() {
    let max = 0;
    for (const leaf of PaneTree.leaves(tree)) {
      const m = /^pane-(\d+)$/.exec(leaf.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return 'pane-' + (max + 1);
  }

  function activeLeaf() {
    if (!tree) return null;
    const found = PaneTree.leaves(tree).find((l) => l.id === activeLeafId);
    if (found) return found;
    const first = PaneTree.leaves(tree)[0] || null;
    activeLeafId = first ? first.id : null;
    return first;
  }

  // --- Persistence (#309 O8) ------------------------------------------------
  // localStorage, like gridLayout/gridViewActive next door. Sizes are fractions,
  // so a layout saved on a 4K screen restores sanely on a laptop.

  // The ONE writer of the layout key, guard included (#344). A detached window owns no layout (#2):
  // it shares this origin's localStorage with the main window, so writing here would overwrite the
  // user's arrangement with the single pane it happens to show. The guard belongs to the key, not to
  // one of its writers — `disable()` used to write past it, and a display-mode change with a
  // detached window open replaced a three-pane layout with one session, with no undo. Ask the URL,
  // not `__detachedSessionId`: that one follows the window's session set since #325 and is empty
  // between a handover and the window closing — long enough to write.
  function writeTree() {
    if (window.isDetachedWindow && window.isDetachedWindow()) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(PaneTree.serialize(tree))); } catch { /* best effort */ }
  }

  function persist() {
    clearTimeout(persistTimer);
    // A sash drag fires dozens of updates per gesture; write once it settles.
    persistTimer = setTimeout(writeTree, PERSIST_DEBOUNCE_MS);
  }

  function loadTree() {
    // The detached window starts as one pane with one session (#2) — it reads the same localStorage
    // as the main window, so loading the stored tree would rebuild the whole arrangement over there,
    // panes and foreign tabs and all. Anything else it holds arrives through `adoptOrphans`.
    if (window.isDetachedWindow && window.isDetachedWindow()) {
      return PaneTree.createTree('pane-1', [makeTerminalTab(window.__detachedSessionId)]);
    }
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { stored = null; }
    const loaded = PaneTree.deserialize(stored, 'pane-1');
    // Prune against the SESSION LIST, never against what is mounted right now.
    // At startup the mode is applied before the launch restore has mounted a
    // single terminal, so pruning by `openSessions` threw the whole saved layout
    // away and every restored session then piled into one pane (#309).
    // A view tab is never restored: its element is empty until something opens a
    // file, a plan or a transcript into it, and a tab onto an empty view is
    // furniture. Terminals do come back — the session is still there.
    const withoutViews = PaneTree.pruneTabs(loaded, (tab) => !isViewTab(tab));
    if (typeof sessionMap === 'undefined' || sessionMap.size === 0) return withoutViews;
    return PaneTree.pruneTabs(withoutViews, (tab) => {
      const sid = sessionOfTab(tab);
      return !!sid && (sessionMap.has(sid) || openSessions.has(sid));
    });
  }

  // Every mounted session needs a home: one that has no tab yet lands in the
  // active pane. This is the single place where a session enters the tree, so
  // the launch restore, a sidebar click and the attention inbox all agree.
  function adoptOrphans() {
    for (const sessionId of openSessions.keys()) {
      if (!PaneTree.leafOfTab(tree, tabIdFor(sessionId))) {
        tree = PaneTree.addTab(tree, activeLeaf().id, makeTerminalTab(sessionId));
      }
    }
  }

  // --- Rendering ------------------------------------------------------------

  // The launch restore mounts N sessions one after another, each calling
  // showSession. Rebuilding the whole tree N times would move every container N
  // times; one rebuild per frame is enough and settles on the final state.
  // A microtask, NOT requestAnimationFrame: Chromium throttles rAF in a window
  // that is not visible, so a session mounted while the app sits behind another
  // window would keep its container in #terminals — outside every pane — until
  // something else forced a render. A microtask always runs.
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued || !enabled) return;
    renderQueued = true;
    queueMicrotask(() => { renderQueued = false; render(); });
  }

  function render() {
    if (!enabled || !tree) return;
    // A rebuild replaces every sash, so a drag in flight has already lost the element it was
    // holding. End it here — before the tree is walked, so the size it dragged to is the one drawn
    // — instead of leaving the gesture and its `pane-sashing` body class behind (#345).
    if (endSashDrag) endSashDrag();
    adoptOrphans();
    // Park every view element at home first. The rebuild below re-adopts the ones
    // that still have a tab; anything left inside the old pane DOM would be
    // destroyed with it by replaceChildren — and these are singletons, so that
    // would take the app's only preview panel with it.
    releaseAllViewElements();
    const root = buildNode(tree, []);
    // The containers were moved into the fresh panes above, so what is left in
    // #terminals is the previous (now empty) pane scaffolding.
    terminalsEl.replaceChildren(root);
    // Flush BEFORE anything becomes visible (#337). A background tab's output is buffered in this
    // mode, and the coalescing buffer can hold up to two seconds of it. Once the element carries
    // `.visible`, that pending chunk takes the write path immediately — and the drain in
    // `refitVisible` then puts the OLDER backlog on top of it, so the terminal shows newer output
    // above older. Flushing while the session is still non-visible parks the chunk behind the
    // backlog instead, which is what the tabs and grid reveal paths already do.
    flushBeforeReveal();
    applyVisibility();
    // Drain SYNCHRONOUSLY, in the same task as the reveal. It used to ride along in `refitVisible`'s
    // deferred frame, which left a window between "the element is visible" and "the backlog is
    // written": any flush landing in it takes the write path (the session now counts as visible) and
    // the deferred drain then puts older data on top — the same inversion, only narrower. Chromium
    // throttles rAF in an occluded window, which is exactly where that window is widest.
    drainRevealed();
    applyWebglPolicy();
    refitVisible();
    updateToolsOverflow();
  }

  /** Write out each revealed pane's replay backlog. Runs right after `applyVisibility`. */
  function drainRevealed() {
    if (typeof drainReplayBuffer !== 'function') return;
    for (const leaf of PaneTree.leaves(tree)) {
      const sessionId = sessionOfTab(leaf.tabs.find((t) => t.id === leaf.activeTabId));
      if (!sessionId || !openSessions.has(sessionId)) continue;
      try { drainReplayBuffer(sessionId); } catch { /* one bad session must not stop the rest */ }
    }
  }

  /**
   * Push each pane's pending coalesced chunk into its replay buffer while the session is still
   * non-visible, so the replay stays in order. Deliberately the ACTIVE tab of every leaf: those are
   * the ones `applyVisibility` is about to reveal.
   */
  function flushBeforeReveal() {
    if (typeof flushTerminalBuffer !== 'function') return;
    for (const leaf of PaneTree.leaves(tree)) {
      const sessionId = sessionOfTab(leaf.tabs.find((t) => t.id === leaf.activeTabId));
      if (!sessionId || !openSessions.has(sessionId)) continue;
      try { flushTerminalBuffer(sessionId); } catch { /* one bad session must not stop the rest */ }
    }
  }

  function buildNode(node, path) {
    if (PaneTree.isLeaf(node)) return buildPane(node);

    const el = document.createElement('div');
    el.className = 'pane-branch pane-' + node.orientation;
    node.children.forEach((child, i) => {
      if (i > 0) el.appendChild(buildSash(node, path, i - 1));
      const childEl = buildNode(child, path.concat(i));
      childEl.style.flex = `${child.size} 1 0`;
      el.appendChild(childEl);
    });
    return el;
  }

  function buildSash(branch, path, index) {
    const sash = document.createElement('div');
    sash.className = 'pane-sash pane-sash-' + branch.orientation;
    sash.setAttribute('role', 'separator');
    sash.setAttribute('aria-orientation', branch.orientation === 'row' ? 'vertical' : 'horizontal');
    sash.addEventListener('pointerdown', (e) => startSashDrag(e, sash, path, index, branch.orientation));
    return sash;
  }

  function buildPane(leaf) {
    const pane = document.createElement('div');
    pane.className = 'pane' + (leaf.id === activeLeafId ? ' pane-active' : '');
    pane.dataset.paneId = leaf.id;

    pane.appendChild(buildStrip(leaf));
    if (toolsPlacement === 'bar') {
      const bar = buildActionBar(leaf);
      if (bar) pane.appendChild(bar);
    }

    const body = document.createElement('div');
    body.className = 'pane-body';
    for (const tab of leaf.tabs) {
      if (isViewTab(tab)) {
        // The element follows its TAB, active or not — parked out of sight when
        // the pane shows something else. Leaving it behind on a switch would hand
        // it to the next replaceChildren.
        const host = hostElementFor(tab.kind);
        if (host) {
          rememberHome(tab.kind, host);
          host.classList.add('pane-hosted');
          host.classList.toggle('pane-hosted-hidden', tab.id !== leaf.activeTabId);
          body.appendChild(host);
        }
        continue;
      }
      const entry = openSessions.get(sessionOfTab(tab));
      if (entry) body.appendChild(entry.element); // moves the live container, xterm and all
    }
    // A tab whose session is not mounted is not an error: the saved layout
    // outlives the sessions in it, and the restore may not have reopened this
    // one. The tab stays, and clicking it opens the session into this pane.
    const activeTab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
    const activeMounted = activeTab && (isViewTab(activeTab) || openSessions.has(sessionOfTab(activeTab)));
    if (!leaf.tabs.length || !activeMounted) {
      body.appendChild(buildEmptyState(leaf, activeTab));
    }
    // Clicking anywhere in a pane makes it the one a sidebar click fills (O7).
    body.addEventListener('mousedown', () => focusPane(leaf.id), true);
    pane.appendChild(body);

    wireDropZones(pane, body, leaf.id);
    return pane;
  }

  // What an empty pane says. Three states: no tabs at all, a tab whose session is
  // still running elsewhere (a click attaches it — nothing to warn about), and a tab
  // whose session has no process. The last one carries the Launch button, because
  // that is the only case where opening it spawns a CLI (#318) — the button says so
  // instead of a tab click doing it silently.
  function buildEmptyState(leaf, activeTab) {
    const empty = document.createElement('div');
    empty.className = 'pane-empty';
    if (!leaf.tabs.length) {
      empty.textContent = 'Pick a session in the sidebar to open it here.';
      return empty;
    }
    const sessionId = sessionOfTab(activeTab);
    if (!sessionId || sessionIsLive(sessionId)) {
      empty.textContent = 'This session is not open — click its tab to open it here.';
      return empty;
    }
    const session = sessionMap.get(sessionId);
    const text = document.createElement('div');
    text.textContent = 'This session is not running. Launching it starts the CLI again; its history stays either way.';
    empty.appendChild(text);
    const launch = document.createElement('button');
    launch.type = 'button';
    launch.className = 'new-session-secondary-btn pane-empty-launch';
    launch.textContent = 'Launch';
    launch.disabled = !session;
    launch.addEventListener('click', (e) => {
      e.stopPropagation();
      focusPane(leaf.id);
      if (session && typeof openSession === 'function') openSession(session, undefined, { show: true });
    });
    empty.appendChild(launch);
    return empty;
  }

  function buildStrip(leaf) {
    const strip = document.createElement('div');
    strip.className = 'pane-strip';

    const list = document.createElement('div');
    list.className = 'session-tabs-list';
    const runtime = (typeof getSessionRuntimeState === 'function') ? getSessionRuntimeState() : {};
    for (const tab of leaf.tabs) list.appendChild(buildTab(leaf, tab, runtime));
    list.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) { list.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
    strip.appendChild(list);

    if (toolsPlacement === 'strip') {
      strip.appendChild(buildTools(leaf));
      const sep = document.createElement('span');
      sep.className = 'pane-strip-sep';
      strip.appendChild(sep);
    }

    const more = document.createElement('button');
    more.className = 'session-tabs-ctrl pane-more-btn';
    more.type = 'button';
    more.textContent = '…';
    more.title = 'Pane actions';
    more.setAttribute('aria-label', 'Pane actions');
    more.addEventListener('click', (e) => { e.stopPropagation(); openPaneMenu({ anchor: more }, leaf.id); });
    strip.appendChild(more);

    strip.addEventListener('mousedown', () => focusPane(leaf.id), true);
    // Right-click on the strip itself (the tabs stop propagation and add their own
    // items) — the pane actions without aiming at the `…` button.
    strip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openPaneMenu({ x: e.clientX, y: e.clientY }, leaf.id);
    });
    return strip;
  }

  // Did this session have a process that has since ended? `launchExitedSessions` is
  // the renderer's marker for exactly that (#290), and it is cleared again the moment
  // a live PTY turns up under the id — so a tab restored from a saved layout, whose
  // session never ran in this run, is not "exited" and still opens on click.
  function hasExited(sessionId) {
    return typeof launchExitedSessions !== 'undefined' && launchExitedSessions.has(sessionId);
  }

  // Clicking a session tab. Three cases, and only the third can start a process:
  // mounted → show it; not mounted but the PTY is alive → attach to it; neither →
  // opening it would SPAWN a fresh CLI. A tab looks like a view, not a launcher, so
  // that last one only selects the tab and lets the pane offer a Launch button
  // (#318). Without that, clicking a dead tab to be rid of it starts the very thing
  // the user was done with.
  function openFromTab(leaf, tab, session) {
    activeLeafId = leaf.id;
    const sessionId = sessionOfTab(tab);
    if (openSessions.has(sessionId)) { focusPane(leaf.id); showSession(sessionId); return; }
    if (!session || typeof openSession !== 'function') return;
    if (!sessionIsLive(sessionId)) {
      focusPane(leaf.id);
      tree = PaneTree.setActiveTab(tree, leaf.id, tab.id);
      render();
      persist();
      return;
    }
    // It already has a tab in THIS pane, so show() finds that leaf and the session
    // lands where the layout says.
    openSession(session, undefined, { show: true });
  }

  function sessionIsLive(sessionId) {
    return typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId);
  }

  function buildTab(leaf, tab, runtime) {
    if (isViewTab(tab)) return buildViewTab(leaf, tab);
    const sessionId = sessionOfTab(tab);
    const session = sessionMap.get(sessionId) || (openSessions.get(sessionId) || {}).session || null;
    const name = (typeof cleanDisplayName === 'function'
      ? cleanDisplayName(session && (session.name || session.aiTitle || session.summary)) : '')
      || String(sessionId || '').slice(0, 8);

    const el = document.createElement('div');
    el.className = 'session-tab' + (tab.id === leaf.activeTabId ? ' active' : '');
    el.dataset.sessionId = sessionId;
    el.dataset.tabId = tab.id;
    el.dataset.paneId = leaf.id;
    el.title = name;
    el.draggable = true;

    // Status dot: the sidebar's classes verbatim, so colour and motion cannot
    // drift between the three places that show it (#257, #269).
    const status = (session && typeof getSessionStatus === 'function') ? getSessionStatus(session, runtime) : null;
    if (status) el.classList.add(status.className);
    const dot = document.createElement('span');
    dot.className = 'session-tab-dot status-dot' + (status ? ' ' + status.className : '');
    el.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'session-tab-label';
    label.textContent = name;
    el.appendChild(label);

    const mounted = openSessions.has(sessionId);
    if (!mounted) el.classList.add(hasExited(sessionId) ? 'session-tab-exited' : 'session-tab-dormant');
    if (!mounted && hasExited(sessionId)) el.title = name + ' — this session has exited.';

    const close = document.createElement('button');
    close.className = 'session-tab-close';
    close.type = 'button';
    close.title = 'Close tab';
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTabFromUi(leaf.id, tab); });
    el.appendChild(close);

    el.addEventListener('click', () => { openFromTab(leaf, tab, session); });
    el.addEventListener('auxclick', (e) => {
      if (middleClickCloses && e.button === 1) { e.preventDefault(); closeSessionTab(sessionId); }
    });
    wireTabContextMenu(el, leaf.id, tab);
    wireTabDrag(el, leaf.id, tab.id);
    return el;
  }

  // Right-click on a tab: the tab's own actions plus the pane's (#312). Propagation
  // stops here so the strip's handler does not answer with the pane-only menu.
  function wireTabContextMenu(el, leafId, tab) {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPaneMenu({ x: e.clientX, y: e.clientY }, leafId, tab);
    });
  }

  // A tab for one of the app's views (#310). No status dot — a view has no
  // process — and closing it hands the element back rather than tearing anything
  // down, so reopening the same file lands in the same place.
  function buildViewTab(leaf, tab) {
    const el = document.createElement('div');
    el.className = 'session-tab session-tab-view' + (tab.id === leaf.activeTabId ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.dataset.paneId = leaf.id;
    el.draggable = true;

    const label = document.createElement('span');
    label.className = 'session-tab-label';
    label.textContent = viewTabLabel(tab);
    el.title = label.textContent;
    el.appendChild(label);

    const close = document.createElement('button');
    close.className = 'session-tab-close';
    close.type = 'button';
    close.title = 'Close tab';
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTabFromUi(leaf.id, tab); });
    el.appendChild(close);

    el.addEventListener('click', () => {
      activeLeafId = leaf.id;
      tree = PaneTree.setActiveTab(tree, leaf.id, tab.id);
      render();
      persist();
    });
    wireTabContextMenu(el, leaf.id, tab);
    wireTabDrag(el, leaf.id, tab.id);
    return el;
  }

  // What a view tab is called. The view itself knows best (the file it shows, the
  // session whose transcript it is); the kind's own title is the fallback.
  function viewTabLabel(tab) {
    const spec = VIEW_KINDS[tab.kind];
    if (tab.kind === 'preview' && typeof window.filePanelTabLabel === 'function') {
      return window.filePanelTabLabel(tab.ref) || spec.title;
    }
    return spec.title;
  }

  // Open (or re-target) the tab for a view. One tab per kind: the element is a
  // singleton, so the tab moves to the pane you opened it from instead of being
  // cloned into a second one. `nearSessionId` names the session it belongs to, so
  // the view lands beside the terminal that produced it.
  function openViewTab(kind, { ref = null, nearSessionId = null } = {}) {
    if (!enabled || !VIEW_KINDS[kind]) return false;
    const tabId = viewTabId(kind);
    const existing = PaneTree.leafOfTab(tree, tabId);
    const target = (nearSessionId && PaneTree.leafOfTab(tree, tabIdFor(nearSessionId))) || activeLeaf();
    if (!target) return false;

    if (existing) {
      // Stay where the user put it. Re-opening the same view (a session switch
      // re-asserts its file panel) must not drag the tab back out of the pane it
      // was dropped into — the drag would be undone by the next click.
      tree = PaneTree.setActiveTab(tree, existing.id, tabId);
      activeLeafId = existing.id;
      render();
      persist();
      return true;
    }
    tree = PaneTree.addTab(tree, target.id, { id: tabId, kind, ref });
    activeLeafId = target.id;
    render();
    persist();
    return true;
  }

  function closeViewTab(kind) {
    if (!enabled) return;
    const tabId = viewTabId(kind);
    const leaf = PaneTree.leafOfTab(tree, tabId);
    if (!leaf) return;
    releaseViewElement(kind);
    hideViewElement(kind);
    tree = PaneTree.closeTab(tree, leaf.id, tabId);
    activeLeaf();
    render();
    persist();
    showActiveOrPlaceholder();
  }

  // Put a view element back where the HTML had it. Every other display mode looks
  // for it there, so leaving it inside a pane would take the view with the pane.
  function releaseViewElement(kind) {
    const host = hostElementFor(kind);
    const home = viewHomes.get(kind);
    if (!host || !home || !home.parent) return;
    host.classList.remove('pane-hosted', 'pane-hosted-hidden');
    if (host.parentElement === home.parent) return;
    // Back to the exact slot, not just the right parent: the side-panel layout is
    // a flex row, so the resize handle has to stay between the terminals and it.
    if (home.next && home.next.parentElement === home.parent) home.parent.insertBefore(host, home.next);
    else home.parent.appendChild(host);
  }

  function releaseAllViewElements() {
    for (const kind of Object.keys(VIEW_KINDS)) releaseViewElement(kind);
  }

  // Closing the TAB has to close the VIEW. These four are shown by setting
  // `display` (that is also how panes-view learns about them), and nothing else
  // resets it on this path: without it the element goes home still visible and,
  // being `position:absolute; inset:0` in #main, covers the whole workspace with
  // no tab left to close it. `preview` is not here — it routes through the file
  // panel's own close, which owns its visibility.
  function hideViewElement(kind) {
    const spec = VIEW_KINDS[kind];
    const host = hostElementFor(kind);
    if (!spec || !spec.watched || !host) return;
    // Through the app's own teardown where there is one: hideAllViewers also puts
    // the terminal area back and drains the transcript's file watches (#75), which
    // setting `display` alone would leave polling. Only one of these can be open at
    // a time, so hiding all of them costs nothing.
    if (typeof hideAllViewers === 'function') hideAllViewers();
    else host.style.display = 'none';
  }

  // --- Adopting the takeover viewers ----------------------------------------
  // One observer instead of a branch inside every viewer's show function: a
  // viewer that becomes visible gets a tab in the pane its session belongs to,
  // and one that hides again loses it. The viewers keep their own logic; all this
  // changes is where the element is on screen.

  let viewObserver = null;

  function startViewWatch() {
    if (viewObserver) return;
    viewObserver = new MutationObserver((records) => {
      if (!enabled) return;
      for (const rec of records) {
        const kind = watchedKindOf(rec.target);
        if (!kind) continue;
        const visible = rec.target.style.display !== 'none';
        const hasTab = !!PaneTree.leafOfTab(tree, viewTabId(kind));
        if (visible && !hasTab) {
          openViewTab(kind, {
            ref: activeSessionId || null,
            nearSessionId: activeSessionId || null,
          });
        } else if (!visible && hasTab) {
          closeViewTab(kind);
        }
      }
    });
    for (const [kind, spec] of Object.entries(VIEW_KINDS)) {
      if (!spec.watched) continue;
      const el = hostElementFor(kind);
      if (!el) continue;
      viewObserver.observe(el, { attributes: true, attributeFilter: ['style'] });
      // An observer reports future mutations only. A viewer that was already open
      // when the mode was switched on would otherwise never be adopted and would
      // sit over the pane tree as an unmanaged overlay.
      if (el.style.display !== 'none' && el.style.display !== '') {
        openViewTab(kind, { ref: activeSessionId || null, nearSessionId: activeSessionId || null });
      }
    }
    // The file panel announces itself through a class, not `display`, so the loop
    // above cannot see it. Open in the previous mode means: still a fixed side
    // strip, squeezing the pane tree, with no tab — the one layout this mode is
    // supposed to end.
    const panel = hostElementFor('preview');
    if (panel && panel.classList.contains('open')) {
      panel.style.width = '';
      openViewTab('preview', { ref: activeSessionId || null, nearSessionId: activeSessionId || null });
    }
  }

  function stopViewWatch() {
    if (!viewObserver) return;
    viewObserver.disconnect();
    viewObserver = null;
  }

  function watchedKindOf(el) {
    for (const [kind, spec] of Object.entries(VIEW_KINDS)) {
      if (spec.watched && el && el.id === spec.hostId) return kind;
    }
    return null;
  }

  // The session tools of the pane's ACTIVE tab (#309 O13/H2). Same actions as the
  // singleton header they replace here, wired to this pane's session rather than
  // to `activeSessionId` — that is the whole point of moving them in.
  function buildTools(leaf) {
    const tools = document.createElement('div');
    tools.className = 'pane-tools';
    const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
    const sessionId = sessionOfTab(tab);
    if (!sessionId) return tools;
    const session = sessionMap.get(sessionId) || (openSessions.get(sessionId) || {}).session || null;

    const btn = (title, svg, onClick) => {
      const b = document.createElement('button');
      b.className = 'session-tabs-ctrl pane-tool-btn';
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = svg;
      b.addEventListener('click', (e) => { e.stopPropagation(); focusPane(leaf.id); onClick(); });
      return b;
    };

    tools.appendChild(btn('View messages',
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>',
      () => { if (session && typeof showJsonlViewer === 'function') showJsonlViewer(session); }));

    tools.appendChild(btn('Tasks for this session',
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
      () => {
        if (!session || typeof openTasksView !== 'function') return;
        openTasksView({ sessionId }, 'Session · ' + (session.name || session.aiTitle || session.summary || sessionId));
      }));

    const varsBtn = btn('Saved variables',
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M12 12l8.5-8.5"/><path d="M16 8l2 2"/><path d="M18.5 5.5l2 2"/></svg>',
      () => {
        window.showVariablesQuickPick?.({
          sessionId,
          projectPath: (session && session.projectPath) || null,
          running: activePtyIds.has(sessionId),
          anchor: varsBtn,
        });
      });
    tools.appendChild(varsBtn);

    // No IDE-emulation chip here (#321). It only ever appeared when the bridge was
    // ACTIVE — never a visible "off" — so the state worth knowing about was the one
    // it stayed silent for. It is a global setting, so with four panes it drew four
    // identical marks, and it toggles nothing where it stands. The single
    // `#terminal-header` chip keeps it for the other display modes.

    if (activePtyIds.has(sessionId)) {
      tools.appendChild(btn('Stop process',
        '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>',
        () => { if (typeof confirmAndStopSession === 'function') confirmAndStopSession(sessionId); }))
        .classList.add('pane-tool-stop');
    }
    return tools;
  }

  // The session's own bar under the tab strip (#310, variant H1): what the single
  // `#terminal-header` shows in the other modes, per pane and for the pane's
  // active session. Nothing to show for a view tab — a preview has no process.
  function buildActionBar(leaf) {
    const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
    const sessionId = sessionOfTab(tab);
    const entry = sessionId ? openSessions.get(sessionId) : null;
    if (!sessionId) return null;
    const session = sessionMap.get(sessionId) || (entry || {}).session || null;

    const bar = document.createElement('div');
    bar.className = 'pane-actionbar';
    // The pane's own chrome answers a right-click with the pane actions, same as the
    // strip (#312). Under the default `paneToolsPlacement: bar` this row is most of
    // what the pane shows above its terminal, so leaving it out would mean aiming at
    // the thin strip to get a menu the bar is sitting right under.
    bar.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openPaneMenu({ x: e.clientX, y: e.clientY }, leaf.id);
    });

    const info = document.createElement('div');
    info.className = 'pane-actionbar-info';

    // The status dot leads the name, the way it does in the sidebar row and on the
    // tab (#321/#14). It belongs to the session, not to the actions — sitting among
    // the tool buttons it read as one more thing to click, and it was the only place
    // in the app where this signal was on the right.
    const running = activePtyIds.has(sessionId);
    const status = document.createElement('span');
    status.className = 'pane-status ' + (running ? 'running' : 'stopped');
    status.title = running ? 'Running' : 'Stopped';
    status.setAttribute('role', 'img');
    status.setAttribute('aria-label', status.title);
    info.appendChild(status);

    const name = document.createElement('span');
    name.className = 'pane-actionbar-name';
    name.textContent = (typeof cleanDisplayName === 'function'
      ? cleanDisplayName(session && (session.name || session.aiTitle || session.summary)) : '') || sessionId;
    info.appendChild(name);

    const ptyTitle = entry && entry.ptyTitle;
    if (ptyTitle) {
      const pty = document.createElement('span');
      pty.className = 'pane-actionbar-pty';
      pty.textContent = ptyTitle;
      info.appendChild(pty);
    }

    const id = document.createElement('span');
    id.className = 'pane-actionbar-id';
    id.textContent = sessionId;
    info.appendChild(id);

    bar.appendChild(info);
    bar.appendChild(buildTools(leaf));
    bar.addEventListener('mousedown', () => focusPane(leaf.id), true);
    return bar;
  }

  // Fold the tools away in a pane too narrow to carry them (they stay reachable
  // in the `…` menu). Measured after layout, so it survives a sash drag too.
  function updateToolsOverflow() {
    for (const pane of terminalsEl.querySelectorAll('.pane')) {
      pane.classList.toggle('pane-narrow', pane.clientWidth > 0 && pane.clientWidth < TOOLS_MIN_PANE_WIDTH);
    }
  }

  // --- Visibility + fit -----------------------------------------------------

  function applyVisibility() {
    for (const leaf of PaneTree.leaves(tree)) {
      for (const tab of leaf.tabs) {
        const entry = openSessions.get(sessionOfTab(tab));
        if (!entry) continue;
        entry.element.classList.toggle('visible', tab.id === leaf.activeTabId);
      }
    }
  }

  // Every terminal in the layout renders the same way — all WebGL, or all DOM (#320).
  //
  // This used to follow the focused pane, inherited from the grid (#140). Panes put
  // two full-height terminals side by side, and there the two renderers do not agree
  // on the cell box: at devicePixelRatio 2 the measured cell was 8.000 px under
  // WebGL and 8.2065 px under DOM, so the unfocused pane drew visibly heavier and
  // sat a line off. A renderer split you can see is worse than either renderer.
  //
  // …and with more than one terminal on screen, that renderer is the DOM one.
  //
  // #320 first gave every pane WebGL, on a measurement: two panes on WebGL, ~18 000
  // distinct codepoints flooded through each to recycle the shared atlas several
  // times over — no corruption. That measurement was too short. In daily use, two
  // terminals rendering ALTERNATELY over minutes, each with its own glyph set, do
  // reproduce #118: one recycles the atlas while the other has already read its
  // coordinates, and characters go missing until something repaints. The atlas
  // contention is real; only the context churn was fixed.
  //
  // So: one terminal on screen → WebGL, several → all DOM. Both failures this mode
  // has seen are gone in that state — no shared atlas to fight over, and no metric
  // split, since the split needs two renderers at once.
  //
  // What decides is how many terminals are VISIBLE AT ONCE — one per pane. Two tabs
  // in one pane are the tabs-mode case, where the atlas is shared too but only one
  // terminal is on screen and the reveal repaint (#118) heals it. Two panes have no
  // such moment: both are on screen, and the one nobody touched keeps the holes.
  //
  // The policy then applies to every mounted terminal, background tabs included —
  // they stay painted so a tab switch does not reflow (#20), so their contexts would
  // recycle the atlas under the visible ones.

  function applyWebglPolicy() {
    const mounted = [];
    let visible = 0;
    for (const leaf of PaneTree.leaves(tree)) {
      for (const tab of leaf.tabs) {
        const sessionId = sessionOfTab(tab);
        const entry = sessionId ? openSessions.get(sessionId) : null;
        if (!entry) continue;
        const active = tab.id === leaf.activeTabId;
        if (active) visible++;
        mounted.push({ leafId: leaf.id, sessionId, entry, active });
      }
    }
    const wantGl = visible <= 1;
    for (const { sessionId, entry } of mounted) {
      // Only ACT on a difference. Recreating the addon on every render (a status
      // tick, a tab click) tore down and rebuilt the GL context each time and left
      // orphaned canvases stacked in the container, until the terminal painted
      // nothing at all.
      if (wantGl && !entry.webglAddon && typeof restoreTerminalWebgl === 'function') restoreTerminalWebgl(sessionId);
      else if (!wantGl && entry.webglAddon && typeof suspendTerminalWebgl === 'function') suspendTerminalWebgl(sessionId);
    }
    // A load can refuse — the setting is off, or WebGL gave up after repeated
    // context losses. Then some panes have GL and some do not, which is the split
    // this policy exists to prevent, so the ones that got it give it back.
    if (wantGl && mounted.some((m) => !m.entry.webglAddon)) {
      for (const { sessionId, entry } of mounted) {
        if (entry.webglAddon && typeof suspendTerminalWebgl === 'function') suspendTerminalWebgl(sessionId);
      }
      return;
    }
    // The active terminal just changed parent, and a moved WebGL canvas keeps a
    // texture atlas another terminal may have grown meanwhile (#118).
    const active = mounted.find((m) => m.leafId === activeLeafId && m.active);
    if (active && active.entry.webglAddon && typeof forceRepaint === 'function') forceRepaint(active.entry);
  }

  function refitVisible() {
    requestAnimationFrame(() => {
      for (const leaf of PaneTree.leaves(tree)) {
        const sessionId = sessionOfTab(leaf.tabs.find((t) => t.id === leaf.activeTabId));
        const entry = sessionId ? openSessions.get(sessionId) : null;
        if (!entry) continue;
        // One terminal that cannot be fitted (disposed mid-frame, zero-sized box)
        // must not take the other panes' fits — or the chrome pass below — with it.
        try {
          // The flush that matters for ORDER happened before `applyVisibility` (#337). This one is
          // for the paths that reach here without a rebuild — a window resize, a sash drag — where
          // the session is already visible and a flush writes straight through. It must stay ahead of
          // the drain either way: with a pending chunk and a backlog both present, writing the chunk
          // second would show newer output above older.
          if (typeof flushTerminalBuffer === 'function') flushTerminalBuffer(sessionId);
          if (typeof drainReplayBuffer === 'function') drainReplayBuffer(sessionId);
          if (typeof safeFit === 'function') safeFit(entry);
        } catch { /* keep fitting the rest */ }
      }
      // A second frame: the fit above can change the pane's own metrics, and the
      // fold-away threshold has to see the settled width, not the one mid-reflow.
      requestAnimationFrame(updateToolsOverflow);
    });
  }

  // --- Actions --------------------------------------------------------------

  function focusPane(leafId) {
    if (!enabled || leafId === activeLeafId) return;
    if (!PaneTree.leaves(tree).some((l) => l.id === leafId)) return;
    activeLeafId = leafId;
    for (const pane of terminalsEl.querySelectorAll('.pane')) {
      pane.classList.toggle('pane-active', pane.dataset.paneId === leafId);
    }
    // Focus follows the pane: the session shown there becomes the active one, so
    // the sidebar highlight and every activeSessionId-scoped action line up.
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    const sessionId = leaf ? sessionOfTab(leaf.tabs.find((t) => t.id === leaf.activeTabId)) : null;
    if (sessionId && openSessions.has(sessionId) && sessionId !== activeSessionId) showSession(sessionId);
    // Since #320 the renderer no longer follows the focus — every pane has the same
    // one — so this is only here for the atlas repaint of the pane that just came
    // forward, and for the case a pane gained a mounted session without a rebuild.
    applyWebglPolicy();
    persist();
  }

  function splitActivePane(direction) {
    if (!enabled) return;
    const leaf = activeLeaf();
    if (!leaf) return;
    const newLeafId = nextLeafId();
    // The new pane starts EMPTY and takes focus: a terminal cannot be shown twice
    // (one PTY, one container), so there is nothing to duplicate into it. The next
    // sidebar click fills it, which is exactly what O7 promises.
    tree = PaneTree.splitLeaf(tree, leaf.id, direction, { newLeafId });
    activeLeafId = newLeafId;
    render();
    persist();
  }

  function closePane(leafId) {
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    if (!leaf) return;
    if (PaneTree.leaves(tree).length === 1) return; // the last pane stays
    // Closing a pane closes its views, not its sessions: every PTY keeps running
    // and every session stays in the sidebar, reopenable. destroySession() calls
    // back into dropSession(), which is what takes each tab out of the tree — so
    // this loop must not remove them a second time.
    for (const tab of leaf.tabs.slice()) {
      // A view tab in this pane loses its tab with the pane, so its view has to be
      // closed too — otherwise the element goes home still visible and covers the
      // workspace with nothing left to dismiss it.
      if (isViewTab(tab)) {
        if (tab.kind === 'preview' && typeof window.closeFilePanel === 'function') window.closeFilePanel();
        else hideViewElement(tab.kind);
        continue;
      }
      const sessionId = sessionOfTab(tab);
      if (sessionId && typeof destroySession === 'function') destroySession(sessionId);
    }
    // An empty pane is left behind when it had no tabs to begin with, or when the
    // last dropSession collapsed nothing because the pane was already the target.
    tree = PaneTree.removeLeaf(tree, leafId);
    activeLeaf();
    render();
    persist();
    showActiveOrPlaceholder();
  }

  // Remove a tab from the layout without touching its session (a dormant tab).
  function dropTab(leafId, tabId) {
    tree = PaneTree.closeTab(tree, leafId, tabId);
    activeLeaf();
    render();
    persist();
  }

  // Close one session's tab. Mirrors tabs mode: the view goes, the PTY survives —
  // unless the close behaviour says otherwise for this kind of session.
  function closeSessionTab(sessionId) {
    const entry = openSessions.get(sessionId);
    const isTerminal = !!(entry && entry.session && entry.session.type === 'terminal');
    const kill = isTerminal ? (terminalCloseBehavior === 'kill') : (closeBehavior === 'stopSession');
    if (kill) { try { window.api.stopSession(sessionId); } catch { /* ignore */ } }
    if (typeof destroySession === 'function') destroySession(sessionId); // → dropSession()
    showActiveOrPlaceholder();
  }

  // After a close: show whatever the active pane now holds, or fall back to the
  // placeholder so the main area is never left blank.
  function showActiveOrPlaceholder() {
    const leaf = activeLeaf();
    const tabs = leaf ? leaf.tabs : [];
    const onTop = tabs.find((t) => t.id === leaf.activeTabId);
    const sessionId = sessionOfTab(onTop);
    if (sessionId && openSessions.has(sessionId)) { showSession(sessionId); return; }
    // A VIEW is on top of this pane. Clearing the active session here would look
    // harmless and is not: the file panel follows the active session, so clearing
    // it closes the panel — and with it the very preview tab that is on top (#310).
    // Keep the session; only a pane with nothing live in it falls back to the
    // placeholder.
    if (typeof activeSessionId !== 'undefined' && activeSessionId && openSessions.has(activeSessionId)) return;
    const fallback = tabs.map(sessionOfTab).find((id) => id && openSessions.has(id));
    if (fallback) showSession(fallback);
    else if (typeof window.clearActiveTerminalView === 'function') window.clearActiveTerminalView();
  }

  // --- Pane menu (#309 O6/A) ------------------------------------------------

  let activeMenu = null;
  let menuDismissHandlers = null;
  // Take the document listeners down with the menu. Leaving them to remove
  // themselves only works on the paths they detect — clicking an item closes the
  // menu directly, and the pair would linger for the rest of the session.
  function closePaneMenu() {
    if (menuDismissHandlers) {
      document.removeEventListener('mousedown', menuDismissHandlers.out, true);
      document.removeEventListener('keydown', menuDismissHandlers.esc, true);
      menuDismissHandlers = null;
    }
    if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  }

  // Closing a tab from the UI — the × and the context menu take the same path, so a
  // view still gets told to close itself and a dormant session still leaves the
  // layout without touching anything live.
  function closeTabFromUi(leafId, tab) {
    if (isViewTab(tab)) {
      // Tell the VIEW to close, not just the layout: it owns the state that decides
      // whether it reappears, and a tab-only close would be undone by the next
      // session switch. Its own close path comes back through closeViewTab.
      if (tab.kind === 'preview' && typeof window.closeFilePanel === 'function') window.closeFilePanel();
      else closeViewTab(tab.kind);
      return;
    }
    const sessionId = sessionOfTab(tab);
    // Nothing to tear down for a tab whose session was never mounted — drop it from
    // the layout and leave the session alone.
    if (!openSessions.has(sessionId)) { dropTab(leafId, tab.id); return; }
    closeSessionTab(sessionId);
  }

  // The tab half of the context menu. A view tab has no process, so it gets Close
  // and nothing else.
  function addTabItems(item, leafId, tab) {
    item('Close', () => closeTabFromUi(leafId, tab));
    if (isViewTab(tab)) return;
    const sessionId = sessionOfTab(tab);
    item('Stop & close', () => {
      try { window.api.stopSession(sessionId); } catch { /* already gone */ }
      closeTabFromUi(leafId, tab);
    }, { danger: true, disabled: !activePtyIds.has(sessionId) });
    item('Relaunch', () => window.relaunchSession(sessionId), {
      disabled: typeof window.relaunchSession !== 'function',
    });
  }

  // Under the `…` button, or at the cursor for a right-click — clamped into the
  // viewport either way.
  function positionPaneMenu(pop, at) {
    pop.style.position = 'fixed';
    if (at && at.anchor) {
      const r = at.anchor.getBoundingClientRect();
      pop.style.top = (r.bottom + 4) + 'px';
      pop.style.right = Math.max(4, window.innerWidth - r.right) + 'px';
      return;
    }
    const rect = pop.getBoundingClientRect();
    pop.style.left = Math.max(4, Math.min(at.x, window.innerWidth - rect.width - 4)) + 'px';
    pop.style.top = Math.max(4, Math.min(at.y, window.innerHeight - rect.height - 4)) + 'px';
  }

  // The `…` button and a right-click show the same menu (#312). The button is the
  // discoverable entry point, the right-click the fast one, so neither may grow
  // items the other lacks — both come through here. `tab` is the tab that was
  // right-clicked; without one the menu is the pane's alone.
  function openPaneMenu(at, leafId, tab = null) {
    closePaneMenu();
    const pop = document.createElement('div');
    pop.className = 'popover session-tab-menu';
    const item = (label, handler, opts = {}) => {
      const b = document.createElement('button');
      b.className = 'session-tab-menu-item' + (opts.danger ? ' danger' : '');
      b.type = 'button';
      b.textContent = label;
      if (opts.disabled) b.disabled = true;
      else b.addEventListener('click', () => { closePaneMenu(); handler(); });
      // `before` is for items that arrive late (the window list, #316) and still belong next to the
      // entry they extend, rather than after the destructive one at the bottom.
      if (opts.before && opts.before.parentElement === pop) pop.insertBefore(b, opts.before);
      else pop.appendChild(b);
      return b;
    };
    const separator = () => {
      const s = document.createElement('div');
      s.className = 'session-tab-menu-sep';
      pop.appendChild(s);
    };

    focusPane(leafId);
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    // Whose session the tab actions and the detach act on: the right-clicked tab if
    // there is one, else the pane's active tab. Taking the active tab while the
    // menu points at another would act on a session the user never aimed at.
    const subject = tab || (leaf ? leaf.tabs.find((t) => t.id === leaf.activeTabId) : null);
    if (tab) { addTabItems(item, leafId, tab); separator(); }

    item('Split right', () => splitActivePane('right'));
    item('Split down', () => splitActivePane('down'));
    // Where this session renders (#2, #314, #316): a window of its own, or any window that already
    // exists. The shared helper builds the block (#327) — including the window list, which lives in
    // main and therefore arrives after the menu is on screen, inserted next to the entry it extends
    // rather than after Close pane.
    if (typeof window.appendWindowItems === 'function') {
      window.appendWindowItems(sessionOfTab(subject), item, () => activeMenu === pop);
    }
    // Closing the PANE is not a tab action: a right-click on a tab is about that tab,
    // and with one tab in the pane the two would read as the same thing. It stays on
    // the pane's own menus — the `…` button, the strip, the session bar.
    if (!tab) {
      item('Close pane', () => closePane(leafId), {
        danger: true,
        disabled: PaneTree.leaves(tree).length === 1,
      });
    }

    document.body.appendChild(pop);
    positionPaneMenu(pop, at);
    activeMenu = pop;
    setTimeout(() => {
      if (!activeMenu) return; // closed again before the listeners went up
      const out = (e) => { if (activeMenu && !activeMenu.contains(e.target)) closePaneMenu(); };
      const esc = (e) => { if (e.key === 'Escape') closePaneMenu(); };
      menuDismissHandlers = { out, esc };
      document.addEventListener('mousedown', out, true);
      document.addEventListener('keydown', esc, true);
    }, 0);
  }

  // --- Drag & drop (#309 W4) ------------------------------------------------
  // Dragging a tab: onto another tab → insert there; onto a pane body → the 10 %
  // edge zones split in that direction, the centre moves the tab into the pane.
  // The ratio is VS Code's for an editor drag (editorDropTarget.ts).

  const EDGE_RATIO = 0.1;
  let drag = null; // { tabId, fromLeafId }

  // Is this event our tab drag? The MIME is the authority (it survives the trip
  // through nested targets); the module state only carries the source.
  const isTabDrag = (e) => !!drag
    && !!e.dataTransfer
    && Array.prototype.includes.call(e.dataTransfer.types || [], PANE_TAB_MIME);

  function wireTabDrag(el, leafId, tabId) {
    el.addEventListener('dragstart', (e) => {
      drag = { tabId, fromLeafId: leafId };
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Only the custom type — a text/plain payload would be inserted into the
      // terminal by any drop that reached it.
      try { e.dataTransfer.setData(PANE_TAB_MIME, tabId); } catch { /* type refused */ }
    });
    el.addEventListener('dragend', () => { drag = null; el.classList.remove('dragging'); clearDropFeedback(); });
    el.addEventListener('dragover', (e) => {
      if (!isTabDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.stopPropagation();
      const gap = tabDropGap(el, leafId, tabId, e);
      showTabCaret(el.parentElement, gap.edge);
    });
    el.addEventListener('drop', (e) => {
      if (!isTabDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      applyMove(drag, leafId, tabDropGap(el, leafId, tabId, e).index);
    });
  }

  // Which gap a drop on this tab means, and where the caret marking it sits. The
  // cursor's half decides: left of the midpoint inserts before the tab, right of it
  // after — without that, a tab could never be dropped last (#313).
  function tabDropGap(el, leafId, tabId, e) {
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    const at = leaf ? leaf.tabs.findIndex((t) => t.id === tabId) : -1;
    const r = el.getBoundingClientRect();
    const after = e.clientX > r.left + (r.width / 2);
    return {
      index: at < 0 ? -1 : at + (after ? 1 : 0),
      edge: after ? el.offsetLeft + el.offsetWidth : el.offsetLeft,
    };
  }

  // Where the caret goes when the drop would append: past the last tab, or the very
  // start of an empty strip.
  function endCaretEdge(list) {
    // Not lastElementChild — the caret lives in this list too and would measure
    // itself.
    const tabs = list ? list.querySelectorAll('.session-tab') : [];
    const last = tabs[tabs.length - 1];
    return last ? last.offsetLeft + last.offsetWidth : 0;
  }

  function wireDropZones(pane, body, leafId) {
    // The strip's empty space takes a tab too — aiming at the tab row is the
    // obvious gesture, and without this it would land nowhere.
    const strip = pane.querySelector('.pane-strip');
    if (strip) {
      const list = strip.querySelector('.session-tabs-list');
      strip.addEventListener('dragover', (e) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        showTabCaret(list, endCaretEdge(list));
      });
      strip.addEventListener('dragleave', (e) => {
        if (!strip.contains(e.relatedTarget)) clearTabCaret();
      });
      strip.addEventListener('drop', (e) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        clearDropFeedback();
        applyMove(drag, leafId, -1);
      });
    }

    body.addEventListener('dragover', (e) => {
      if (!isTabDrag(e)) return;
      // preventDefault is what makes this a drop target at all — the terminal
      // container inside deliberately does NOT do it for a tab drag (#309).
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showDropHint(body, dropZone(body, e));
    });
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) clearDropHint();
    });
    body.addEventListener('drop', (e) => {
      if (!isTabDrag(e)) return;
      e.preventDefault();
      const zone = dropZone(body, e);
      clearDropHint();
      if (zone === 'center') applyMove(drag, leafId, -1);
      else applySplitMove(drag, leafId, zone);
    });
  }

  function dropZone(body, e) {
    const r = body.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width);
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    if (x < EDGE_RATIO) return 'left';
    if (x > 1 - EDGE_RATIO) return 'right';
    if (y < EDGE_RATIO) return 'up';
    if (y > 1 - EDGE_RATIO) return 'down';
    return 'center';
  }

  let dropHint = null;
  function showDropHint(body, zone) {
    clearTabCaret(); // the body and the strip never mean the same drop
    if (!dropHint) {
      dropHint = document.createElement('div');
      dropHint.className = 'pane-drop-hint';
    }
    if (dropHint.parentElement !== body) body.appendChild(dropHint);
    dropHint.className = 'pane-drop-hint pane-drop-' + zone;
  }
  function clearDropHint() { if (dropHint) { dropHint.remove(); } }

  // The insertion caret in a tab strip (#313). It lives inside the scrolling tab
  // list, so it stays on its gap while the strip scrolls.
  let tabCaret = null;
  function showTabCaret(list, edge) {
    if (!list) return;
    clearDropHint();
    if (!tabCaret) {
      tabCaret = document.createElement('div');
      tabCaret.className = 'pane-tab-caret';
    }
    if (tabCaret.parentElement !== list) list.appendChild(tabCaret);
    tabCaret.style.left = Math.max(0, edge - 1) + 'px';
  }
  function clearTabCaret() { if (tabCaret) { tabCaret.remove(); } }
  function clearDropFeedback() { clearDropHint(); clearTabCaret(); }

  function applyMove(from, toLeafId, index) {
    const next = PaneTree.moveTab(tree, { fromLeafId: from.fromLeafId, toLeafId, tabId: from.tabId, index });
    drag = null;
    clearDropFeedback();
    tree = next;
    activeLeafId = toLeafId;
    activeLeaf(); // the target can have collapsed away while the drop was in flight
    render();
    persist();
    showActiveOrPlaceholder();
  }

  function applySplitMove(from, leafId, direction) {
    const newLeafId = nextLeafId();
    let next = PaneTree.splitLeaf(tree, leafId, direction, { newLeafId });
    next = PaneTree.moveTab(next, { fromLeafId: from.fromLeafId, toLeafId: newLeafId, tabId: from.tabId });
    drag = null;
    tree = next;
    activeLeafId = newLeafId;
    render();
    persist();
    showActiveOrPlaceholder();
  }

  // --- Sash drag ------------------------------------------------------------
  //
  // The gesture outlives the element it starts on, so its listeners must too (#345). They used to
  // hang on the SASH, and the only thing that removed `pane-sashing` from <body> was its `pointerup`
  // — while every `render()` does `replaceChildren` and takes the sash with it. A background session
  // ending mid-drag (destroySession → dropSession → scheduleRender) was enough: the sash died before
  // it could be released, the class stayed, and `body.pane-sashing .terminal-container` kept
  // `pointer-events: none` on every terminal for the rest of the window's life. Nothing was
  // clickable, selectable or right-clickable, and the only way out was performing another complete
  // sash drag.
  //
  // Ways a pointer gesture ends. `pointerup` is the ordinary one; `pointercancel` arrives when the
  // browser takes the pointer away (a touch turning into a scroll, the window losing it), and
  // `lostpointercapture` when the capture goes — including the implicit release when the captured
  // element is removed from the document. Several of them can arrive for one gesture, so the ender
  // has to be idempotent.
  const SASH_END_EVENTS = ['pointerup', 'pointercancel', 'lostpointercapture'];

  // The in-flight gesture's ender, or null. `render()` calls it: a rebuild takes the sash away, so
  // the drag has already lost its anchor and finishing it there is what keeps the class off <body>.
  let endSashDrag = null;

  function startSashDrag(e, sash, path, index, orientation) {
    if (e.button !== 0) return;
    e.preventDefault();
    // A second gesture cannot start on top of a live one — end the old one first, or its listeners
    // and the body class would outlive it.
    if (endSashDrag) endSashDrag();
    const branchEl = sash.parentElement;
    const extent = orientation === 'row' ? branchEl.clientWidth : branchEl.clientHeight;
    if (!extent) return;
    const start = orientation === 'row' ? e.clientX : e.clientY;
    // Capture keeps the drag alive when the pointer crosses a terminal; a pointer
    // id the element never saw (a synthesised event) throws, and the drag still
    // works without capture, so it must not abort here.
    try { sash.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    sash.classList.add('dragging');
    document.body.classList.add('pane-sashing');

    let pending = null;
    const onMove = (ev) => {
      const now = orientation === 'row' ? ev.clientX : ev.clientY;
      pending = (now - start) / extent;
      // Live feedback without a rebuild: only the two flex bases change, so the
      // xterms keep their DOM and the drag stays smooth.
      const branch = PaneTree.nodeAt(tree, path);
      const preview = PaneTree.resizeSash(tree, path, index, pending);
      const previewBranch = PaneTree.nodeAt(preview, path);
      if (!branch || !previewBranch) return;
      const kids = Array.from(branchEl.children).filter((c) => !c.classList.contains('pane-sash'));
      previewBranch.children.forEach((child, i) => {
        if (kids[i]) kids[i].style.flex = `${child.size} 1 0`;
      });
    };
    const finish = () => {
      if (endSashDrag !== finish) return; // already ended — a second ender for the same gesture
      endSashDrag = null;
      window.removeEventListener('pointermove', onMove, true);
      for (const type of SASH_END_EVENTS) window.removeEventListener(type, finish, true);
      sash.classList.remove('dragging');
      // The one line this whole rework exists for: it runs no matter which way the gesture ended.
      document.body.classList.remove('pane-sashing');
      if (pending) {
        // Commit what was dragged rather than discarding it. When the ender is a rebuild, `render()`
        // calls this BEFORE it walks the tree, so the new sizes are the ones it draws.
        tree = PaneTree.resizeSash(tree, path, index, pending);
        persist();
      }
      // The panes changed size, so every visible terminal needs a fresh fit.
      refitVisible();
    };
    endSashDrag = finish;
    // On `window`, in the capture phase: the sash is the one element this gesture cannot rely on.
    window.addEventListener('pointermove', onMove, true);
    for (const type of SASH_END_EVENTS) window.addEventListener(type, finish, true);
  }

  // --- Mode lifecycle -------------------------------------------------------

  function enable() {
    if (enabled) return;
    enabled = true;
    document.body.classList.add('display-mode-panes');
    tree = loadTree();
    activeLeaf();
    // The tools moved into the strips (O13/H2) — the singleton header would only
    // repeat them, for one of the panes, above all of them.
    if (typeof terminalHeader !== 'undefined' && terminalHeader) terminalHeader.style.display = 'none';
    startViewWatch();
    render();
    showActiveOrPlaceholder();
  }

  function disable() {
    if (!enabled) return;
    // End an in-flight sash drag before the panes go (#345). This path removes the pane DOM without
    // going through `render()`, so its hook does not fire — and `body.pane-sashing .terminal-container
    // { pointer-events: none }` is NOT scoped to panes mode, so the class left behind here would go
    // on killing clicks in the mode being switched INTO. A settings change is broadcast to every
    // window, so this is reachable while the user is still holding the mouse down.
    if (endSashDrag) endSashDrag();
    // Write the final state NOW rather than letting the debounce fire into a torn-down mode — but
    // through the one guarded writer, so a detached window still writes nothing (#344).
    clearTimeout(persistTimer);
    writeTree();
    closePaneMenu();
    // Off FIRST, before anything that can call back in. `filePanelRelayout` below
    // re-shows the panel, and while this still read as active that took the panes
    // branch, re-adopted the element into a pane — and the pane was then removed
    // with the element inside it.
    enabled = false;
    stopViewWatch();
    releaseAllViewElements();
    // Hand every container back to #terminals before the panes go, or they would
    // be removed with their pane and the session would lose its terminal.
    for (const entry of openSessions.values()) {
      if (entry && entry.element) {
        entry.element.classList.remove('visible');
        terminalsEl.appendChild(entry.element);
      }
    }
    terminalsEl.querySelectorAll('.pane-branch, .pane').forEach((el) => el.remove());
    document.body.classList.remove('display-mode-panes');
    tree = null;
    activeLeafId = null;

    // The side panel sizes itself from its own state; hosting it in a pane took
    // its width and its resize handle away, and nothing else re-applies them.
    if (typeof window.filePanelRelayout === 'function') window.filePanelRelayout();

    // Hand the single view back a visible terminal. Every mode decides what is on
    // screen through `.visible`, and this teardown cleared it on all of them — the
    // mode we are switching INTO does not re-establish it on its own, so without
    // this the terminal area is left blank until the next click.
    const entry = (typeof activeSessionId !== 'undefined' && activeSessionId)
      ? openSessions.get(activeSessionId) : null;
    if (entry) {
      // Same order as any other reveal (#337): flush while still non-visible so the pending chunk
      // parks behind the backlog, then reveal, then drain. This session was a background tab in a
      // pane a moment ago, so it can carry both — and without the drain the backlog would sit there
      // until some later showSession wrote it AFTER newer output.
      if (typeof flushTerminalBuffer === 'function') flushTerminalBuffer(activeSessionId);
      entry.element.classList.add('visible');
      if (typeof drainReplayBuffer === 'function') drainReplayBuffer(activeSessionId);
      if (typeof restoreTerminalWebgl === 'function') restoreTerminalWebgl(activeSessionId);
      requestAnimationFrame(() => {
        if (openSessions.get(activeSessionId) === entry && typeof safeFit === 'function') safeFit(entry);
      });
    }
  }

  // --- Hooks the rest of the renderer calls ---------------------------------

  // showSession() routes here first in panes mode: activate the tab (adopting the
  // session into the active pane when it has no tab yet) and let the caller carry
  // on with the sidebar highlight, the fit and the focus.
  function show(sessionId) {
    if (!enabled || !openSessions.has(sessionId)) return false;
    const tabId = tabIdFor(sessionId);
    let leaf = PaneTree.leafOfTab(tree, tabId);
    if (!leaf) {
      tree = PaneTree.addTab(tree, activeLeaf().id, makeTerminalTab(sessionId));
      leaf = PaneTree.leafOfTab(tree, tabId);
    } else {
      tree = PaneTree.setActiveTab(tree, leaf.id, tabId);
    }
    activeLeafId = leaf.id;
    scheduleRender();
    persist();
    return true;
  }

  // A live session moved to a new id (#346). `/clear` in a CLI is the everyday case: the CLI starts
  // a fresh session, main reports it, and the renderer re-keys openSessions/sessionMap onto the new
  // id. A tab id is DERIVED from the session id (`tabIdFor`), so without this the tree keeps naming
  // the retired one — the pane finds nothing mounted behind its own active tab and falls back to
  // the empty state, while `adoptOrphans` gives the session that IS running a fresh tab in whatever
  // pane happens to be active. Rename in place, so the session stays where the user put it.
  function rekeySession(oldId, newId) {
    if (!enabled || !tree || !oldId || !newId || oldId === newId) return false;
    const fromTabId = tabIdFor(oldId);
    const leaf = PaneTree.leafOfTab(tree, fromTabId);
    if (!leaf) return false;
    // The new id can already have a tab of its own — a dormant one from a saved layout. Then there
    // is nothing to rename onto: retire the old tab and leave the existing one where it is.
    tree = PaneTree.leafOfTab(tree, tabIdFor(newId))
      ? PaneTree.closeTab(tree, leaf.id, fromTabId)
      : PaneTree.replaceTab(tree, leaf.id, fromTabId, makeTerminalTab(newId));
    activeLeaf();
    scheduleRender();
    persist();
    return true;
  }

  // A session went away (closed tab, LRU eviction, exit auto-close). Its tab goes
  // with it; a pane emptied by that disappears (#309 O10).
  function dropSession(sessionId) {
    if (!enabled || !tree) return;
    const tabId = tabIdFor(sessionId);
    const leaf = PaneTree.leafOfTab(tree, tabId);
    if (!leaf) return;
    tree = PaneTree.closeTab(tree, leaf.id, tabId);
    activeLeaf();
    scheduleRender();
    persist();
  }

  // Repaint the tab dots from the live status without rebuilding the strips — a
  // rebuild on every busy edge would churn the DOM and cancel a drag (#124).
  function patchStatuses() {
    if (!enabled) return false;
    const tabs = terminalsEl.querySelectorAll('.pane-strip .session-tab');
    if (!tabs.length) return false;
    const runtime = (typeof getSessionRuntimeState === 'function') ? getSessionRuntimeState() : {};
    const statusClasses = (typeof SESSION_STATUS_CLASSES !== 'undefined') ? SESSION_STATUS_CLASSES : [];
    for (const tab of tabs) {
      const session = sessionMap.get(tab.dataset.sessionId);
      const status = (session && typeof getSessionStatus === 'function') ? getSessionStatus(session, runtime) : null;
      const dot = tab.querySelector('.session-tab-dot');
      if (statusClasses.length) {
        tab.classList.remove(...statusClasses);
        if (dot) dot.classList.remove(...statusClasses);
      }
      if (status) {
        tab.classList.add(status.className);
        if (dot) dot.classList.add(status.className);
      }
      tab.classList.toggle('subagent-active',
        typeof subagentActiveSessions !== 'undefined' && subagentActiveSessions.has(tab.dataset.sessionId));
    }
    return true;
  }

  // Rebuild the strips only (tools follow the running state, so a process that
  // exits has to drop its stop button).
  function refreshChrome() {
    if (!enabled || !tree) return;
    for (const pane of terminalsEl.querySelectorAll('.pane')) {
      const leaf = PaneTree.leaves(tree).find((l) => l.id === pane.dataset.paneId);
      const strip = pane.querySelector('.pane-strip');
      if (!leaf || !strip) continue;
      pane.replaceChild(buildStrip(leaf), strip);
      const bar = pane.querySelector('.pane-actionbar');
      if (toolsPlacement !== 'bar') {
        if (bar) bar.remove();
        continue;
      }
      const next = buildActionBar(leaf);
      if (bar && next) pane.replaceChild(next, bar);
      else if (bar) bar.remove();
      else if (next) pane.insertBefore(next, pane.querySelector('.pane-body'));
    }
    updateToolsOverflow();
  }

  function applySettings(g) {
    g = g || {};
    const prevPlacement = toolsPlacement;
    toolsPlacement = g.paneToolsPlacement === 'strip' ? 'strip' : 'bar';
    closeBehavior = g.tabCloseBehavior === 'stopSession' ? 'stopSession' : 'closeView';
    terminalCloseBehavior = g.terminalCloseBehavior === 'keep' ? 'keep' : 'kill';
    middleClickCloses = g.tabMiddleClickCloses !== false;
    if (g.sessionDisplayMode === 'panes') {
      const wasEnabled = enabled;
      enable();
      // Moving the tools between the bar and the strip changes the pane's shape,
      // so an already-running mode has to rebuild (enable() no-ops when it is).
      if (wasEnabled && prevPlacement !== toolsPlacement) render();
    } else {
      disable();
    }
  }

  // Focus the n-th pane in render order (1-based) — the Ctrl/Cmd+Shift+1..9 chord.
  function focusPaneByIndex(n) {
    if (!enabled || !tree) return false;
    const leaf = PaneTree.leaves(tree)[n - 1];
    if (!leaf) return false;
    focusPane(leaf.id);
    return true;
  }

  // Move focus to the neighbouring pane in render order. Panes-mode answer to the
  // arrow chord that cycles sessions in single view and walks cells in the grid.
  function focusNeighbourPane(delta) {
    if (!enabled || !tree) return false;
    const all = PaneTree.leaves(tree);
    if (all.length < 2) return false;
    const at = Math.max(0, all.findIndex((l) => l.id === activeLeafId));
    const next = all[(at + delta + all.length) % all.length];
    focusPane(next.id);
    return true;
  }

  window.panesView = {
    active: () => enabled,
    applySettings,
    show,
    rekeySession,
    dropSession,
    patchStatuses,
    refreshChrome,
    render: () => render(),
    showActiveOrPlaceholder,
    openViewTab,
    closeViewTab,
    hasViewTab: (kind) => !!(enabled && tree && PaneTree.leafOfTab(tree, viewTabId(kind))),
    splitActivePane,
    focusPaneByIndex,
    focusNeighbourPane,
  };

  // A window resize changes every pane's box; refit what is on screen.
  window.addEventListener('resize', () => { if (enabled) refitVisible(); });
})();
