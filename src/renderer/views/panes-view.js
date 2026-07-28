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

  function persist() {
    // A detached window shows one session and owns no layout (#2). It shares this origin's
    // localStorage with the main window, so writing here would overwrite the user's arrangement with
    // a single pane the moment they pop a session out.
    if (window.__detachedSessionId) return;
    clearTimeout(persistTimer);
    // A sash drag fires dozens of updates per gesture; write once it settles.
    persistTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(PaneTree.serialize(tree))); } catch { /* best effort */ }
    }, PERSIST_DEBOUNCE_MS);
  }

  function loadTree() {
    // The detached window is one pane with one session (#2) — it reads the same localStorage as the
    // main window, so loading the stored tree would rebuild the whole arrangement over there, panes
    // and foreign tabs and all.
    if (window.__detachedSessionId) {
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
    applyVisibility();
    applyWebglPolicy();
    refitVisible();
    updateToolsOverflow();
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
      const empty = document.createElement('div');
      empty.className = 'pane-empty';
      empty.textContent = leaf.tabs.length
        ? 'This session is not open — click its tab to open it here.'
        : 'Pick a session in the sidebar to open it here.';
      body.appendChild(empty);
    }
    // Clicking anywhere in a pane makes it the one a sidebar click fills (O7).
    body.addEventListener('mousedown', () => focusPane(leaf.id), true);
    pane.appendChild(body);

    wireDropZones(pane, body, leaf.id);
    return pane;
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
    more.addEventListener('click', (e) => { e.stopPropagation(); openPaneMenu(more, leaf.id); });
    strip.appendChild(more);

    strip.addEventListener('mousedown', () => focusPane(leaf.id), true);
    return strip;
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
    if (!mounted) el.classList.add('session-tab-dormant');

    const close = document.createElement('button');
    close.className = 'session-tab-close';
    close.type = 'button';
    close.title = 'Close tab';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      // Nothing to tear down for a tab whose session was never mounted — drop it
      // from the layout and leave the session alone.
      if (!openSessions.has(sessionId)) { dropTab(leaf.id, tab.id); return; }
      closeSessionTab(sessionId);
    });
    el.appendChild(close);

    el.addEventListener('click', () => {
      activeLeafId = leaf.id;
      if (openSessions.has(sessionId)) { focusPane(leaf.id); showSession(sessionId); return; }
      // Dormant tab: mount the session. It already has a tab in THIS pane, so
      // show() finds that leaf and the session lands where the layout says.
      if (session && typeof openSession === 'function') openSession(session, undefined, { show: true });
    });
    el.addEventListener('auxclick', (e) => {
      if (middleClickCloses && e.button === 1) { e.preventDefault(); closeSessionTab(sessionId); }
    });
    wireTabDrag(el, leaf.id, tab.id);
    return el;
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
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      // Tell the VIEW to close, not just the layout: it owns the state that
      // decides whether it reappears, and a tab-only close would be undone by the
      // next session switch. Its own close path comes back through closeViewTab.
      if (tab.kind === 'preview' && typeof window.closeFilePanel === 'function') window.closeFilePanel();
      else closeViewTab(tab.kind);
    });
    el.appendChild(close);

    el.addEventListener('click', () => {
      activeLeafId = leaf.id;
      tree = PaneTree.setActiveTab(tree, leaf.id, tab.id);
      render();
      persist();
    });
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
  function buildTools(leaf, { withStatus = false } = {}) {
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

    // In the bar the running state is spelled out, as the session header always
    // did. In the strip it is not: the tab's dot already carries it, and the words
    // would cost the space the tabs need.
    if (withStatus) {
      const running = activePtyIds.has(sessionId);
      const status = document.createElement('span');
      status.className = 'pane-status ' + (running ? 'running' : 'stopped');
      status.textContent = running ? 'Running' : 'Stopped';
      tools.appendChild(status);
    }

    // The IDE-emulation chip belongs to the preview module, which owns the state
    // (file-panel.js). It exposes the flag rather than the element, because in
    // this mode there is one chip per pane instead of the single header one.
    if (typeof window.isMcpActiveForSession === 'function' && window.isMcpActiveForSession(sessionId)) {
      const chip = document.createElement('span');
      chip.className = 'mcp-toggle enabled pane-mcp-chip';
      chip.textContent = withStatus ? 'IDE Emulation' : 'IDE';
      chip.title = 'IDE Emulation is active. Go to Global Settings to disable.';
      tools.appendChild(chip);
    }

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

    const info = document.createElement('div');
    info.className = 'pane-actionbar-info';

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
    bar.appendChild(buildTools(leaf, { withStatus: true }));
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

  // WebGL follows the focused pane, exactly as it follows the focused card in the
  // grid (#140). Several live GL terminals share one texture atlas, and a sibling
  // growing it leaves the others painting scrambled or blank glyphs until they
  // happen to repaint (#118, #262) — with four panes on screen that is the normal
  // case, not an edge case. So: the active pane keeps its context, every other
  // pane falls back to the DOM renderer, which is correct at any size.
  function applyWebglPolicy() {
    for (const leaf of PaneTree.leaves(tree)) {
      const sessionId = sessionOfTab(leaf.tabs.find((t) => t.id === leaf.activeTabId));
      const entry = sessionId ? openSessions.get(sessionId) : null;
      if (!entry) continue;
      const wantGl = leaf.id === activeLeafId;
      const hasGl = !!entry.webglAddon;
      // Only ACT on a difference. Recreating the addon on every render (a status
      // tick, a tab click) tore down and rebuilt the GL context each time and left
      // orphaned canvases stacked in the container, until the terminal painted
      // nothing at all.
      if (wantGl && !hasGl && typeof restoreTerminalWebgl === 'function') restoreTerminalWebgl(sessionId);
      else if (!wantGl && hasGl && typeof suspendTerminalWebgl === 'function') suspendTerminalWebgl(sessionId);
      // The active terminal just changed parent, and a moved WebGL canvas keeps a
      // texture atlas another terminal may have grown meanwhile (#118).
      if (wantGl && entry.webglAddon && typeof forceRepaint === 'function') forceRepaint(entry);
    }
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
          // A moved container has a new box; flush what buffered while it was in
          // the background before fitting, so the fit sees the final line count.
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
    // WebGL follows the focus, so the pane that just gained it takes the context.
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

  function openPaneMenu(anchor, leafId) {
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
      pop.appendChild(b);
    };

    focusPane(leafId);
    item('Split right', () => splitActivePane('right'));
    item('Split down', () => splitActivePane('down'));
    // Detach (#2): the pane's active session moves into a window of its own. Only a running session
    // can — there is nothing to render in the new window otherwise.
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    const detachId = leaf ? sessionOfTab(leaf.tabs.find((t) => t.id === leaf.activeTabId)) : null;
    item('Move to new window', () => { window.detachSession?.(detachId); }, {
      disabled: !detachId || !activePtyIds.has(detachId) || !!window.isDetachedWindow?.(),
    });
    item('Close pane', () => closePane(leafId), {
      danger: true,
      disabled: PaneTree.leaves(tree).length === 1,
    });

    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = (r.bottom + 4) + 'px';
    pop.style.right = Math.max(4, window.innerWidth - r.right) + 'px';
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
    el.addEventListener('dragend', () => { drag = null; el.classList.remove('dragging'); clearDropHint(); });
    el.addEventListener('dragover', (e) => {
      if (!isTabDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.stopPropagation();
    });
    el.addEventListener('drop', (e) => {
      if (!isTabDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const target = PaneTree.leaves(tree).find((l) => l.id === leafId);
      const index = target ? target.tabs.findIndex((t) => t.id === tabId) : -1;
      applyMove(drag, leafId, index);
    });
  }

  function wireDropZones(pane, body, leafId) {
    // The strip's empty space takes a tab too — aiming at the tab row is the
    // obvious gesture, and without this it would land nowhere.
    const strip = pane.querySelector('.pane-strip');
    if (strip) {
      strip.addEventListener('dragover', (e) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      strip.addEventListener('drop', (e) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        clearDropHint();
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
    if (!dropHint) {
      dropHint = document.createElement('div');
      dropHint.className = 'pane-drop-hint';
    }
    if (dropHint.parentElement !== body) body.appendChild(dropHint);
    dropHint.className = 'pane-drop-hint pane-drop-' + zone;
  }
  function clearDropHint() { if (dropHint) { dropHint.remove(); } }

  function applyMove(from, toLeafId, index) {
    const next = PaneTree.moveTab(tree, { fromLeafId: from.fromLeafId, toLeafId, tabId: from.tabId, index });
    drag = null;
    clearDropHint();
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

  function startSashDrag(e, sash, path, index, orientation) {
    if (e.button !== 0) return;
    e.preventDefault();
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
    const onUp = () => {
      sash.removeEventListener('pointermove', onMove);
      sash.removeEventListener('pointerup', onUp);
      sash.classList.remove('dragging');
      document.body.classList.remove('pane-sashing');
      if (pending) {
        tree = PaneTree.resizeSash(tree, path, index, pending);
        persist();
      }
      // The panes changed size, so every visible terminal needs a fresh fit.
      refitVisible();
    };
    sash.addEventListener('pointermove', onMove);
    sash.addEventListener('pointerup', onUp);
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
    clearTimeout(persistTimer);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(PaneTree.serialize(tree))); } catch { /* best effort */ }
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
      entry.element.classList.add('visible');
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
