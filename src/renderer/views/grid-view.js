// --- Session Grid Overview ---
// No reparenting — terminals stay in #terminals. We wrap each terminal container
// with an in-place card overlay (header/footer) and switch #terminals to grid layout.
//
// Depends on globals from app.js: openSessions, activeSessionId, sessionMap, activePtyIds,
// sortedOrder, sidebarContent, terminalsEl, gridViewActive, gridViewer, gridViewerCount,
// placeholder, terminalHeader, planViewer, statsViewer, memoryViewer, settingsViewer,
// jsonlViewer, terminalArea, cachedProjects, isMac
// Depends on: cleanDisplayName, formatDate (utils.js), fitAndScroll, showSession (terminal-manager.js)

let gridCards = new Map(); // sessionId → card wrapper element
let gridFocusedSessionId = null;
let gridStatusFilter = localStorage.getItem('gridStatusFilter') || 'all';
// The one writer of gridStatusFilter: assign + persist in a single place so the three callers (the bulk
// bar, the terminal-manager reset, and the empty-filter fallback below) cannot drift on the storage key or
// forget to persist. It is a window property because two of those callers are in other files (#218).
window._setGridStatusFilter = (value) => {
  gridStatusFilter = value;
  localStorage.setItem('gridStatusFilter', value);
};
// True while a drag-reorder or resize gesture is in progress. Status ticks must
// not tear down and rebuild the grid mid-gesture (it would detach the card the
// user is holding), so refreshGridView() bails out while this is set.
let gridInteracting = false;
// Session id whose card is in keyboard "move mode" (null = mode off). While set,
// bare arrows reorder the card, Shift+arrows resize it, and Esc/Enter leave. The
// mode also gates keys away from the focused xterm (see isGridMoveModeKey), so
// every exit path must run exitGridMoveMode() — a stuck mode would swallow the
// terminal's arrow keys.
let gridMoveModeSessionId = null;

// Flexible grid layout (spec 08): per-session { order, colSpan, rowSpan } map,
// persisted in localStorage like gridViewActive/gridStatusFilter.
let gridLayout = loadGridLayout();

function loadGridLayout() {
  try {
    const parsed = JSON.parse(localStorage.getItem('gridLayout') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveGridLayout() {
  try {
    localStorage.setItem('gridLayout', JSON.stringify(gridLayout));
  } catch {
    /* storage full / unavailable — layout simply won't persist */
  }
}

// gridReducedMotion(), debouncedFit() and gridFitTimers moved to views/grid-gestures.js (#218) — the
// pointer gestures were their only callers.

// The one runtime snapshot builder lives in app.js (window.sessionRuntimeState, #260). This used to be
// a near-copy that dropped the inbox fields — harmless for getSessionStatus, which never reads them,
// but a divergence waiting to bite. Delegate so the grid reads the same shape as everything else.
function getGridRuntimeState() {
  return window.sessionRuntimeState();
}

// The six status classes a card can carry, cleared as a set before the current one is applied — and on
// a lookup miss so no stale state lingers (#258). Mirrors SESSION_STATUS_CLASSES in sidebar.js.
const GRID_STATUS_CLASSES = ['status-needs-attention', 'status-response-ready',
  'status-busy', 'status-running', 'status-exited', 'status-idle'];

function getGridOpenSessions() {
  const sessions = [];
  for (const [sid, entry] of openSessions) {
    if (entry.closed) continue;
    const session = sessionMap.get(sid) || entry.session;
    if (session) sessions.push(session);
  }
  return sessions;
}

function getGridAllowedSessionIds() {
  const filtered = getFilteredSessionsByStatus(getGridOpenSessions(), getGridRuntimeState(), gridStatusFilter);
  return new Set(filtered.map(session => session.sessionId));
}

// The filter chips and the bulk action bar moved to views/grid-bulk-actions.js (#218). The state they
// read (gridStatusFilter and the three accessors above) stays here: this file owns it, they render it.

function wrapInGridCard(sessionId, parent, layout) {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);
  if (!session || !entry) return;
  const target = parent || terminalsEl;

  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary) || sessionId;
  const shortProject = session.projectPath ? session.projectPath.split('/').filter(Boolean).slice(-2).join('/') : '';
  const status = getSessionStatus(session, getGridRuntimeState());
  const health = getSessionHealth(session);

  // Create card wrapper
  const card = document.createElement('div');
  card.className = `grid-card ${status.className} ${health.className}`;
  card.dataset.sessionId = sessionId;

  // Apply persisted span (spec 08). Defaults to 1x1.
  const colSpan = Math.max(1, Number(layout && layout.colSpan) || 1);
  const rowSpan = Math.max(1, Number(layout && layout.rowSpan) || 1);
  card.dataset.colSpan = colSpan;
  card.dataset.rowSpan = rowSpan;
  card.style.gridColumn = `span ${colSpan}`;
  card.style.gridRow = `span ${rowSpan}`;

  // Header
  const header = document.createElement('div');
  header.className = 'grid-card-header';
  const dot = document.createElement('span');
  // Driven by status.className, same as the chip on this card (#253). `status-dot` shares the sidebar's
  // spinner/ripple/glow motion (#269). It used to get no state class at build and stayed invisible until
  // the first patch pass, because .grid-card-dot has no default fill.
  dot.className = 'grid-card-dot status-dot ' + status.className;
  header.appendChild(dot);
  const name = document.createElement('span');
  name.className = 'grid-card-name';
  name.textContent = displayName;
  header.appendChild(name);
  const statusChip = document.createElement('span');
  statusChip.className = `grid-card-status-chip ${status.className}`;
  statusChip.textContent = status.label;
  header.appendChild(statusChip);
  if (health.state !== 'healthy') {
    const healthChip = document.createElement('button');
    healthChip.type = 'button';
    healthChip.className = `grid-card-health-chip ${health.className}`;
    healthChip.textContent = health.label;
    healthChip.title = 'Create handoff';
    healthChip.addEventListener('click', (e) => {
      e.stopPropagation();
      showHandoffPrompt(session);
    });
    header.appendChild(healthChip);
  }
  const project = document.createElement('span');
  project.className = 'grid-card-project';
  project.textContent = shortProject;
  header.appendChild(project);

  // Snap-layout button (spec 08) — Windows 11-style preset sizes.
  const snapBtn = document.createElement('button');
  snapBtn.className = 'grid-card-snap-btn';
  snapBtn.type = 'button';
  snapBtn.title = 'Snap layout';
  snapBtn.setAttribute('aria-label', `Snap layout for ${displayName}`);
  snapBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="1.5" width="13" height="13" rx="2"/><line x1="8" y1="1.5" x2="8" y2="14.5"/><line x1="1.5" y1="8" x2="14.5" y2="8"/></svg>';
  snapBtn.onclick = (e) => {
    e.stopPropagation();
    toggleSnapLayoutPopover(sessionId, card, snapBtn);
  };
  // Hover-open with an intent delay (gated to fine/hover pointers inside the
  // scheduler); moving onto the popover keeps it open.
  snapBtn.addEventListener('mouseenter', () => scheduleSnapHoverOpen(sessionId, card, snapBtn));
  snapBtn.addEventListener('mouseleave', () => scheduleSnapHoverClose());
  header.appendChild(snapBtn);

  const stopBtn = document.createElement('button');
  stopBtn.className = 'grid-card-stop-btn';
  stopBtn.title = 'Stop session';
  stopBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';
  stopBtn.style.display = activePtyIds.has(sessionId) ? '' : 'none';
  stopBtn.onclick = (e) => {
    e.stopPropagation();
    confirmAndStopSession(sessionId);
  };
  header.appendChild(stopBtn);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'grid-card-footer';
  const statusSpan = document.createElement('span');
  const timeSpan = document.createElement('span');
  timeSpan.textContent = formatDate(lastActivityTime.get(sessionId) || new Date(session.modified));
  footer.appendChild(statusSpan);
  footer.appendChild(timeSpan);

  // Corner resize handle (spec 08) — drag to snap col/row spans.
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'grid-card-resize-handle';
  resizeHandle.title = 'Resize card';
  resizeHandle.setAttribute('aria-hidden', 'true');
  resizeHandle.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M11 11H8l3-3zM11 6.5H5.5L11 1zM6 11H3l3-3z" opacity="0.9"/></svg>';

  // Build the card DOM
  card.appendChild(header);
  entry.element.classList.add('visible', 'grid-mode');
  // Drain any data that accumulated while this session was non-visible.
  // Must happen after classList.add so isSessionVisible returns true.
  if (typeof drainReplayBuffer === 'function') drainReplayBuffer(sessionId);
  card.appendChild(entry.element);
  card.appendChild(footer);
  card.appendChild(resizeHandle);

  target.appendChild(card);

  // Click header or footer to focus
  const focusFromCardChrome = (e) => {
    if (e?.target?.closest?.('button')) return;
    e.stopPropagation();
    focusGridCard(sessionId);
  };
  header.addEventListener('mousedown', focusFromCardChrome);
  makeButtonLike(header, focusFromCardChrome, `Focus ${displayName}`);

  // Drag-to-reorder / drag-into-group via the header (single shared drag system).
  header.addEventListener('pointerdown', (e) => startCardDrag(sessionId, card, e));
  // Resize via the corner handle.
  resizeHandle.addEventListener('pointerdown', (e) => startCardResize(sessionId, card, e));
  // Double-click header to switch to full terminal view
  header.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    gridFocusedSessionId = sessionId;
    toggleGridView();
  });
  footer.addEventListener('mousedown', focusFromCardChrome);
  makeButtonLike(footer, focusFromCardChrome, `Focus ${displayName}`);

  // Clicking/focusing the terminal area also selects the card
  entry.element.addEventListener('focusin', () => {
    if (gridViewActive && gridFocusedSessionId !== sessionId) {
      focusGridCard(sessionId);
    }
  });

  gridCards.set(sessionId, card);
  syncTitleToAriaLabel(card);
  syncTitleToTooltip(card);
  if (gridCardObserver) gridCardObserver.observe(card);
  // Initial status is applied by the caller via one updateRunningIndicators()
  // after the whole render loop — calling it per card here made every grid
  // rebuild O(N²) (it iterates all cards each time) (#80).
}

// ===== Flexible layout: resize, drag-reorder (spec 08) =====

function getContainerColumnCount(container) {
  if (!container) return 1;
  // Count the resolved track list from computed style, falling back to the same
  // width-based calc updateGridColumns() uses so resize/snap clamp to the real
  // number of columns the container actually offers.
  const tracks = getComputedStyle(container).gridTemplateColumns;
  if (tracks && tracks !== 'none') {
    const count = tracks.split(' ').filter(Boolean).length;
    if (count > 0) return count;
  }
  if (typeof calculateGridColumnCount === 'function') {
    const cardCount = container.querySelectorAll('.grid-card').length;
    const width = container.clientWidth || terminalsEl.clientWidth;
    return calculateGridColumnCount({ width, cardCount });
  }
  return 1;
}

// Persist the current visual order (DOM order) plus each card's span into the
// gridLayout map.
function persistGridOrder() {
  let order = 0;
  for (const card of terminalsEl.querySelectorAll('.grid-card')) {
    const sid = card.dataset.sessionId;
    const prev = gridLayout[sid] || {};
    gridLayout[sid] = {
      order,
      colSpan: Number(prev.colSpan) || Number(card.dataset.colSpan) || 1,
      rowSpan: Number(prev.rowSpan) || Number(card.dataset.rowSpan) || 1,
    };
    order++;
  }
  saveGridLayout();
}

// The pointer gestures (drag-to-reorder, corner resize) moved to views/grid-gestures.js (#218).
// They write gridInteracting (above) across the file boundary — see that file's header.

// Write a span onto a card + the persisted layout map (no fit/persist-order;
// callers decide when to reflow). Shared by drag-resize and snap presets.
function writeCardSpan(sessionId, card, span) {
  card.dataset.colSpan = span.cols;
  card.dataset.rowSpan = span.rows;
  card.style.gridColumn = `span ${span.cols}`;
  card.style.gridRow = `span ${span.rows}`;
  const prev = gridLayout[sessionId] || {};
  gridLayout[sessionId] = {
    order: Number.isFinite(prev.order) ? prev.order : 0,
    colSpan: span.cols,
    rowSpan: span.rows,
  };
}

// Apply a discrete preset size to a card (Windows 11-style snap), clamped to the
// columns currently available in its container, then persist + reflow.
function applyCardSnap(sessionId, cols, rows) {
  const card = gridCards.get(sessionId);
  if (!card) return;
  const maxCols = getContainerColumnCount(card.parentElement);
  const span = normalizeSpan({ cols, rows }, maxCols);
  const before = snapshotGridCardBoxes();
  writeCardSpan(sessionId, card, span);
  saveGridLayout();
  updateGridColumns();
  refitResizedGridCards(before);
}

// Box of every mounted, visible grid card. Cards inside a collapsed region have no
// geometry and are skipped — a real show refits them anyway.
function snapshotGridCardBoxes() {
  const boxes = new Map();
  for (const [sessionId] of gridCards) {
    const entry = openSessions.get(sessionId);
    const el = entry && !entry.closed && entry.element;
    if (!el || el.offsetParent === null) continue;
    boxes.set(sessionId, { w: el.clientWidth, h: el.clientHeight });
  }
  return boxes;
}

// Re-fit every card whose box actually changed — not just the one that was
// resized. A rowSpan change re-flows the whole track, so a neighbour can shrink
// without being touched. Nothing here is animated (only transform/border-color
// are), so the post-updateGridColumns boxes are already final.
//
// Shrinking additionally needs a PTY nudge: xterm's reflow of wrapped lines leaves
// mis-drawn cells behind and the TUI only repaints on its own once something is
// typed. Growing reflows correctly, and nudging it would just flash the card.
function refitResizedGridCards(before) {
  for (const [sessionId, box] of snapshotGridCardBoxes()) {
    const old = before.get(sessionId);
    if (!old || (old.w === box.w && old.h === box.h)) continue;
    const entry = openSessions.get(sessionId);
    if (entry) fitAndScroll(entry);
    if (box.w < old.w || box.h < old.h) requestCardRedraw(sessionId);
  }
}

// Ask the PTY for one clean frame (see refitResizedGridCards).
function requestCardRedraw(sessionId) {
  const entry = openSessions.get(sessionId);
  if (!entry || entry.closed) return;
  if (window.api && typeof window.api.redrawTerminal === 'function') {
    window.api.redrawTerminal(sessionId);
  }
}

// The snap-layout popover moved to views/grid-snap-popover.js (#218). It reaches back in here for
// getContainerColumnCount() and applyCardSnap(); nothing else crosses.

function resetGridLayout() {
  gridLayout = {};
  saveGridLayout();
  closeSnapLayoutPopover();
  if (gridViewActive) showGridView();
}

function unwrapGridCards() {
  for (const [sid, card] of gridCards) {
    if (gridCardObserver) gridCardObserver.unobserve(card);
    const entry = openSessions.get(sid);
    if (entry) {
      entry.element.classList.remove('grid-mode', 'visible');
      // Move terminal container back to #terminals (out of the card)
      terminalsEl.appendChild(entry.element);
    }
    card.remove();
  }
  gridCards.clear();
  // No cards → nothing is off-screen; a stale entry would silently freeze the
  // session's writes in single/tabs view.
  gridOffscreenSessions.clear();
}

function focusGridCard(sessionId) {
  // Focus moved off the card being moved (nav shortcut, click, inbox jump) —
  // the mode belongs to that one card, so it ends here.
  if (isGridMoveModeActive() && gridMoveModeSessionId !== sessionId) exitGridMoveMode();
  const prevFocused = gridFocusedSessionId;
  gridFocusedSessionId = sessionId;
  // WebGL follows focus (#140): demote the previously focused card to the DOM
  // renderer and promote the new one, so only one grid card ever holds a live
  // WebGL context. Off-screen cards stay DOM (applyGridWebglPolicy checks that).
  if (prevFocused && prevFocused !== sessionId) applyGridWebglPolicy(prevFocused);
  applyGridWebglPolicy(sessionId);
  setActiveSession(sessionId);
  clearNotifications(sessionId);
  lruTouch(sessionId);
  // Update sidebar active highlight
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const sidebarItem = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (sidebarItem) sidebarItem.classList.add('active');
  // Update visual focus
  document.querySelectorAll('.grid-card').forEach(c => c.classList.remove('focused'));
  const card = gridCards.get(sessionId);
  if (card) {
    card.classList.add('focused');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const entry = openSessions.get(sessionId);
  if (entry) entry.terminal.focus();
}

// The set of session ids the grid should currently render, in sidebar order.
// Mirrors the selection showGridView() performs.
function gridDesiredSids() {
  const openSet = new Set();
  for (const [sid, entry] of openSessions) {
    if (!entry.closed) openSet.add(sid);
  }
  const allowedSet = getGridAllowedSessionIds();
  const ids = [];
  for (const item of sidebarContent.querySelectorAll('.session-item[data-session-id]')) {
    const sid = item.dataset.sessionId;
    if (!openSet.has(sid) || !allowedSet.has(sid)) continue;
    ids.push(sid);
  }
  return ids;
}

// Decide whether the grid must be fully rebuilt (membership changed) versus just
// updated in place. Card ORDER and spans are intentionally not treated as rebuild
// triggers — they're owned by the user's drag/resize and must survive status ticks.
function gridNeedsRebuild() {
  const desired = gridDesiredSids();
  if (desired.length !== gridCards.size) return true;
  return desired.some(sid => !gridCards.get(sid));
}

// Refresh the grid in response to a status tick. Never rebuilds mid-gesture;
// otherwise updates card status/dots/chips in place and only does a full
// rebuild when the rendered session set actually changed.
function refreshGridView() {
  if (!gridViewActive) return;
  if (gridInteracting) return;
  if (gridCards.size === 0 || gridNeedsRebuild()) {
    showGridView();
    return;
  }
  updateGridCardStatuses();
  renderGridStatusFilters();
  renderGridBulkActions();
}

// Update each rendered grid card's status/health visuals in place — no teardown,
// so layout (order + spans) and any in-progress gesture are preserved. Shared by
// refreshGridView() and updateRunningIndicators().
function updateGridCardStatuses() {
  const runtime = getGridRuntimeState();
  for (const [sid, card] of gridCards) {
    const session = sessionMap.get(sid) || openSessions.get(sid)?.session;
    if (!session) {
      // No resolvable session — clear the status classes rather than leaving the card asserting a
      // state nobody can look up (#258). The card itself is torn down on the next grid rebuild.
      card.classList.remove(...GRID_STATUS_CLASSES);
      continue;
    }
    const status = getSessionStatus(session, runtime);
    const health = getSessionHealth(session);
    // Keep the card title in sync with the live session metadata (user renames,
    // AI titles, /title). Title updates arrive via loadProjects() without a full
    // grid rebuild, so refresh the name in place here rather than leaving it stale.
    const name = card.querySelector('.grid-card-name');
    if (name) {
      const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary) || sid;
      if (name.textContent !== displayName) name.textContent = displayName;
    }
    const dot = card.querySelector('.grid-card-dot');
    // The dot follows the resolved status, no longer a three-way collapse that painted attention/ready
    // green and contradicted the chip on the same card (#253). `status-dot` carries the shared motion (#269).
    if (dot) dot.className = 'grid-card-dot status-dot ' + status.className;
    card.classList.remove(...GRID_STATUS_CLASSES, 'health-healthy', 'health-growing', 'health-marathon-risk', 'health-handoff-recommended');
    card.classList.add(status.className, health.className);
    // Subagent activity is an overlay on the dot, not a status of its own (#123).
    card.classList.toggle('subagent-active', typeof subagentActiveSessions !== 'undefined' && subagentActiveSessions.has(sid));
    const chip = card.querySelector('.grid-card-status-chip');
    if (chip) {
      chip.className = `grid-card-status-chip ${status.className}`;
      chip.textContent = status.label;
    }
    const healthChip = card.querySelector('.grid-card-health-chip');
    if (healthChip) {
      healthChip.className = `grid-card-health-chip ${health.className}`;
      healthChip.textContent = health.label;
      healthChip.style.display = health.state === 'healthy' ? 'none' : '';
    }
    const footer = card.querySelector('.grid-card-footer');
    if (footer && footer.children[0]) footer.children[0].textContent = status.label;
    const stopBtn = card.querySelector('.grid-card-stop-btn');
    // Stop applies to a live process, so it keys on the pty — matching the build path (wrapInGridCard),
    // which used activePtyIds. The old `running` collapse also showed it for an idle attention/ready row.
    if (stopBtn) stopBtn.style.display = activePtyIds.has(sid) ? '' : 'none';
  }
}

// Auto-open active sessions in the grid: every session with a live PTY should
// surface as a card without the user clicking it in the sidebar first. We only
// ATTACH to already-running PTYs (attachRunningSession reattaches; the main
// process never spawns a new `claude` for an active session), so idle/stopped
// sessions are never force-started. Mounts are batched and followed by a single
// showGridView() rebuild + fit pass. Safe to call repeatedly: it no-ops when
// there's nothing new to mount, when the grid is closed, or mid-gesture.
let gridAutoMounting = false;
async function ensureGridActiveSessionsMounted() {
  if (!gridViewActive || gridAutoMounting || gridInteracting) return false;
  if (typeof getGridAutoOpenSessionIds !== 'function' || typeof attachRunningSession !== 'function') {
    return false;
  }
  // Only sessions we have metadata for can become cards; the rest are picked up
  // on a later poll once loadProjects() populates sessionMap.
  const toMount = getGridAutoOpenSessionIds(getGridRuntimeState())
    .map(sid => sessionMap.get(sid))
    .filter(Boolean);
  if (toMount.length === 0) return false;

  gridAutoMounting = true;
  let mounted = 0;
  try {
    for (const session of toMount) {
      // A concurrent path (manual click, restore) may have opened it while we
      // awaited a previous attach — re-check before mounting again.
      const entry = openSessions.get(session.sessionId);
      if (entry && !entry.closed) continue;
      if (await attachRunningSession(session)) mounted++;
    }
  } finally {
    gridAutoMounting = false;
  }

  // One batched rebuild after all attaches land (skip if the view closed or a
  // drag/resize started while we were awaiting).
  if (mounted > 0 && gridViewActive && !gridInteracting) showGridView();
  return mounted > 0;
}

function showGridView() {
  // Also reached WITHOUT user input — a rebuild after an auto-mounted session reflows every card
  // (#207). The palette anchors to one terminal's rectangle, so it would end up hanging over a
  // different session's card while still inserting into the one it captured.
  if (typeof closeVariablePalette === 'function') closeVariablePalette({ refocus: false });
  gridViewActive = true;
  localStorage.setItem('gridViewActive', '1');
  renderGridStatusFilters();
  renderGridBulkActions();
  unwrapGridCards();
  placeholder.style.display = 'none';
  terminalHeader.style.display = 'none';

  // Hide other viewers but keep terminal-area visible
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  memoryViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  jsonlViewer.style.display = 'none';
  timelineViewer.style.display = 'none'; // was missing → timeline overlapped the grid
  terminalArea.style.display = '';

  // Switch #terminals to grid layout
  terminalsEl.classList.add('grid-layout');

  // Collect open (non-closed) session IDs
  const openSet = new Set();
  for (const [sid, entry] of openSessions) {
    if (!entry.closed) openSet.add(sid);
  }
  let allowedSet = getGridAllowedSessionIds();
  if (gridStatusFilter !== 'all' && allowedSet.size === 0) {
    window._setGridStatusFilter('all');
    allowedSet = getGridAllowedSessionIds();
    renderGridStatusFilters();
  }

  // Hide all terminals first, then collect allowed session ids in sidebar order.
  document.querySelectorAll('.terminal-container').forEach(el => el.classList.remove('visible'));
  const orderedSids = [];
  const sidebarItems = sidebarContent.querySelectorAll('.session-item[data-session-id]');
  for (const item of sidebarItems) {
    const sid = item.dataset.sessionId;
    if (!openSet.has(sid) || !allowedSet.has(sid)) continue;
    orderedSids.push(sid);
  }

  // Apply persisted order + spans (spec 08).
  const gridWidth = terminalsEl.clientWidth;
  const sessionIds = [];
  const cols = calculateGridColumnCount({ width: gridWidth, cardCount: orderedSids.length });
  for (const item of applyLayout(orderedSids, gridLayout, cols)) {
    wrapInGridCard(item.sessionId, terminalsEl, item);
    sessionIds.push(item.sessionId);
  }

  // Set initial card statuses once for the whole render (see wrapInGridCard).
  updateRunningIndicators();

  // Show grid header bar with session count
  gridViewer.style.display = 'block';
  gridViewerCount.textContent = sessionIds.length + ' session' + (sessionIds.length !== 1 ? 's' : '');

  const btn = document.getElementById('grid-toggle-btn');
  if (btn) {
    btn.classList.add('active');
    btn.title = 'Exit session overview';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('data-tooltip', btn.title);
  }

  updateGridColumns();

  // Fit all terminals after layout resolves. Grid cards drop to the thumbnail
  // scrollback budget: xterm trims the buffer immediately when the new limit is
  // below the current row count, so content scrolled past SCROLLBACK_GRID rows is
  // lost on entering the grid — accepted trade-off, the full budget is restored
  // (for future output) when a session returns to single view (see showSession).
  for (const sid of sessionIds) {
    const entry = openSessions.get(sid);
    if (!entry) continue;
    entry.terminal.options.scrollback = SCROLLBACK_GRID;
    fitAndScroll(entry);
  }
  // Focus active or first (deferred so fitAndScroll's rAF runs first).
  requestAnimationFrame(() => {
    const toFocus = activeSessionId && sessionIds.includes(activeSessionId) ? activeSessionId : sessionIds[0];
    if (toFocus) focusGridCard(toFocus);
  });
}

function updateGridColumns() {
  if (!gridViewActive) return;
  const width = terminalsEl.clientWidth;

  const cardCount = terminalsEl.querySelectorAll('.grid-card').length;
  const cols = calculateGridColumnCount({ width, cardCount });
  terminalsEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  terminalsEl.classList.toggle('grid-few-cards', cardCount > 0 && cardCount <= 2);
  terminalsEl.classList.toggle('grid-single-card', cardCount === 1);
}

// Virtualize WebGL on grid cards: only on-screen cards keep a GL context.
// Off-screen cards drop to xterm's DOM renderer (suspendTerminalWebgl) and
// get the context back when scrolled into view. This both frees GPU memory
// and keeps the total context count under Chromium's ~16-per-process cap on
// large grids.
let gridCardObserver = null;

// Sessions whose grid card is currently scrolled out of view. terminal-manager's
// isSessionVisible() treats these as non-visible, so their PTY output skips the
// xterm write/VT-parse entirely and lands in the replay buffer instead — the
// IntersectionObserver drains it when the card scrolls back in (#81).
const gridOffscreenSessions = new Set();

// Remove a session's grid card and release its observer registration. Called
// from destroySession (terminal-manager.js) — without the unobserve, the
// IntersectionObserver keeps a strong ref to the detached card node, leaking
// one element per LRU eviction while the grid stays open.
function destroyGridCard(sessionId) {
  const card = gridCards.get(sessionId);
  if (!card) return false;
  // The card being moved is going away — leave the mode, or its gate would keep
  // swallowing arrow keys with nothing left to move.
  if (gridMoveModeSessionId === sessionId) exitGridMoveMode();
  if (gridCardObserver) gridCardObserver.unobserve(card);
  gridOffscreenSessions.delete(sessionId);
  card.remove();
  gridCards.delete(sessionId);
  return true;
}

// initGridObservers is called from app.js after DOM refs are ready
function initGridObservers() {
  new ResizeObserver(updateGridColumns).observe(terminalsEl);
  new MutationObserver(updateGridColumns).observe(terminalsEl, { childList: true });
  // Leaving the window ends move mode: nothing would deliver its keys anyway, and
  // a mode surviving in the background is how the terminal's arrows go dead.
  window.addEventListener('blur', () => exitGridMoveMode());
  // So does any pointer interaction — including a click back into the same card's
  // terminal, which focusGridCard() alone wouldn't catch (same session id).
  document.addEventListener('pointerdown', () => exitGridMoveMode(), true);
  const resetBtn = document.getElementById('grid-reset-layout-btn');
  if (resetBtn) resetBtn.addEventListener('click', resetGridLayout);
  // The collapse-all-groups toggle now lives in the bulk-actions bar and is
  // (re)created + bound by renderGridBulkActions on each render.
  if (typeof IntersectionObserver !== 'undefined') {
    // TODO: threshold 0 suspends/restores on every boundary crossing; if fast
    // grid scrolling ever shows GL-context churn, add a small debounce or
    // rootMargin here.
    gridCardObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const sid = e.target.dataset.sessionId;
        if (!sid) continue;
        if (e.isIntersecting) {
          applyGridWebglPolicy(sid, true); // WebGL only for the focused card (#140)
          // Back on screen: flush the pending chunk while still marked
          // off-screen (keeps it behind the replay data), then drain what
          // accumulated while the card was scrolled out (#81).
          if (typeof flushTerminalBuffer === 'function') flushTerminalBuffer(sid);
          gridOffscreenSessions.delete(sid);
          if (typeof drainReplayBuffer === 'function') drainReplayBuffer(sid);
        } else {
          gridOffscreenSessions.add(sid);
          suspendTerminalWebgl(sid);
        }
      }
    }, { threshold: 0 });
  }
}

// Only the focused grid card runs the WebGL renderer; every other card uses the
// DOM renderer (#140). xterm shares one glyph texture atlas across all WebGL
// terminals with identical config, but each holds its own GL context — so several
// live WebGL grid cards corrupt each other's glyphs (all but the actively-
// rendering/focused one, healed only by a full re-render like a resize). Keeping
// WebGL to the single focused card removes the shared-atlas contention entirely.
// Off-screen cards are always DOM (they get suspended by the observer). No fork
// does this — jbr/haydng/doctly keep WebGL on every visible card.
function applyGridWebglPolicy(sid, onScreen) {
  if (!gridViewActive) return;
  if (onScreen === undefined) onScreen = !gridOffscreenSessions.has(sid);
  if (sid === gridFocusedSessionId && onScreen) {
    if (typeof restoreTerminalWebgl === 'function') restoreTerminalWebgl(sid);
  } else {
    if (typeof suspendTerminalWebgl === 'function') suspendTerminalWebgl(sid);
  }
}

function hideGridView() {
  gridViewActive = false;
  localStorage.setItem('gridViewActive', '0');
  exitGridMoveMode();
  closeSnapLayoutPopover();
  // Restore the full scrollback budget for every session, not just the one
  // about to be focused — background sessions keep producing output after the
  // grid closes and would otherwise stay silently capped at the thumbnail
  // budget until individually shown.
  for (const entry of openSessions.values()) {
    if (!entry.closed) entry.terminal.options.scrollback = SCROLLBACK_SINGLE;
  }
  unwrapGridCards();
  terminalsEl.classList.remove('grid-layout');
  terminalsEl.classList.remove('grid-few-cards', 'grid-single-card');
  terminalsEl.style.gridTemplateColumns = '';
  gridViewer.style.display = 'none';
  const btn = document.getElementById('grid-toggle-btn');
  if (btn) {
    btn.classList.remove('active');
    btn.title = 'Session overview';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('data-tooltip', btn.title);
  }
}

function toggleGridView() {
  // The palette is anchored to a terminal rectangle that this re-wraps into (or out of) a grid card,
  // and the anchor only re-runs on a window resize — so it would hang over stale coordinates (#207).
  if (typeof closeVariablePalette === 'function') closeVariablePalette({ refocus: false });
  if (gridViewActive) {
    const restoreId = gridFocusedSessionId || activeSessionId;
    hideGridView();
    gridFocusedSessionId = null;
    if (restoreId && openSessions.has(restoreId)) {
      showSession(restoreId);
    } else {
      placeholder.style.display = '';
    }
  } else {
    // Tabs mode is single-view only — never activate the grid mosaic there.
    if (document.body.classList.contains('display-mode-tabs')) return;
    terminalHeader.style.display = 'none';
    showGridView();
    // Surface every currently-running session as a card. Kick a fresh poll so
    // activePtyIds is current (it can be stale on the 30s idle cadence); the
    // poll handler then auto-mounts via ensureGridActiveSessionsMounted().
    if (typeof pollActiveSessions === 'function') pollActiveSessions();
    else ensureGridActiveSessionsMounted();
  }
}

// Session navigation and the app-wide shortcut table (appShortcuts/setAppShortcuts/handleSessionNavKey)
// moved to shell/session-nav.js (#218) — they were never grid code.

// --- Keyboard move mode (a11y counterpart to pointer drag/resize) ---
// The pointer path owns startCardDrag/startCardResize; this is the keyboard path
// into the same primitives (DOM reorder + persistGridOrder, applyCardSnap).

const gridLiveRegion = document.getElementById('grid-live-region');

function announceGrid(message) {
  if (gridLiveRegion) gridLiveRegion.textContent = message;
}

function isGridMoveModeActive() {
  return gridMoveModeSessionId !== null;
}

// Where the card sits among the cards it can actually be reordered against —
// its own container, which is the group region in grouped mode.
function gridCardSiblings(card) {
  const container = card.parentElement;
  if (!container) return [];
  return [...container.children].filter(n => n.classList && n.classList.contains('grid-card'));
}

function gridMoveModePosition(card) {
  const sibs = gridCardSiblings(card);
  return { index: sibs.indexOf(card), total: sibs.length };
}

function gridCardSpanLabel(card) {
  const cols = Math.max(1, Number(card.dataset.colSpan) || 1);
  const rows = Math.max(1, Number(card.dataset.rowSpan) || 1);
  return `${cols} column${cols === 1 ? '' : 's'} by ${rows} row${rows === 1 ? '' : 's'}`;
}

function enterGridMoveMode(sessionId) {
  const card = gridCards.get(sessionId);
  if (!card) return false;
  gridMoveModeSessionId = sessionId;
  // Same guard the pointer gestures use: a status tick must not rebuild the grid
  // and detach the card being moved.
  gridInteracting = true;
  card.classList.add('move-mode');
  const { index, total } = gridMoveModePosition(card);
  announceGrid(`Move mode. Card ${index + 1} of ${total}, ${gridCardSpanLabel(card)}. Arrows move, Shift plus arrows resize, Escape leaves.`);
  return true;
}

function exitGridMoveMode({ announce = false } = {}) {
  if (!isGridMoveModeActive()) return;
  const card = gridCards.get(gridMoveModeSessionId);
  if (card) card.classList.remove('move-mode');
  gridMoveModeSessionId = null;
  gridInteracting = false;
  if (announce) announceGrid('Move mode off.');
}

// Reorder the card one slot within its container, then persist. moveIndex owns
// the step + edge semantics (grid-layout.js); this only moves the node.
function gridMoveModeReorder(card, direction) {
  const sibs = gridCardSiblings(card);
  const idx = sibs.indexOf(card);
  if (idx === -1) return false;
  const next = moveIndex(idx, sibs.length, direction);
  if (next === null) return false;
  const container = card.parentElement;
  // Moving forward: insert after the neighbour we're passing. Backward: before it.
  container.insertBefore(card, next > idx ? sibs[next].nextSibling : sibs[next]);
  persistGridOrder();
  return true;
}

// Grow/shrink the card by one track. applyCardSnap re-clamps to the container's
// real column count, persists, and re-fits the terminal.
function gridMoveModeResize(sessionId, card, direction) {
  const maxCols = getContainerColumnCount(card.parentElement);
  const span = resizeSpan(
    { cols: Number(card.dataset.colSpan) || 1, rows: Number(card.dataset.rowSpan) || 1 },
    direction,
    maxCols,
  );
  applyCardSnap(sessionId, span.cols, span.rows);
}

// The gate xterm and the document listener both consult: true for the activation
// shortcut, and for the mode's own keys while it runs. Returning true here keeps
// the key away from the PTY.
function isGridMoveModeKey(e) {
  if (matchShortcut('gridMoveMode', e, isMac, appShortcuts)) return true;
  return isGridMoveModeActive() && isMoveModeChord(e, isMac);
}

// Acts on the event. Returns true when consumed (caller should stop).
function handleGridMoveModeKey(e) {
  if (matchShortcut('gridMoveMode', e, isMac, appShortcuts)) {
    e.preventDefault();
    if (e.type !== 'keydown') return true;
    if (isGridMoveModeActive()) { exitGridMoveMode({ announce: true }); return true; }
    if (!gridViewActive) return true;
    const sessionId = gridFocusedSessionId || activeSessionId;
    if (sessionId) enterGridMoveMode(sessionId);
    return true;
  }

  if (!isGridMoveModeActive() || !isMoveModeChord(e, isMac)) return false;
  e.preventDefault();
  if (e.type !== 'keydown') return true;

  if (e.key === 'Escape' || e.key === 'Enter') {
    exitGridMoveMode({ announce: true });
    return true;
  }

  const sessionId = gridMoveModeSessionId;
  const card = gridCards.get(sessionId);
  if (!card) { exitGridMoveMode(); return true; }
  const direction = MOVE_MODE_DIRECTIONS[e.key];

  if (e.shiftKey) {
    gridMoveModeResize(sessionId, card, direction);
    announceGrid(gridCardSpanLabel(card));
    return true;
  }

  if (!gridMoveModeReorder(card, direction)) {
    const { index, total } = gridMoveModePosition(card);
    announceGrid(`Edge of grid. Card ${index + 1} of ${total}.`);
    return true;
  }
  const { index, total } = gridMoveModePosition(card);
  announceGrid(`Card ${index + 1} of ${total}.`);
  return true;
}

