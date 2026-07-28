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
// activePtyIds, terminalsEl, placeholder (app.js) · showSession, destroySession,
// safeFit, flushTerminalBuffer, drainReplayBuffer (terminal-manager.js) ·
// getSessionStatus, getSessionRuntimeState, SESSION_STATUS_CLASSES
// (session-status.js) · cleanDisplayName (utils.js) · confirmAndStopSession,
// showJsonlViewer, openTasksView (app.js) · PaneTree (views/pane-tree.js).

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
    clearTimeout(persistTimer);
    // A sash drag fires dozens of updates per gesture; write once it settles.
    persistTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(PaneTree.serialize(tree))); } catch { /* best effort */ }
    }, PERSIST_DEBOUNCE_MS);
  }

  function loadTree() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { stored = null; }
    const loaded = PaneTree.deserialize(stored, 'pane-1');
    // Drop tabs whose session is not mounted (closed since the last run). An
    // emptied pane disappears with them, like any other emptied pane.
    return PaneTree.pruneTabs(loaded, (tab) => {
      const sid = sessionOfTab(tab);
      return !!sid && openSessions.has(sid);
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

  function render() {
    if (!enabled || !tree) return;
    adoptOrphans();
    const root = buildNode(tree, []);
    // The containers were moved into the fresh panes above, so what is left in
    // #terminals is the previous (now empty) pane scaffolding.
    terminalsEl.replaceChildren(root);
    applyVisibility();
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

    const body = document.createElement('div');
    body.className = 'pane-body';
    for (const tab of leaf.tabs) {
      const entry = openSessions.get(sessionOfTab(tab));
      if (entry) body.appendChild(entry.element); // moves the live container, xterm and all
    }
    if (!leaf.tabs.length) {
      const empty = document.createElement('div');
      empty.className = 'pane-empty';
      empty.textContent = 'Pick a session in the sidebar to open it here.';
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

    strip.appendChild(buildTools(leaf));

    const sep = document.createElement('span');
    sep.className = 'pane-strip-sep';
    strip.appendChild(sep);

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

    const close = document.createElement('button');
    close.className = 'session-tab-close';
    close.type = 'button';
    close.title = 'Close tab';
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeSessionTab(sessionId); });
    el.appendChild(close);

    el.addEventListener('click', () => { focusPane(leaf.id); showSession(sessionId); });
    el.addEventListener('auxclick', (e) => {
      if (middleClickCloses && e.button === 1) { e.preventDefault(); closeSessionTab(sessionId); }
    });
    wireTabDrag(el, leaf.id, tab.id);
    return el;
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

    // The IDE-emulation chip belongs to the preview module, which owns the state
    // (file-panel.js). It exposes the flag rather than the element, because in
    // this mode there is one chip per pane instead of the single header one.
    if (typeof window.isMcpActiveForSession === 'function' && window.isMcpActiveForSession(sessionId)) {
      const chip = document.createElement('span');
      chip.className = 'mcp-toggle enabled pane-mcp-chip';
      chip.textContent = 'IDE';
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
    if (sessionId && sessionId !== activeSessionId) showSession(sessionId);
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
    const sessionId = leaf ? sessionOfTab(leaf.tabs.find((t) => t.id === leaf.activeTabId)) : null;
    if (sessionId && openSessions.has(sessionId)) showSession(sessionId);
    else if (typeof window.clearActiveTerminalView === 'function') window.clearActiveTerminalView();
  }

  // --- Pane menu (#309 O6/A) ------------------------------------------------

  let activeMenu = null;
  function closePaneMenu() { if (activeMenu) { activeMenu.remove(); activeMenu = null; } }

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
    // Detach lands with #2; the entry is here so the menu does not change shape
    // when it does, and so the mode already says where it will live.
    item('Move to new window', () => {}, { disabled: true });
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
      document.addEventListener('mousedown', function out(e) {
        if (activeMenu && !activeMenu.contains(e.target)) { closePaneMenu(); document.removeEventListener('mousedown', out, true); }
      }, true);
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { closePaneMenu(); document.removeEventListener('keydown', esc, true); }
      }, true);
    }, 0);
  }

  // --- Drag & drop (#309 W4) ------------------------------------------------
  // Dragging a tab: onto another tab → insert there; onto a pane body → the 10 %
  // edge zones split in that direction, the centre moves the tab into the pane.
  // The ratio is VS Code's for an editor drag (editorDropTarget.ts).

  const EDGE_RATIO = 0.1;
  let drag = null; // { tabId, fromLeafId }

  function wireTabDrag(el, leafId, tabId) {
    el.addEventListener('dragstart', (e) => {
      drag = { tabId, fromLeafId: leafId };
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', tabId); } catch { /* Firefox needs the payload; Electron does not */ }
    });
    el.addEventListener('dragend', () => { drag = null; el.classList.remove('dragging'); clearDropHint(); });
    el.addEventListener('dragover', (e) => { if (drag) e.preventDefault(); });
    el.addEventListener('drop', (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      const target = PaneTree.leaves(tree).find((l) => l.id === leafId);
      const index = target ? target.tabs.findIndex((t) => t.id === tabId) : -1;
      applyMove(drag, leafId, index);
    });
  }

  function wireDropZones(pane, body, leafId) {
    body.addEventListener('dragover', (e) => {
      if (!drag) return;
      e.preventDefault();
      showDropHint(body, dropZone(body, e));
    });
    body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget)) clearDropHint(); });
    body.addEventListener('drop', (e) => {
      if (!drag) return;
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
    render();
    showActiveOrPlaceholder();
  }

  function disable() {
    if (!enabled) return;
    clearTimeout(persistTimer);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(PaneTree.serialize(tree))); } catch { /* best effort */ }
    closePaneMenu();
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
    enabled = false;
    tree = null;
    activeLeafId = null;
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
    render();
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
    render();
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
      if (leaf && strip) pane.replaceChild(buildStrip(leaf), strip);
    }
    updateToolsOverflow();
  }

  function applySettings(g) {
    g = g || {};
    closeBehavior = g.tabCloseBehavior === 'stopSession' ? 'stopSession' : 'closeView';
    terminalCloseBehavior = g.terminalCloseBehavior === 'keep' ? 'keep' : 'kill';
    middleClickCloses = g.tabMiddleClickCloses !== false;
    if (g.sessionDisplayMode === 'panes') enable();
    else disable();
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
    splitActivePane,
    focusPaneByIndex,
    focusNeighbourPane,
  };

  // A window resize changes every pane's box; refit what is on screen.
  window.addEventListener('resize', () => { if (enabled) refitVisible(); });
})();
