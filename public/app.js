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
const workFilesContent = document.getElementById('work-files-content');
const workFilesViewer = document.getElementById('work-files-viewer');
const workFilesPanel = new ViewerPanel(workFilesViewer, {
  copyPath: true, copyContent: true,
  language: 'auto', storageKey: 'workFilesPreviewMode',
  format: true,
  onDelete: async (filePath) => {
    const result = await window.api.deleteWorkFile(filePath);
    if (result && result.ok) {
      // Hide the panel and surgically remove the entry from the cached list.
      // We avoid loadWorkFiles() because the full disk re-scan can freeze the
      // UI on projects with large .work-files/ trees (e.g. tagpay = 39k files).
      workFilesViewer.style.display = 'none';
      if (typeof removeWorkFileFromCache === 'function') removeWorkFileFromCache(filePath);
    }
    return result;
  },
  onClose: () => {
    workFilesViewer.style.display = 'none';
  },
});
const terminalArea = document.getElementById('terminal-area');
const settingsViewer = document.getElementById('settings-viewer');
const globalSettingsBtn = document.getElementById('global-settings-btn');
const addProjectBtn = document.getElementById('add-project-btn');
const resortBtn = document.getElementById('resort-btn');
const collapseAllToggle = document.getElementById('collapse-all-toggle');
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
const viewModeToggle = document.getElementById('view-mode-toggle');
// Sidebar layout: 'directory' (project dir first) or 'folder' (user groups first,
// split by project dir within, ungrouped below). Persisted across restarts.
let sidebarViewMode = localStorage.getItem('sidebarViewMode') === 'folder' ? 'folder' : 'directory';
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
// User-defined session groups (spec 07). State is restored from the `groups`
// settings blob on startup and persisted on every mutation.
let groupsState = createGroupsState();
// Collapse state for user groups persists across restarts via localStorage
// (keyed by the stable group DOM id), tracking which groups are collapsed.
function getCollapsedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '[]')); } catch { return new Set(); }
}
function saveCollapsedGroups() {
  const collapsed = [];
  document.querySelectorAll('.user-group.collapsed').forEach(g => { if (g.id) collapsed.push(g.id); });
  localStorage.setItem('collapsedGroups', JSON.stringify(collapsed));
}
function persistGroupsState() {
  return window.api.setSetting('groups', serialize(groupsState));
}
// Mutation helpers used by sidebar/grid assignment UI. Each persists and
// refreshes the affected views.
function assignSessionToGroup(sessionId, groupId) {
  assignSession(groupsState, sessionId, groupId);
  persistGroupsState();
  refreshSidebar();
  if (gridViewActive) showGridView();
}
function createGroupForSession(sessionId, { name, color } = {}) {
  const { group } = addGroup(groupsState, { name, color });
  if (sessionId) assignSession(groupsState, sessionId, group.id);
  persistGroupsState();
  refreshSidebar();
  if (gridViewActive) showGridView();
  return group;
}
function renameUserGroup(groupId, name) {
  renameGroup(groupsState, groupId, name);
  persistGroupsState();
  refreshSidebar();
  if (gridViewActive) showGridView();
}
function recolorUserGroup(groupId, color) {
  recolorGroup(groupsState, groupId, color);
  persistGroupsState();
  refreshSidebar();
  if (gridViewActive) showGridView();
}
function removeUserGroup(groupId) {
  removeGroup(groupsState, groupId);
  persistGroupsState();
  refreshSidebar();
  if (gridViewActive) showGridView();
}

// All session ids currently assigned to a group (independent of sidebar filters,
// open state, or whether their metadata is loaded). Returned in assignment order.
function getGroupMemberSessionIds(groupId) {
  if (!groupId || typeof groupsState === 'undefined' || !groupsState.assignments) return [];
  return Object.keys(groupsState.assignments).filter(sid => groupsState.assignments[sid] === groupId);
}

// Best-guess project for a (cross-project) group: the project that the most
// members belong to. Used when launching a new session from a group folder so
// the session lands in a sensible working directory before being assigned.
// Returns a project object ({ folder, projectPath, sessions }) or null.
function getProjectForGroup(groupId) {
  const memberIds = getGroupMemberSessionIds(groupId);
  const counts = new Map();
  for (const sid of memberIds) {
    const s = sessionMap.get(sid);
    if (s && s.projectPath) counts.set(s.projectPath, (counts.get(s.projectPath) || 0) + 1);
  }
  let bestPath = null;
  let bestCount = -1;
  for (const [path, count] of counts) {
    if (count > bestCount) { bestCount = count; bestPath = path; }
  }
  if (!bestPath) return null;
  const proj = [...cachedProjects, ...cachedAllProjects].find(p => p.projectPath === bestPath);
  return proj || { folder: encodeProjectPath(bestPath), projectPath: bestPath, sessions: [] };
}

// One-click "Launch all" for a user group. Explicit user intent, so — unlike the
// grid auto-open which only re-attaches already-running PTYs — this opens EVERY
// member that isn't already mounted: running members re-attach, stopped members
// resume/start. attachRunningSession() handles both transparently (its
// openTerminal call re-attaches when the PTY is live, otherwise resumes), so we
// reuse it for all members and batch the mounts into a single view refresh + fit
// pass instead of N re-renders. Already-open members are skipped (no double-open).
async function launchAllInGroup(groupId) {
  const memberIds = getGroupMemberSessionIds(groupId);
  const toLaunch = (typeof getSessionsToLaunch === 'function'
    ? getSessionsToLaunch(memberIds, { openSessions })
    : memberIds.filter(sid => { const e = openSessions.get(sid); return !e || e.closed; }))
    .map(sid => sessionMap.get(sid))
    .filter(Boolean);

  if (toLaunch.length === 0) {
    if (typeof showControlToast === 'function') {
      showControlToast({ message: 'All sessions in this group are already open.', timeoutMs: 3000 });
    }
    return 0;
  }

  // Batch the mounts (no per-session view switch), then refresh views once.
  let launched = 0;
  for (const session of toLaunch) {
    if (await attachRunningSession(session)) launched++;
  }
  // Some members may have been freshly spawned — refresh active PTY tracking.
  pollActiveSessions();

  const openedIds = toLaunch
    .map(s => s.sessionId)
    .filter(sid => { const e = openSessions.get(sid); return e && !e.closed; });

  // Multiple sessions → show them all at once in the grid. A single launch just
  // opens in the current view so we don't yank the user into the grid needlessly.
  if (openedIds.length >= 2) {
    showGridView(); // sets/keeps grid active and rebuilds once with the new cards
    const focusId = openedIds[0];
    requestAnimationFrame(() => { if (typeof focusGridCard === 'function') focusGridCard(focusId); });
  } else if (openedIds.length === 1) {
    if (gridViewActive) showGridView();
    else showSession(openedIds[0]);
  }
  refreshSidebar();
  return launched;
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

// Cached copy of the global settings blob, kept in sync with the settings panel.
// Used for the attention alert sound and the next-attention hotkey binding.
let appGlobalSettings = {};
let nextAttentionBinding =
  typeof DEFAULT_NEXT_ATTENTION_BINDING !== 'undefined'
    ? DEFAULT_NEXT_ATTENTION_BINDING
    : { key: 'a', mod: true, shift: true, alt: false };

window._applyNotificationSettings = (settings) => {
  appGlobalSettings = settings || {};
  const override = appGlobalSettings.shortcuts && appGlobalSettings.shortcuts.nextAttention;
  if (override) nextAttentionBinding = override;
};

function getNextAttentionBinding() {
  return nextAttentionBinding;
}

// Live-apply the terminal right-click behavior (terminalRightClickMode lives in
// terminal-context-menu.js); takes effect on the next right-click, no relaunch.
window._applyTerminalRightClick = (mode) => { terminalRightClickMode = mode || 'menu'; };
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
const attentionSessions = new Set(); // sessions needing user action (OSC 9 or hook)
const attentionReason = new Map(); // sessionId → { reason, source } — for hook>osc9 precedence
const responseReadySessions = new Set(); // Claude finished, user hasn't looked (terminal state)
const sessionBusyState = new Map(); // sessionId → boolean (currently active)
const lastActivityTime = new Map(); // sessionId → Date of last terminal output
const lastViewedTime = new Map(); // sessionId → Date the session last became focused
const filesTouchedSinceViewed = new Map(); // sessionId → Map<path, { at, kind }>
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
  if (gridViewActive) refreshGridView();
  announceAttentionSummary();
  syncNativeNotifications();
}

// --- Next-attention focus (shared by the inbox button and the hotkey) ---
function statusRuntime() {
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

// Open/focus a single attention inbox item. Shared so the sidebar "Focus next"
// button and the keyboard shortcut stay in sync.
function focusAttentionItem(item) {
  if (item && item.session) openSession(item.session);
}

// Focus the next session needing attention (wrap-around handled by the helper).
function focusNextAttention() {
  if (typeof getNextAttentionInboxItem !== 'function') return;
  const next = getNextAttentionInboxItem(getAllKnownSessionsForStatus(), statusRuntime(), activeSessionId);
  focusAttentionItem(next);
}

// --- Attention alert sound (synthesized, no bundled binary) ---
let _attentionAudioCtx = null;
function playAttentionSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    _attentionAudioCtx = _attentionAudioCtx || new Ctx();
    if (_attentionAudioCtx.state === 'suspended') _attentionAudioCtx.resume();
    const ctx = _attentionAudioCtx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    // Two-tone rising chime.
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1175, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.34);
  } catch {
    // Audio is best-effort; never let it break status handling.
  }
}

function maybePlayAttentionSound(prevAttention, nextAttention) {
  if (typeof shouldPlayAttentionSound !== 'function') return;
  const settings = {
    sound: !!(appGlobalSettings.notifications && appGlobalSettings.notifications.sound),
  };
  if (shouldPlayAttentionSound({ prev: prevAttention, next: nextAttention, settings })) {
    playAttentionSound();
  }
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

// Single funnel for both attention sources (OSC-9 heuristic + Claude Code hooks).
// `signal` is the normalized output of classifyAttentionSignal: { kind, reason, source }.
function applyAttention(sessionId, signal) {
  if (!signal) return;
  const { kind, reason, source } = signal;

  if (kind === 'needs-attention') {
    // Focused session needs no inbox flag — the user is already looking at it.
    if (sessionId === activeSessionId) return;
    const winner = reduceAttention(attentionReason.get(sessionId) || null, { reason, source });
    attentionReason.set(sessionId, winner);
    const wasAttention = attentionSessions.has(sessionId);
    const prevAttention = new Set(attentionSessions);
    attentionSessions.add(sessionId);
    recordTimelineEvent(sessionId, 'needs-attention', 'Needs human attention', winner.reason);
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.add('needs-attention');
    if (!wasAttention) {
      refreshSessionStatusViews();
      maybePlayAttentionSound(prevAttention, attentionSessions);
    }
  } else if (kind === 'ready' || kind === 'idle') {
    // Agent finished / went idle → response-ready when unfocused (handled by setActivity).
    setActivity(sessionId, false);
  } else if (kind === 'busy') {
    setActivity(sessionId, true);
  }
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
  // Focus choke point: every focus path (showSession, focusGridCard) flows through
  // here. Compute the "while you were away" recap before unread/attention state is
  // cleared, then stamp the session as viewed.
  handleSessionViewed(sessionId);
  clearUnread(sessionId);
  const changed = attentionSessions.delete(sessionId);
  attentionReason.delete(sessionId);
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) item.classList.remove('needs-attention');
  if (changed) refreshSessionStatusViews();
}

// --- Native notification + dock badge + tray funnel (Spec 01) ---
// Every attention/ready transition reaches refreshSessionStatusViews(), which
// calls syncNativeNotifications() below. The actual decision (what to notify,
// coalescing, throttle, badge count) lives in the pure, unit-tested
// notification-policy.js module — this just feeds it state and forwards results
// to the main process over IPC.
let notificationSettings = { enabled: true, notifyOnReady: false };
let windowFocused = typeof document !== 'undefined' ? document.hasFocus() : true;
let lastNotifiedAt = 0;
let prevNotificationSnapshot = { attention: new Set(), ready: new Set() };

// Bridge for settings-panel.js so toggles apply without a restart.
window._setNotificationSettings = (settings) => {
  notificationSettings = {
    enabled: settings?.enabled !== false,
    notifyOnReady: !!settings?.notifyOnReady,
  };
  syncNativeNotifications();
};

function buildTraySummary() {
  const attention = attentionSessions.size;
  const ready = responseReadySessions.size;
  const parts = [];
  if (attention) parts.push(`${attention} need${attention === 1 ? 's' : ''} you`);
  if (ready) parts.push(`${ready} ready`);
  return parts.length ? `Switchboard — ${parts.join(' · ')}` : 'Switchboard';
}

function syncNativeNotifications() {
  if (typeof decideNotifications !== 'function' || !window.api) return;
  const next = {
    attention: new Set(attentionSessions),
    ready: new Set(responseReadySessions),
  };
  const now = Date.now();
  const result = decideNotifications({
    prev: prevNotificationSnapshot,
    next,
    windowFocused,
    settings: notificationSettings,
    now,
    lastNotifiedAt,
  });

  for (const notification of result.notifications) {
    window.api.notify({
      title: notification.title,
      body: notification.body,
      sessionId: notification.sessionIds[0],
    });
  }
  if (result.notifications.length > 0) lastNotifiedAt = now;

  window.api.setBadge(result.badgeCount);
  window.api.setTraySummary(buildTraySummary());

  prevNotificationSnapshot = next;
}

function setWindowFocused(focused) {
  windowFocused = focused;
  // Regaining focus may have cleared attended sessions; recompute the badge and
  // reset the transition baseline so we don't re-notify on the next change.
  syncNativeNotifications();
}
window.addEventListener('focus', () => setWindowFocused(true));
window.addEventListener('blur', () => setWindowFocused(false));
document.addEventListener('visibilitychange', () => {
  setWindowFocused(!document.hidden && document.hasFocus());
});

// Clicking a native notification focuses the window and opens that session.
window.api.onFocusSession((sessionId) => {
  if (!sessionId) return;
  setWindowFocused(true);
  let session = sessionMap.get(sessionId);
  if (!session) {
    session = getAllKnownSessionsForStatus().find((s) => s.sessionId === sessionId);
  }
  if (session) openSession(session);
  clearNotifications(sessionId);
});

// --- "While you were away" summary ---------------------------------------
//
// Tracks files an agent touched (via the MCP open-diff/open-file bridge) and,
// when you refocus a session that changed while you were elsewhere, surfaces a
// compact, dismissible recap above the live terminal. The terminal is never
// hidden or unmounted.

let awaySummaryEl = null;
let awaySummarySessionId = null;
let awaySummaryInputDisposable = null;

function recordFileTouched(sessionId, path, kind) {
  if (!sessionId || !path) return;
  let map = filesTouchedSinceViewed.get(sessionId);
  if (!map) {
    map = new Map();
    filesTouchedSinceViewed.set(sessionId, map);
  }
  map.set(path, { at: new Date().toISOString(), kind });
}

function awaySummaryFilesFor(sessionId) {
  const map = filesTouchedSinceViewed.get(sessionId);
  if (!map) return [];
  return [...map.entries()].map(([path, meta]) => ({ path, at: meta.at, kind: meta.kind }));
}

// Called at the focus choke point. Renders the recap for sessions that changed
// while unfocused, then records the new "last viewed" timestamp.
function handleSessionViewed(sessionId) {
  if (!sessionId) return;
  const previous = lastViewedTime.get(sessionId);
  let summary = null;
  if (previous && !gridViewActive && typeof buildAwaySummary === 'function') {
    summary = buildAwaySummary({
      events: getTimelineEvents(sessionTimelineStore, sessionId),
      filesTouched: awaySummaryFilesFor(sessionId),
      lastViewedAt: previous,
      now: new Date(),
    });
  }
  lastViewedTime.set(sessionId, new Date());

  if (summary && summary.hasChanges) {
    renderAwaySummary(sessionId, summary);
    // Recap is now showing the snapshot — reset the per-session file tally.
    filesTouchedSinceViewed.delete(sessionId);
  } else if (awaySummarySessionId) {
    // Focused something with nothing new — clear any stale banner.
    hideAwaySummary();
  }
}

function ensureAwaySummaryEl() {
  if (awaySummaryEl) return awaySummaryEl;
  awaySummaryEl = document.createElement('div');
  awaySummaryEl.id = 'away-summary';
  awaySummaryEl.hidden = true;
  const anchor = document.getElementById('grid-viewer') || document.getElementById('terminals');
  if (anchor && anchor.parentNode === terminalArea) {
    terminalArea.insertBefore(awaySummaryEl, anchor);
  } else {
    terminalArea.appendChild(awaySummaryEl);
  }
  return awaySummaryEl;
}

function hideAwaySummary() {
  if (awaySummaryInputDisposable) {
    try { awaySummaryInputDisposable.dispose(); } catch { /* noop */ }
    awaySummaryInputDisposable = null;
  }
  if (awaySummaryEl) {
    awaySummaryEl.hidden = true;
    awaySummaryEl.innerHTML = '';
    delete awaySummaryEl.dataset.sessionId;
  }
  awaySummarySessionId = null;
}

function dismissAwaySummary(sessionId) {
  if (sessionId) filesTouchedSinceViewed.delete(sessionId);
  hideAwaySummary();
}

function awaySummaryBasename(path) {
  if (!path) return '';
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

function renderAwaySummary(sessionId, summary) {
  const el = ensureAwaySummaryEl();
  el.dataset.sessionId = sessionId;
  const reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.classList.toggle('no-motion', !!reduceMotion);

  const eventsHtml = summary.events.map(event => `
    <li class="away-summary-event away-kind-${escapeHtml(event.kind)}">
      <span class="away-summary-event-time">${escapeHtml(event.time)}</span>
      <span class="away-summary-event-label">${escapeHtml(event.label)}</span>
      ${event.detail ? `<span class="away-summary-event-detail">${escapeHtml(event.detail)}</span>` : ''}
    </li>`).join('');

  const moreHtml = summary.extraEventCount
    ? `<li class="away-summary-more">+${summary.extraEventCount} earlier event${summary.extraEventCount === 1 ? '' : 's'}</li>`
    : '';

  const filesHtml = summary.files.length
    ? `<div class="away-summary-files">
        <span class="away-summary-files-label">Files touched</span>
        ${summary.files.map(file => `<span class="away-summary-file" data-kind="${escapeHtml(file.kind)}" title="${escapeHtml(file.path)}">${escapeHtml(awaySummaryBasename(file.path))}</span>`).join('')}
      </div>`
    : '';

  el.innerHTML = `
    <div class="away-summary-head">
      <span class="away-summary-title">While you were away</span>
      ${summary.sinceText ? `<span class="away-summary-since">${escapeHtml(summary.sinceText)}</span>` : ''}
      ${summary.waitingOnYou ? '<span class="away-summary-waiting">Waiting on you</span>' : ''}
      <button class="away-summary-close" type="button" aria-label="Dismiss summary" title="Dismiss">&times;</button>
    </div>
    ${eventsHtml || moreHtml ? `<ul class="away-summary-events">${eventsHtml}${moreHtml}</ul>` : ''}
    ${filesHtml}
    <div class="away-summary-actions">
      <button class="away-summary-timeline-link" type="button">View full timeline</button>
    </div>
  `;
  el.hidden = false;

  const closeBtn = el.querySelector('.away-summary-close');
  if (closeBtn) closeBtn.addEventListener('click', () => dismissAwaySummary(sessionId));
  const timelineLink = el.querySelector('.away-summary-timeline-link');
  if (timelineLink) {
    timelineLink.addEventListener('click', () => {
      const session = sessionMap.get(sessionId)
        || (openSessions.get(sessionId) && openSessions.get(sessionId).session);
      if (session && typeof showTimelineViewer === 'function') {
        showTimelineViewer(session);
      } else if (typeof renderTimelineViewer === 'function') {
        renderTimelineViewer(sessionId);
      }
    });
  }

  // Auto-dismiss as soon as the user types into this terminal.
  const entry = openSessions.get(sessionId);
  if (entry && entry.terminal && typeof entry.terminal.onData === 'function') {
    awaySummaryInputDisposable = entry.terminal.onData(() => dismissAwaySummary(sessionId));
  }
  awaySummarySessionId = sessionId;
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

// Track files the agent touches so the "while you were away" recap can list
// them. These are additive listeners alongside file-panel.js's own handlers.
window.api.onMcpOpenDiff((sessionId, _diffId, data) => {
  recordFileTouched(sessionId, data && data.oldFilePath, 'diff');
});
window.api.onMcpOpenFile((sessionId, data) => {
  recordFileTouched(sessionId, data && data.filePath, 'open');
});

// Re-show the recap when the OS window regains focus for the active session.
window.addEventListener('focus', () => {
  if (!gridViewActive && activeSessionId && openSessions.has(activeSessionId)) {
    handleSessionViewed(activeSessionId);
  }
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
// The OSC-9 regex now lives in public/attention-source.js (one source of truth,
// shared with the hook path). classifyAttentionSignal returns needs-attention for
// the four CLI notification types and ready for "waiting for your input".
window.api.onTerminalNotification((sessionId, message) => {
  applyAttention(sessionId, classifyAttentionSignal({ source: 'osc9', payload: message }));

  // Show in header if active
  if (sessionId === activeSessionId && terminalHeaderPtyTitle) {
    terminalHeaderPtyTitle.textContent = message;
    terminalHeaderPtyTitle.style.display = '';
  }
});

// --- Structured attention signals from Claude Code hooks (spec 05) ---
// main.js already normalized the raw hook JSON via attention-source.js; trust it.
window.api.onAttentionSignal((signal) => {
  if (!signal || !signal.sessionId) return;
  applyAttention(signal.sessionId, {
    kind: signal.kind,
    reason: signal.reason,
    source: signal.source || 'hook',
  });
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
  if (typeof updateCollapseAllToggle === 'function') updateCollapseAllToggle();
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

// --- Sidebar view mode toggle (directory-first <-> folder-first) ---
const VIEW_MODE_ICONS = {
  // Stacked folders: signals "folder-first" is active.
  folder: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.6a1 1 0 0 1 .8.4l1.2 1.6H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  // Directory tree: signals "directory-first" is active.
  directory: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><line x1="4" y1="6" x2="4.01" y2="6"/><line x1="4" y1="12" x2="4.01" y2="12"/><line x1="4" y1="18" x2="4.01" y2="18"/></svg>',
};
function updateViewModeToggle() {
  if (!viewModeToggle) return;
  const folderFirst = sidebarViewMode === 'folder';
  viewModeToggle.classList.toggle('active', folderFirst);
  viewModeToggle.title = folderFirst
    ? 'Folder-first layout (click for directory-first)'
    : 'Directory-first layout (click for folder-first)';
  viewModeToggle.setAttribute('aria-label', viewModeToggle.title);
  viewModeToggle.setAttribute('data-tooltip', viewModeToggle.title);
  viewModeToggle.innerHTML = folderFirst ? VIEW_MODE_ICONS.folder : VIEW_MODE_ICONS.directory;
}
if (viewModeToggle) {
  updateViewModeToggle();
  viewModeToggle.addEventListener('click', () => {
    sidebarViewMode = sidebarViewMode === 'folder' ? 'directory' : 'folder';
    localStorage.setItem('sidebarViewMode', sidebarViewMode);
    updateViewModeToggle();
    refreshSidebar({ resort: true });
  });
}

// --- Re-sort button ---
resortBtn.addEventListener('click', () => {
  loadProjects({ resort: true });
});

// --- Collapse / expand all ---
// Operates on every collapsible section in the session overview: project and
// worktree headers, auto slug groups, and user groups. They all share the
// `.collapsed` class, so "collapse all" adds it everywhere and "expand all"
// removes it. Slug/user-group collapse state is persisted via their existing
// helpers; project/worktree headers persist across re-renders via morphdom.
const COLLAPSIBLE_SECTION_SELECTOR = '.project-header, .worktree-header, .slug-group, .user-group, .ff-project-header';

function getCollapsibleSections() {
  return Array.from(sidebarContent.querySelectorAll(COLLAPSIBLE_SECTION_SELECTOR));
}

function updateCollapseAllToggle() {
  if (!collapseAllToggle) return;
  const sections = getCollapsibleSections();
  // "All collapsed" only when there is something to collapse and nothing is open.
  const allCollapsed = sections.length > 0 && sections.every(s => s.classList.contains('collapsed'));
  collapseAllToggle.classList.toggle('all-collapsed', allCollapsed);
  collapseAllToggle.disabled = sections.length === 0;
  collapseAllToggle.title = allCollapsed ? 'Expand all' : 'Collapse all';
  collapseAllToggle.setAttribute('aria-label', collapseAllToggle.title);
  collapseAllToggle.setAttribute('data-tooltip', collapseAllToggle.title);
  collapseAllToggle.innerHTML = allCollapsed
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 5 12 11 18 5"/><polyline points="6 13 12 19 18 13"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 11 12 5 18 11"/><polyline points="6 19 12 13 18 19"/></svg>';
}

function toggleCollapseAllSections() {
  const sections = getCollapsibleSections();
  if (sections.length === 0) return;
  // Collapse everything unless it's already all collapsed (then expand).
  const collapse = sections.some(s => !s.classList.contains('collapsed'));
  for (const section of sections) section.classList.toggle('collapsed', collapse);
  saveExpandedSlugs();
  saveCollapsedGroups();
  updateCollapseAllToggle();
}

if (collapseAllToggle) {
  collapseAllToggle.addEventListener('click', toggleCollapseAllSections);
  updateCollapseAllToggle();
}

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
  } else if (activeTab === 'work-files') {
    renderWorkFiles();
  }
}

searchClear.addEventListener('click', () => {
  clearSearch();
  searchInput.focus();
});

// Extracted so the rebuild-cache button and Enter handler can call it too.
async function runSearchQuery() {
  const query = searchInput.value.trim();
  if (!query) {
    clearSearch();
    return;
  }
  try {
    if (activeTab === 'sessions') {
      const results = await window.api.search('session', query, searchTitlesOnly);
      searchMatchIds = new Set(results.map(r => r.id));
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
    } else if (activeTab === 'work-files') {
      const results = await window.api.search('work-file', query, searchTitlesOnly);
      const matchIds = new Set(results.map(r => r.id));
      renderWorkFiles(matchIds);
    }
  } catch {
    if (activeTab === 'sessions') {
      searchMatchIds = null;
      searchMatchProjectPaths = null;
      refreshSidebar({ resort: true });
    }
  }
}

// Debounced search-as-you-type. Bumped from 200ms to 350ms — gentler under
// heavy workloads (many active subagents) and gives the user time to finish
// a word before searching. Explicit triggers (Enter, refresh button) bypass
// the debounce.
searchInput.addEventListener('input', () => {
  searchBar.classList.toggle('has-query', searchInput.value.length > 0);
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    runSearchQuery();
  }, 350);
});

// Enter in the search field = "I want fresh results": trigger a full worker
// reindex (which rewrites search_fts with the live content of active session
// JSONLs), then re-run the query. Pending debounce gets cancelled.
searchInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  await triggerRebuildAndSearch();
});

// Refresh button in the search bar — same behavior as pressing Enter.
const searchRefreshBtn = document.getElementById('search-refresh-btn');
if (searchRefreshBtn) {
  searchRefreshBtn.addEventListener('click', () => triggerRebuildAndSearch());
}

let rebuildInFlight = false;
async function triggerRebuildAndSearch() {
  if (rebuildInFlight) return;
  rebuildInFlight = true;
  if (searchRefreshBtn) searchRefreshBtn.classList.add('spinning');
  try {
    await window.api.rebuildCache();
  } catch {}
  finally {
    rebuildInFlight = false;
    if (searchRefreshBtn) searchRefreshBtn.classList.remove('spinning');
  }
  // After reindex, refire the current query so the user sees fresh hits.
  await runSearchQuery();
}

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
    // While the grid is open, keep it filled with every running session — newly
    // active sessions surface automatically (reattach only, never a new spawn).
    if (gridViewActive && typeof ensureGridActiveSessionsMounted === 'function') {
      ensureGridActiveSessionsMounted();
    }
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
      attentionReason.delete(id);
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
  // Update grid card dots and status text in place (shared with refreshGridView).
  if (typeof updateGridCardStatuses === 'function') updateGridCardStatuses();
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
  // Reloaded project data can carry new titles (user renames, AI titles, /title)
  // and membership changes; keep the grid view in sync too — otherwise grid cards
  // stay stale until the layout is reset or the grid is toggled off and on.
  if (gridViewActive) refreshGridView();
  renderDefaultStatus();
}

// Sidebar rendering (slugId, folderId, buildSlugGroup, renderProjects,
// rebindSidebarEvents, buildSessionItem, startRename) → sidebar.js


async function launchNewSession(project, sessionOptions, seedText, groupId) {
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
  // Launched from a group folder → assign before first paint so it appears in
  // the right group immediately (assignSessionToGroup persists + re-renders).
  if (groupId && typeof assignSessionToGroup === 'function') {
    assignSessionToGroup(sessionId, groupId);
  } else {
    refreshSidebar();
  }

  const entry = createTerminalEntry(session);

  // Open terminal in main process with session options
  const result = await window.api.openTerminal(sessionId, projectPath, true, sessionOptions || null);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    showSession(sessionId);
    return null;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  showSession(sessionId);
  pollActiveSessions();

  // For the guided handoff flow: seed the fresh session with the handoff packet
  // as its first message once the CLI has booted. Because we pass --session-id
  // (isNew), the session id stays this temp id, so we can seed it directly.
  if (seedText && String(seedText).trim()) {
    seedSessionWhenReady(sessionId, String(seedText));
  }

  return sessionId;
}

// Seed a freshly-launched session with its first message once the Claude CLI has
// booted and gone quiet. Rather than guessing a fixed delay, we watch
// lastActivityTime (populated by trackActivity for every session's output) for
// the boot UI to render and then settle. Best-effort: seeds anyway at timeout.
function seedSessionWhenReady(sessionId, seedText) {
  const SETTLE_MS = 700;
  const POLL_MS = 250;
  const MAX_WAIT_MS = 12000;
  const startedAt = Date.now();
  let seeded = false;

  function attempt() {
    if (seeded) return;
    const entry = openSessions.get(sessionId);
    if (!entry || entry.closed) return; // session closed before it was ready

    const last = lastActivityTime.get(sessionId);
    const quietFor = last ? Date.now() - last.getTime() : Infinity;
    const settled = last && quietFor >= SETTLE_MS;
    const timedOut = Date.now() - startedAt >= MAX_WAIT_MS;

    if (settled || timedOut) {
      seeded = true;
      // Bracketed paste keeps the multi-line markdown packet intact, then submit.
      window.api.sendInput(sessionId, `\x1b[200~${seedText}\x1b[201~\r`);
      recordTimelineEvent(sessionId, 'started', 'Handoff seeded', 'Seeded fresh session with the handoff packet.');
      return;
    }
    setTimeout(attempt, POLL_MS);
  }

  setTimeout(attempt, POLL_MS);
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

// Mount (attach) an already-running session's terminal WITHOUT switching the
// single-terminal view — used by the grid auto-open path so every active
// session surfaces as a card without the user clicking it first. The session is
// guaranteed live (it comes from activePtyIds), so the main-process
// open-terminal handler takes its reattach branch: we attach to the existing
// PTY and never spawn a new `claude` process. Returns true once a usable
// terminal entry exists. Callers batch these and trigger a single grid rebuild.
async function attachRunningSession(session) {
  const { sessionId, projectPath } = session;
  const existing = openSessions.get(sessionId);
  if (existing) {
    if (!existing.closed) return true; // already mounted — nothing to do
    destroySession(sessionId);
  }

  const entry = createTerminalEntry(session);
  // Resume options mirror openSession() (worktree stripped) so that, in the rare
  // race where the PTY exited between the last poll and now, the fallback spawn
  // still resumes the existing session rather than starting a fresh one.
  const resumeOptions = await resolveDefaultSessionOptions({ projectPath });
  if (resumeOptions) { delete resumeOptions.worktree; delete resumeOptions.worktreeName; }
  const result = await window.api.openTerminal(sessionId, projectPath, false, resumeOptions);
  if (!result || !result.ok) {
    if (result && result.error) entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return false;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);
  return true;
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
    workFilesContent.style.display = 'none';
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
    } else if (tabName === 'work-files') {
      searchBar.style.display = '';
      searchInput.placeholder = 'Search work files...';
      workFilesContent.style.display = '';
      loadWorkFiles();
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
  gridToggleBtn.title = gridViewActive ? 'Exit session overview' : 'Session overview';
  gridToggleBtn.setAttribute('aria-label', gridToggleBtn.title);
  gridToggleBtn.setAttribute('data-tooltip', gridToggleBtn.title);
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
    // Cmd/Ctrl+Shift+A (data-driven) → focus next session needing attention
    if (typeof isNextAttentionKey === 'function' && isNextAttentionKey(e, nextAttentionBinding)) {
      e.preventDefault();
      focusNextAttention();
      return;
    }
    // Session navigation: Cmd+Shift+[/], Cmd+Arrow
    handleSessionNavKey(e);
  });

  // Tray "Focus next attention" menu item (spec 01); guarded so it's a no-op
  // until that IPC bridge exists.
  if (window.api && typeof window.api.onFocusNextAttention === 'function') {
    window.api.onFocusNextAttention(() => focusNextAttention());
  }
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
    window._applyNotificationSettings(global);
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
    if (global.notifications) {
      window._setNotificationSettings(global.notifications);
    }
    if (global.terminalRightClick) terminalRightClickMode = global.terminalRightClick;
  }

  // Restore user-defined session groups (spec 07).
  try {
    groupsState = deserialize(await window.api.getSetting('groups'));
  } catch {
    groupsState = createGroupsState();
  }
  refreshSidebar();
})();

loadProjects().then(async () => {
  // Restore grid view preference before opening sessions so they enter grid mode
  if (localStorage.getItem('gridViewActive') === '1') {
    showGridView();
    // Auto-fill the grid with already-running sessions on launch. A fresh poll
    // refreshes activePtyIds (the idle cadence may not have run yet); its
    // handler then mounts them via ensureGridActiveSessionsMounted().
    pollActiveSessions();
  }
  if (isRendererReload) return;
  // Reopen the set of sessions that were open at the last ordinary quit.
  const restoredOpenSessions = await restoreOpenSessionsOnLaunch();
  if (restoredOpenSessions) return;
  // Fallback: restore the single active session (e.g. after a reload).
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

// --- Persist & restore open sessions across an ordinary quit → relaunch ---
// Mirrors the auto-update restart flow but uses a durable localStorage key that
// we refresh on every normal quit (not a one-shot). PTYs die when the app quits,
// so "persist" means re-open/resume the same sessions on next launch — exactly
// what the update path does.
function restoreOpenSessionsEnabled() {
  // Default ON: only an explicit `false` disables it.
  return !(appGlobalSettings && appGlobalSettings.restoreSessionsOnLaunch === false);
}

// Synchronous (runs from beforeunload/pagehide) — must not await anything.
function saveOpenSessionsState() {
  if (typeof collectUpdateRestartState !== 'function') return;
  if (!restoreOpenSessionsEnabled()) {
    try { localStorage.removeItem(OPEN_SESSIONS_STATE_KEY); } catch {}
    return;
  }
  const state = collectUpdateRestartState(openSessions, { activeSessionId, gridViewActive });
  try {
    if (typeof hasRestorableUpdateSessions === 'function' && hasRestorableUpdateSessions(state)) {
      localStorage.setItem(OPEN_SESSIONS_STATE_KEY, JSON.stringify(state));
    } else {
      localStorage.removeItem(OPEN_SESSIONS_STATE_KEY);
    }
  } catch {}
}

async function restoreOpenSessionsOnLaunch() {
  if (typeof hasRestorableUpdateSessions !== 'function') return false;
  // Read the live setting (the cached copy may not be populated yet at boot).
  try {
    const global = await window.api.getSetting('global');
    if (global && global.restoreSessionsOnLaunch === false) return false;
  } catch {}

  let state = null;
  try {
    state = JSON.parse(localStorage.getItem(OPEN_SESSIONS_STATE_KEY) || 'null');
  } catch {}
  // Durable key — left in place so a crash/forced-kill still restores next time;
  // it is refreshed on the next normal quit.
  if (!hasRestorableUpdateSessions(state)) return false;

  if (state.gridViewActive) {
    localStorage.setItem('gridViewActive', '1');
    if (!gridViewActive) showGridView();
  }

  const uniqueSessions = selectRestorableSessions(state, {
    lookup: (id) => sessionMap.get(id),
    isOpen: (id) => openSessions.has(id),
  });

  for (const session of uniqueSessions) {
    await openSession(session);
  }

  if (state.activeSessionId && openSessions.has(state.activeSessionId)) {
    showSession(state.activeSessionId);
  }
  return uniqueSessions.length > 0;
}

// Persist on the renderer unload that accompanies an ordinary quit. localStorage
// writes are synchronous and durable, so the blob survives to the next launch.
window.addEventListener('beforeunload', saveOpenSessionsState);
window.addEventListener('pagehide', saveOpenSessionsState);

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


// --- Initialize file panel (MCP bridge UI) ---
if (typeof initFilePanel === 'function') initFilePanel();
