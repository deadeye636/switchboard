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

// Build a labeled grid region for a group (or the ungrouped pool). Appends the
// region to #terminals and returns its inner cards container.
function buildGridRegion(group, sessions) {
  const counts = getStatusCounts(sessions, getGridRuntimeState());

  const region = document.createElement('div');
  region.className = 'grid-region' + (group ? '' : ' ungrouped');
  region.dataset.groupId = group ? group.id : '';
  if (group) region.style.setProperty('--user-group-color', group.color);

  const header = document.createElement('div');
  header.className = 'grid-region-header';

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

  const cardsEl = document.createElement('div');
  cardsEl.className = 'grid-region-cards';

  region.appendChild(header);
  region.appendChild(cardsEl);
  terminalsEl.appendChild(region);
  return cardsEl;
}

function wrapInGridCard(sessionId, parent) {
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

  // Build the card DOM
  card.appendChild(header);
  entry.element.classList.add('visible', 'grid-mode');
  card.appendChild(entry.element);
  card.appendChild(footer);

  target.appendChild(card);

  // Click header or footer to focus
  const focusFromCardChrome = (e) => {
    if (e?.target?.closest?.('button')) return;
    e.stopPropagation();
    focusGridCard(sessionId);
  };
  header.addEventListener('mousedown', focusFromCardChrome);
  makeButtonLike(header, focusFromCardChrome, `Focus ${displayName}`);
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

function focusGridCard(sessionId) {
  gridFocusedSessionId = sessionId;
  setActiveSession(sessionId);
  clearNotifications(sessionId);
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

function showGridView() {
  gridViewActive = true;
  localStorage.setItem('gridViewActive', '1');
  renderGridStatusFilters();
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

  const sessionIds = [];
  if (groupBuckets.size > 0) {
    terminalsEl.classList.add('grid-grouped');
    const orderedGroups = [...groupsState.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const group of orderedGroups) {
      const bucket = groupBuckets.get(group.id);
      if (!bucket || bucket.length === 0) continue;
      const cardsEl = buildGridRegion(group, bucket.map(sessionFor).filter(Boolean));
      for (const sid of bucket) {
        wrapInGridCard(sid, cardsEl);
        sessionIds.push(sid);
      }
    }
    if (ungroupedSids.length > 0) {
      const cardsEl = buildGridRegion(null, ungroupedSids.map(sessionFor).filter(Boolean));
      for (const sid of ungroupedSids) {
        wrapInGridCard(sid, cardsEl);
        sessionIds.push(sid);
      }
    }
  } else {
    for (const sid of orderedSids) {
      wrapInGridCard(sid);
      sessionIds.push(sid);
    }
  }

  // Show grid header bar with session count
  gridViewer.style.display = 'block';
  gridViewerCount.textContent = sessionIds.length + ' session' + (sessionIds.length !== 1 ? 's' : '');

  const btn = document.getElementById('grid-toggle-btn');
  if (btn) btn.classList.add('active');

  updateGridColumns();

  // Fit all terminals after layout resolves
  for (const sid of sessionIds) {
    const entry = openSessions.get(sid);
    if (entry) fitAndScroll(entry);
  }
  // Focus active or first (deferred so fitAndScroll's rAF runs first)
  requestAnimationFrame(() => {
    const toFocus = activeSessionId && sessionIds.includes(activeSessionId) ? activeSessionId : sessionIds[0];
    if (toFocus) focusGridCard(toFocus);
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
}

function hideGridView() {
  gridViewActive = false;
  localStorage.setItem('gridViewActive', '0');
  unwrapGridCards();
  terminalsEl.classList.remove('grid-layout');
  terminalsEl.classList.remove('grid-few-cards', 'grid-single-card');
  terminalsEl.style.gridTemplateColumns = '';
  gridViewer.style.display = 'none';
  const btn = document.getElementById('grid-toggle-btn');
  if (btn) btn.classList.remove('active');
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
  const cards = [...terminalsEl.querySelectorAll('.grid-card')];
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
  return false;
}

function handleSessionNavKey(e) {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return false;

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
