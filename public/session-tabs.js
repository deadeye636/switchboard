// --- Session tabs (Phase 1) ---
//
// VS-Code-style tab strip over the terminal area — an alternative switcher to the
// sidebar, active only in display mode 'tabs'. Reuses the single-view machinery:
// a tab click → showSession(); closing a tab → destroySession() (PTY keeps running,
// the session stays in the sidebar) or stopSession() depending on tabCloseBehavior.
//
// Loaded as a classic <script> (exposes window.* hooks) AND require()-d by node
// tests for the pure buildTabModel(). Keep buildTabModel free of DOM/globals.
//
// Depends on renderer globals: openSessions, activeSessionId, showSession,
// destroySession (terminal-manager.js), cleanDisplayName (utils.js), activePtyIds,
// attentionSessions, window.api.

// Pure: order the open sessions into a tab list. `sessions` is a plain array of
// { sessionId, name, closed }; `order` is the persisted sessionId order (unknown
// ids keep their insertion order at the end). Returns [{ sessionId, name, active }].
function buildTabModel(sessions, activeId, order) {
  const pos = new Map((order || []).map((id, i) => [id, i]));
  return (sessions || [])
    .filter(s => s && s.sessionId && !s.closed)
    .map(s => ({ sessionId: s.sessionId, name: s.name || '', active: s.sessionId === activeId }))
    .sort((a, b) => {
      const ai = pos.has(a.sessionId) ? pos.get(a.sessionId) : Infinity;
      const bi = pos.has(b.sessionId) ? pos.get(b.sessionId) : Infinity;
      return ai - bi;
    });
}

// Pure: resolve the auto-close-on-exit mode from persisted settings.
// 'never' | 'onSuccess' | 'always'. Default 'always'.
function resolveAutoCloseMode(g) {
  const v = g && g.tabAutoCloseMode;
  return (v === 'never' || v === 'onSuccess' || v === 'always') ? v : 'always';
}

// Pure: resolve the auto-close delay in seconds. Default 5, floored at 0
// (0 = close immediately). Missing / non-numeric / negative → default 5.
function resolveAutoCloseDelaySec(g) {
  const n = g && g.tabAutoCloseDelaySec;
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return 5;
  return Math.floor(n);
}

// Pure: given the mode and a process exit code, should the tab auto-close?
function shouldAutoClose(mode, exitCode) {
  if (mode === 'always') return true;
  if (mode === 'onSuccess') return exitCode === 0;
  return false; // 'never' or unknown
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildTabModel, resolveAutoCloseMode, resolveAutoCloseDelaySec, shouldAutoClose };
}

(function () {
  if (typeof document === 'undefined') return; // node test context

  let displayMode = 'grid';        // grid | tabs
  let tabPosition = 'top';         // top | bottom
  let closeBehavior = 'closeView'; // closeView | stopSession (Claude sessions)
  let terminalCloseBehavior = 'kill'; // kill | keep (plain terminals, decoupled)
  let middleClickCloses = true;
  let dragReorder = true;
  let autoCloseMode = 'always';    // never | onSuccess | always
  let autoCloseDelaySec = 5;       // seconds; 0 = close immediately
  let tabOrder = [];               // sessionId[] persisted order
  let dragId = null;
  let initialized = false;         // first applySessionDisplaySettings = startup
  const autoCloseTimers = new Map(); // sessionId → pending auto-close timeout id

  function stripEl() { return document.getElementById('session-tabs'); }

  function persistOrder() {
    try { window.api.getSetting('global').then(g => {
      const next = { ...(g || {}), tabOrder };
      window.api.setSetting('global', next);
    }); } catch { /* best effort */ }
  }

  // Collect the current open sessions into buildTabModel's plain input shape.
  function collectSessions() {
    const out = [];
    if (typeof openSessions === 'undefined') return out;
    for (const [sessionId, entry] of openSessions) {
      if (!entry || entry.closed) continue;
      const s = entry.session || { sessionId };
      const name = (typeof cleanDisplayName === 'function'
        ? cleanDisplayName(s.name || s.aiTitle || s.summary) : '') || sessionId.slice(0, 8);
      out.push({ sessionId, name, closed: false });
    }
    return out;
  }

  function isRunning(sessionId) {
    return typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId);
  }
  function needsAttention(sessionId) {
    return typeof attentionSessions !== 'undefined' && attentionSessions.has(sessionId);
  }

  // Tear down a tab's view and, when it was the active session, fall back to the
  // next open tab (or the idle placeholder if none remain) so the main area is
  // never left blank. Shared by manual close (×/middle-click) and auto-close.
  function performClose(sessionId) {
    const wasActive = (typeof activeSessionId !== 'undefined' && activeSessionId === sessionId);
    cancelTabAutoClose(sessionId);
    // For 'closeView' the PTY in main keeps running and the session stays in the
    // sidebar, reopenable; 'stopSession' (handled by the caller) ends the process.
    if (typeof destroySession === 'function') destroySession(sessionId);
    tabOrder = tabOrder.filter(id => id !== sessionId);
    if (wasActive) {
      const remaining = buildTabModel(collectSessions(), null, tabOrder);
      if (remaining.length > 0) {
        if (typeof showSession === 'function') showSession(remaining[0].sessionId);
      } else if (typeof window.clearActiveTerminalView === 'function') {
        window.clearActiveTerminalView();
      }
    }
    refreshSessionTabs();
  }

  function closeTab(sessionId) {
    // Plain terminals use their own close behavior (kill | keep), decoupled from the
    // Claude-session tabCloseBehavior (closeView | stopSession).
    const entry = (typeof openSessions !== 'undefined') ? openSessions.get(sessionId) : null;
    const isTerminal = !!(entry && entry.session && entry.session.type === 'terminal');
    const kill = isTerminal ? (terminalCloseBehavior === 'kill') : (closeBehavior === 'stopSession');
    if (kill) {
      try { window.api.stopSession(sessionId); } catch { /* ignore */ }
    }
    performClose(sessionId);
  }

  // Schedule an auto-close after the session's process exits. Only in tabs mode,
  // only when the mode/exit-code combination opts in. The timer no-ops if the
  // session was relaunched (a fresh, non-closed entry exists) or already torn down.
  function scheduleTabAutoClose(sessionId, exitCode) {
    if (displayMode !== 'tabs') return;
    if (!shouldAutoClose(autoCloseMode, exitCode)) return;
    cancelTabAutoClose(sessionId);
    const t = setTimeout(() => {
      autoCloseTimers.delete(sessionId);
      const entry = (typeof openSessions !== 'undefined') ? openSessions.get(sessionId) : null;
      if (!entry || !entry.closed) return; // relaunched or gone — leave it be
      performClose(sessionId);
    }, autoCloseDelaySec * 1000);
    autoCloseTimers.set(sessionId, t);
  }

  function cancelTabAutoClose(sessionId) {
    const t = autoCloseTimers.get(sessionId);
    if (t) { clearTimeout(t); autoCloseTimers.delete(sessionId); }
  }

  function activateTab(sessionId) {
    cancelTabAutoClose(sessionId); // user re-engaged with the session
    if (typeof showSession === 'function') showSession(sessionId);
    refreshSessionTabs();
  }

  // --- Render ---

  function refreshSessionTabs() {
    const strip = stripEl();
    if (!strip) return;
    if (displayMode !== 'tabs') { strip.innerHTML = ''; return; }

    const model = buildTabModel(collectSessions(), (typeof activeSessionId !== 'undefined' ? activeSessionId : null), tabOrder);
    // Keep tabOrder in sync with what's actually open (append new, drop gone).
    const openIds = model.map(m => m.sessionId);
    tabOrder = tabOrder.filter(id => openIds.includes(id));
    for (const id of openIds) if (!tabOrder.includes(id)) tabOrder.push(id);

    strip.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'session-tabs-list';

    let activeEl = null;
    for (const t of model) {
      const tab = document.createElement('div');
      tab.className = 'session-tab' + (t.active ? ' active' : '');
      if (isRunning(t.sessionId)) tab.classList.add('running');
      if (needsAttention(t.sessionId)) tab.classList.add('needs-attention');
      tab.dataset.sessionId = t.sessionId;
      tab.title = t.name;
      if (dragReorder) tab.draggable = true;

      const dot = document.createElement('span');
      dot.className = 'session-tab-dot';
      const label = document.createElement('span');
      label.className = 'session-tab-label';
      label.textContent = t.name;
      const close = document.createElement('button');
      close.className = 'session-tab-close';
      close.title = 'Close tab';
      close.textContent = '×';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.sessionId); });

      tab.appendChild(dot);
      tab.appendChild(label);
      tab.appendChild(close);

      tab.addEventListener('click', () => activateTab(t.sessionId));
      // Middle-click closes (auxclick button 1).
      tab.addEventListener('auxclick', (e) => {
        if (middleClickCloses && e.button === 1) { e.preventDefault(); closeTab(t.sessionId); }
      });
      // Right-click → context menu (Close / Stop & close / Relaunch).
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openTabContextMenu(e.clientX, e.clientY, t.sessionId);
      });
      if (dragReorder) wireDrag(tab, t.sessionId);

      if (t.active) activeEl = tab;
      list.appendChild(tab);
    }

    strip.appendChild(list);

    // Overflow controls (scroll arrows + ▾ menu) — shown only when overflowing.
    const controls = document.createElement('div');
    controls.className = 'session-tabs-controls';
    const left = makeCtrlBtn('◀', () => list.scrollBy({ left: -200, behavior: 'smooth' }));
    const right = makeCtrlBtn('▶', () => list.scrollBy({ left: 200, behavior: 'smooth' }));
    const menu = makeCtrlBtn('▾', () => openOverflowMenu(menu, model));
    menu.title = 'All open tabs';
    controls.appendChild(left); controls.appendChild(right); controls.appendChild(menu);
    strip.appendChild(controls);

    // Wheel over the strip scrolls the list horizontally.
    list.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) { list.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });

    const updateOverflow = () => {
      const overflow = list.scrollWidth > list.clientWidth + 1;
      controls.classList.toggle('visible', overflow);
    };
    requestAnimationFrame(() => {
      updateOverflow();
      if (activeEl) activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
  }

  function makeCtrlBtn(text, onClick) {
    const b = document.createElement('button');
    b.className = 'session-tabs-ctrl';
    b.textContent = text;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  // --- Overflow dropdown (all open tabs + filter) ---

  let activeOverflow = null;
  function closeOverflowMenu() { if (activeOverflow) { activeOverflow.remove(); activeOverflow = null; } }

  function openOverflowMenu(anchor, model) {
    closeOverflowMenu();
    const pop = document.createElement('div');
    pop.className = 'popover session-tabs-overflow';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-tabs-overflow-filter';
    input.placeholder = 'Filter open tabs…';
    const listEl = document.createElement('div');
    listEl.className = 'session-tabs-overflow-list';
    pop.appendChild(input);
    pop.appendChild(listEl);

    function renderList() {
      const q = input.value.trim().toLowerCase();
      listEl.innerHTML = '';
      for (const t of model) {
        if (q && !t.name.toLowerCase().includes(q)) continue;
        const row = document.createElement('button');
        row.className = 'session-tabs-overflow-item' + (t.active ? ' active' : '');
        row.textContent = t.name;
        row.addEventListener('click', () => { closeOverflowMenu(); activateTab(t.sessionId); });
        listEl.appendChild(row);
      }
    }
    input.addEventListener('input', renderList);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverflowMenu(); });
    renderList();

    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = (r.bottom + 4) + 'px';
    pop.style.right = Math.max(4, window.innerWidth - r.right) + 'px';
    activeOverflow = pop;
    input.focus();
    setTimeout(() => {
      document.addEventListener('mousedown', function out(e) {
        if (activeOverflow && !activeOverflow.contains(e.target)) { closeOverflowMenu(); document.removeEventListener('mousedown', out, true); }
      }, true);
    }, 0);
  }

  // --- Tab context menu (right-click) ---

  let activeCtxMenu = null;
  function closeTabContextMenu() { if (activeCtxMenu) { activeCtxMenu.remove(); activeCtxMenu = null; } }

  // Right-click a tab: Close (close the view, PTY keeps running), Stop & close
  // (kill the process, then close), Relaunch (stop + reopen fresh).
  function openTabContextMenu(x, y, sessionId) {
    closeTabContextMenu();
    closeOverflowMenu();
    const pop = document.createElement('div');
    pop.className = 'popover session-tab-menu';

    const addItem = (label, handler, opts = {}) => {
      const b = document.createElement('button');
      b.className = 'session-tab-menu-item' + (opts.danger ? ' danger' : '');
      b.textContent = label;
      b.addEventListener('click', () => { closeTabContextMenu(); handler(); });
      pop.appendChild(b);
    };

    addItem('Close', () => performClose(sessionId));
    addItem('Stop & close', () => {
      try { window.api.stopSession(sessionId); } catch { /* ignore */ }
      performClose(sessionId);
    }, { danger: true });
    addItem('Relaunch', () => {
      if (typeof window.relaunchSession === 'function') window.relaunchSession(sessionId);
    });

    document.body.appendChild(pop);
    // Position at the cursor, clamped into the viewport.
    pop.style.position = 'fixed';
    const rect = pop.getBoundingClientRect();
    pop.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
    pop.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
    activeCtxMenu = pop;
    setTimeout(() => {
      document.addEventListener('mousedown', function out(e) {
        if (activeCtxMenu && !activeCtxMenu.contains(e.target)) { closeTabContextMenu(); document.removeEventListener('mousedown', out, true); }
      }, true);
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { closeTabContextMenu(); document.removeEventListener('keydown', esc, true); }
      }, true);
    }, 0);
  }

  // --- Drag reorder ---

  function wireDrag(tab, sessionId) {
    tab.addEventListener('dragstart', (e) => { dragId = sessionId; tab.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    tab.addEventListener('dragend', () => { dragId = null; tab.classList.remove('dragging'); });
    tab.addEventListener('dragover', (e) => { e.preventDefault(); });
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragId || dragId === sessionId) return;
      const from = tabOrder.indexOf(dragId);
      const to = tabOrder.indexOf(sessionId);
      if (from === -1 || to === -1) return;
      tabOrder.splice(from, 1);
      tabOrder.splice(to, 0, dragId);
      persistOrder();
      refreshSessionTabs();
    });
  }

  // --- Settings apply ---

  function applyMode() {
    document.body.classList.toggle('display-mode-tabs', displayMode === 'tabs');
    document.body.classList.toggle('tabs-bottom', tabPosition === 'bottom');
    refreshSessionTabs();
  }

  function applySessionDisplaySettings(g) {
    g = g || {};
    const prevMode = displayMode;
    // Non-tabs is the "grid" mode (sidebar + grid overview / single view). Legacy
    // stored values ('legacy') still map here — anything that isn't 'tabs' is grid.
    displayMode = g.sessionDisplayMode === 'tabs' ? 'tabs' : 'grid';
    tabPosition = g.tabPosition === 'bottom' ? 'bottom' : 'top';
    closeBehavior = g.tabCloseBehavior === 'stopSession' ? 'stopSession' : 'closeView';
    terminalCloseBehavior = g.terminalCloseBehavior === 'keep' ? 'keep' : 'kill';
    middleClickCloses = g.tabMiddleClickCloses !== false;
    dragReorder = g.tabDragReorder !== false;
    autoCloseMode = resolveAutoCloseMode(g);
    autoCloseDelaySec = resolveAutoCloseDelaySec(g);
    if (typeof window._setTabsLiveRender === 'function') window._setTabsLiveRender(g.tabsLiveRender !== false);
    tabOrder = Array.isArray(g.tabOrder) ? g.tabOrder.slice() : [];
    applyMode();

    // Tabs mode is single-view only; the grid mosaic belongs to grid mode. On a real
    // user mode switch, scope the grid per mode WITHOUT losing the grid-mode mosaic
    // preference (saved separately so grid mode keeps its mosaic). Skip on the first
    // apply (startup) — the persisted gridViewActive already matches the mode.
    if (initialized && prevMode !== displayMode) {
      if (displayMode === 'tabs') {
        try { localStorage.setItem('gridModePref', localStorage.getItem('gridViewActive') || '0'); } catch { /* ignore */ }
        if (typeof gridViewActive !== 'undefined' && gridViewActive && typeof toggleGridView === 'function') {
          toggleGridView(); // hide grid → single (persists gridViewActive=0)
        }
      } else {
        let pref = '0';
        try { pref = localStorage.getItem('gridModePref') || '0'; } catch { /* ignore */ }
        if (pref === '1' && typeof gridViewActive !== 'undefined' && !gridViewActive && typeof toggleGridView === 'function') {
          toggleGridView(); // restore grid mode's mosaic
        } else if (typeof returnToTerminal === 'function') {
          // Grid-mode single view: re-establish the view explicitly. Tabs CSS paints
          // all containers regardless of `.visible`, so tabs can sit in a
          // zero-`.visible` state; grid-mode CSS shows only `.visible`, so without
          // this the area goes blank. returnToTerminal shows the active session (or
          // the placeholder).
          returnToTerminal();
        }
      }
    }
    initialized = true;
  }

  window.refreshSessionTabs = refreshSessionTabs;
  window.scheduleTabAutoClose = scheduleTabAutoClose;
  window.cancelTabAutoClose = cancelTabAutoClose;
  // Close a tab immediately (deliberate stop/archive) — switches to a neighbour or
  // the placeholder. Only meaningful in tabs mode; grid/legacy manage their own view.
  window.closeTabNow = (sessionId) => { if (displayMode === 'tabs') performClose(sessionId); };
  window._applySessionDisplaySettings = applySessionDisplaySettings;
})();
