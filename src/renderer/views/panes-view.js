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
  const ACTIVE_KEY = 'paneActiveLeaf';
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
  // `close` names which teardown the tab's × runs, and it is the same distinction the viewers' own
  // header buttons already make: `data-close-admin` for the three surfaces a SIDEBAR TAB drives, and
  // `data-close-viewer` for the rest. Hiding an admin surface without switching the sidebar tab back
  // leaves the sidebar asserting a view that is no longer on screen (#342).
  //
  // Every one of these is an earlier sibling of `#terminal-area` inside `#main`, all `position:
  // absolute; inset: 0`, all shown by setting `display`. In tabs and grid mode they take over by
  // hiding `#terminal-area`; in panes mode `display: flex !important` keeps that area alive, so the
  // takeover is neutralised and DOM order decides — the pane tree, being the last child, paints over
  // them. Measured: opening Projects put a `pane-sash` on top of it, both at `z-index: auto`. Hence
  // every main-area surface belongs in this table, not just the session-shaped ones (#342).
  const VIEW_KINDS = {
    preview: { hostId: 'file-panel', title: 'Preview', watched: false },
    jsonl: { hostId: 'jsonl-viewer', title: 'Messages', watched: true },
    plan: { hostId: 'plan-viewer', title: 'Plan', watched: true },
    stats: { hostId: 'stats-viewer', title: 'Activity', watched: true, close: 'admin' },
    memory: { hostId: 'memory-viewer', title: 'Memory', watched: true },
    projects: { hostId: 'projects-viewer', title: 'Projects', watched: true, close: 'admin' },
    variables: { hostId: 'variables-admin-content', title: 'Variables', watched: true, close: 'admin' },
    workFiles: { hostId: 'work-files-viewer', title: 'Work files', watched: true },
    settings: { hostId: 'settings-viewer', title: 'Settings', watched: true },
    tasks: { hostId: 'tasks-viewer', title: 'Tasks', watched: true },
    bookmarks: { hostId: 'bookmarks-viewer', title: 'Bookmarks', watched: true },
    timeline: { hostId: 'timeline-viewer', title: 'Timeline', watched: true },
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
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(PaneTree.serialize(tree)));
      // Which pane was focused, beside the tree (#352). Only the tree was stored, so after every
      // reload the active pane was `leaves(tree)[0]` again — and "a sidebar click opens in the
      // active pane" quietly meant "in pane 1". Its own key: the tree's shape is the serialised
      // model and nothing else belongs inside it.
      if (activeLeafId) localStorage.setItem(ACTIVE_KEY, activeLeafId);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch { /* best effort */ }
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
    // The zoom lives on the DOM, not in the tree, so a rebuild has to re-assert it — and drop it
    // when the pane it pointed at is no longer there (#350).
    applyZoom();
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
    updateStripChrome();
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

  // How far one arrow press moves a sash, as a fraction of the branch. Coarse enough to get
  // somewhere, fine enough to land where you meant; Shift makes it a nudge.
  const SASH_KEY_STEP = 0.05;
  const SASH_KEY_STEP_FINE = 0.01;

  function buildSash(branch, path, index) {
    const sash = document.createElement('div');
    sash.className = 'pane-sash pane-sash-' + branch.orientation;
    sash.setAttribute('role', 'separator');
    sash.setAttribute('aria-orientation', branch.orientation === 'row' ? 'vertical' : 'horizontal');
    // The role was there already, on an element with no tabindex and no key handling — an ARIA
    // promise with nothing behind it (#351). Now it is focusable and it resizes, and it reports the
    // share of the pane before it so the number a screen reader hears is the one that changes.
    sash.tabIndex = 0;
    sash.setAttribute('aria-label', 'Resize panes');
    // A keyboard resize rebuilds the tree, which destroys this element — so it has to be findable
    // again afterwards, or the focus would land back at the top of the document on the first press.
    sash.dataset.sash = path.join('.') + ':' + index;
    const before = branch.children[index];
    if (before) {
      sash.setAttribute('aria-valuenow', String(Math.round(before.size * 100)));
      sash.setAttribute('aria-valuemin', String(Math.round(PaneTree.MIN_PANE_FRACTION * 100)));
      sash.setAttribute('aria-valuemax', String(100 - Math.round(PaneTree.MIN_PANE_FRACTION * 100)));
    }
    sash.addEventListener('pointerdown', (e) => startSashDrag(e, sash, path, index, branch.orientation));
    sash.addEventListener('keydown', (e) => handleSashKey(e, branch.orientation, path, index));
    return sash;
  }

  // Resize from the keyboard. Home distributes the branch evenly again, which is also the "reset"
  // the pointer path has never had.
  // Put the focus back on the sash the user is holding, after the rebuild took the element away.
  function refocusSash(path, index) {
    const key = path.join('.') + ':' + index;
    const el = terminalsEl.querySelector('.pane-sash[data-sash="' + key + '"]');
    if (el && typeof el.focus === 'function') el.focus();
  }

  function handleSashKey(e, orientation, path, index) {
    const back = orientation === 'row' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = orientation === 'row' ? 'ArrowRight' : 'ArrowDown';
    const step = e.shiftKey ? SASH_KEY_STEP_FINE : SASH_KEY_STEP;
    let delta = 0;
    if (e.key === back) delta = -step;
    else if (e.key === fwd) delta = step;
    else if (e.key === 'Home') {
      e.preventDefault();
      tree = PaneTree.distributeEvenly(tree, path);
      render();
      persist();
      refocusSash(path, index);
      announcePane('Panes distributed evenly');
      return;
    } else return;
    e.preventDefault();
    tree = PaneTree.resizeSash(tree, path, index, delta);
    render();
    persist();
    refocusSash(path, index);
    const branch = PaneTree.nodeAt(tree, path);
    const size = branch && branch.children[index] ? Math.round(branch.children[index].size * 100) : null;
    if (size !== null) announcePane('Pane ' + (index + 1) + ', ' + size + ' percent');
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
    // The panel the tab list controls (#351). Labelled by whichever tab is on top, so a screen
    // reader moving into the body is told what it is looking at.
    body.setAttribute('role', 'tabpanel');
    if (leaf.activeTabId) body.setAttribute('aria-labelledby', domTabId(leaf.id, leaf.activeTabId));
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

  // --- Accessibility (#351) -------------------------------------------------
  //
  // The strip was a row of unlabelled divs: no `role`, no `aria-selected`, `tabIndex -1`, and 93
  // focusable elements across the panes — almost all of them the `×` on each tab. So tabbing handed
  // the user a destroy button for every tab and no way to select one.
  //
  // The model is VS Code's editor tabs, which is also what a screen reader user will already know:
  // `role="tablist"` over `role="tab"` with `aria-selected`, the pane body as the tab panel, and a
  // ROVING TABINDEX — the whole strip is ONE tab stop, and arrows move inside it. That is what turns
  // the `×` buttons from tab stops into what they are, buttons you reach deliberately.

  const paneLiveRegion = document.getElementById('pane-live-region');
  function announcePane(message) {
    if (paneLiveRegion) paneLiveRegion.textContent = message;
  }

  // A DOM id for a tab element, so the pane body can point at the one that labels it. Tab ids carry
  // a colon (`term:<uuid>`), which is legal in an id but awkward everywhere it is later selected.
  const domTabId = (leafId, tabId) => 'pt-' + leafId + '-' + String(tabId).replace(/[^a-zA-Z0-9_-]/g, '_');

  // What a screen reader hears for a tab: the name plus the state a sighted user reads from the dot
  // and the dimming. Without the state it would announce a dead session and a running one alike.
  function tabAccessibleName(leaf, tab) {
    const label = tabLabel(leaf, tab);
    if (isViewTab(tab)) return label + ', view';
    const sessionId = sessionOfTab(tab);
    if (!openSessions.has(sessionId)) return label + (hasExited(sessionId) ? ', exited' : ', not open');
    return label + (sessionIsLive(sessionId) ? ', running' : ', stopped');
  }

  // Move focus inside the strip. Roving tabindex: exactly one tab is reachable by Tab, and the
  // arrows move both the focus and which one that is. Focus does NOT activate — a screen reader user
  // has to be able to walk past a tab without opening every session on the way.
  function focusTabAt(list, index) {
    const tabs = [...list.querySelectorAll('.session-tab')];
    if (!tabs.length) return;
    const at = Math.max(0, Math.min(index, tabs.length - 1));
    for (const [i, el] of tabs.entries()) el.tabIndex = i === at ? 0 : -1;
    tabs[at].focus();
    if (typeof tabs[at].scrollIntoView === 'function') tabs[at].scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function wireStripKeys(list, leaf) {
    list.addEventListener('keydown', (e) => {
      const tabs = [...list.querySelectorAll('.session-tab')];
      const at = tabs.indexOf(e.target.closest ? e.target.closest('.session-tab') : null);
      if (at < 0) return;
      const tab = leaf.tabs[at];
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); focusTabAt(list, at - 1); return;
        case 'ArrowRight': e.preventDefault(); focusTabAt(list, at + 1); return;
        case 'Home': e.preventDefault(); focusTabAt(list, 0); return;
        case 'End': e.preventDefault(); focusTabAt(list, tabs.length - 1); return;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (!tab) return;
          if (isViewTab(tab)) {
            tree = PaneTree.setActiveTab(tree, leaf.id, tab.id);
            activeLeafId = leaf.id;
            render();
            persist();
          } else {
            openFromTab(leaf, tab, sessionOfId(sessionOfTab(tab)));
          }
          announcePane(tabAccessibleName(leaf, tab) + ', selected');
          return;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          if (tab) { announcePane(tabLabel(leaf, tab) + ', closed'); closeTabFromUi(leaf.id, tab); }
          return;
        default:
          // Shift+F10 and the menu key are the keyboard's context menu, on the FOCUSED tab — the
          // `…` button reaches the pane's menu, never a particular tab's.
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault();
            const r = tabs[at].getBoundingClientRect();
            openPaneMenu({ x: r.left, y: r.bottom }, leaf.id, tab);
          }
      }
    });
  }

  function stripCtrl(text, title, onClick) {
    const b = document.createElement('button');
    b.className = 'session-tabs-ctrl';
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function buildStrip(leaf) {
    const strip = document.createElement('div');
    strip.className = 'pane-strip';

    const list = document.createElement('div');
    list.className = 'session-tabs-list';
    // The strip IS a tab list (#351) — it just never said so.
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-orientation', 'horizontal');
    list.setAttribute('aria-label', 'Tabs in this pane');
    const runtime = (typeof getSessionRuntimeState === 'function') ? getSessionRuntimeState() : {};
    for (const tab of leaf.tabs) list.appendChild(buildTab(leaf, tab, runtime));
    wireStripKeys(list, leaf);
    list.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) { list.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
    strip.appendChild(list);

    // The overflow set tabs mode already has (#349). Without it a strip that overflows offers a
    // mouse wheel and nothing else, so a tab scrolled out of sight is unreachable by any other
    // means — no arrows, no scrollbar, no list. Hidden until the tabs actually overflow.
    const controls = document.createElement('div');
    controls.className = 'session-tabs-controls';
    controls.appendChild(stripCtrl('◀', 'Scroll tabs left', () => list.scrollBy({ left: -200, behavior: 'smooth' })));
    controls.appendChild(stripCtrl('▶', 'Scroll tabs right', () => list.scrollBy({ left: 200, behavior: 'smooth' })));
    const allBtn = stripCtrl('▾', 'All tabs in this pane', () => openTabListMenu(allBtn, leaf.id));
    controls.appendChild(allBtn);
    strip.appendChild(controls);

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

  const sessionOfId = (sessionId) =>
    sessionMap.get(sessionId) || (openSessions.get(sessionId) || {}).session || null;

  // The name a tab shows before anything is done about duplicates.
  function tabBaseName(tab) {
    if (isViewTab(tab)) return viewTabLabel(tab);
    const sessionId = sessionOfTab(tab);
    const session = sessionOfId(sessionId);
    return (typeof cleanDisplayName === 'function'
      ? cleanDisplayName(session && (session.name || session.aiTitle || session.summary)) : '')
      || String(sessionId || '').slice(0, 8);
  }

  // The last segment of a session's project path — what tells two same-named sessions apart. The
  // splitter lives in session-tabs.js, so the tab label and the tooltip cannot disagree about what a
  // project is called (#334, #349).
  function projectLabelOf(session) {
    return (typeof projectTailOf === 'function') ? projectTailOf(session && session.projectPath) : '';
  }

  // What a tab is CALLED. Two sessions with the same name in one pane rendered as two identical
  // chips with nothing to tell them apart (#349), so a duplicate is qualified by its project folder
  // — the same answer VS Code gives for two open files with the same name. Only duplicates pay the
  // extra width.
  function tabLabel(leaf, tab) {
    const base = tabBaseName(tab);
    const clashes = leaf.tabs.some((t) => t !== tab && tabBaseName(t) === base);
    if (!clashes) return base;
    const qualifier = projectLabelOf(sessionOfId(sessionOfTab(tab)));
    return qualifier ? `${base} — ${qualifier}` : base;
  }

  // The `×` on a tab. NOT its own tab stop (#351): ninety-three focusable elements in the panes were
  // almost all of these, so Tab offered a destroy button per tab and no way to select one. It stays
  // clickable and stays labelled; the keyboard route to it is Delete on the focused tab.
  function buildTabClose(leaf, tab, name) {
    const close = document.createElement('button');
    close.className = 'session-tab-close';
    close.type = 'button';
    close.title = 'Close tab';
    close.textContent = '×';
    close.tabIndex = -1;
    close.setAttribute('aria-label', 'Close ' + name);
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTabFromUi(leaf.id, tab); });
    return close;
  }

  function buildTab(leaf, tab, runtime) {
    if (isViewTab(tab)) return buildViewTab(leaf, tab);
    const sessionId = sessionOfTab(tab);
    const session = sessionOfId(sessionId);
    const name = tabLabel(leaf, tab);

    const el = document.createElement('div');
    const isActive = tab.id === leaf.activeTabId;
    el.className = 'session-tab' + (isActive ? ' active' : '');
    el.dataset.sessionId = sessionId;
    el.dataset.tabId = tab.id;
    el.dataset.paneId = leaf.id;
    el.draggable = true;
    // Roving tabindex (#351): the active tab is the strip's single tab stop, the rest are reachable
    // with the arrows once focus is inside.
    el.id = domTabId(leaf.id, tab.id);
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(isActive));
    el.tabIndex = isActive ? 0 : -1;
    el.setAttribute('aria-label', tabAccessibleName(leaf, tab));

    // Status dot: the sidebar's classes verbatim, so colour and motion cannot
    // drift between the three places that show it (#257, #269).
    const status = (session && typeof getSessionStatus === 'function') ? getSessionStatus(session, runtime) : null;
    if (status) el.classList.add(status.className);
    // Project · backend · state beside the name (#334). Built by the same helper the tabs-mode strip
    // uses, so the two cannot drift on what a tooltip says.
    el.title = (session && typeof window.tabTooltipFor === 'function' && window.tabTooltipFor(session, status)) || name;
    const dot = document.createElement('span');
    dot.className = 'session-tab-dot status-dot' + (status ? ' ' + status.className : '');
    el.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'session-tab-label';
    label.textContent = name;
    el.appendChild(label);

    const mounted = openSessions.has(sessionId);
    if (!mounted) el.classList.add(hasExited(sessionId) ? 'session-tab-exited' : 'session-tab-dormant');
    if (!mounted && hasExited(sessionId)) el.title += '\nThis session has exited.';

    el.appendChild(buildTabClose(leaf, tab, name));

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
    const isActive = tab.id === leaf.activeTabId;
    el.className = 'session-tab session-tab-view' + (isActive ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.dataset.paneId = leaf.id;
    el.draggable = true;
    el.id = domTabId(leaf.id, tab.id);
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(isActive));
    el.tabIndex = isActive ? 0 : -1;
    el.setAttribute('aria-label', tabAccessibleName(leaf, tab));

    const label = document.createElement('span');
    label.className = 'session-tab-label';
    label.textContent = viewTabLabel(tab);
    el.title = label.textContent;
    el.appendChild(label);

    el.appendChild(buildTabClose(leaf, tab, label.textContent));

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

  // `closeTheView` says WHO is closing. The user clicking the tab's × wants the view itself told to
  // close; the observer calling this because the element was hidden must not tell it anything — the
  // app has already done it, and repeating the app's own close route here is actively wrong for the
  // sidebar-driven surfaces: switching from Projects to Variables hides Projects, and answering that
  // with `closeAdminView()` sent the sidebar back to the previous tab and undid the switch (#342).
  function closeViewTab(kind, { closeTheView = false } = {}) {
    if (!enabled) return;
    const tabId = viewTabId(kind);
    const leaf = PaneTree.leafOfTab(tree, tabId);
    if (!leaf) return;
    releaseViewElement(kind);
    if (closeTheView) hideViewElement(kind);
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
    // A surface a sidebar tab drives has to close the way its own × does — through the tab (#342).
    // `hideAllViewers` would hide the element and leave the sidebar sitting on the tab that opened
    // it, asserting a view the user can no longer see. It also does not know
    // `variables-admin-content` at all.
    if (spec.close === 'admin' && typeof closeAdminView === 'function') { closeAdminView(); return; }
    // Otherwise through the app's own teardown: hideAllViewers also puts the terminal
    // area back and drains the transcript's file watches (#75), which setting `display`
    // alone would leave polling. Only one of these can be open at a time, so hiding all
    // of them costs nothing.
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

  // Show the scroll arrows and the tab list only when the tabs actually overflow — the same test
  // tabs mode makes, so a pane with three tabs does not grow chrome it has no use for.
  function updateStripOverflow() {
    for (const strip of terminalsEl.querySelectorAll('.pane-strip')) {
      const list = strip.querySelector('.session-tabs-list');
      const controls = strip.querySelector('.session-tabs-controls');
      if (!list || !controls) continue;
      controls.classList.toggle('visible', list.scrollWidth > list.clientWidth + 1);
    }
  }

  // Bring each pane's active tab into view (#349). A strip holding 25 tabs showed the first sixteen
  // with nothing highlighted, and the only thing on screen naming the session you had just clicked
  // was the action bar. Runs after a rebuild — which is also what resets the scroll offset, so this
  // never fights a position the user still has.
  function revealActiveTabs() {
    for (const list of terminalsEl.querySelectorAll('.pane-strip .session-tabs-list')) {
      const active = list.querySelector('.session-tab.active');
      if (active && typeof active.scrollIntoView === 'function') {
        active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      }
    }
  }

  // The three things every strip rebuild has to settle. One name, so a new render path cannot pick
  // up two of them and quietly miss the third.
  function updateStripChrome() {
    updateToolsOverflow();
    updateStripOverflow();
    revealActiveTabs();
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

  // Run `fn` after the layout has settled, in a window that may not be VISIBLE.
  //
  // Chromium does not fire `requestAnimationFrame` in a hidden or occluded window, and this file
  // already says so about `scheduleRender` — the fit that follows the render was left on a bare rAF
  // anyway. Measured with `document.hidden === true`: a pane zoomed to a 1043 px box kept a terminal
  // at 8 columns for six seconds and counting, because the frame never came. A TUI then wraps its
  // prompt at a width the box does not have, which looks exactly like text arriving with line breaks
  // nobody typed. Same family as #81 and #322.
  //
  // So: a frame if one comes, a timer if it does not, whichever is first — a fit needs measured
  // layout, so a microtask (what `scheduleRender` uses) would run too early.
  const HIDDEN_FRAME_MS = 32; // ~2 frames; only ever used when rAF is not running
  function afterLayout(fn) {
    let done = false;
    const run = () => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(run, HIDDEN_FRAME_MS);
    requestAnimationFrame(run);
  }

  // One pending pass at a time (#352). A window resize fires several events per frame and each one
  // used to queue a full pass over every visible pane — flush, drain and `safeFit` each — so a drag
  // of the window border ran the most expensive thing in this file dozens of times for one final
  // size. Coalescing is safe because the pass reads the layout as it is when it runs, not as it was
  // when it was asked for.
  let refitPending = false;
  function refitVisible() {
    if (refitPending) return;
    refitPending = true;
    afterLayout(() => {
      refitPending = false;
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
      // A second pass: the fit above can change the pane's own metrics, and the fold-away threshold
      // has to see the settled width, not the one mid-reflow. Same scheduler, same reason.
      afterLayout(updateStripChrome);
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
    // A split while zoomed would put the new pane behind the zoomed one, where nothing points at it.
    zoomedLeafId = null;
    // The new pane starts EMPTY and takes focus: a terminal cannot be shown twice
    // (one PTY, one container), so there is nothing to duplicate into it. The next
    // sidebar click fills it, which is exactly what O7 promises.
    tree = PaneTree.splitLeaf(tree, leaf.id, direction, { newLeafId });
    activeLeafId = newLeafId;
    render();
    persist();
  }

  // Does closing this session's tab end its process? A plain terminal follows
  // `terminalCloseBehavior`, an agent session `tabCloseBehavior`. ONE reader for the decision,
  // because closing a pane has to answer it exactly as closing each of its tabs would (#347) — it
  // used to skip the question entirely and orphan every process in the pane, which is the opposite
  // of what the × on those same tabs does.
  function closeStopsProcess(sessionId) {
    const entry = openSessions.get(sessionId);
    if (!entry) return false;
    const isTerminal = !!(entry.session && entry.session.type === 'terminal');
    return isTerminal ? (terminalCloseBehavior === 'kill') : (closeBehavior === 'stopSession');
  }

  // Ask before a pane close ends processes — once, naming how many, not once per session. A pane
  // with nothing running must not gain a click, so this is only reached when something would stop.
  function confirmClosePane(stopping, keeping) {
    if (typeof showControlDialog !== 'function') return Promise.resolve(true);
    const what = stopping === 1 ? 'one running process' : `${stopping} running processes`;
    return showControlDialog({
      title: 'Close pane',
      message: keeping
        ? `Closing this pane stops ${what}. ${keeping === 1 ? 'One other session' : `${keeping} other sessions`} keep running.`
        : `Closing this pane stops ${what}.`,
      confirmLabel: 'Close pane',
      cancelLabel: 'Cancel',
      tone: 'danger',
    });
  }

  async function closePane(leafId) {
    let leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    if (!leaf) return;
    if (PaneTree.leaves(tree).length === 1) return; // the last pane stays

    // What this is about to do to the processes in the pane, decided before anything is torn down.
    const live = leaf.tabs.map(sessionOfTab).filter((id) => id && openSessions.has(id) && sessionIsLive(id));
    const stopping = live.filter(closeStopsProcess);
    if (stopping.length && !(await confirmClosePane(stopping.length, live.length - stopping.length))) return;
    // Re-resolve after the await. Every PaneTree operation returns a NEW tree, so `leaf` is a
    // snapshot: a session that exited while the dialog was open took its tab out of the real tree
    // and left it in this copy. Re-reading also settles a second click on the same pane — by then
    // the pane is gone and there is nothing left to close.
    leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    if (!leaf || PaneTree.leaves(tree).length === 1) return;
    // …and the answer about the processes has to come from the tree that is actually being closed.
    const keeping = leaf.tabs.map(sessionOfTab)
      .filter((id) => id && openSessions.has(id) && sessionIsLive(id) && !closeStopsProcess(id));

    // A session's own tab closing keeps its PTY or stops it depending on the settings; the pane
    // close now says the same thing. destroySession() calls back into dropSession(), which is what
    // takes each tab out of the tree — so this loop must not remove them a second time.
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
      if (!sessionId) continue;
      if (closeStopsProcess(sessionId)) { try { window.api.stopSession(sessionId); } catch { /* already gone */ } }
      if (typeof destroySession === 'function') destroySession(sessionId);
    }
    // Say what is still out there. Without this the sessions the settings deliberately keep alive
    // leave no trace on screen at all — the pane that pointed at them is what just went away.
    if (keeping.length && typeof showControlToast === 'function') {
      showControlToast({
        message: keeping.length === 1
          ? 'Pane closed — its session keeps running.'
          : `Pane closed — ${keeping.length} of its sessions keep running.`,
      });
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
    // Every other close path ends here; this one did not (#352). Dropping the last dormant tab of
    // the active pane left the main area showing whatever the closed tab had been in front of.
    showActiveOrPlaceholder();
  }

  // Close one session's tab. Mirrors tabs mode: the view goes, the PTY survives —
  // unless the close behaviour says otherwise for this kind of session.
  function closeSessionTab(sessionId) {
    if (closeStopsProcess(sessionId)) { try { window.api.stopSession(sessionId); } catch { /* ignore */ } }
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
      else closeViewTab(tab.kind, { closeTheView: true });
      return;
    }
    const sessionId = sessionOfTab(tab);
    // Nothing to tear down for a tab whose session was never mounted — drop it from
    // the layout and leave the session alone.
    if (!openSessions.has(sessionId)) { dropTab(leafId, tab.id); return; }
    closeSessionTab(sessionId);
  }

  // Ask once before a bulk close ends processes, the way `confirmClosePane` does for a pane. Its own
  // wording, because this is about tabs and not about a pane, but the same counting.
  function confirmCloseTabs(stopping) {
    if (typeof showControlDialog !== 'function') return Promise.resolve(true);
    const what = stopping === 1 ? 'one running process' : `${stopping} running processes`;
    return showControlDialog({
      title: 'Close tabs',
      message: `Closing these tabs stops ${what}.`,
      confirmLabel: 'Close tabs',
      cancelLabel: 'Cancel',
      tone: 'danger',
    });
  }

  // Close a SET of tabs as one action (#349). Emptying a full pane used to be one click per tab on a
  // 12-px `×`. One question for the whole set, then each tab down the path its own `×` takes, so the
  // configured close behaviour still decides per session.
  async function closeTabs(tabs) {
    const live = tabs.map(sessionOfTab).filter((id) => id && openSessions.has(id) && sessionIsLive(id));
    const stopping = live.filter(closeStopsProcess);
    if (stopping.length && !(await confirmCloseTabs(stopping.length))) return;
    for (const tab of tabs) {
      // Re-read the owner each time: closing one tab can move or remove others (a pane collapses, an
      // exiting session drops its own tab), so a leaf id captured up front goes stale mid-loop.
      const owner = PaneTree.leafOfTab(tree, tab.id);
      if (!owner) continue;
      closeTabFromUi(owner.id, tab);
    }
  }

  // The tab half of the context menu. A view tab has no process, so it gets Close
  // and nothing else.
  function addTabItems(item, leafId, tab) {
    item('Close', () => closeTabFromUi(leafId, tab));
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    const siblings = leaf ? leaf.tabs : [];
    const at = siblings.findIndex((t) => t.id === tab.id);
    const others = siblings.filter((t) => t.id !== tab.id);
    const toRight = at >= 0 ? siblings.slice(at + 1) : [];
    item('Close others', () => closeTabs(others), { disabled: !others.length });
    item('Close to the right', () => closeTabs(toRight), { disabled: !toRight.length });
    item('Close all', () => closeTabs(siblings.slice()), { disabled: !siblings.length });
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

  // Every tab in this pane, filterable — the panes counterpart of the "All open tabs" list in tabs
  // mode (#349). With a strip that overflows this is the only way to reach a tab that scrolled off.
  function openTabListMenu(anchor, leafId) {
    closePaneMenu();
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    if (!leaf) return;
    focusPane(leafId);

    const pop = document.createElement('div');
    pop.className = 'popover session-tabs-overflow';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-tabs-overflow-filter';
    input.placeholder = 'Filter tabs in this pane…';
    const listEl = document.createElement('div');
    listEl.className = 'session-tabs-overflow-list';
    pop.appendChild(input);
    pop.appendChild(listEl);

    const renderList = () => {
      const q = input.value.trim().toLowerCase();
      listEl.replaceChildren();
      for (const tab of leaf.tabs) {
        const label = tabLabel(leaf, tab);
        if (q && !label.toLowerCase().includes(q)) continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'session-tabs-overflow-item' + (tab.id === leaf.activeTabId ? ' active' : '');
        b.textContent = label;
        b.addEventListener('click', () => {
          closePaneMenu();
          if (isViewTab(tab)) {
            tree = PaneTree.setActiveTab(tree, leaf.id, tab.id);
            activeLeafId = leaf.id;
            render();
            persist();
            return;
          }
          openFromTab(leaf, tab, sessionOfId(sessionOfTab(tab)));
        });
        listEl.appendChild(b);
      }
    };
    input.addEventListener('input', renderList);
    renderList();

    document.body.appendChild(pop);
    positionPaneMenu(pop, { anchor });
    activeMenu = pop;
    input.focus();
    armMenuDismiss(pop);
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
    armMenuDismiss(pop);
  }

  // Arm the dismiss listeners for `pop` on the next tick, so the click that opened the menu does not
  // close it again. The test is `activeMenu !== pop`, not `!activeMenu`: a menu replaced within the
  // same tick would otherwise arm ITS pair into the single `menuDismissHandlers` slot on top of the
  // live menu's, and the overwritten pair could never be removed again.
  function armMenuDismiss(pop) {
    setTimeout(() => {
      if (activeMenu !== pop) return; // closed, or replaced, before the listeners went up
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
    // Restore the focused pane, not just the tree (#352). A detached window has its own one-pane
    // tree and must not read the main window's choice.
    if (!(window.isDetachedWindow && window.isDetachedWindow())) {
      try { activeLeafId = localStorage.getItem(ACTIVE_KEY) || null; } catch { activeLeafId = null; }
    }
    activeLeaf(); // falls back to the first leaf when the stored id is not in this tree
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

  // A session moved into this window with no process (#332). It has no mount to hang a tab off, and
  // every other way into the tree needs one: `show` refuses a session that is not in `openSessions`,
  // and `adoptOrphans` walks that map. So this is the one path that puts an UNMOUNTED session into the
  // tree — and what it produces is nothing new, just the tab a saved layout restores: `buildTab` marks
  // it dormant and the pane body draws the "not running / Launch" placeholder (#318).
  //
  // It becomes the pane's active tab by default, like a mounted adopt does (`mountOnce(session, true)`):
  // the user moved this session here, so showing it is the feedback that the move happened. The boot
  // reconcile passes `{ activate: false }` — it is filling tabs in BEHIND whatever the window is already
  // showing, and stealing the front there would undo the choice the boot path just made.
  //
  // Refused without a session record. `buildTab` reads the name from `sessionMap`, so a tab without one
  // is an unnamed placeholder the user cannot identify — worse than the move being declined.
  function openDormantTab(sessionId, opts) {
    if (!enabled || !tree || !sessionId) return false;
    if (typeof sessionMap === 'undefined' || !sessionMap.has(sessionId)) return false;
    const activate = !opts || opts.activate !== false;
    const tabId = tabIdFor(sessionId);
    let leaf = PaneTree.leafOfTab(tree, tabId);
    if (!leaf) {
      const target = activeLeaf();
      // `addTab` makes what it adds the pane's active tab, so a non-activating call has to put the
      // previous choice back rather than the model growing a second way to add one.
      const wasActive = target.activeTabId;
      tree = PaneTree.addTab(tree, target.id, makeTerminalTab(sessionId));
      leaf = PaneTree.leafOfTab(tree, tabId);
      if (!leaf) return false;
      if (!activate && wasActive) tree = PaneTree.setActiveTab(tree, leaf.id, wasActive);
    }
    if (activate) {
      tree = PaneTree.setActiveTab(tree, leaf.id, tabId);
      activeLeafId = leaf.id;
    }
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
    // Terminal tabs only. The selector used to take the view tabs too (#352) — they carry no
    // `data-session-id`, so every status tick ran `sessionMap.get(undefined)` once per view tab and
    // then stripped the status classes off an element that never had one.
    const tabs = terminalsEl.querySelectorAll('.pane-strip .session-tab[data-session-id]');
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
    // A chrome refresh rebuilds the strips, which resets their scroll offset — so the active tab has
    // to be brought back into view here too, not only after a full render.
    updateStripChrome();
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

  // Move focus to the pane that lies in `direction` ON SCREEN (#350).
  //
  // This used to index `PaneTree.leaves()` in render order and wrap, which is not a direction: in an
  // L-shaped arrangement "up" from the top-right pane went left and "right" went down. Grid mode in
  // this same app measures bounding rectangles and gets it right, and `pickGridNeighbor` is that
  // geometry already factored out — dead zone on the primary axis, cross-axis distance weighted so
  // the same row or column wins ties. Panes gets the same answer from the same code.
  //
  // No wrap. An arrow that walks off the edge of the layout does nothing, which is what every tiling
  // window manager does; wrapping is how the old version turned "up" into "somewhere else".
  function focusNeighbourPane(direction) {
    if (!enabled || !tree) return false;
    const panes = [...terminalsEl.querySelectorAll('.pane')];
    if (panes.length < 2) return false;
    const at = panes.findIndex((p) => p.dataset.paneId === activeLeafId);
    if (at < 0) return false;
    const rects = panes.map((p) => p.getBoundingClientRect());
    const best = (typeof pickGridNeighbor === 'function') ? pickGridNeighbor(rects, at, direction) : -1;
    if (best < 0) return false;
    focusPane(panes[best].dataset.paneId);
    return true;
  }

  // --- Zoom (#350) ----------------------------------------------------------
  // A pane can only be read properly by dragging a sash, which has a 5 % floor and no reset. Zoom is
  // the answer every comparable tool has (tmux `prefix z`, Windows Terminal `togglePaneZoom`, iTerm2,
  // VS Code) and it is a VIEW state, not a layout change: the tree is untouched, so leaving zoom puts
  // the arrangement back exactly as it was. Nothing is persisted — a zoom is where you are, not how
  // your workspace is set up.
  let zoomedLeafId = null;

  function applyZoom() {
    const on = !!zoomedLeafId && PaneTree.leaves(tree || null).some((l) => l.id === zoomedLeafId);
    if (!on) zoomedLeafId = null;
    terminalsEl.classList.toggle('pane-zoomed', on);
    for (const pane of terminalsEl.querySelectorAll('.pane')) {
      pane.classList.toggle('pane-zoom-target', on && pane.dataset.paneId === zoomedLeafId);
    }
  }

  function toggleZoom(leafId) {
    if (!enabled || !tree) return false;
    const target = leafId || activeLeafId;
    if (!target || !PaneTree.leaves(tree).some((l) => l.id === target)) return false;
    zoomedLeafId = (zoomedLeafId === target) ? null : target;
    if (zoomedLeafId) focusPane(zoomedLeafId);
    applyZoom();
    // Both terminals just changed box: the one filling the area and the ones it covered.
    refitVisible();
    return true;
  }

  // Step through the ACTIVE PANE's own tabs. The bracket pair next to this one walks the sidebar
  // order across every pane, which is why it reads as a lie when you are looking at one strip.
  function navigateTabInPane(delta) {
    if (!enabled || !tree) return false;
    const leaf = activeLeaf();
    if (!leaf || leaf.tabs.length < 2) return false;
    const at = leaf.tabs.findIndex((t) => t.id === leaf.activeTabId);
    const next = leaf.tabs[((at < 0 ? 0 : at) + delta + leaf.tabs.length) % leaf.tabs.length];
    if (!next) return false;
    if (isViewTab(next)) {
      tree = PaneTree.setActiveTab(tree, leaf.id, next.id);
      render();
      persist();
      return true;
    }
    openFromTab(leaf, next, sessionOfId(sessionOfTab(next)));
    return true;
  }

  // Close the active pane's active tab — the keyboard route to the × on it.
  function closeActiveTab() {
    if (!enabled || !tree) return false;
    const leaf = activeLeaf();
    const tab = leaf && leaf.tabs.find((t) => t.id === leaf.activeTabId);
    if (!tab) return false;
    closeTabFromUi(leaf.id, tab);
    return true;
  }

  function closeActivePane() {
    if (!enabled || !tree || !activeLeafId) return false;
    if (PaneTree.leaves(tree).length === 1) return false;
    closePane(activeLeafId);
    return true;
  }

  window.panesView = {
    active: () => enabled,
    applySettings,
    show,
    openDormantTab,
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
    closePane,
    closeActivePane,
    closeActiveTab,
    focusPaneByIndex,
    focusNeighbourPane,
    navigateTabInPane,
    toggleZoom,
    isZoomed: () => !!zoomedLeafId,
  };

  // A window resize changes every pane's box; refit what is on screen.
  window.addEventListener('resize', () => { if (enabled) refitVisible(); });
})();
