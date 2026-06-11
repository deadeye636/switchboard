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
let gridGroupFilter = localStorage.getItem('gridGroupFilter') || 'all'; // 'all' | 'ungrouped' | groupId
// True while a drag-reorder or resize gesture is in progress. Status ticks must
// not tear down and rebuild the grid mid-gesture (it would detach the card the
// user is holding), so refreshGridView() bails out while this is set.
let gridInteracting = false;

// Flexible grid layout (spec 08): per-session { order, colSpan, rowSpan } map,
// persisted in localStorage like gridViewActive/gridStatusFilter.
let gridLayout = loadGridLayout();
const gridFitTimers = new Map(); // sessionId → debounce timer for fitAndScroll

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

function gridReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Debounce xterm reflow so a card only re-fits once a resize drag settles.
function debouncedFit(sessionId) {
  const existing = gridFitTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  gridFitTimers.set(sessionId, setTimeout(() => {
    gridFitTimers.delete(sessionId);
    const entry = openSessions.get(sessionId);
    if (entry) fitAndScroll(entry);
  }, 90));
}

function getGridRuntimeState() {
  return {
    activePtyIds,
    attentionSessions,
    responseReadySessions,
    sessionBusyState,
    openSessions,
    lastActivityTime,
    activeSessionId,
  };
}

function getGridOpenSessions() {
  const sessions = [];
  for (const [sid, entry] of openSessions) {
    if (entry.closed) continue;
    const session = sessionMap.get(sid) || entry.session;
    if (session) sessions.push(session);
  }
  return sessions;
}

function getGridGroupForSession(sessionId) {
  if (typeof getGroupForSession !== 'function' || typeof groupsState === 'undefined') return null;
  return getGroupForSession(groupsState, sessionId);
}

function getGridAllowedSessionIds() {
  let filtered = getFilteredSessionsByStatus(getGridOpenSessions(), getGridRuntimeState(), gridStatusFilter);
  if (gridGroupFilter && gridGroupFilter !== 'all') {
    filtered = filtered.filter(session => {
      const group = getGridGroupForSession(session.sessionId);
      if (gridGroupFilter === 'ungrouped') return !group;
      return group && group.id === gridGroupFilter;
    });
  }
  return new Set(filtered.map(session => session.sessionId));
}

function renderGridStatusFilters() {
  const container = document.getElementById('grid-status-filters');
  if (!container) return;

  const counts = getStatusCounts(getGridOpenSessions(), getGridRuntimeState());
  const filters = [
    ['all', 'All', counts.all],
    ['attention', 'Needs You', counts.attention],
    ['ready', 'Ready', counts.ready],
    ['active', 'Running', counts.active],
  ];

  container.innerHTML = '';
  for (const [key, label, count] of filters) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grid-status-filter' + (gridStatusFilter === key ? ' active' : '');
    btn.dataset.filter = key;
    btn.textContent = `${label} ${count}`;
    btn.disabled = key !== 'all' && count === 0;
    btn.addEventListener('click', () => {
      gridStatusFilter = key;
      localStorage.setItem('gridStatusFilter', gridStatusFilter);
      showGridView();
    });
    container.appendChild(btn);
  }

  renderGridGroupFilters(container);
}

// --- Bulk actions (Spec 06) ---
// Keep this block self-contained so it integrates cleanly alongside Spec 07's
// header (group filter) edits.

function gridSessionLabel(sessionId) {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);
  return cleanDisplayName(session && (session.name || session.aiTitle || session.summary)) || sessionId;
}

function gridSessionProject(sessionId) {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);
  if (!session || !session.projectPath) return '';
  return session.projectPath.split('/').filter(Boolean).slice(-2).join('/');
}

function renderGridBulkActions() {
  const container = document.getElementById('grid-bulk-actions');
  if (!container) return;

  const targets = bulkTargets(getGridOpenSessions(), getGridRuntimeState(), gridStatusFilter);
  container.innerHTML = '';

  const stepBtn = document.createElement('button');
  stepBtn.type = 'button';
  stepBtn.className = 'grid-bulk-btn';
  stepBtn.innerHTML = '<span class="grid-bulk-icon" aria-hidden="true">▶</span> Step';
  stepBtn.title = 'Focus the next session needing attention';
  stepBtn.disabled = targets.queue.length === 0;
  stepBtn.addEventListener('click', () => stepThroughQueue(targets.queue));
  container.appendChild(stepBtn);

  const seenBtn = document.createElement('button');
  seenBtn.type = 'button';
  seenBtn.className = 'grid-bulk-btn';
  seenBtn.textContent = `Mark ${targets.readyToClear.length} ready seen`;
  seenBtn.title = 'Clear the unread "ready" flag for every ready session in view';
  seenBtn.disabled = targets.readyToClear.length === 0;
  seenBtn.addEventListener('click', () => markAllReadySeen(targets.readyToClear));
  container.appendChild(seenBtn);

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'grid-bulk-btn grid-bulk-btn-danger';
  stopBtn.textContent = `Stop ${targets.runningToStop.length} running`;
  stopBtn.title = 'Stop every running session in view (asks for confirmation)';
  stopBtn.disabled = targets.runningToStop.length === 0;
  stopBtn.addEventListener('click', () => stopAllRunning(targets.runningToStop));
  container.appendChild(stopBtn);

  // Collapse/expand-all-groups toggle lives at the right end of the bulk bar.
  // It's region-scoped, so updateGridCollapseAllBtn() hides it when the grid
  // isn't grouped and flips its icon/label based on collapse state.
  const collapseAllBtn = document.createElement('button');
  collapseAllBtn.type = 'button';
  collapseAllBtn.id = 'grid-collapse-all-btn';
  collapseAllBtn.title = 'Collapse all groups';
  collapseAllBtn.addEventListener('click', toggleGridCollapseAll);
  container.appendChild(collapseAllBtn);
  updateGridCollapseAllBtn();
}

// Step ▶ — focus the next attention/ready session relative to the focused card,
// wrapping around. Pure traversal, no confirmation.
function stepThroughQueue(queue) {
  if (!queue || queue.length === 0) return;
  const currentIdx = queue.indexOf(gridFocusedSessionId);
  const next = queue[(currentIdx + 1) % queue.length];
  if (next) focusGridCard(next);
}

// Mark N ready seen — clear the unread flag for each ready session, with an
// Undo toast that re-adds them to responseReadySessions.
function markAllReadySeen(readyToClear) {
  if (!readyToClear || readyToClear.length === 0) return;
  const cleared = readyToClear.slice();
  for (const sid of cleared) clearUnread(sid);
  if (gridViewActive) showGridView();

  const count = cleared.length;
  showControlToast({
    message: `Marked ${count} ready session${count !== 1 ? 's' : ''} as seen`,
    actionLabel: 'Undo',
    onAction: () => {
      for (const sid of cleared) {
        if (activePtyIds.has(sid)) responseReadySessions.add(sid);
      }
      refreshSessionStatusViews();
    },
  });
}

// Stop N running — destructive. Always confirm with counts + names before
// terminating anything; cancel does nothing.
async function stopAllRunning(runningToStop) {
  if (!runningToStop || runningToStop.length === 0) return;
  const ids = runningToStop.slice();
  const count = ids.length;
  const details = ids.map(sid => ({ label: gridSessionLabel(sid), value: gridSessionProject(sid) || '—' }));

  const confirmed = await showControlDialog({
    title: `Stop ${count} running session${count !== 1 ? 's' : ''}?`,
    message: 'This terminates the running process for each session below. Their history stays available in the sidebar.',
    confirmLabel: `Stop ${count} session${count !== 1 ? 's' : ''}`,
    tone: 'danger',
    details,
  });
  if (!confirmed) return;

  for (const sid of ids) {
    await window.api.stopSession(sid);
    recordTimelineEvent(sid, 'stopped', 'Session stopped', 'Stopped via grid bulk action.');
    activePtyIds.delete(sid);
  }
  refreshSidebar();
  if (gridViewActive) showGridView();
}

// Group filter segment (spec 07): a divider plus an "All groups" / per-group /
// "Ungrouped" control rendered alongside the status filters.
function renderGridGroupFilters(container) {
  if (typeof groupsState === 'undefined' || !groupsState.groups || groupsState.groups.length === 0) {
    return;
  }

  const openSessionList = getGridOpenSessions();
  const groupCounts = new Map();
  let ungroupedCount = 0;
  for (const session of openSessionList) {
    const group = getGridGroupForSession(session.sessionId);
    if (group) groupCounts.set(group.id, (groupCounts.get(group.id) || 0) + 1);
    else ungroupedCount++;
  }

  const divider = document.createElement('span');
  divider.className = 'grid-filter-divider';
  divider.setAttribute('aria-hidden', 'true');
  container.appendChild(divider);

  const options = [['all', 'All groups', openSessionList.length]];
  for (const group of [...groupsState.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    options.push([group.id, group.name, groupCounts.get(group.id) || 0, group.color]);
  }
  if (ungroupedCount > 0) options.push(['ungrouped', 'Ungrouped', ungroupedCount]);

  for (const [key, label, count, color] of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grid-group-filter' + (gridGroupFilter === key ? ' active' : '');
    btn.dataset.group = key;
    if (color) {
      const dot = document.createElement('span');
      dot.className = 'grid-group-filter-dot';
      dot.style.background = color;
      btn.appendChild(dot);
    }
    const text = document.createElement('span');
    text.textContent = `${label} ${count}`;
    btn.appendChild(text);
    btn.disabled = key !== 'all' && count === 0;
    btn.addEventListener('click', () => {
      gridGroupFilter = key;
      localStorage.setItem('gridGroupFilter', gridGroupFilter);
      showGridView();
    });
    container.appendChild(btn);
  }
}

// Collapse state for grid group regions persists across renders/restart via
// localStorage, keyed by group id ('ungrouped' for the ungrouped pool) — mirrors
// the sidebar user-group collapse (collapsedGroups) and gridGroupFilter.
function getCollapsedGridGroups() {
  try { return new Set(JSON.parse(localStorage.getItem('collapsedGridGroups') || '[]')); } catch { return new Set(); }
}
function saveCollapsedGridGroups(set) {
  try { localStorage.setItem('collapsedGridGroups', JSON.stringify([...set])); } catch { /* storage unavailable */ }
}
function gridRegionCollapseKey(group) {
  return group ? group.id : 'ungrouped';
}

// Toggle a grid region's collapsed state, persist it, keep aria-expanded in sync,
// and re-fit the revealed terminals on expand (hidden terminals can't be sized).
function toggleGridRegionCollapse(region) {
  if (!region) return;
  const key = region.dataset.collapseKey;
  const willCollapse = !region.classList.contains('collapsed');
  region.classList.toggle('collapsed', willCollapse);
  const btn = region.querySelector('.grid-region-expand');
  if (btn) btn.setAttribute('aria-expanded', String(!willCollapse));
  const set = getCollapsedGridGroups();
  if (willCollapse) set.add(key); else set.delete(key);
  saveCollapsedGridGroups(set);
  if (!willCollapse) {
    for (const cardEl of region.querySelectorAll('.grid-card')) {
      const entry = openSessions.get(cardEl.dataset.sessionId);
      if (entry) fitAndScroll(entry);
    }
  }
  updateGridCollapseAllBtn();
}

// Reflect the current grid-region collapse state on the header's collapse-all
// button: hidden when there are no regions (flat grid), and its icon/label flip
// to "Expand all" once every region is collapsed.
function updateGridCollapseAllBtn() {
  const btn = document.getElementById('grid-collapse-all-btn');
  if (!btn) return;
  const regions = terminalsEl.querySelectorAll('.grid-region');
  if (regions.length === 0) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  const allCollapsed = [...regions].every(r => r.classList.contains('collapsed'));
  btn.classList.toggle('all-collapsed', allCollapsed);
  btn.title = allCollapsed ? 'Expand all groups' : 'Collapse all groups';
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = allCollapsed
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 5 12 11 18 5"/><polyline points="6 13 12 19 18 13"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 11 12 5 18 11"/><polyline points="6 19 12 13 18 19"/></svg>';
}

// Collapse every grid region at once, or expand them all when already fully
// collapsed. Persists via the shared collapsedGridGroups set and re-fits any
// terminals revealed by expanding (hidden terminals can't be measured).
function toggleGridCollapseAll() {
  const regions = [...terminalsEl.querySelectorAll('.grid-region')];
  if (regions.length === 0) return;
  const collapse = regions.some(r => !r.classList.contains('collapsed'));
  const set = getCollapsedGridGroups();
  for (const region of regions) {
    region.classList.toggle('collapsed', collapse);
    const expandBtn = region.querySelector('.grid-region-expand');
    if (expandBtn) expandBtn.setAttribute('aria-expanded', String(!collapse));
    const key = region.dataset.collapseKey;
    if (key) { if (collapse) set.add(key); else set.delete(key); }
  }
  saveCollapsedGridGroups(set);
  if (!collapse) {
    for (const cardEl of terminalsEl.querySelectorAll('.grid-region .grid-card')) {
      const entry = openSessions.get(cardEl.dataset.sessionId);
      if (entry) fitAndScroll(entry);
    }
  }
  updateGridCollapseAllBtn();
}

// Build a labeled grid region for a group (or the ungrouped pool). Appends the
// region to #terminals and returns its inner cards container.
function buildGridRegion(group, sessions) {
  const counts = getStatusCounts(sessions, getGridRuntimeState());

  const region = document.createElement('div');
  region.className = 'grid-region' + (group ? '' : ' ungrouped');
  region.dataset.groupId = group ? group.id : '';
  const collapseKey = gridRegionCollapseKey(group);
  region.dataset.collapseKey = collapseKey;
  const collapsed = getCollapsedGridGroups().has(collapseKey);
  if (collapsed) region.classList.add('collapsed');
  if (group) region.style.setProperty('--user-group-color', group.color);

  const header = document.createElement('div');
  header.className = 'grid-region-header';

  const regionLabel = group ? group.name : 'Ungrouped';
  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'grid-region-expand';
  expand.setAttribute('aria-expanded', String(!collapsed));
  expand.setAttribute('aria-label', `Toggle ${regionLabel} region`);
  expand.innerHTML = '<span class="arrow" aria-hidden="true">&#9654;</span>';
  header.appendChild(expand);

  // Click anywhere on the header (or keyboard-activate the caret button) to
  // collapse/expand the region.
  header.addEventListener('click', () => toggleGridRegionCollapse(region));

  const dot = document.createElement('span');
  dot.className = 'grid-region-dot';
  header.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'grid-region-name';
  name.textContent = group ? group.name : 'Ungrouped';
  header.appendChild(name);

  const count = document.createElement('span');
  count.className = 'grid-region-count';
  count.textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'}`;
  header.appendChild(count);

  if (counts.attention > 0) {
    const chip = document.createElement('span');
    chip.className = 'grid-region-chip status-needs-attention';
    chip.textContent = String(counts.attention);
    chip.title = `${counts.attention} need${counts.attention === 1 ? 's' : ''} attention`;
    header.appendChild(chip);
  }
  if (counts.ready > 0) {
    const chip = document.createElement('span');
    chip.className = 'grid-region-chip status-response-ready';
    chip.textContent = String(counts.ready);
    chip.title = `${counts.ready} ready`;
    header.appendChild(chip);
  }

  // "Launch all" for real user groups (not the ungrouped pool). Opens every
  // group member — including ones not yet surfaced in the grid — via the shared
  // launchAllInGroup() path. stopPropagation so it doesn't toggle the region.
  if (group && typeof launchAllInGroup === 'function') {
    const launchBtn = document.createElement('button');
    launchBtn.type = 'button';
    launchBtn.className = 'grid-region-launch-btn';
    const memberCount = (typeof getGroupMemberSessionIds === 'function')
      ? getGroupMemberSessionIds(group.id).length
      : sessions.length;
    const launchLabel = `Launch all ${memberCount} session${memberCount === 1 ? '' : 's'} in ${group.name}`;
    launchBtn.title = launchLabel;
    launchBtn.setAttribute('aria-label', launchLabel);
    launchBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    launchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      launchAllInGroup(group.id);
    });
    header.appendChild(launchBtn);
  }

  const cardsEl = document.createElement('div');
  cardsEl.className = 'grid-region-cards';

  region.appendChild(header);
  region.appendChild(cardsEl);
  terminalsEl.appendChild(region);
  return cardsEl;
}

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
  dot.className = 'grid-card-dot';
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
  // Set initial status from the single source of truth
  updateRunningIndicators();
}

// ===== Flexible layout: resize, drag-reorder, group drop (spec 08) =====

function getContainerColumnCount(container) {
  if (!container) return 1;
  // Primary: count the resolved track list from computed style (works for the
  // flat #terminals grid). For grouped regions (.grid-region-cards) this can
  // resolve to a single track / 'none' before updateGridColumns() has applied a
  // template, which would clamp every resize to 1 column. Fall back to the same
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

// Persist the current visual order (DOM order across all regions) plus each
// card's span into the gridLayout map.
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

function clearGridDropTargets() {
  terminalsEl.querySelectorAll('.grid-card.drop-before, .grid-card.drop-after')
    .forEach(c => c.classList.remove('drop-before', 'drop-after'));
  terminalsEl.querySelectorAll('.grid-region.drop-region')
    .forEach(r => r.classList.remove('drop-region'));
}

function getGridDropInfo(card, x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const targetCard = el.closest('.grid-card');
  return {
    targetCard: targetCard && targetCard !== card ? targetCard : null,
    region: el.closest('.grid-region'),
  };
}

function updateGridDropTarget(card, x, y) {
  clearGridDropTargets();
  const info = getGridDropInfo(card, x, y);
  if (!info) return;
  // Hovering a different group region → highlight it as a reassignment target.
  if (info.region && terminalsEl.classList.contains('grid-grouped')) {
    const sourceRegion = card.closest('.grid-region');
    if (info.region !== sourceRegion) {
      info.region.classList.add('drop-region');
      return;
    }
  }
  if (info.targetCard) {
    const r = info.targetCard.getBoundingClientRect();
    const after = (x - r.left) > r.width / 2;
    info.targetCard.classList.add(after ? 'drop-after' : 'drop-before');
  }
}

// True layout box of a grid card with any in-flight FLIP transform removed, so
// insertion math stays stable while siblings are mid-animation. Hit-testing and
// getBoundingClientRect both include transforms; subtracting the live translate
// recovers the settled position and prevents the "cards jump around" feedback
// loop (where reading transformed positions kept re-moving the placeholder).
function gridCardLayoutRect(el) {
  const r = el.getBoundingClientRect();
  const t = getComputedStyle(el).transform;
  if (t && t !== 'none') {
    try {
      const m = new DOMMatrixReadOnly(t);
      return { left: r.left - m.m41, top: r.top - m.m42, width: r.width, height: r.height };
    } catch { /* fall through to raw rect */ }
  }
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

// Reading-order insertion index for the cursor among sibling layout rects: the
// count of siblings that sort before the cursor (row-major). Result is in
// [0, rects.length] and can address every slot — including the dragged card's
// origin — so the user can always return to the start position.
function cursorInsertionIndex(rects, x, y) {
  let idx = 0;
  for (const r of rects) {
    const cx = r.left + r.width / 2;
    let before;
    if (y > r.top + r.height) before = true;       // cursor in a lower row
    else if (y < r.top) before = false;            // cursor in an upper row
    else before = x > cx;                           // same row → compare to center
    if (before) idx++;
  }
  return idx;
}

// Index of the placeholder among the container's real sibling cards (excluding
// the lifted dragged card) — used to seed/dedup the live insertion index.
function placeholderSlotIndex(container, placeholder, exclude) {
  let idx = 0;
  for (const n of container.children) {
    if (n === placeholder) break;
    if (n.classList && n.classList.contains('grid-card') && n !== exclude) idx++;
  }
  return idx;
}

// FLIP-animate a container's sibling cards as the drop placeholder is moved into
// `refNode`'s slot: record visual positions, move, then invert + transition to
// identity so the surrounding tiles visibly slide to preview the new
// arrangement. Reads are batched before writes; LAST is read transform-free so
// overlapping animations continue smoothly. `exclude` is the lifted card.
function flipMovePlaceholder(container, placeholder, refNode, exclude) {
  const sibs = [...container.children].filter(
    n => n.classList && n.classList.contains('grid-card') && n !== exclude
  );
  // READ (batched): current visual rects (include any in-flight transform).
  const first = sibs.map(c => c.getBoundingClientRect());
  // WRITE: move the placeholder slot.
  container.insertBefore(placeholder, refNode);
  // READ (batched): settled post-move layout rects (transform-free).
  const last = sibs.map(c => gridCardLayoutRect(c));
  // WRITE: invert each card to its old visual spot (or settle if at rest).
  const moved = [];
  for (let i = 0; i < sibs.length; i++) {
    const c = sibs[i];
    const dx = first[i].left - last[i].left;
    const dy = first[i].top - last[i].top;
    c.style.transition = 'none';
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      c.style.transform = `translate(${dx}px, ${dy}px)`;
      moved.push(c);
    } else {
      c.style.transform = '';
    }
  }
  // PLAY: next frame, restore the CSS transition and animate to identity.
  requestAnimationFrame(() => {
    for (const c of sibs) {
      c.style.transition = '';
      if (moved.includes(c)) c.style.transform = '';
    }
  });
}

// Single shared drag system: dragging a card's header reorders it (with a live
// FLIP preview of the surrounding tiles), or — when 07's group regions are
// present — drops it into a different group (assignSession). Honors
// prefers-reduced-motion by falling back to the static drop indicators.
function startCardDrag(sessionId, card, e) {
  if (e.button !== 0) return;
  if (e.target.closest('button, .grid-card-resize-handle')) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const reduced = gridReducedMotion();
  let dragging = false;
  let placeholder = null;
  let rafId = 0;
  let lastX = startX;
  let lastY = startY;
  // The placeholder's current insertion index among the container's real
  // siblings; used to dedup FLIPs (only animate when the index actually changes).
  let currentIdx = 0;

  const beginDrag = () => {
    dragging = true;
    gridInteracting = true;
    card.classList.add('dragging');
    document.body.classList.add('grid-dragging');
    card.style.pointerEvents = 'none';
    if (reduced) return; // static-indicator path only
    card.style.zIndex = '1000';
    const startRect = card.getBoundingClientRect();
    // Placeholder holds the dragged card's slot (same span) so siblings reflow
    // around it; the real card is lifted out of grid flow to follow the cursor.
    // Both the placeholder and the lifted card are pointer-events:none so neither
    // is ever returned by hit-testing.
    placeholder = document.createElement('div');
    placeholder.className = 'grid-card-placeholder';
    placeholder.style.pointerEvents = 'none';
    placeholder.style.gridColumn = card.style.gridColumn || `span ${card.dataset.colSpan || 1}`;
    placeholder.style.gridRow = card.style.gridRow || `span ${card.dataset.rowSpan || 1}`;
    card.parentElement.insertBefore(placeholder, card);
    card.style.position = 'fixed';
    card.style.margin = '0';
    card.style.width = `${startRect.width}px`;
    card.style.height = `${startRect.height}px`;
    card.style.left = `${startRect.left}px`;
    card.style.top = `${startRect.top}px`;
    // Seed the dedup index from the placeholder's origin slot so the first
    // recompute doesn't spuriously re-flip the origin.
    currentIdx = placeholderSlotIndex(card.parentElement, placeholder, card);
  };

  // Recompute the projected insertion slot and reflect it live (throttled to one
  // pass per animation frame). Insertion is computed from transform-free
  // geometry (not elementFromPoint on animating cards) so it never oscillates,
  // and only an actual integer index change triggers a FLIP.
  const updatePreview = () => {
    rafId = 0;
    if (!dragging || !placeholder) return;
    clearGridDropTargets();
    const container = placeholder.parentElement;
    if (!container) return;
    const grouped = terminalsEl.classList.contains('grid-grouped');
    const sourceRegion = card.closest('.grid-region');

    // Hovering a different group region previews reassignment (no reorder).
    if (grouped) {
      const el = document.elementFromPoint(lastX, lastY);
      const region = el && el.closest ? el.closest('.grid-region') : null;
      if (region && region !== sourceRegion) {
        region.classList.add('drop-region');
        return;
      }
    }

    // Only reorder while the cursor is within the active container's box.
    const cRect = container.getBoundingClientRect();
    if (lastX < cRect.left || lastX > cRect.right || lastY < cRect.top || lastY > cRect.bottom) return;

    const sibs = [...container.children].filter(
      n => n.classList && n.classList.contains('grid-card') && n !== card && n !== placeholder
    );
    const rects = sibs.map(gridCardLayoutRect);
    const idx = Math.max(0, Math.min(cursorInsertionIndex(rects, lastX, lastY), sibs.length));
    if (idx === currentIdx) return; // slot unchanged — skip the FLIP (no flip-flop)
    currentIdx = idx;
    flipMovePlaceholder(container, placeholder, sibs[idx] || null, card);
  };

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragging) {
      if (Math.hypot(dx, dy) < 6) return;
      beginDrag();
    }
    lastX = ev.clientX;
    lastY = ev.clientY;
    if (reduced) {
      updateGridDropTarget(card, ev.clientX, ev.clientY);
      return;
    }
    card.style.transform = `translate(${dx}px, ${dy}px)`;
    if (!rafId) rafId = requestAnimationFrame(updatePreview);
  };

  const endDrag = () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    card.classList.remove('dragging');
    document.body.classList.remove('grid-dragging');
    card.style.pointerEvents = '';
    card.style.transform = '';
    card.style.zIndex = '';
    card.style.position = '';
    card.style.left = '';
    card.style.top = '';
    card.style.width = '';
    card.style.height = '';
    card.style.margin = '';
    if (placeholder && placeholder.parentElement) placeholder.remove();
    placeholder = null;
    clearGridDropTargets();
    // Drop any lingering FLIP transforms so nothing is left mid-animation.
    for (const c of terminalsEl.querySelectorAll('.grid-card')) {
      c.style.transition = '';
      c.style.transform = '';
    }
  };

  const onUp = (ev) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (dragging) {
      commitCardDrag(sessionId, card, placeholder, reduced, ev.clientX, ev.clientY);
      endDrag();
      gridInteracting = false;
    }
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

// Commit a finished drag: reassign across group regions, or land the card in the
// previewed slot (the placeholder position). Falls back to the original
// before/after reorder when reduced-motion left no placeholder.
function commitCardDrag(sessionId, card, placeholder, reduced, x, y) {
  const info = getGridDropInfo(card, x, y);

  // Drop into a different group region → reassign via 07's groups-model.
  if (info && info.region && terminalsEl.classList.contains('grid-grouped')) {
    const sourceRegion = card.closest('.grid-region');
    if (info.region !== sourceRegion) {
      const targetGroupId = info.region.dataset.groupId || null;
      if (typeof assignSessionToGroup === 'function') {
        assignSessionToGroup(sessionId, targetGroupId); // persists + re-renders grid
      }
      return;
    }
  }

  // Live-preview path: land the card exactly where the placeholder previewed.
  if (!reduced && placeholder && placeholder.parentElement) {
    placeholder.parentElement.insertBefore(card, placeholder);
    persistGridOrder();
    debouncedFit(sessionId);
    return;
  }

  // Reduced-motion fallback: original before/after reorder within the container.
  if (info && info.targetCard && info.targetCard.parentElement === card.parentElement) {
    const container = card.parentElement;
    const r = info.targetCard.getBoundingClientRect();
    const after = (x - r.left) > r.width / 2;
    const ids = [...container.querySelectorAll('.grid-card')].map(c => c.dataset.sessionId);
    const targetId = info.targetCard.dataset.sessionId;
    let newIds = reorder(ids, sessionId, targetId);
    if (after) {
      newIds = ids.filter(id => id !== sessionId);
      newIds.splice(newIds.indexOf(targetId) + 1, 0, sessionId);
    }
    for (const id of newIds) {
      const c = gridCards.get(id);
      if (c) container.appendChild(c);
    }
    persistGridOrder();
    debouncedFit(sessionId);
  }
}

// Corner-handle resize: snap to whole column/row spans, debounce the terminal fit.
function startCardResize(sessionId, card, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  // Capture the pointer on the handle so drag events keep flowing even when the
  // cursor passes over the card's xterm canvas (which would otherwise swallow
  // them), making the corner resize reliable.
  const handle = e.currentTarget;
  if (handle && typeof handle.setPointerCapture === 'function') {
    try { handle.setPointerCapture(e.pointerId); } catch { /* capture best-effort */ }
  }
  const container = card.parentElement;
  const startRect = card.getBoundingClientRect();
  const startColSpan = Math.max(1, Number(card.dataset.colSpan) || 1);
  const startRowSpan = Math.max(1, Number(card.dataset.rowSpan) || 1);
  const colUnit = (startRect.width + GRID_GAP) / startColSpan;
  const rowUnit = (startRect.height + GRID_GAP) / startRowSpan;
  const maxCols = getContainerColumnCount(container);
  card.classList.add('resizing');
  document.body.classList.add('grid-dragging');
  gridInteracting = true;

  const onMove = (ev) => {
    const dx = ev.clientX - e.clientX;
    const dy = ev.clientY - e.clientY;
    const rawCols = Math.round((startRect.width + dx + GRID_GAP) / colUnit);
    const rawRows = Math.round((startRect.height + dy + GRID_GAP) / rowUnit);
    const span = normalizeSpan({ cols: rawCols, rows: rawRows }, maxCols);
    if (Number(card.dataset.colSpan) === span.cols && Number(card.dataset.rowSpan) === span.rows) return;
    writeCardSpan(sessionId, card, span);
    debouncedFit(sessionId);
  };

  const onUp = (ev) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (handle && typeof handle.releasePointerCapture === 'function') {
      try { handle.releasePointerCapture(ev.pointerId); } catch { /* best-effort */ }
    }
    card.classList.remove('resizing');
    document.body.classList.remove('grid-dragging');
    gridInteracting = false;
    persistGridOrder();
    updateGridColumns();
    const entry = openSessions.get(sessionId);
    if (entry) fitAndScroll(entry);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

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
  writeCardSpan(sessionId, card, span);
  saveGridLayout();
  updateGridColumns();
  const entry = openSessions.get(sessionId);
  if (entry) fitAndScroll(entry);
}

let snapPopoverEl = null;
// True when the open popover was opened by hover (auto-closes on pointer-out);
// click-opened popovers keep their click-away / Esc semantics instead.
let snapPopoverHoverOpened = false;
let snapHoverOpenTimer = null;
let snapHoverCloseTimer = null;
// Intent delay before a hover opens the popover; small grace before it closes so
// the pointer can travel from the button into the popover without it vanishing.
const SNAP_HOVER_OPEN_DELAY = 300;
const SNAP_HOVER_CLOSE_DELAY = 180;

// Hover-open only makes sense for fine/hover-capable pointers — never on touch.
function snapHoverEnabled() {
  return typeof window.matchMedia === 'function' &&
    (window.matchMedia('(hover: hover)').matches || window.matchMedia('(pointer: fine)').matches);
}

function clearSnapHoverTimers() {
  if (snapHoverOpenTimer) { clearTimeout(snapHoverOpenTimer); snapHoverOpenTimer = null; }
  if (snapHoverCloseTimer) { clearTimeout(snapHoverCloseTimer); snapHoverCloseTimer = null; }
}

function closeSnapLayoutPopover() {
  clearSnapHoverTimers();
  snapPopoverHoverOpened = false;
  if (snapPopoverEl) {
    snapPopoverEl.remove();
    snapPopoverEl = null;
    document.removeEventListener('pointerdown', onSnapPopoverOutside, true);
    document.removeEventListener('keydown', onSnapPopoverKey, true);
  }
}
function onSnapPopoverOutside(e) {
  if (snapPopoverEl && !snapPopoverEl.contains(e.target) && !e.target.closest('.grid-card-snap-btn')) {
    closeSnapLayoutPopover();
  }
}
function onSnapPopoverKey(e) {
  if (e.key === 'Escape') closeSnapLayoutPopover();
}

// Schedule a hover-open after the intent delay. Cancels any pending close (the
// pointer re-entered the hover region) and no-ops if this card's popover already
// shows. Opening replaces any other card's popover.
function scheduleSnapHoverOpen(sessionId, card, anchor) {
  if (!snapHoverEnabled()) return;
  if (snapHoverCloseTimer) { clearTimeout(snapHoverCloseTimer); snapHoverCloseTimer = null; }
  if (snapPopoverEl && snapPopoverEl.dataset.sessionId === sessionId) return;
  if (snapHoverOpenTimer) clearTimeout(snapHoverOpenTimer);
  snapHoverOpenTimer = setTimeout(() => {
    snapHoverOpenTimer = null;
    openSnapLayoutPopover(sessionId, card, anchor, { hover: true });
  }, SNAP_HOVER_OPEN_DELAY);
}

// Schedule a hover-close after the grace delay. Cancels a pending open, and only
// closes popovers that were opened by hover (click-opened ones persist).
function scheduleSnapHoverClose() {
  if (snapHoverOpenTimer) { clearTimeout(snapHoverOpenTimer); snapHoverOpenTimer = null; }
  if (!snapPopoverHoverOpened) return;
  if (snapHoverCloseTimer) clearTimeout(snapHoverCloseTimer);
  snapHoverCloseTimer = setTimeout(() => {
    snapHoverCloseTimer = null;
    closeSnapLayoutPopover();
  }, SNAP_HOVER_CLOSE_DELAY);
}

// Click-toggle entry point: close if this card's popover is already open,
// otherwise open it (click-opened popovers persist until click-away / Esc /
// selecting a preset).
function toggleSnapLayoutPopover(sessionId, card, anchor) {
  clearSnapHoverTimers();
  if (snapPopoverEl && snapPopoverEl.dataset.sessionId === sessionId) {
    closeSnapLayoutPopover();
    return;
  }
  openSnapLayoutPopover(sessionId, card, anchor, { hover: false });
}

// Windows 11-style snap layouts: a popover of preset size tiles. Each tile is a
// miniature of the resulting span; clicking snaps the card to that size. Opening
// always replaces any other open popover. When `hover` is true the popover
// auto-closes shortly after the pointer leaves the button+popover hover region.
function openSnapLayoutPopover(sessionId, card, anchor, { hover = false } = {}) {
  closeSnapLayoutPopover();

  const maxCols = Math.max(1, getContainerColumnCount(card.parentElement));
  // Presets clamped to what currently fits: single, wide, tall, large, full-width.
  const presets = [
    { cols: 1, rows: 1, label: 'Single' },
    { cols: 2, rows: 1, label: 'Wide' },
    { cols: 1, rows: 2, label: 'Tall' },
    { cols: 2, rows: 2, label: 'Large' },
    { cols: maxCols, rows: 1, label: 'Full width' },
  ];
  const seen = new Set();
  const usable = presets
    .map(p => ({ ...p, cols: Math.min(p.cols, maxCols) }))
    .filter(p => {
      const key = `${p.cols}x${p.rows}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const pop = document.createElement('div');
  pop.className = 'snap-layout-popover';
  pop.dataset.sessionId = sessionId;
  const curCols = Number(card.dataset.colSpan) || 1;
  const curRows = Number(card.dataset.rowSpan) || 1;

  for (const preset of usable) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'snap-tile';
    if (preset.cols === curCols && preset.rows === curRows) tile.classList.add('active');
    tile.title = `${preset.label} (${preset.cols}×${preset.rows})`;
    const mini = document.createElement('span');
    mini.className = 'snap-tile-mini';
    mini.style.gridTemplateColumns = `repeat(${Math.min(preset.cols, 3)}, 1fr)`;
    mini.style.gridTemplateRows = `repeat(${preset.rows}, 1fr)`;
    const cell = document.createElement('span');
    cell.className = 'snap-tile-cell';
    cell.style.gridColumn = `span ${Math.min(preset.cols, 3)}`;
    cell.style.gridRow = `span ${preset.rows}`;
    mini.appendChild(cell);
    tile.appendChild(mini);
    const label = document.createElement('span');
    label.className = 'snap-tile-label';
    label.textContent = preset.label;
    tile.appendChild(label);
    tile.addEventListener('click', (e) => {
      e.stopPropagation();
      applyCardSnap(sessionId, preset.cols, preset.rows);
      closeSnapLayoutPopover();
    });
    pop.appendChild(tile);
  }

  // Treat the popover as part of the hover region: entering cancels a pending
  // close, leaving schedules one (only effective for hover-opened popovers).
  pop.addEventListener('mouseenter', () => {
    if (snapHoverCloseTimer) { clearTimeout(snapHoverCloseTimer); snapHoverCloseTimer = null; }
  });
  pop.addEventListener('mouseleave', () => scheduleSnapHoverClose());

  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.round(r.bottom + 6)}px`;
  // Keep within the viewport's right edge.
  const left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8);
  pop.style.left = `${Math.round(Math.max(8, left))}px`;
  snapPopoverEl = pop;
  snapPopoverHoverOpened = hover;
  document.addEventListener('pointerdown', onSnapPopoverOutside, true);
  document.addEventListener('keydown', onSnapPopoverKey, true);
}

function resetGridLayout() {
  gridLayout = {};
  saveGridLayout();
  closeSnapLayoutPopover();
  if (gridViewActive) showGridView();
}

function unwrapGridCards() {
  for (const [sid, card] of gridCards) {
    const entry = openSessions.get(sid);
    if (entry) {
      entry.element.classList.remove('grid-mode', 'visible');
      // Move terminal container back to #terminals (out of card/region)
      terminalsEl.appendChild(entry.element);
    }
    card.remove();
  }
  gridCards.clear();
  // Remove any group region containers and reset grouped layout
  terminalsEl.querySelectorAll('.grid-region').forEach(el => el.remove());
  terminalsEl.classList.remove('grid-grouped');
}

function focusGridCard(sessionId, { reveal = true } = {}) {
  gridFocusedSessionId = sessionId;
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
    // An explicit focus (click/keyboard nav/step/inbox) should reveal the card
    // if its group region is collapsed. The passive end-of-render focus passes
    // reveal:false so it doesn't fight the user's persisted collapse state.
    if (reveal) {
      const region = card.closest('.grid-region.collapsed');
      if (region) toggleGridRegionCollapse(region);
    }
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

// Decide whether the grid must be fully rebuilt (membership or group placement
// changed) versus just updated in place. Card ORDER and spans are intentionally
// not treated as rebuild triggers — they're owned by the user's drag/resize and
// must survive status ticks.
function gridNeedsRebuild() {
  const desired = gridDesiredSids();
  if (desired.length !== gridCards.size) return true;
  for (const sid of desired) {
    const card = gridCards.get(sid);
    if (!card) return true;
    const group = getGridGroupForSession(sid);
    const region = card.closest('.grid-region');
    const renderedGroupId = region ? (region.dataset.groupId || '') : '';
    if ((group ? group.id : '') !== renderedGroupId) return true;
  }
  return false;
}

// Refresh the grid in response to a status tick. Never rebuilds mid-gesture;
// otherwise updates card status/dots/chips in place and only does a full
// rebuild when the rendered session set or grouping actually changed.
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
  updateGridRegionCounts();
}

// Update each rendered grid card's status/health visuals in place — no teardown,
// so layout (order + spans) and any in-progress gesture are preserved. Shared by
// refreshGridView() and updateRunningIndicators().
function updateGridCardStatuses() {
  for (const [sid, card] of gridCards) {
    const session = sessionMap.get(sid) || openSessions.get(sid)?.session;
    if (!session) continue;
    const status = getSessionStatus(session, getGridRuntimeState());
    const health = getSessionHealth(session);
    const running = status.key === 'running' || status.key === 'busy'
      || status.key === 'needs-attention' || status.key === 'response-ready';
    // Keep the card title in sync with the live session metadata (user renames,
    // AI titles, /title). Title updates arrive via loadProjects() without a full
    // grid rebuild, so refresh the name in place here rather than leaving it stale.
    const name = card.querySelector('.grid-card-name');
    if (name) {
      const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary) || sid;
      if (name.textContent !== displayName) name.textContent = displayName;
    }
    const dot = card.querySelector('.grid-card-dot');
    if (dot) dot.className = 'grid-card-dot ' + (status.key === 'busy' ? 'busy' : (running ? 'running' : 'stopped'));
    card.classList.remove('status-needs-attention', 'status-response-ready', 'status-busy', 'status-running', 'status-exited', 'status-idle', 'health-healthy', 'health-growing', 'health-marathon-risk', 'health-handoff-recommended');
    card.classList.add(status.className, health.className);
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
    if (stopBtn) stopBtn.style.display = running ? '' : 'none';
  }
}

// Recompute the rolled-up attention/ready chips on each group region header
// without rebuilding the regions.
function updateGridRegionCounts() {
  for (const region of terminalsEl.querySelectorAll('.grid-region')) {
    const sids = [...region.querySelectorAll('.grid-card')].map(c => c.dataset.sessionId);
    const sessions = sids.map(sid => sessionMap.get(sid) || openSessions.get(sid)?.session).filter(Boolean);
    const counts = getStatusCounts(sessions, getGridRuntimeState());
    const setChip = (cls, value, label) => {
      let chip = region.querySelector(`.grid-region-chip.${cls}`);
      if (value > 0) {
        if (!chip) {
          chip = document.createElement('span');
          chip.className = `grid-region-chip ${cls}`;
          const countEl = region.querySelector('.grid-region-count');
          if (countEl) countEl.after(chip); else region.querySelector('.grid-region-header')?.appendChild(chip);
        }
        chip.textContent = String(value);
        chip.title = label(value);
      } else if (chip) {
        chip.remove();
      }
    };
    setChip('status-needs-attention', counts.attention, (n) => `${n} need${n === 1 ? 's' : ''} attention`);
    setChip('status-response-ready', counts.ready, (n) => `${n} ready`);
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
    gridStatusFilter = 'all';
    localStorage.setItem('gridStatusFilter', gridStatusFilter);
    allowedSet = getGridAllowedSessionIds();
    renderGridStatusFilters();
  }
  if (gridGroupFilter !== 'all' && allowedSet.size === 0) {
    gridGroupFilter = 'all';
    localStorage.setItem('gridGroupFilter', gridGroupFilter);
    allowedSet = getGridAllowedSessionIds();
    renderGridStatusFilters();
    renderGridBulkActions();
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

  // Partition into user-group buckets (preserving sidebar order). When any
  // open session belongs to a group, render bounded labeled regions; otherwise
  // fall back to the flat grid to preserve the original layout.
  const sessionFor = (sid) => sessionMap.get(sid) || openSessions.get(sid)?.session;
  const groupBuckets = new Map();
  const ungroupedSids = [];
  for (const sid of orderedSids) {
    const group = getGridGroupForSession(sid);
    if (group) {
      if (!groupBuckets.has(group.id)) groupBuckets.set(group.id, []);
      groupBuckets.get(group.id).push(sid);
    } else {
      ungroupedSids.push(sid);
    }
  }

  // Apply persisted order + spans (spec 08) within each container.
  const gridWidth = terminalsEl.clientWidth;
  const sessionIds = [];
  const renderBucket = (sids, cardsEl) => {
    const cols = calculateGridColumnCount({ width: gridWidth, cardCount: sids.length });
    for (const item of applyLayout(sids, gridLayout, cols)) {
      wrapInGridCard(item.sessionId, cardsEl, item);
      sessionIds.push(item.sessionId);
    }
  };

  if (groupBuckets.size > 0) {
    terminalsEl.classList.add('grid-grouped');
    const orderedGroups = [...groupsState.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const group of orderedGroups) {
      const bucket = groupBuckets.get(group.id);
      if (!bucket || bucket.length === 0) continue;
      const cardsEl = buildGridRegion(group, bucket.map(sessionFor).filter(Boolean));
      renderBucket(bucket, cardsEl);
    }
    if (ungroupedSids.length > 0) {
      const cardsEl = buildGridRegion(null, ungroupedSids.map(sessionFor).filter(Boolean));
      renderBucket(ungroupedSids, cardsEl);
    }
  } else {
    renderBucket(orderedSids, terminalsEl);
  }

  // Show grid header bar with session count
  gridViewer.style.display = 'block';
  gridViewerCount.textContent = sessionIds.length + ' session' + (sessionIds.length !== 1 ? 's' : '');
  updateGridCollapseAllBtn();

  const btn = document.getElementById('grid-toggle-btn');
  if (btn) {
    btn.classList.add('active');
    btn.title = 'Exit session overview';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('data-tooltip', btn.title);
  }

  updateGridColumns();

  // Fit all terminals after layout resolves (skip cards hidden in a collapsed
  // region — a display:none terminal can't be measured/fit).
  for (const sid of sessionIds) {
    const entry = openSessions.get(sid);
    if (!entry) continue;
    const card = gridCards.get(sid);
    if (card && card.closest('.grid-region.collapsed')) continue;
    fitAndScroll(entry);
  }
  // Focus active or first (deferred so fitAndScroll's rAF runs first). This
  // passive focus must not auto-expand a collapsed region the user persisted.
  requestAnimationFrame(() => {
    const toFocus = activeSessionId && sessionIds.includes(activeSessionId) ? activeSessionId : sessionIds[0];
    if (toFocus) focusGridCard(toFocus, { reveal: false });
  });
}

function updateGridColumns() {
  if (!gridViewActive) return;
  const width = terminalsEl.clientWidth;

  // Grouped layout: each region container holds its own card grid.
  if (terminalsEl.classList.contains('grid-grouped')) {
    terminalsEl.style.gridTemplateColumns = '';
    terminalsEl.classList.remove('grid-few-cards', 'grid-single-card');
    for (const cardsEl of terminalsEl.querySelectorAll('.grid-region-cards')) {
      const cardCount = cardsEl.querySelectorAll('.grid-card').length;
      const cols = calculateGridColumnCount({ width, cardCount });
      cardsEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      cardsEl.classList.toggle('grid-single-card', cardCount === 1);
    }
    return;
  }

  const cardCount = terminalsEl.querySelectorAll('.grid-card').length;
  const cols = calculateGridColumnCount({ width, cardCount });
  terminalsEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  terminalsEl.classList.toggle('grid-few-cards', cardCount > 0 && cardCount <= 2);
  terminalsEl.classList.toggle('grid-single-card', cardCount === 1);
}

// initGridObservers is called from app.js after DOM refs are ready
function initGridObservers() {
  new ResizeObserver(updateGridColumns).observe(terminalsEl);
  new MutationObserver(updateGridColumns).observe(terminalsEl, { childList: true });
  const resetBtn = document.getElementById('grid-reset-layout-btn');
  if (resetBtn) resetBtn.addEventListener('click', resetGridLayout);
  // The collapse-all-groups toggle now lives in the bulk-actions bar and is
  // (re)created + bound by renderGridBulkActions on each render.
}

function hideGridView() {
  gridViewActive = false;
  localStorage.setItem('gridViewActive', '0');
  closeSnapLayoutPopover();
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
    terminalHeader.style.display = 'none';
    showGridView();
    // Surface every currently-running session as a card. Kick a fresh poll so
    // activePtyIds is current (it can be stale on the 30s idle cadence); the
    // poll handler then auto-mounts via ensureGridActiveSessionsMounted().
    if (typeof pollActiveSessions === 'function') pollActiveSessions();
    else ensureGridActiveSessionsMounted();
  }
}

// --- Session navigation (Cmd+Shift+[/], Cmd+Arrow) ---

// Returns ordered list of open (non-closed) session IDs matching sidebar order.
function getOrderedOpenSessionIds() {
  const items = sidebarContent.querySelectorAll('.session-item[data-session-id]');
  const ids = [];
  for (const item of items) {
    const sid = item.dataset.sessionId;
    const entry = openSessions.get(sid);
    if (entry && !entry.closed) ids.push(sid);
  }
  return ids;
}

function navigateSession(direction) {
  const ids = getOrderedOpenSessionIds();
  const current = gridViewActive ? gridFocusedSessionId : activeSessionId;
  const idx = ids.indexOf(current);
  let next;
  if (idx === -1) {
    next = ids[0];
  } else {
    next = ids[(idx + direction + ids.length) % ids.length];
  }
  if (ids.length === 0 || !next) return;
  if (gridViewActive) {
    focusGridCard(next);
  } else {
    showSession(next);
  }
}

// Navigate the grid in 2D by visual position using bounding rects.
// Project headings break the simple index math, so we use actual screen positions.
function navigateGrid(direction) {
  if (!gridViewActive) return;
  // Exclude cards hidden inside a collapsed region — they have no usable
  // geometry and shouldn't be reachable by 2D navigation.
  const cards = [...terminalsEl.querySelectorAll('.grid-card')].filter(c => c.offsetParent !== null);
  if (cards.length === 0) return;
  const currentCard = gridCards.get(gridFocusedSessionId || activeSessionId);
  if (!currentCard || !cards.includes(currentCard)) {
    for (const [sid, card] of gridCards) {
      if (card === cards[0]) { focusGridCard(sid); return; }
    }
    return;
  }
  const cur = currentCard.getBoundingClientRect();
  const curCx = cur.left + cur.width / 2;
  const curCy = cur.top + cur.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const card of cards) {
    if (card === currentCard) continue;
    const r = card.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Filter by direction
    const dx = cx - curCx;
    const dy = cy - curCy;
    let valid = false;
    switch (direction) {
      case 'left':  valid = dx < -10; break;
      case 'right': valid = dx > 10; break;
      case 'up':    valid = dy < -10; break;
      case 'down':  valid = dy > 10; break;
    }
    if (!valid) continue;
    // For left/right prefer same row (small dy), for up/down prefer same column (small dx)
    let dist;
    if (direction === 'left' || direction === 'right') {
      dist = Math.abs(dy) * 3 + Math.abs(dx);
    } else {
      dist = Math.abs(dx) * 3 + Math.abs(dy);
    }
    if (dist < bestDist) {
      bestDist = dist;
      best = card;
    }
  }
  if (!best) return;
  for (const [sid, card] of gridCards) {
    if (card === best) { focusGridCard(sid); return; }
  }
}

// Returns true if the key combo is a session nav shortcut (used by xterm to block without acting)
function isSessionNavKey(e) {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return false;
  if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) return true;
  if (!e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return true;
  // Cmd/Ctrl+Shift+A — focus next attention (let it through while a terminal is focused)
  if (typeof isNextAttentionKey === 'function' && isNextAttentionKey(e, nextAttentionBindingForNav())) return true;
  return false;
}

// Resolve the active next-attention binding (override-aware) without coupling
// grid-view to app.js init order.
function nextAttentionBindingForNav() {
  return typeof getNextAttentionBinding === 'function' ? getNextAttentionBinding() : undefined;
}

function handleSessionNavKey(e) {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return false;

  // Cmd/Ctrl+Shift+A — focus next session needing attention
  if (typeof isNextAttentionKey === 'function' && isNextAttentionKey(e, nextAttentionBindingForNav())) {
    e.preventDefault();
    if (e.type === 'keydown' && typeof focusNextAttention === 'function') focusNextAttention();
    return true;
  }

  // Cmd+Shift+[ or Cmd+Shift+] — prev/next session
  // On macOS, Shift changes e.key to { / }, so check code for reliable matching
  if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
    e.preventDefault();
    if (e.type === 'keydown') navigateSession(e.code === 'BracketLeft' ? -1 : 1);
    return true;
  }

  // Cmd+Arrow — in grid view: 2D grid navigation; in single view: left/right cycle sessions
  if (!e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    if (e.type === 'keydown') {
      if (gridViewActive) {
        const dirMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
        navigateGrid(dirMap[e.key]);
      } else {
        const dir = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
        navigateSession(dir);
      }
    }
    return true;
  }

  return false;
}
