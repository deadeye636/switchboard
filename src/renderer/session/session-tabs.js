// --- Session tabs (Phase 1) ---
//
// What is LEFT of this file is shared with panes mode (#357): the pure `buildTabModel`, the tab
// tooltip and the project-path splitter (#334), the auto-close rules and `closeTabNow`. Panes calls
// them; nothing here renders panes' tabs.
//
// The strip itself is the retired tabs mode's own switcher — a VS-Code-style bar over the terminal
// area. With the mode gone there is no setting that turns it on, so `refreshSessionTabs` only ever
// empties it now. The markup, the drag handlers and the tab builders below are unreachable and want
// removing as their own pass; they are left in one piece rather than half-cut.
//
// Loaded as a classic <script> (exposes window.* hooks) AND require()-d by node
// tests for the pure buildTabModel(). Keep buildTabModel free of DOM/globals.
//
// Depends on renderer globals: openSessions, activeSessionId, showSession,
// destroySession (terminal-manager.js), cleanDisplayName (utils.js), sessionMap,
// getSessionStatus + getSessionRuntimeState (the tab dot's status), window.api.

// Pure: order the open sessions into a tab list. `sessions` is a plain array of
// { sessionId, name, closed }; `order` is the persisted sessionId order (unknown
// ids keep their insertion order at the end). Returns [{ sessionId, name, active }].
function buildTabModel(sessions, activeId, order) {
  const pos = new Map((order || []).map((id, i) => [id, i]));
  return (sessions || [])
    // A closed (exited) session keeps its tab — the tab exists for as long as the session is mounted,
    // and leaves only via destroySession (the user closing it, or auto-close firing). Filtering closed
    // here made an exited tab vanish on the next unrelated rebuild, even with auto-close off (#256).
    .filter(s => s && s.sessionId)
    .map(s => ({ sessionId: s.sessionId, name: s.name || '', active: s.sessionId === activeId, closed: !!s.closed }))
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

// Pure: the tooltip a session's tab carries (#334). It used to be the name and nothing else — which
// is a tooltip that repeats what is already on screen, in the one place a truncated label can be read
// in full and the one place "which of these two is the one in the other project" can be answered.
// Empty parts are left out rather than shown blank: a backend that declares no label, or a session
// with no project, should cost a line, not an empty one.
function buildTabTooltip({ name, project, backend, state } = {}) {
  const title = String(name || '').trim();
  const detail = [project, backend, state].map((v) => String(v || '').trim()).filter(Boolean);
  return [title, detail.join(' · ')].filter(Boolean).join('\n');
}

// The tooltip for a session BAR — the row under the tabs, which shows the name and the project and
// nothing else (#358). Everything the row used to spell out moves in here: the AI title when the name
// shown is a rename over it, the terminal's own title, and the session id. Built on the tab's tooltip
// rather than beside it, so the first two lines say the same thing in both places.
//
// Each extra line is dropped when it repeats one already there. A row whose name IS the AI title would
// otherwise show the same sentence three times, which is the thing this issue removed from the row.
function buildSessionBarTooltip({ name, aiTitle, ptyTitle, sessionId, project, backend, state } = {}) {
  const head = buildTabTooltip({ name, project, backend, state });
  // Compared without a leading marker, because a CLI's own title is usually the AI title with an
  // activity glyph in front of it ("✳ Review the handoff"). Those are two different strings and one
  // sentence, and listing both is the repetition this issue removed one level up. Only the leading
  // run is stripped, and only for the comparison — what gets shown is what the CLI wrote.
  const key = (value) => String(value || '').trim().replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
  const shown = key(name);
  const lines = [];
  const seen = new Set([shown]);
  const add = (value) => {
    const text = String(value || '').trim();
    const k = key(value);
    if (!text || !k || seen.has(k)) return;
    seen.add(k);
    lines.push(text);
  };
  add(aiTitle);
  add(ptyTitle);
  // The id goes through the same filter: a session with no name of any kind is DISPLAYED as its id
  // (`tabTooltipFor` falls back to it), and printing it again under itself is the repetition this
  // whole change removed from the row.
  add(sessionId);
  return [head, ...lines].filter(Boolean).join('\n');
}

// What a typed name MEANS (#95, #358). Three surfaces rename a session — the sidebar row, the tabs-mode
// header and every pane's action row — and all three must agree, because the answer is not "store what
// was typed":
//
//   empty                     -> null: drop the override, follow the automatic title again. There is no
//                                such thing as a session with an empty name.
//   the automatic title       -> null as well. Otherwise confirming without editing anything freezes
//                                TODAY's AI title as a MANUAL name, and no better one can replace it.
//   anything else             -> the typed name.
//
// `fallback` is the automatic title AS DISPLAYED — `cleanDisplayName`'d. Against the raw string the
// second rule never matched for a title carrying a plan prefix or an XML-ish tag, so a rename that
// changed nothing silently switched the automatic title off. That was the sidebar's behaviour until
// #358, while the header compared the cleaned form: one rule, two answers.
function resolveRenameTarget(typed, fallback) {
  const name = String(typed == null ? '' : typed).trim();
  const auto = String(fallback == null ? '' : fallback).trim();
  return (name && name !== auto) ? name : null;
}

// The last segment of a project path — what tells two same-named sessions apart.
function projectTailOf(projectPath) {
  if (!projectPath) return '';
  const parts = String(projectPath).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildTabModel, resolveAutoCloseMode, resolveAutoCloseDelaySec, shouldAutoClose,
    buildTabTooltip, buildSessionBarTooltip, resolveRenameTarget, projectTailOf,
  };
}

(function () {
  if (typeof document === 'undefined') return; // node test context

  let displayMode = 'grid';        // grid | panes (#309, rendered by views/panes-view.js)
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
    // Atomic key-scoped merge in main — a full read-modify-write of the whole
    // `global` blob here races with settings saves / a second window (issue #75).
    try { window.api.mergeSetting('global', { tabOrder }); } catch { /* best effort */ }
  }

  // Collect the current open sessions into buildTabModel's plain input shape.
  function collectSessions() {
    const out = [];
    if (typeof openSessions === 'undefined') return out;
    for (const [sessionId, entry] of openSessions) {
      if (!entry) continue;
      const s = entry.session || { sessionId };
      const name = (typeof cleanDisplayName === 'function'
        ? cleanDisplayName(s.name || s.aiTitle || s.summary) : '') || sessionId.slice(0, 8);
      // Keep closed entries — an exited tab stays until destroySession removes it from openSessions (#256).
      out.push({ sessionId, name, closed: !!entry.closed });
    }
    return out;
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
    // Panes mode: destroySession already took the tab out of the tree (and the
    // pane with it, if that was its last one). All that is left is to show what
    // the active pane holds now. The tab-strip bookkeeping below is not its.
    if (displayMode === 'panes') {
      if (window.panesView) window.panesView.showActiveOrPlaceholder();
      return;
    }
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
    // An exited session should not leave a dead tab sitting in a pane.
    if (displayMode !== 'panes') return;
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
    // The mode that filled this strip is retired (#357), so emptying it is all that is left to do —
    // and it still has to be DONE, once, or an upgrade leaves the last render painted there.
    // Everything below is unreachable from here on. It is left whole rather than half-cut: the
    // builders, the drag handlers and the overflow menu come out together, as their own pass.
    strip.innerHTML = '';
    return;

    // Keep the strip empty while the launch restore mounts the tabs — otherwise it
    // fills in one by one. The restore rebuilds it once at the end (flag cleared).
    if (typeof window !== 'undefined' && window.__restoringOpenSessions) { strip.innerHTML = ''; return; }

    const model = buildTabModel(collectSessions(), (typeof activeSessionId !== 'undefined' ? activeSessionId : null), tabOrder);
    // Keep tabOrder in sync with what's actually open (append new, drop gone).
    // Never drop while nothing is open yet (boot: this renders before the launch
    // restore reopens the tabs) or while that restore is still mounting them —
    // pruning against an empty/partial set would throw away the dragged order the
    // restore is about to need, and the next drag would persist the loss.
    const openIds = model.map(m => m.sessionId);
    const restoring = typeof window !== 'undefined' && window.__restoringOpenSessions;
    if (openIds.length > 0 && !restoring) {
      tabOrder = tabOrder.filter(id => openIds.includes(id));
    }
    for (const id of openIds) if (!tabOrder.includes(id)) tabOrder.push(id);

    strip.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'session-tabs-list';

    // Classify each tab's status the same way the sidebar/grid do, so the tab
    // dot colors always match the status badge palette (#97).
    const tabRuntime = (typeof getSessionRuntimeState === 'function') ? getSessionRuntimeState() : {};
    let activeEl = null;
    for (const t of model) {
      const tab = document.createElement('div');
      tab.className = 'session-tab' + (t.active ? ' active' : '');
      const tabSession = (typeof sessionMap !== 'undefined') ? sessionMap.get(t.sessionId) : null;
      const tabStatus = (typeof getSessionStatus === 'function' && tabSession)
        ? getSessionStatus(tabSession, tabRuntime) : null;
      if (tabStatus) tab.classList.add(tabStatus.className); // status-busy / status-running / …
      if (isSubagentActive(t.sessionId)) tab.classList.add('subagent-active'); // #123
      tab.dataset.sessionId = t.sessionId;
      // Project · backend · state beside the name (#334), not the name on its own.
      tab.title = (tabSession && window.tabTooltipFor(tabSession, tabStatus)) || t.name;
      if (dragReorder) tab.draggable = true;

      const dot = document.createElement('span');
      // The dot carries the status class itself (plus the shared `status-dot` marker), so the sidebar's
      // spinner/ripple/glow motion applies here too (#269) — previously only the tab wore the class and
      // the dot was a flat colour.
      dot.className = 'session-tab-dot status-dot' + (tabStatus ? ' ' + tabStatus.className : '');
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
  // Take the document listeners down WITH the menu (#352). They used to remove themselves, which
  // only works on the paths they detect: closing the menu by clicking one of its own items — the
  // ordinary way to use it — reached neither, so every use left a capture-phase `mousedown` on
  // `document` behind, permanently, one per use for the lifetime of the window. The pane menu next
  // door describes this fix in a comment; this half never got it.
  let ctxDismissHandlers = null;
  function closeTabContextMenu() {
    if (ctxDismissHandlers) {
      document.removeEventListener('mousedown', ctxDismissHandlers.out, true);
      document.removeEventListener('keydown', ctxDismissHandlers.esc, true);
      ctxDismissHandlers = null;
    }
    if (activeCtxMenu) { activeCtxMenu.remove(); activeCtxMenu = null; }
  }

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
      // An action that cannot apply right now is shown greyed rather than left out (#327): the pane
      // menu has always done it that way, and an entry that silently disappears reads as a feature
      // the app does not have.
      if (opts.disabled) b.disabled = true;
      b.addEventListener('click', () => { closeTabContextMenu(); handler(); });
      // `before` places an item that arrived late (the window list, #316) next to the one it extends.
      if (opts.before && opts.before.parentElement === pop) pop.insertBefore(b, opts.before);
      else pop.appendChild(b);
      return b;
    };

    addItem('Close', () => performClose(sessionId));
    addItem('Stop & close', () => {
      try { window.api.stopSession(sessionId); } catch { /* ignore */ }
      performClose(sessionId);
    }, { danger: true });
    addItem('Relaunch', () => {
      if (typeof window.relaunchSession === 'function') window.relaunchSession(sessionId);
    });
    // Where this session renders (#2, #314, #316). The whole block — the direction to offer, whether a
    // session without a process may go, and the windows it can be moved to — is built by the shared
    // helper (#327); this menu contributes only how an item looks. The tab goes with the session: the
    // window that has it releases its terminal, the one that takes it attaches.
    if (typeof window.appendWindowItems === 'function') {
      window.appendWindowItems(sessionId, addItem, () => activeCtxMenu === pop);
    }

    document.body.appendChild(pop);
    // Position at the cursor, clamped into the viewport.
    pop.style.position = 'fixed';
    const rect = pop.getBoundingClientRect();
    pop.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
    pop.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
    activeCtxMenu = pop;
    setTimeout(() => {
      // Against THIS menu, not "some menu is open": a menu replaced inside one tick would otherwise
      // arm its pair into the single slot on top of the live one's, and the overwritten pair could
      // never be removed again.
      if (activeCtxMenu !== pop) return;
      const out = (e) => { if (activeCtxMenu && !activeCtxMenu.contains(e.target)) closeTabContextMenu(); };
      const esc = (e) => { if (e.key === 'Escape') closeTabContextMenu(); };
      ctxDismissHandlers = { out, esc };
      document.addEventListener('mousedown', out, true);
      document.addEventListener('keydown', esc, true);
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
    document.body.classList.toggle('tabs-bottom', tabPosition === 'bottom');
    refreshSessionTabs();
  }

  function applySessionDisplaySettings(g) {
    g = g || {};
    const prevMode = displayMode;
    // 'grid' is the legacy mode (sidebar + grid overview / single view); stored
    // 'legacy' still maps there. 'panes' (#309) renders its own tree and shares
    // this mode switch, but nothing else in this file.
    // A stored 'tabs' resolves to 'panes' (#357) — one place decides that, in grid-layout.js.
    displayMode = resolveSessionDisplayMode(g.sessionDisplayMode);
    tabPosition = g.tabPosition === 'bottom' ? 'bottom' : 'top';
    closeBehavior = g.tabCloseBehavior === 'stopSession' ? 'stopSession' : 'closeView';
    terminalCloseBehavior = g.terminalCloseBehavior === 'keep' ? 'keep' : 'kill';
    middleClickCloses = g.tabMiddleClickCloses !== false;
    dragReorder = g.tabDragReorder !== false;
    autoCloseMode = resolveAutoCloseMode(g);
    autoCloseDelaySec = resolveAutoCloseDelaySec(g);
    // `tabsLiveRender` is the retired name (#339): the setting stopped being about tabs when panes
    // started obeying it. A stored preference still counts — reading the old key second is what makes
    // the rename invisible to whoever had already turned it off.
    if (typeof window._setLiveRenderBackground === 'function') {
      const stored = g.liveRenderBackground !== undefined ? g.liveRenderBackground : g.tabsLiveRender;
      window._setLiveRenderBackground(stored !== false);
    }
    tabOrder = Array.isArray(g.tabOrder) ? g.tabOrder.slice() : [];
    applyMode();
    // Panes mode owns the terminal area itself (#309): it enables on 'panes' and
    // hands every container back to #terminals on any other mode. Run it before
    // the grid scoping below, so a switch out of panes restores the single view
    // into a #terminals that already holds the containers again.
    if (window.panesView) window.panesView.applySettings(g);

    // Tabs mode is single-view only; the grid mosaic belongs to grid mode. On a real
    // user mode switch, scope the grid per mode WITHOUT losing the grid-mode mosaic
    // preference (saved separately so grid mode keeps its mosaic). Skip on the first
    // apply (startup) — the persisted gridViewActive already matches the mode.
    if (initialized && prevMode !== displayMode) {
      if (displayMode === 'panes') {
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

  // Does a subagent work inside this session? Owned by app.js (#119/#121).
  function isSubagentActive(sessionId) {
    return typeof subagentActiveSessions !== 'undefined' && subagentActiveSessions.has(sessionId);
  }

  // Repaint the tab dots from the live status, without rebuilding the strip (#124).
  // A rebuild on every busy edge would churn the DOM and cancel a tab drag, so the
  // status classes are patched in place — the same trade-off patchSidebarStatuses
  // makes. Returns false when there is nothing to patch, so the caller can fall
  // back to a full render.
  function patchTabStatuses() {
    const strip = stripEl();
    if (!strip) return false;
    const tabs = strip.querySelectorAll('.session-tab');
    if (!tabs.length) return false;
    const runtime = (typeof getSessionRuntimeState === 'function') ? getSessionRuntimeState() : {};
    const statusClasses = (typeof SESSION_STATUS_CLASSES !== 'undefined') ? SESSION_STATUS_CLASSES : [];
    for (const tab of tabs) {
      const sid = tab.dataset.sessionId;
      const session = (typeof sessionMap !== 'undefined') ? sessionMap.get(sid) : null;
      const status = (session && typeof getSessionStatus === 'function') ? getSessionStatus(session, runtime) : null;
      const dot = tab.querySelector('.session-tab-dot');
      if (status) {
        if (!tab.classList.contains(status.className)) {
          if (statusClasses.length) tab.classList.remove(...statusClasses);
          tab.classList.add(status.className);
        }
        if (dot && !dot.classList.contains(status.className)) {
          if (statusClasses.length) dot.classList.remove(...statusClasses);
          dot.classList.add(status.className);
        }
      } else if (statusClasses.length) {
        // Session no longer resolvable — drop the stale class instead of leaving the dot asserting it (#258).
        tab.classList.remove(...statusClasses);
        if (dot) dot.classList.remove(...statusClasses);
      }
      // Subagent activity is an overlay on the dot, not a status of its own (#123).
      tab.classList.toggle('subagent-active', isSubagentActive(sid));
    }
    return true;
  }

  // The tooltip for a session's tab, wherever that tab is (#334). Panes mode calls this too: the two
  // strips build their tabs from the same session data, and a tooltip that said different things in
  // the two modes would be worse than the name-only one it replaces. The state comes from
  // `getSessionStatus`, the same source the dot uses, so the two cannot disagree — and the backend is
  // its own declared label, never an id.
  window.tabTooltipFor = function (session, status) {
    if (!session) return '';
    const backend = (typeof window.getBackend === 'function') ? window.getBackend(session.backendId) : null;
    const name = (typeof cleanDisplayName === 'function'
      ? cleanDisplayName(session.name || session.aiTitle || session.summary) : '') || session.sessionId;
    return buildTabTooltip({
      name,
      project: projectTailOf(session.projectPath),
      backend: backend && backend.label,
      state: status && status.label,
    });
  };

  // The session bar's tooltip and the project it shows beside the name (#358). Both surfaces that carry
  // a session bar — the pane's action row and the tabs-mode header — read them from here, for the same
  // reason `tabTooltipFor` exists: two compositions of the same facts is the pair that drifts.
  window.sessionBarTooltipFor = function (session, status, ptyTitle) {
    if (!session) return '';
    const backend = (typeof window.getBackend === 'function') ? window.getBackend(session.backendId) : null;
    const name = (typeof cleanDisplayName === 'function'
      ? cleanDisplayName(session.name || session.aiTitle || session.summary) : '') || session.sessionId;
    return buildSessionBarTooltip({
      name,
      aiTitle: (typeof cleanDisplayName === 'function'
        ? cleanDisplayName(session.aiTitle || session.summary) : (session.aiTitle || session.summary)),
      ptyTitle,
      sessionId: session.sessionId,
      project: projectTailOf(session.projectPath),
      backend: backend && backend.label,
      state: status && status.label,
    });
  };
  window.sessionProjectLabel = (session) => projectTailOf(session && session.projectPath);

  window.refreshSessionTabs = refreshSessionTabs;
  window.patchTabStatuses = patchTabStatuses;
  window.scheduleTabAutoClose = scheduleTabAutoClose;
  window.cancelTabAutoClose = cancelTabAutoClose;
  // Close a tab immediately (deliberate stop/archive) — switches to a neighbour or
  // the placeholder. Panes mode has tabs too (#309/#310) and nothing else would ever
  // take that one down: the timed auto-close is the other branch, for a process that
  // ended on its own (#317). Grid/legacy manage their own view.
  window.closeTabNow = (sessionId) => {
    if (displayMode === 'panes') performClose(sessionId);
  };
  window._applySessionDisplaySettings = applySessionDisplaySettings;
})();
