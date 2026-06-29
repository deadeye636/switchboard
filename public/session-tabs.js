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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildTabModel };
}

(function () {
  if (typeof document === 'undefined') return; // node test context

  let displayMode = 'legacy';      // legacy | tabs
  let tabPosition = 'top';         // top | bottom
  let closeBehavior = 'closeView'; // closeView | stopSession
  let middleClickCloses = true;
  let dragReorder = true;
  let tabOrder = [];               // sessionId[] persisted order
  let dragId = null;
  let initialized = false;         // first applySessionDisplaySettings = startup

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

  function closeTab(sessionId) {
    if (closeBehavior === 'stopSession') {
      try { window.api.stopSession(sessionId); } catch { /* ignore */ }
    }
    // Either way the renderer view is torn down; for 'closeView' the PTY in main
    // keeps running and the session stays in the sidebar, reopenable.
    if (typeof destroySession === 'function') destroySession(sessionId);
    tabOrder = tabOrder.filter(id => id !== sessionId);
    refreshSessionTabs();
  }

  function activateTab(sessionId) {
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
    displayMode = g.sessionDisplayMode === 'tabs' ? 'tabs' : 'legacy';
    tabPosition = g.tabPosition === 'bottom' ? 'bottom' : 'top';
    closeBehavior = g.tabCloseBehavior === 'stopSession' ? 'stopSession' : 'closeView';
    middleClickCloses = g.tabMiddleClickCloses !== false;
    dragReorder = g.tabDragReorder !== false;
    tabOrder = Array.isArray(g.tabOrder) ? g.tabOrder.slice() : [];
    applyMode();

    // Tabs mode is single-view only; the grid mosaic is legacy-only. On a real
    // user mode switch, scope the grid per mode WITHOUT losing the legacy grid
    // preference (saved separately so legacy keeps its mosaic). Skip on the first
    // apply (startup) — the persisted gridViewActive already matches the mode.
    if (initialized && prevMode !== displayMode) {
      if (displayMode === 'tabs') {
        try { localStorage.setItem('legacyGridPref', localStorage.getItem('gridViewActive') || '0'); } catch { /* ignore */ }
        if (typeof gridViewActive !== 'undefined' && gridViewActive && typeof toggleGridView === 'function') {
          toggleGridView(); // hide grid → single (persists gridViewActive=0)
        }
      } else {
        let pref = '0';
        try { pref = localStorage.getItem('legacyGridPref') || '0'; } catch { /* ignore */ }
        if (pref === '1' && typeof gridViewActive !== 'undefined' && !gridViewActive && typeof toggleGridView === 'function') {
          toggleGridView(); // restore legacy's grid mosaic
        }
      }
    }
    initialized = true;
  }

  window.refreshSessionTabs = refreshSessionTabs;
  window._applySessionDisplaySettings = applySessionDisplaySettings;
})();
