const statusBarInfo = document.getElementById('status-bar-info');
const statusBarUsage = document.getElementById('status-bar-usage');
const statusBarActivity = document.getElementById('status-bar-activity');
const terminalsEl = document.getElementById('terminals');
const sidebarContent = document.getElementById('sidebar-content');
const plansContent = document.getElementById('plans-content');
const placeholder = document.getElementById('placeholder');
const archiveToggle = document.getElementById('archive-toggle');
const starToggle = document.getElementById('star-toggle');
const searchInput = document.getElementById('search-input');
const terminalHeader = document.getElementById('terminal-header');
const terminalHeaderName = document.getElementById('terminal-header-name');
const terminalHeaderId = document.getElementById('terminal-header-id');
const terminalHeaderStatus = document.getElementById('terminal-header-status');
const terminalHeaderShell = document.getElementById('terminal-header-shell');
const terminalStopBtn = document.getElementById('terminal-stop-btn');
const runningToggle = document.getElementById('running-toggle');
const todayToggle = document.getElementById('today-toggle');
const springCleaningBtn = document.getElementById('spring-cleaning-btn');
const planViewer = document.getElementById('plan-viewer');
const planPanel = new ViewerPanel(planViewer, {
  copyPath: true, copyContent: true,
  language: 'markdown', storageKey: 'markdownPreviewMode',
  onSave: (filePath, content) => window.api.savePlan(filePath, content),
});

// currentPlanContent, currentPlanFilePath, currentPlanFilename → plans-memory-view.js
const loadingStatus = document.getElementById('loading-status');
const sessionFilters = document.getElementById('session-filters');
const searchBar = document.getElementById('search-bar');
const statsContent = document.getElementById('stats-content');
const memoryContent = document.getElementById('memory-content');
const statsViewer = document.getElementById('stats-viewer');
const statsViewerBody = document.getElementById('stats-viewer-body');
const memoryViewer = document.getElementById('memory-viewer');
const memoryPanel = new ViewerPanel(memoryViewer, {
  copyPath: true, copyContent: true,
  language: 'markdown', storageKey: 'markdownPreviewMode',
  onSave: (filePath, content) => window.api.saveMemory(filePath, content),
});
const terminalArea = document.getElementById('terminal-area');
const settingsViewer = document.getElementById('settings-viewer');
const globalSettingsBtn = document.getElementById('global-settings-btn');
const addProjectBtn = document.getElementById('add-project-btn');
const resortBtn = document.getElementById('resort-btn');
const jsonlViewer = document.getElementById('jsonl-viewer');
const jsonlViewerTitle = document.getElementById('jsonl-viewer-title');
const jsonlViewerSessionId = document.getElementById('jsonl-viewer-session-id');
const jsonlViewerBody = document.getElementById('jsonl-viewer-body');
const timelineViewer = document.getElementById('timeline-viewer');
const timelineViewerTitle = document.getElementById('timeline-viewer-title');
const timelineViewerSessionId = document.getElementById('timeline-viewer-session-id');
const timelineViewerBody = document.getElementById('timeline-viewer-body');
const timelineSearchInput = document.getElementById('timeline-search-input');
const timelineKindFilter = document.getElementById('timeline-kind-filter');
const gridViewer = document.getElementById('grid-viewer');
const gridViewerCount = document.getElementById('grid-viewer-count');
const appLiveRegion = document.getElementById('app-live-region');
let gridViewActive = localStorage.getItem('gridViewActive') === '1';
const navigationEntry = performance.getEntriesByType?.('navigation')?.[0];
const isRendererReload = navigationEntry?.type === 'reload';

// Map<sessionId, { terminal, element, fitAddon, session, closed }>
const openSessions = new Map();
window._openSessions = openSessions;
let activeSessionId = sessionStorage.getItem('activeSessionId') || null;
function setActiveSession(id) {
  activeSessionId = id;
  if (id) sessionStorage.setItem('activeSessionId', id);
  else sessionStorage.removeItem('activeSessionId');
  // Update file panel to show this session's open files/diffs
  if (typeof switchPanel === 'function') switchPanel(id);
}
// Persist slug group expand state across reloads
function getExpandedSlugs() {
  try { return new Set(JSON.parse(sessionStorage.getItem('expandedSlugs') || '[]')); } catch { return new Set(); }
}
function saveExpandedSlugs() {
  const expanded = [];
  document.querySelectorAll('.slug-group:not(.collapsed)').forEach(g => { if (g.id) expanded.push(g.id); });
  sessionStorage.setItem('expandedSlugs', JSON.stringify(expanded));
}
let showArchived = false;
let showStarredOnly = false;
let showRunningOnly = false;
let showTodayOnly = false;
let cachedProjects = [];
let cachedAllProjects = [];
let activePtyIds = new Set();
let sortedOrder = []; // [{ projectPath, itemIds: [itemId, ...] }, ...] — single source of truth for sidebar order
let activeTab = 'sessions';
let cachedPlans = [];
let visibleSessionCount = 10;
let sessionMaxAgeDays = 3;
const pendingSessions = new Map(); // sessionId → { session, projectPath, folder }

// Bridge functions for settings-panel.js
window._setVisibleSessionCount = (v) => { visibleSessionCount = v; };
window._setSessionMaxAge = (v) => { sessionMaxAgeDays = v; };
window._applyTerminalTheme = (themeName) => {
  currentThemeName = themeName;
  TERMINAL_THEME = getTerminalTheme();
  for (const [, entry] of openSessions) {
    entry.terminal.options.theme = TERMINAL_THEME;
    entry.element.style.backgroundColor = TERMINAL_THEME.background;
  }
};
let searchMatchIds = null; // null = no search active; Set<string> = matched session IDs
let searchMatchProjectPaths = null; // Set<string> of project paths matched by name

// --- Activity tracking ---
//
// Activity is determined by two signals:
//   1. OSC 0 braille spinner (authoritative: Claude CLI sets title to spinner chars)
//   2. Noise-filtered terminal output (fallback: non-noise, non-TUI-repaint data)
//
// Both feed into setActivity(sessionId, active):
//   active=true  → cli-busy (spinner dot)
//   active=false → response-ready if not focused (terminal state until user clicks)
// OSC 0 idle signal is the authoritative source for marking sessions as idle.
//
const attentionSessions = new Set(); // sessions needing user action (OSC 9)
const responseReadySessions = new Set(); // Claude finished, user hasn't looked (terminal state)
const sessionBusyState = new Map(); // sessionId → boolean (currently active)
const lastActivityTime = new Map(); // sessionId → Date of last terminal output
const sessionTimelineStore = createTimelineStore();

// Noise patterns — these don't count as activity
const activityNoiseRe = /file-history-snapshot|^\s*$/;
let lastAnnouncedAttentionSummary = '';

function getAllKnownSessionsForStatus() {
  const sessionsById = new Map();
  for (const session of sessionMap.values()) sessionsById.set(session.sessionId, session);
  for (const project of [...cachedProjects, ...cachedAllProjects]) {
    for (const session of project.sessions || []) sessionsById.set(session.sessionId, session);
  }
  return [...sessionsById.values()];
}

function announceAttentionSummary() {
  if (!appLiveRegion || typeof getStatusCounts !== 'function') return;
  const counts = getStatusCounts(getAllKnownSessionsForStatus(), {
    activePtyIds,
    attentionSessions,
    responseReadySessions,
    sessionBusyState,
    openSessions,
    lastActivityTime,
    activeSessionId,
  });
  const parts = [];
  if (counts.attention) parts.push(`${counts.attention} need${counts.attention === 1 ? 's' : ''} attention`);
  if (counts.ready) parts.push(`${counts.ready} ready`);
  if (counts.active) parts.push(`${counts.active} running`);
  const next = parts.length ? `Agent status: ${parts.join(', ')}.` : '';
  if (next === lastAnnouncedAttentionSummary) return;
  lastAnnouncedAttentionSummary = next;
  appLiveRegion.textContent = next;
}

function refreshSessionStatusViews() {
  if (activeTab === 'sessions') refreshSidebar();
  if (gridViewActive) showGridView();
  announceAttentionSummary();
}

function recordTimelineEvent(sessionId, kind, label, detail) {
  addTimelineEvent(sessionTimelineStore, sessionId, kind, label, { detail });
  if (timelineViewer.style.display !== 'none' && timelineViewer.dataset.sessionId === sessionId) {
    renderTimelineViewer(sessionId);
  }
}

// Central activity dispatcher
function setActivity(sessionId, active) {
  if (responseReadySessions.has(sessionId)) {
    return;
  }

  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);

  if (wasActive && !active) {
    // Activity ended → response-ready if user isn't looking at this session
    if (sessionId !== activeSessionId) {
      responseReadySessions.add(sessionId);
      recordTimelineEvent(sessionId, 'response-ready', 'Ready for review', 'Agent stopped producing output while this session was not focused.');
      const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
      if (item) {
        item.classList.remove('cli-busy');
        item.classList.add('response-ready');
      }
      refreshSessionStatusViews();
    }
  }

  // Sync cli-busy class (only if not response-ready)
  if (!responseReadySessions.has(sessionId)) {
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.toggle('cli-busy', active);
  }
  if (wasActive !== active) {
    recordTimelineEvent(sessionId, active ? 'busy' : 'idle', active ? 'Agent working' : 'Agent idle', active ? 'Claude activity started.' : 'Claude activity stopped.');
  }
  if (wasActive !== active) refreshSessionStatusViews();
}

// Terminal output activity — updates lastActivityTime only, busy state driven by backend
function trackActivity(sessionId, data) {
  if (activityNoiseRe.test(data)) return;
  lastActivityTime.set(sessionId, new Date());
}

function clearUnread(sessionId) {
  const changed = responseReadySessions.delete(sessionId);
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) {
    item.classList.remove('response-ready');
  }
  if (changed) refreshSessionStatusViews();
}

function clearNotifications(sessionId) {
  clearUnread(sessionId);
  const changed = attentionSessions.delete(sessionId);
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) item.classList.remove('needs-attention');
  if (changed) refreshSessionStatusViews();
}
// Terminal themes, utils (cleanDisplayName, formatDate, escapeHtml, shellEscape)
// are defined in terminal-themes.js and utils.js (loaded before app.js).

// Terminal key bindings, write buffering, isAtBottom, safeFit, fitAndScroll → terminal-manager.js

// --- IPC listeners from main process ---

window.api.onTerminalData((sessionId, data) => {
  const entry = openSessions.get(sessionId);
  if (entry) {
    let buf = terminalWriteBuffers.get(sessionId);
    if (!buf) {
      buf = { chunks: [], syncDepth: 0, rafId: 0, timerId: 0 };
      terminalWriteBuffers.set(sessionId, buf);
    }
    buf.chunks.push(data);

    // Track sync start/end nesting
    if (data.includes(ESC_SYNC_START)) buf.syncDepth++;
    if (data.includes(ESC_SYNC_END)) buf.syncDepth = Math.max(0, buf.syncDepth - 1);

    if (buf.syncDepth > 0) {
      // Inside a synchronized update — keep buffering.
      // Set a safety timeout so we never hold data forever.
      cancelAnimationFrame(buf.rafId);
      if (!buf.timerId) {
        buf.timerId = setTimeout(() => flushTerminalBuffer(sessionId), SYNC_BUFFER_TIMEOUT);
      }
    } else {
      // Not in a sync block (or sync just ended) — flush on next frame.
      clearTimeout(buf.timerId);
      buf.timerId = 0;
      scheduleFlush(sessionId, buf);
    }
  }
  // Update last activity time (noise-filtered)
  trackActivity(sessionId, data);
});

window.api.onSessionDetected((tempId, realId) => {
  const entry = openSessions.get(tempId);
  if (!entry) return;

  entry.session.sessionId = realId;
  if (activeSessionId === tempId) setActiveSession(realId);

  // Re-key in openSessions
  openSessions.delete(tempId);
  openSessions.set(realId, entry);
  const previousEvents = sessionTimelineStore.eventsBySession.get(tempId);
  if (previousEvents) {
    sessionTimelineStore.eventsBySession.delete(tempId);
    sessionTimelineStore.eventsBySession.set(realId, previousEvents.map(event => ({ ...event, sessionId: realId })));
  }
  recordTimelineEvent(realId, 'started', 'Session detected', 'Claude wrote its real session id.');

  terminalHeaderId.textContent = realId;
  terminalHeaderName.textContent = 'New session';

  // Refresh sidebar to show the new session, then select it
  loadProjects().then(() => {
    const item = document.querySelector(`[data-session-id="${realId}"]`);
    if (item) {
      document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    }
  });
  pollActiveSessions();
});

window.api.onSessionForked((oldId, newId) => {
  const entry = openSessions.get(oldId);
  if (!entry) return;

  entry.session.sessionId = newId;
  if (activeSessionId === oldId) setActiveSession(newId);

  openSessions.delete(oldId);
  openSessions.set(newId, entry);
  const previousEvents = sessionTimelineStore.eventsBySession.get(oldId);
  if (previousEvents) {
    sessionTimelineStore.eventsBySession.delete(oldId);
    sessionTimelineStore.eventsBySession.set(newId, previousEvents.map(event => ({ ...event, sessionId: newId })));
  }
  recordTimelineEvent(newId, 'forked', 'Session forked', `Forked from ${oldId}.`);

  // Re-key file panel state for the new session ID
  if (typeof rekeyFilePanelState === 'function') rekeyFilePanelState(oldId, newId);

  // Re-key pending session to newId so sidebar item persists until DB has real data
  const pendingEntry = pendingSessions.get(oldId);
  pendingSessions.delete(oldId);
  if (pendingEntry) {
    pendingEntry.sessionId = newId;
    pendingSessions.set(newId, pendingEntry);
  }
  sessionMap.delete(oldId);
  sessionMap.set(newId, entry.session);

  terminalHeaderId.textContent = newId;

  loadProjects().then(() => {
    const item = document.querySelector(`[data-session-id="${newId}"]`);
    if (item) {
      document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      const summary = item.querySelector('.session-summary');
      if (summary) terminalHeaderName.textContent = summary.textContent;
    }
  });
  pollActiveSessions();
});

window.api.onProcessExited((sessionId, exitCode) => {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId);
  if (entry) {
    entry.closed = true;
    recordTimelineEvent(sessionId, 'exited', 'Process exited', `Exit code ${exitCode}.`);
    // Write a visible exit banner so the user can see when the process ended
    // and read any error output it printed (claude / devbox / shell stderr).
    // Without this, a fast-failing pre-launch command would tear down the
    // terminal before the user could read the error.
    try {
      const colour = exitCode === 0 ? '\x1b[2m' : '\x1b[33m';
      entry.terminal.write(
        `\r\n${colour}── session exited (code ${exitCode}) — re-click this session in the sidebar to relaunch, or click another to dismiss ──\x1b[0m\r\n`
      );
    } catch {}
  }

  // Plain terminal sessions are ephemeral — destroy immediately and remove from
  // the sidebar. Claude sessions stay mounted (see below) so the user can read
  // the exit reason.
  if (session?.type === 'terminal') {
    if (entry) destroySession(sessionId);
    if (gridViewActive) {
      gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
    } else if (activeSessionId === sessionId) {
      setActiveSession(null);
      terminalHeader.style.display = 'none';
      placeholder.style.display = '';
    }
    pendingSessions.delete(sessionId);
    for (const projList of [cachedProjects, cachedAllProjects]) {
      for (const proj of projList) {
        proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
      }
    }
    sessionMap.delete(sessionId);
    refreshSidebar();
    pollActiveSessions();
    return;
  }

  // Claude sessions: keep the terminal mounted with the exit banner visible so
  // the user can read what happened. Cleanup is deferred — openSession destroys
  // the closed entry when the user re-clicks the session (existing behavior).
  // If the session was pending (no .jsonl was written), leave the sidebar
  // entry in place too so the user has somewhere to relaunch from; it'll be
  // tidied up by the regular pending-reconciliation pass once it's clear no
  // real session file is coming.

  if (gridViewActive) {
    gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  }

  pollActiveSessions();
});

// --- Terminal notifications (iTerm2 OSC 9 — "needs attention") ---
window.api.onTerminalNotification((sessionId, message) => {
  // Only mark as needing attention for "attention" messages, not "waiting for input"
  // Matches all four CLI notification types:
  // 1. "Claude Code needs your attention"         → attention
  // 2. "Claude Code needs your approval for the plan" → approval, needs your
  // 3. "Claude needs your permission to use {tool}"   → permission, needs your
  // 4. "Claude Code wants to enter plan mode"         → wants to enter
  if (/attention|approval|permission|needs your|wants to enter/i.test(message) && sessionId !== activeSessionId) {
    const wasAttention = attentionSessions.has(sessionId);
    attentionSessions.add(sessionId);
    recordTimelineEvent(sessionId, 'needs-attention', 'Needs human attention', message);
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.add('needs-attention');
    if (!wasAttention) refreshSessionStatusViews();
  } else if (/waiting for your input/i.test(message)) {
    // "Claude is waiting for your input" — delayed idle notification, mark response-ready
    setActivity(sessionId, false);
  }

  // Show in header if active
  if (sessionId === activeSessionId && terminalHeaderPtyTitle) {
    terminalHeaderPtyTitle.textContent = message;
    terminalHeaderPtyTitle.style.display = '';
  }
});

// --- CLI busy state (OSC 0 title spinner detection) ---
window.api.onCliBusyState((sessionId, busy) => {
  setActivity(sessionId, busy);
});

// --- Single entry point for all sidebar renders ---
// resort=true: re-sort items by priority+time (use for user-initiated actions)
// resort=false (default): preserve existing DOM order, new items go to top
function refreshSidebar({ resort = false } = {}) {
  // When searching, always use all projects (search ignores archive filter)
  let projects = (searchMatchIds !== null)
    ? cachedAllProjects
    : (showArchived ? cachedAllProjects : cachedProjects);

  if (searchMatchIds !== null) {
    projects = projects.map(p => {
      const hasMatchingSessions = p.sessions.some(s => searchMatchIds.has(s.sessionId));
      const projectMatched = searchMatchProjectPaths && searchMatchProjectPaths.has(p.projectPath);
      if (!hasMatchingSessions && !projectMatched) return null;
      return {
        ...p,
        sessions: hasMatchingSessions ? p.sessions.filter(s => searchMatchIds.has(s.sessionId)) : [],
        _projectMatchedOnly: projectMatched && !hasMatchingSessions,
      };
    }).filter(Boolean);
  }

  renderProjects(projects, resort);
}

// --- Archive toggle ---
archiveToggle.innerHTML = ICONS.archive(18);
archiveToggle.addEventListener('click', () => {
  showArchived = !showArchived;
  archiveToggle.classList.toggle('active', showArchived);
  refreshSidebar({ resort: true });
});

if (springCleaningBtn) {
  springCleaningBtn.innerHTML = ICONS.cleanup(16);
  springCleaningBtn.addEventListener('click', () => showSpringCleaningDialog());
}

// --- Star filter toggle ---
starToggle.addEventListener('click', () => {
  showStarredOnly = !showStarredOnly;
  if (showStarredOnly) { showRunningOnly = false; runningToggle.classList.remove('active'); }
  starToggle.classList.toggle('active', showStarredOnly);
  refreshSidebar({ resort: true });
});

// --- Running filter toggle ---
runningToggle.addEventListener('click', () => {
  showRunningOnly = !showRunningOnly;
  if (showRunningOnly) { showStarredOnly = false; starToggle.classList.remove('active'); }
  runningToggle.classList.toggle('active', showRunningOnly);
  refreshSidebar({ resort: true });
});

// --- Today filter toggle ---
todayToggle.addEventListener('click', () => {
  showTodayOnly = !showTodayOnly;
  todayToggle.classList.toggle('active', showTodayOnly);
  refreshSidebar({ resort: true });
});

// --- Re-sort button ---
resortBtn.addEventListener('click', () => {
  loadProjects({ resort: true });
});

// --- Global settings gear button ---
globalSettingsBtn.innerHTML = ICONS.gear(18);
globalSettingsBtn.addEventListener('click', () => {
  openSettingsViewer('global');
});

// --- Add project button ---
addProjectBtn.addEventListener('click', () => {
  showAddProjectDialog();
});

syncTitleToAriaLabel(document);

// --- Search (debounced, per-tab FTS) ---
let searchDebounceTimer = null;
const searchClear = document.getElementById('search-clear');
const searchTitlesToggle = document.getElementById('search-titles-toggle');
let searchTitlesOnly = false;

// Load persisted preference
(async () => {
  const saved = await window.api.getSetting('searchTitlesOnly');
  if (saved) {
    searchTitlesOnly = true;
    searchTitlesToggle.classList.add('active');
  }
})();

searchTitlesToggle.addEventListener('click', async () => {
  searchTitlesOnly = !searchTitlesOnly;
  searchTitlesToggle.classList.toggle('active', searchTitlesOnly);
  await window.api.setSetting('searchTitlesOnly', searchTitlesOnly);
  // Re-run current search if there's a query
  const query = searchInput.value.trim();
  if (query) {
    searchInput.dispatchEvent(new Event('input'));
  }
});

function clearSearch() {
  searchInput.value = '';
  searchBar.classList.remove('has-query');
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  if (activeTab === 'sessions') {
    searchMatchIds = null;
    searchMatchProjectPaths = null;
    refreshSidebar({ resort: true });
  } else if (activeTab === 'plans') {
    renderPlans(cachedPlans);
  } else if (activeTab === 'memory') {
    renderMemories();
  }
}

searchClear.addEventListener('click', () => {
  clearSearch();
  searchInput.focus();
});

searchInput.addEventListener('input', () => {
  // Toggle clear button visibility
  searchBar.classList.toggle('has-query', searchInput.value.length > 0);

  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(async () => {
    searchDebounceTimer = null;
    const query = searchInput.value.trim();

    if (!query) {
      clearSearch();
      return;
    }

    try {
      if (activeTab === 'sessions') {
        const results = await window.api.search('session', query, searchTitlesOnly);
        searchMatchIds = new Set(results.map(r => r.id));
        // When title-only, also match project names
        searchMatchProjectPaths = null;
        if (searchTitlesOnly) {
          const lowerQ = query.toLowerCase();
          for (const p of cachedAllProjects) {
            const shortName = p.projectPath.split('/').filter(Boolean).slice(-2).join('/');
            if (shortName.toLowerCase().includes(lowerQ)) {
              if (!searchMatchProjectPaths) searchMatchProjectPaths = new Set();
              searchMatchProjectPaths.add(p.projectPath);
            }
          }
        }
        refreshSidebar({ resort: true });
      } else if (activeTab === 'plans') {
        const results = await window.api.search('plan', query, searchTitlesOnly);
        const matchIds = new Set(results.map(r => r.id));
        renderPlans(cachedPlans.filter(p => matchIds.has(p.filename)));
      } else if (activeTab === 'memory') {
        const results = await window.api.search('memory', query, searchTitlesOnly);
        const matchIds = new Set(results.map(r => r.id));
        renderMemories(matchIds);
      }
    } catch {
      if (activeTab === 'sessions') {
        searchMatchIds = null;
        searchMatchProjectPaths = null;
        refreshSidebar({ resort: true });
      }
    }
  }, 200);
});

// --- Stop session helper ---
async function confirmAndStopSession(sessionId) {
  const session = sessionMap.get(sessionId);
  const label = cleanDisplayName(session?.name || session?.aiTitle || session?.summary) || sessionId;
  const confirmed = await showControlDialog({
    title: 'Stop Session',
    message: 'This will terminate the running process. The session history stays available in the sidebar.',
    confirmLabel: 'Stop Session',
    tone: 'danger',
    details: {
      Session: label,
      Project: session?.projectPath ? session.projectPath.split('/').filter(Boolean).slice(-2).join('/') : '',
    },
  });
  if (!confirmed) return;
  await window.api.stopSession(sessionId);
  recordTimelineEvent(sessionId, 'stopped', 'Session stopped', 'Stopped by the user.');
  activePtyIds.delete(sessionId);
  if (!gridViewActive && activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
    placeholder.style.display = '';
  }
  refreshSidebar();
}

// --- Terminal header controls ---
terminalStopBtn.addEventListener('click', () => {
  if (activeSessionId) confirmAndStopSession(activeSessionId);
});


// --- Poll for active PTY sessions ---
// Adaptive cadence: poll fast (3s) only while PTYs are running; when idle, back
// off to 30s. Every renderer path that starts a session (launchNewSession,
// openSession, launchTerminalSession, onSessionDetected/Forked) calls
// pollActiveSessions() explicitly, which re-arms the fast cadence immediately.
// The 30s idle floor still catches sessions started outside the renderer
// (scheduler-spawned PTYs, other windows) within at most 30s.
const POLL_FAST_MS = 3000;
const POLL_IDLE_MS = 30000;
let pollTimer = null;

function scheduleActiveSessionsPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = activePtyIds.size > 0 ? POLL_FAST_MS : POLL_IDLE_MS;
  pollTimer = setTimeout(pollActiveSessions, delay);
}

async function pollActiveSessions() {
  try {
    const ids = await window.api.getActiveSessions();
    activePtyIds = new Set(ids);
    updateRunningIndicators();
    updateTerminalHeader();
  } catch {}
  scheduleActiveSessionsPoll();
}

function updateRunningIndicators() {
  let statusChanged = false;
  document.querySelectorAll('.session-item').forEach(item => {
    const id = item.dataset.sessionId;
    const running = activePtyIds.has(id);
    if (item.classList.contains('has-running-pty') !== running) statusChanged = true;
    item.classList.toggle('has-running-pty', running);
    if (!running) {
      if (attentionSessions.has(id) || responseReadySessions.has(id) || sessionBusyState.has(id)) {
        statusChanged = true;
      }
      item.classList.remove('needs-attention', 'response-ready', 'cli-busy');
      attentionSessions.delete(id);
      responseReadySessions.delete(id);
      sessionBusyState.delete(id);
    }
    const dot = item.querySelector('.session-status-dot');
    if (dot) dot.classList.toggle('running', running);
  });
  // Update slug group running dots
  document.querySelectorAll('.slug-group').forEach(group => {
    const hasRunning = group.querySelector('.session-item.has-running-pty') !== null;
    const dot = group.querySelector('.slug-group-dot');
    if (dot) dot.classList.toggle('running', hasRunning);
  });
  // Update grid card dots and status text
  for (const [sid, card] of gridCards) {
    const session = sessionMap.get(sid);
    if (!session) continue;
    const status = getSessionStatus(session, getGridRuntimeState());
    const health = getSessionHealth(session);
    const running = status.key === 'running' || status.key === 'busy' || status.key === 'needs-attention' || status.key === 'response-ready';
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
    if (footer) footer.children[0].textContent = status.label;
    const stopBtn = card.querySelector('.grid-card-stop-btn');
    if (stopBtn) stopBtn.style.display = running ? '' : 'none';
  }
  if (statusChanged) refreshSessionStatusViews();
}

function updateTerminalHeader() {
  if (!activeSessionId) return;
  const running = activePtyIds.has(activeSessionId);
  terminalHeaderStatus.className = running ? 'running' : 'stopped';
  terminalHeaderStatus.textContent = running ? 'Running' : 'Stopped';
  terminalStopBtn.style.display = running ? '' : 'none';
  updatePtyTitle();
}

const terminalHeaderPtyTitle = document.getElementById('terminal-header-pty-title');

function updatePtyTitle() {
  if (!activeSessionId || !terminalHeaderPtyTitle) return;
  const entry = openSessions.get(activeSessionId);
  const title = entry?.ptyTitle || '';
  terminalHeaderPtyTitle.textContent = title;
  terminalHeaderPtyTitle.style.display = title ? '' : 'none';
}

scheduleActiveSessionsPoll();

// Refresh sidebar timeago labels every 30s so "just now" ticks forward
setInterval(() => {
  if (lastActivityTime.size === 0) return;
  for (const [sessionId, time] of lastActivityTime) {
    const item = document.getElementById('si-' + sessionId);
    if (!item) continue;
    const meta = item.querySelector('.session-meta-text');
    if (!meta) continue;
    const session = sessionMap.get(sessionId);
    const msgSuffix = session?.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '';
    meta.textContent = formatDate(time) + msgSuffix;
  }
}, 30000);

// Shared session map so all caches reference the same objects
const sessionMap = new Map();

function dedup(projects) {
  for (const p of projects) {
    for (let i = 0; i < p.sessions.length; i++) {
      const s = p.sessions[i];
      if (sessionMap.has(s.sessionId)) {
        Object.assign(sessionMap.get(s.sessionId), s);
        p.sessions[i] = sessionMap.get(s.sessionId);
      } else {
        sessionMap.set(s.sessionId, s);
      }
    }
  }
}

async function loadProjects({ resort = false } = {}) {
  const wasEmpty = cachedProjects.length === 0;
  if (wasEmpty) {
    loadingStatus.textContent = 'Loading\u2026';
    loadingStatus.className = 'active';
    loadingStatus.style.display = '';
  }
  const [defaultProjects, allProjects] = await Promise.all([
    window.api.getProjects(false),
    window.api.getProjects(true),
  ]);
  cachedProjects = defaultProjects;
  cachedAllProjects = allProjects;
  loadingStatus.style.display = 'none';
  loadingStatus.className = '';
  dedup(cachedProjects);
  dedup(cachedAllProjects);

  // Reconcile pending sessions: remove ones that now have real data
  let hasReinjected = false;
  for (const [sid, pending] of [...pendingSessions]) {
    const realExists = allProjects.some(p => p.sessions.some(s => s.sessionId === sid));
    if (realExists) {
      pendingSessions.delete(sid);
    } else {
      hasReinjected = true;
      // Still pending — re-inject into cached data
      for (const projList of [cachedProjects, cachedAllProjects]) {
        let proj = projList.find(p => p.projectPath === pending.projectPath);
        if (!proj) {
          // Project not in list (no other sessions) — create a synthetic entry
          proj = { folder: pending.folder, projectPath: pending.projectPath, sessions: [] };
          projList.unshift(proj);
        }
        if (!proj.sessions.some(s => s.sessionId === sid)) {
          proj.sessions.unshift(pending.session);
        }
      }
    }
  }

  // Track active plain terminals in pendingSessions/sessionMap (data now comes from backend)
  try {
    const activeTerminals = await window.api.getActiveTerminals();
    for (const { sessionId, projectPath } of activeTerminals) {
      if (pendingSessions.has(sessionId)) continue; // already tracked
      const folder = encodeProjectPath(projectPath);
      // Find the session object already injected by the backend
      let session;
      for (const proj of cachedAllProjects) {
        session = proj.sessions.find(s => s.sessionId === sessionId);
        if (session) break;
      }
      if (!session) continue;
      pendingSessions.set(sessionId, { session, projectPath, folder });
      sessionMap.set(sessionId, session);
    }
  } catch {}

  await pollActiveSessions();
  refreshSidebar({ resort });
  renderDefaultStatus();
}

// Sidebar rendering (slugId, folderId, buildSlugGroup, renderProjects,
// rebindSidebarEvents, buildSessionItem, startRename) → sidebar.js


async function launchNewSession(project, sessionOptions) {
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const session = {
    sessionId,
    summary: 'New session',
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
  };

  // Track as pending (no .jsonl yet)
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data so it appears in sidebar immediately
  sessionMap.set(sessionId, session);
  recordTimelineEvent(sessionId, 'started', sessionOptions?.forkFrom ? 'Fork requested' : 'Session started', sessionOptions?.forkFrom ? `Forking from ${sessionOptions.forkFrom}.` : 'Created from Switchboard.');
  for (const projList of [cachedProjects, cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  const entry = createTerminalEntry(session);

  // Open terminal in main process with session options
  const result = await window.api.openTerminal(sessionId, projectPath, true, sessionOptions || null);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    showSession(sessionId);
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  showSession(sessionId);
  pollActiveSessions();
}

// Legacy alias
function openNewSession(project) {
  return launchNewSession(project);
}

async function showTerminalHeader(session) {
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);
  terminalHeaderName.textContent = displayName;
  terminalHeaderId.textContent = session.sessionId;
  terminalHeader.style.display = '';
  updateTerminalHeader();

  // Show active shell profile
  try {
    const effective = await window.api.getEffectiveSettings(session.projectPath);
    const profileId = effective.shellProfile || 'auto';
    if (profileId === 'auto') {
      terminalHeaderShell.style.display = 'none';
    } else {
      const profiles = await window.api.getShellProfiles();
      const profile = profiles.find(p => p.id === profileId);
      terminalHeaderShell.textContent = profile ? profile.name : profileId;
      terminalHeaderShell.style.display = '';
    }
  } catch {
    terminalHeaderShell.style.display = 'none';
  }
}

function renderTimelineViewer(sessionId) {
  const session = sessionMap.get(sessionId);
  const events = getTimelineEvents(sessionTimelineStore, sessionId);
  const filteredEvents = filterTimelineEvents(events, {
    query: timelineSearchInput?.value || '',
    kind: timelineKindFilter?.value || 'all',
  });
  const displayName = cleanDisplayName(session?.name || session?.aiTitle || session?.summary) || sessionId;

  timelineViewer.dataset.sessionId = sessionId;
  timelineViewerTitle.textContent = displayName;
  timelineViewerSessionId.textContent = sessionId;
  timelineViewerBody.innerHTML = '';
  renderTimelineFilters(events);

  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    empty.textContent = 'No timeline events yet. Switchboard will record session starts, attention requests, ready states, exits, stops, and forks from this point forward.';
    timelineViewerBody.appendChild(empty);
    return;
  }

  if (filteredEvents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    empty.textContent = 'No timeline events match the current filter.';
    timelineViewerBody.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'timeline-list';
  for (const event of filteredEvents) {
    const formatted = formatTimelineEvent(event);
    const row = document.createElement('div');
    row.className = `timeline-event timeline-event-kind-${formatted.kind}`;
    row.innerHTML = `
      <div class="timeline-event-header">
        <span class="timeline-event-time">${escapeHtml(formatted.time)}</span>
        <span class="timeline-event-label">${escapeHtml(formatted.label)}</span>
      </div>
      ${formatted.detail ? `<div class="timeline-event-detail">${escapeHtml(formatted.detail)}</div>` : ''}
    `;
    list.appendChild(row);
  }
  timelineViewerBody.appendChild(list);
}

function renderTimelineFilters(events) {
  if (!timelineKindFilter) return;
  const current = timelineKindFilter.value || 'all';
  const labels = {
    started: 'Started',
    busy: 'Working',
    idle: 'Idle',
    'needs-attention': 'Needs attention',
    'response-ready': 'Ready',
    exited: 'Exited',
    stopped: 'Stopped',
    forked: 'Forked',
  };
  timelineKindFilter.innerHTML = '<option value="all">All events</option>';
  for (const kind of getTimelineKinds(events)) {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = labels[kind] || kind;
    timelineKindFilter.appendChild(option);
  }
  timelineKindFilter.value = [...timelineKindFilter.options].some(option => option.value === current) ? current : 'all';
}

function showTimelineViewer(session) {
  hidePlanViewer();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  timelineViewer.style.display = 'flex';
  if (timelineSearchInput) timelineSearchInput.value = '';
  if (timelineKindFilter) timelineKindFilter.value = 'all';
  renderTimelineViewer(session.sessionId);
}

if (timelineSearchInput) {
  timelineSearchInput.addEventListener('input', () => {
    const sessionId = timelineViewer.dataset.sessionId;
    if (sessionId) renderTimelineViewer(sessionId);
  });
}

if (timelineKindFilter) {
  timelineKindFilter.addEventListener('change', () => {
    const sessionId = timelineViewer.dataset.sessionId;
    if (sessionId) renderTimelineViewer(sessionId);
  });
}

// Terminal lifecycle (createTerminalEntry, destroySession, showSession, setupDragAndDrop) → terminal-manager.js

async function openSession(session, customOptions) {
  const { sessionId, projectPath } = session;

  // If already open, handle closed-session cleanup or just show it
  if (openSessions.has(sessionId)) {
    const entry = openSessions.get(sessionId);
    if (entry.closed) {
      destroySession(sessionId);
      if (session.type === 'terminal') {
        launchTerminalSession({ projectPath: session.projectPath });
        return;
      }
    } else {
      showSession(sessionId);
      return;
    }
  }

  // Create new terminal entry (hidden until showSession)
  const entry = createTerminalEntry(session);

  // Open terminal in main process
  const resumeOptions = customOptions || await resolveDefaultSessionOptions({ projectPath });
  // The `worktree` default applies to NEW sessions only. Resuming must reuse the
  // session's existing directory, so never pass --worktree on resume — otherwise
  // a plain-click resume tries to spin up a fresh git worktree and fails to attach
  // (the Resume-with-config dialog already omits worktree, which is why it works).
  if (resumeOptions) { delete resumeOptions.worktree; delete resumeOptions.worktreeName; }
  const result = await window.api.openTerminal(sessionId, projectPath, false, resumeOptions);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    showSession(sessionId);
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  showSession(sessionId);
  pollActiveSessions();
}

// Handle window resize
window.addEventListener('resize', () => {
  if (gridViewActive) {
    for (const entry of openSessions.values()) {
      fitAndScroll(entry);
    }
    return;
  }
  if (activeSessionId && openSessions.has(activeSessionId)) {
    const entry = openSessions.get(activeSessionId);
    safeFit(entry);
  }
});

// --- Tab switching ---
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    if (tabName === activeTab) return;
    activeTab = tabName;
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));

    // Clear search on tab switch
    searchInput.value = '';
    searchBar.classList.remove('has-query');
    searchMatchIds = null;
    searchMatchProjectPaths = null;

    // Hide all sidebar content areas
    sidebarContent.style.display = 'none';
    plansContent.style.display = 'none';
    statsContent.style.display = 'none';
    memoryContent.style.display = 'none';
    sessionFilters.style.display = 'none';
    searchBar.style.display = 'none';

    if (tabName === 'sessions') {
      sessionFilters.style.display = '';
      searchBar.style.display = '';
      searchInput.placeholder = 'Search sessions...';
      sidebarContent.style.display = '';
      // Restore terminal area
      hideAllViewers();
      if (gridViewActive) {
        // Grid is still set up — just re-show it and refit
        placeholder.style.display = 'none';
        terminalHeader.style.display = 'none';
        gridViewer.style.display = 'block';
        for (const entry of openSessions.values()) {
          if (!entry.closed) fitAndScroll(entry);
        }
      } else if (activeSessionId && openSessions.has(activeSessionId)) {
        showSession(activeSessionId);
      } else {
        placeholder.style.display = '';
      }
      // Catch up on changes that happened while on another tab
      if (projectsChangedWhileAway) {
        projectsChangedWhileAway = false;
        loadProjects();
      }
    } else if (tabName === 'plans') {
      searchBar.style.display = '';
      searchInput.placeholder = 'Search plans...';
      plansContent.style.display = '';
      loadPlans();
    } else if (tabName === 'stats') {
      statsContent.style.display = '';
      // Immediately show stats viewer in main area
      placeholder.style.display = 'none';
      terminalArea.style.display = 'none';
      planViewer.style.display = 'none';
      memoryViewer.style.display = 'none';
      settingsViewer.style.display = 'none';
      timelineViewer.style.display = 'none';
      statsViewer.style.display = 'flex';
      loadStats();
    } else if (tabName === 'memory') {
      searchBar.style.display = '';
      searchInput.placeholder = 'Search agent files...';
      memoryContent.style.display = '';
      loadMemories();
    }
  });
});

// Plans & viewer helpers → plans-memory-view.js


// Grid view → grid-view.js
// Initialize grid observers now that DOM refs are ready
initGridObservers();

// JSONL viewer (renderJsonlText, formatDuration, makeCollapsible, renderJsonlEntry, showJsonlViewer) → jsonl-viewer.js

// Stats view (loadStats, buildUsageSection, buildDailyBarChart, buildHeatmap, calculateStreak, buildStatsSummary) → stats-view.js

// Memory viewer → plans-memory-view.js


// Dialogs (resolveDefaultSessionOptions, forkSession, showNewSessionPopover,
// showNewSessionDialog, showResumeSessionDialog, showAddProjectDialog, launchTerminalSession) → dialogs.js


// --- Sidebar toggle ---
{
  const sidebar = document.getElementById('sidebar');
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  const expandBtn = document.getElementById('sidebar-expand-btn');

  collapseBtn.addEventListener('click', () => sidebar.classList.add('collapsed'));
  expandBtn.addEventListener('click', () => sidebar.classList.remove('collapsed'));
}

// --- Sidebar resize ---
{
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-resize-handle');
  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const width = Math.min(600, Math.max(200, e.clientX));
    sidebar.style.width = width + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Refit active terminal
    if (!gridViewActive && activeSessionId && openSessions.has(activeSessionId)) {
      const entry = openSessions.get(activeSessionId);
      safeFit(entry);
    }
    // Save sidebar width to settings
    const width = parseInt(sidebar.style.width);
    if (width) {
      window.api.getSetting('global').then(g => {
        const global = g || {};
        global.sidebarWidth = width;
        window.api.setSetting('global', global);
      });
    }
  });
}

// --- Grid view toggle button (next to resort button in sidebar filters) ---
{
  const gridToggleBtn = document.createElement('button');
  gridToggleBtn.id = 'grid-toggle-btn';
  gridToggleBtn.title = 'Session overview';
  gridToggleBtn.innerHTML = '<svg width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>';
  gridToggleBtn.addEventListener('click', toggleGridView);
  // Insert next to the resort button
  resortBtn.parentElement.insertBefore(gridToggleBtn, resortBtn);

  // Global keyboard shortcuts (covers non-terminal focus)
  // When a terminal is focused, xterm's customKeyEventHandler fires first and sets
  // e._handled to prevent the document listener from double-firing the same action.
  document.addEventListener('keydown', (e) => {
    if (e._handled) return;
    // Cmd/Ctrl+Shift+G → toggle grid view
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === 'g' && mod && e.shiftKey && !e.altKey) {
      e.preventDefault();
      toggleGridView();
      return;
    }
    // Session navigation: Cmd+Shift+[/], Cmd+Arrow
    handleSessionNavKey(e);
  });
}

// Warm up xterm.js renderer so first terminal open is fast
setTimeout(() => {
  const warmEl = document.createElement('div');
  warmEl.style.cssText = 'position:absolute;left:-9999px;width:400px;height:200px;';
  document.body.appendChild(warmEl);
  const warmTerm = new Terminal({ cols: 80, rows: 10 });
  const warmFit = new FitAddon.FitAddon();
  warmTerm.loadAddon(warmFit);
  warmTerm.open(warmEl);
  warmTerm.write(' ');
  requestAnimationFrame(() => {
    warmTerm.dispose();
    warmEl.remove();
  });
}, 100);


// --- Init: restore settings ---
(async () => {
  const global = await window.api.getSetting('global');
  if (global) {
    if (global.sidebarWidth) {
      document.getElementById('sidebar').style.width = global.sidebarWidth + 'px';
    }
    if (global.visibleSessionCount) {
      visibleSessionCount = global.visibleSessionCount;
    }
    if (global.sessionMaxAgeDays) {
      sessionMaxAgeDays = global.sessionMaxAgeDays;
    }
    if (global.terminalTheme && TERMINAL_THEMES[global.terminalTheme]) {
      currentThemeName = global.terminalTheme;
      TERMINAL_THEME = getTerminalTheme();
    }
  }
})();

loadProjects().then(async () => {
  // Restore grid view preference before opening sessions so they enter grid mode
  if (localStorage.getItem('gridViewActive') === '1') {
    showGridView();
  }
  const restoredAfterUpdate = await restoreUpdateRestartState();
  if (restoredAfterUpdate) return;
  if (isRendererReload) return;
  // Restore active session after reload
  if (activeSessionId && !openSessions.has(activeSessionId)) {
    const session = sessionMap.get(activeSessionId);
    if (session) openSession(session);
  }
});

// Live-reload sidebar when filesystem changes are detected
let projectsChangedTimer = null;
let projectsChangedWhileAway = false;
window.api.onProjectsChanged(() => {
  // Debounce to avoid rapid re-renders during bulk changes
  if (projectsChangedTimer) clearTimeout(projectsChangedTimer);
  if (activeTab !== 'sessions') {
    projectsChangedWhileAway = true;
    return;
  }
  projectsChangedTimer = setTimeout(() => {
    projectsChangedTimer = null;
    loadProjects();
  }, 300);
});

// Status bar
let activityTimer = null;
let usageStatusTimer = null;
const USAGE_RETRY_AT_KEY = 'usageStatusRetryAt';
const USAGE_CACHE_KEY = 'usageStatusLastValue';
let cachedStatusBarUsage = null;

function renderDefaultStatus() {
  const totalSessions = cachedAllProjects.reduce((n, p) => n + p.sessions.length, 0);
  const totalProjects = cachedAllProjects.length;
  const running = activePtyIds.size;
  const parts = [];
  if (running > 0) parts.push(`${running} running`);
  parts.push(`${totalSessions} sessions`);
  parts.push(`${totalProjects} projects`);
  statusBarInfo.textContent = parts.join(' \u00b7 ');
}

function renderUsageStatus(usage) {
  if (!statusBarUsage || typeof formatUsageStatus !== 'function') return;
  const status = formatUsageStatus(usage);
  statusBarUsage.title = status.title;
  statusBarUsage.className = status.level && status.level !== 'empty' ? `usage-status-${status.level}` : '';
  statusBarUsage.innerHTML = '';
  if (!status.text) return;

  const label = document.createElement('span');
  label.className = 'status-bar-usage-label';
  label.textContent = status.text;
  statusBarUsage.appendChild(label);

  if (Number.isFinite(status.percent)) {
    const track = document.createElement('span');
    track.className = 'status-bar-usage-track';
    const fill = document.createElement('span');
    fill.className = 'status-bar-usage-fill';
    fill.style.width = `${Math.max(1, Math.min(100, status.percent))}%`;
    track.appendChild(fill);
    statusBarUsage.appendChild(track);
  }
}

async function refreshStatusBarUsage() {
  if (!statusBarUsage) return;
  const retryAt = Number(localStorage.getItem(USAGE_RETRY_AT_KEY) || 0);
  if (retryAt && Date.now() < retryAt) {
    const rateLimitedUsage = {
      _rateLimited: true,
      retryAfterSeconds: Math.ceil((retryAt - Date.now()) / 1000),
    };
    const displayUsage = typeof withCachedUsageFallback === 'function'
      ? withCachedUsageFallback(rateLimitedUsage, cachedStatusBarUsage)
      : rateLimitedUsage;
    renderUsageStatus(displayUsage);
    usageStatusTimer = setTimeout(refreshStatusBarUsage, Math.max(1000, retryAt - Date.now()));
    return;
  }

  let usage = null;
  try {
    usage = await window.api.getUsage();
  } catch (err) {
    usage = { _error: true, message: err?.message || 'Could not fetch Claude usage data.' };
  }

  const displayUsage = typeof withCachedUsageFallback === 'function'
    ? withCachedUsageFallback(usage || {}, cachedStatusBarUsage)
    : usage;
  renderUsageStatus(displayUsage || {});

  if (usage?._rateLimited && usage.retryAfterSeconds) {
    localStorage.setItem(USAGE_RETRY_AT_KEY, String(Date.now() + getUsageRefreshDelayMs(usage)));
  } else if (!usage?._rateLimited) {
    localStorage.removeItem(USAGE_RETRY_AT_KEY);
    if (usage && !usage._error && Object.keys(usage).length) {
      cachedStatusBarUsage = usage;
      try { localStorage.setItem(USAGE_CACHE_KEY, JSON.stringify(usage)); } catch {}
    }
  }

  if (usageStatusTimer) clearTimeout(usageStatusTimer);
  usageStatusTimer = setTimeout(refreshStatusBarUsage, getUsageRefreshDelayMs(usage || {}));
}

function scheduleUsageStatusRefresh() {
  try {
    const cachedUsage = JSON.parse(localStorage.getItem(USAGE_CACHE_KEY) || 'null');
    if (cachedUsage && !cachedUsage._error && !cachedUsage._rateLimited) {
      cachedStatusBarUsage = cachedUsage;
      renderUsageStatus(cachedUsage);
    }
  } catch {}
  refreshStatusBarUsage();
}

function saveUpdateRestartState() {
  if (typeof collectUpdateRestartState !== 'function') return null;
  const state = collectUpdateRestartState(openSessions, { activeSessionId, gridViewActive });
  if (typeof hasRestorableUpdateSessions === 'function' && hasRestorableUpdateSessions(state)) {
    localStorage.setItem(UPDATE_RESTART_STATE_KEY, JSON.stringify(state));
  } else {
    localStorage.removeItem(UPDATE_RESTART_STATE_KEY);
  }
  return state;
}

async function restoreUpdateRestartState() {
  if (typeof hasRestorableUpdateSessions !== 'function') return false;
  let state = null;
  try {
    state = JSON.parse(localStorage.getItem(UPDATE_RESTART_STATE_KEY) || 'null');
  } catch {}
  localStorage.removeItem(UPDATE_RESTART_STATE_KEY);
  if (!hasRestorableUpdateSessions(state)) return false;

  if (state.gridViewActive) {
    localStorage.setItem('gridViewActive', '1');
    if (!gridViewActive) showGridView();
  }

  const uniqueSessions = [];
  const seen = new Set();
  for (const item of state.sessions) {
    if (!item?.sessionId || seen.has(item.sessionId)) continue;
    const session = sessionMap.get(item.sessionId);
    if (session) {
      uniqueSessions.push(session);
      seen.add(item.sessionId);
    }
  }

  for (const session of uniqueSessions) {
    await openSession(session);
  }

  if (state.activeSessionId && openSessions.has(state.activeSessionId)) {
    showSession(state.activeSessionId);
  }
  showControlToast({
    message: `Restored ${uniqueSessions.length} session${uniqueSessions.length === 1 ? '' : 's'} after update.`,
    timeoutMs: 6000,
  });
  return uniqueSessions.length > 0;
}

window.api.onStatusUpdate((text, type) => {
  if (activityTimer) clearTimeout(activityTimer);
  statusBarActivity.textContent = text;
  statusBarActivity.className = type === 'done' ? 'status-done' : '';
  if (!text || type === 'done') {
    activityTimer = setTimeout(() => {
      statusBarActivity.textContent = '';
      statusBarActivity.className = '';
    }, type === 'done' ? 3000 : 0);
  }
});

scheduleUsageStatusRefresh();

// --- Auto-update status + toast ---
const statusBarUpdater = document.getElementById('status-bar-updater');
let updaterStatusTimer = null;
function setUpdaterStatus(text, duration) {
  if (updaterStatusTimer) clearTimeout(updaterStatusTimer);
  statusBarUpdater.textContent = text;
  if (duration) {
    updaterStatusTimer = setTimeout(() => { statusBarUpdater.textContent = ''; }, duration);
  }
}
const updaterHandler = (type, data) => {
  switch (type) {
    case 'checking':
      setUpdaterStatus('Checking for updates…');
      break;
    case 'update-available':
      setUpdaterStatus(`Downloading v${data.version}…`);
      break;
    case 'update-not-available':
      setUpdaterStatus('Up to date', 3000);
      break;
    case 'download-progress':
      setUpdaterStatus(`Updating… ${Math.round(data.percent)}%`);
      break;
    case 'update-downloaded': {
      setUpdaterStatus(`v${data.version} ready — restart to update`);
      const dismissed = localStorage.getItem('update-dismissed');
      if (dismissed === data.version) return;
      const toast = document.getElementById('update-toast');
      const msg = document.getElementById('update-toast-msg');
      const notice = (data.releaseName && data.releaseName !== `v${data.version}` && data.releaseName !== data.version) ? `<span class="update-summary">${escapeHtml(data.releaseName)}</span>` : '';
      msg.innerHTML = `New Version Ready<br><span class="update-version">v${data.version}</span> (<a href="https://github.com/doctly/switchboard/releases" target="_blank" class="update-notes-link">release notes</a>)${notice}`;
      toast.classList.remove('hidden');
      document.getElementById('update-restart-btn').onclick = async () => {
        saveUpdateRestartState();
        const result = await window.api.updaterInstall();
        if (result?.ok === false) {
          showControlToast({ message: 'Update restart is only available in packaged builds.' });
        }
      };
      document.getElementById('update-dismiss-btn').onclick = () => {
        toast.classList.add('hidden');
        localStorage.setItem('update-dismissed', data.version);
      };
      break;
    }
    case 'error':
      setUpdaterStatus('Update check failed', 5000);
      break;
  }
};
window.api.onUpdaterEvent(updaterHandler);

// --- Initialize file panel (MCP bridge UI) ---
if (typeof initFilePanel === 'function') initFilePanel();
