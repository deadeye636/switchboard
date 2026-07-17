const statusBarInfo = document.getElementById('status-bar-info');
const statusBarUsage = document.getElementById('status-bar-usage');
const statusBarActivity = document.getElementById('status-bar-activity');
const terminalsEl = document.getElementById('terminals');
const sidebarContent = document.getElementById('sidebar-content');
const plansContent = document.getElementById('plans-content');
const placeholder = document.getElementById('placeholder');
const restoreProgressEl = document.getElementById('restore-progress');
const archiveToggle = document.getElementById('archive-toggle');
const starToggle = document.getElementById('star-toggle');
const searchInput = document.getElementById('search-input');
const terminalHeader = document.getElementById('terminal-header');
const terminalHeaderName = document.getElementById('terminal-header-name');
const terminalHeaderId = document.getElementById('terminal-header-id');
let headerRenaming = false; // true while the header title is being inline-renamed (issue #95)
const terminalHeaderStatus = document.getElementById('terminal-header-status');
const terminalHeaderShell = document.getElementById('terminal-header-shell');
const terminalVariablesBtn = document.getElementById('terminal-variables-btn');
const terminalStopBtn = document.getElementById('terminal-stop-btn');
const runningToggle = document.getElementById('running-toggle');
const todayToggle = document.getElementById('today-toggle');
const favoriteToggle = document.getElementById('favorite-toggle');
const projectTagFilters = document.getElementById('project-tag-filters');
const springCleaningBtn = document.getElementById('spring-cleaning-btn');
const planViewer = document.getElementById('plan-viewer');
const planPanel = new ViewerPanel(planViewer, {
  copyPath: true, copyContent: true,
  language: 'markdown', storageKey: 'markdownPreviewMode',
  onSave: (filePath, content) => window.api.savePlan(filePath, content),
});

// currentPlanContent, currentPlanFilePath, currentPlanFilename → plans-memory-view.js
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
const projectsViewer = document.getElementById('projects-viewer');
const tasksViewer = document.getElementById('tasks-viewer');
const bookmarksViewer = document.getElementById('bookmarks-viewer');
const variablesAdminContent = document.getElementById('variables-admin-content');
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
// Project sorting (#17). Persisted in localStorage, render-synchronous.
//
// Two layers since #181. The SAVED value comes from Settings and is the fallback and the source of
// truth; the View menu in the sidebar sets an OVERRIDE that lives for this run of the app only — it is
// never written anywhere, so a restart is back to what Settings says. `projectSortMode` and
// `favoritesOwnList` are the EFFECTIVE values the renderers read: the override if there is one, the
// saved value otherwise.
let savedProjectSortMode = (() => {
  const m = localStorage.getItem('projectSortMode');
  return m === 'alpha' || m === 'manual' ? m : 'activity';
})();
// Favorites presentation: false = favorites pinned on top (block + divider);
// true ("Eigene Favoritenliste") = favorites only via the star filter, not pinned.
let savedFavoritesOwnList = localStorage.getItem('favoritesOwnList') === '1';
let sortOverride = null;   // { projectSortMode, favoritesOwnList } — this session only, never persisted
let projectSortMode = savedProjectSortMode;
let favoritesOwnList = savedFavoritesOwnList;
let projectOrder = (() => {
  try { const a = JSON.parse(localStorage.getItem('projectOrder')); return Array.isArray(a) ? a : []; }
  catch { return []; }
})();
const navigationEntry = performance.getEntriesByType?.('navigation')?.[0];
const isRendererReload = navigationEntry?.type === 'reload';

// Map<sessionId, { terminal, element, fitAddon, session, closed }>
const openSessions = new Map();
window._openSessions = openSessions;
// Sessions the user deliberately stopped/archived. onProcessExited suppresses the
// "exited (code 1) — re-click to relaunch" banner and the timed auto-close for these
// (both are meant for sessions that end on their own), and closes the tab cleanly.
const userStoppedSessions = new Set();
window._markUserStopped = (id) => { if (id) userStoppedSessions.add(id); };
let activeSessionId = sessionStorage.getItem('activeSessionId') || null;

// Visit history (#36). setActiveSession is the choke point every focus path funnels
// through — showSession, focusGridCard, tabs, the attention inbox — so recording
// here catches them all. `navigatingHistory` suppresses the record while a
// back/forward jump is in flight: without it the jump would append itself and
// destroy the forward tail, degrading back/forward into "toggle the last two".
const sessionHistory = createSessionHistory();
let navigatingHistory = false;

function setActiveSession(id) {
  activeSessionId = id;
  if (id) sessionStorage.setItem('activeSessionId', id);
  else sessionStorage.removeItem('activeSessionId');
  if (id && !navigatingHistory) visitSession(sessionHistory, id);
  // Update file panel to show this session's open files/diffs
  if (typeof switchPanel === 'function') switchPanel(id);
}

// A history entry is navigable only while its session is still mounted — a closed
// or evicted session would otherwise be a dead jump target.
function sessionHistoryAlive(sessionId) {
  const entry = openSessions.get(sessionId);
  return !!entry && !entry.closed;
}

// Step through the visit history. Direction: -1 back, +1 forward.
function navigateSessionHistory(direction) {
  const target = direction < 0
    ? historyBack(sessionHistory, sessionHistoryAlive)
    : historyForward(sessionHistory, sessionHistoryAlive);
  if (!target || target === activeSessionId) return;
  navigatingHistory = true;
  try {
    if (gridViewActive) focusGridCard(target);
    else showSession(target);
  } finally {
    navigatingHistory = false;
  }
}
// Persist slug group expand state across reloads AND restarts (localStorage, so
// the "letzter Stand" collapse-default actually survives an app restart).
function getExpandedSlugs() {
  return new Set(readLsJson('expandedSlugs', '[]'));
}
function saveExpandedSlugs() {
  const expanded = [];
  document.querySelectorAll('.slug-group:not(.collapsed)').forEach(g => { if (g.id) expanded.push(g.id); });
  localStorage.setItem('expandedSlugs', JSON.stringify(expanded));
}
// Explicit per-project collapse state (keyed by projectPath) so the "last state"
// startup default also remembers top-level project headers — which otherwise only
// follow a render-time age heuristic and aren't persisted. { path: true|false }.
function getProjectCollapseState() {
  return readLsJson('projectCollapseState', '{}');
}
function setProjectCollapsed(projectPath, collapsed) {
  if (!projectPath) return;
  const s = getProjectCollapseState();
  s[projectPath] = !!collapsed;
  try { localStorage.setItem('projectCollapseState', JSON.stringify(s)); } catch { /* ignore */ }
}
let showArchived = false;
let showStarredOnly = false;
let showRunningOnly = false;
let showTodayOnly = false;
let showFavoritedProjectsOnly = false;
// Project tag filter (#98): AND multi-select of colored chips. activeProjectTagFilter
// holds the selected tags; projectTagMap is projectPath -> Set<tag> for matching.
let activeProjectTagFilter = new Set();
let projectTagMap = new Map();
// Session tag filter (#164), in the SAME chip bar. A project tag drops whole projects; a session tag
// drops session rows and a project disappears as a consequence. Selected together they AND across the
// two kinds — "sessions tagged bug IN projects tagged kunde" — which is the reason they share one bar.
let activeSessionTagFilter = new Set();
let sessionTagMap = new Map();
let cachedProjects = [];
let cachedAllProjects = [];
let loadProjectsGen = 0; // bumped per loadProjects() call; stale responses bail (issue #75)
let activePtyIds = new Set();
let sortedOrder = []; // [{ projectPath, itemIds: [itemId, ...] }, ...] — single source of truth for sidebar order
let activeTab = 'sessions';
let cachedPlans = [];
let visibleSessionCount = 10;
let sessionMaxAgeDays = 3;
const pendingSessions = new Map(); // sessionId → { session, projectPath, folder }

// Inject a pending (not-yet-on-disk) session into the cached project lists so
// the sidebar shows it immediately. Shared by the new-session/new-terminal
// dialogs and the refresh reconcile loop (#79). The default list mirrors the
// backend's archive exclusion: don't inject an archived pending session there,
// or an otherwise-empty project looks non-empty and the sidebar's "all filtered
// out" guard drops the whole project (kept in the archived list so undo still
// works). Re-injection on refresh is deduped by sessionId.
function injectPendingSession(session, projectPath, folder) {
  for (const projList of [cachedProjects, cachedAllProjects]) {
    if (projList === cachedProjects && session && session.archived) continue;
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, sessions: [] };
      projList.unshift(proj);
    }
    if (!proj.sessions.some(s => s.sessionId === session.sessionId)) {
      proj.sessions.unshift(session);
    }
  }
}

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
  // Sticky attention inbox (default on) — pure CSS, toggled on the scroll container.
  const sidebarContentEl = document.getElementById('sidebar-content');
  if (sidebarContentEl) {
    sidebarContentEl.classList.toggle('sticky-inbox', appGlobalSettings.stickyAttentionInbox !== false);
  }
  // #112: apply the subagent live-status toggle to the overlay right away.
  if (appGlobalSettings.subagentLiveStatus === false) {
    if (subagentActiveSessions.size) { subagentActiveSessions.clear(); refreshSessionStatusViews(); }
  } else {
    if (typeof window._liveSubagentParents === 'function') {
      for (const p of window._liveSubagentParents()) recomputeSubagentActive(p);
    }
  }
};

function getNextAttentionBinding() {
  return nextAttentionBinding;
}

// Live-apply the terminal right-click behavior (terminalRightClickMode lives in
// terminal-context-menu.js); takes effect on the next right-click, no relaunch.
window._applyTerminalRightClick = (mode) => {
  terminalRightClickMode = mode || 'menu';
  // Leaving 'action-bar' mode: drop any open selection bar (#88).
  if (typeof closeSelectionBar === 'function') closeSelectionBar();
};
// Live-apply terminal mouse mode (setTerminalMouseReporting lives in
// terminal-manager.js). 'native' | 'select' (local left-drag select + native
// wheel) | 'off' (strip all mouse-tracking). Resets open terminals immediately.
window._applyTerminalMouseReporting = (mode) => { if (typeof setTerminalMouseReporting === 'function') setTerminalMouseReporting(mode); };
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
// Subagent activity overlay (#112). Not a status of its own: with async subagents
// the parent keeps generating, so it stays Working/Running and merely gains a
// two-color dot. Membership follows the live-subagent set, which the
// SubagentStart/SubagentStop hooks drive exactly and the JSONL scan backs up (#119).
const subagentActiveSessions = new Set();
const finishedAt = new Map(); // sessionId → ms timestamp of the last busy→idle edge (drives running-in-inbox)
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
  // During the launch restore the whole view settles once at the end; skip the
  // per-session churn that pollActiveSessions would otherwise trigger N times.
  if (typeof window !== 'undefined' && window.__restoringOpenSessions) return;
  if (activeTab === 'sessions') {
    // Status edges fire per session activity — patch the rendered DOM in place
    // (#80) and fall back to the full rebuild when the patcher can't (running
    // filter active, sidebar not rendered yet).
    if (typeof patchSidebarStatuses !== 'function' || !patchSidebarStatuses()) refreshSidebar();
  }
  if (gridViewActive) refreshGridView();
  // Tabs read their status at render time, and were only repainted when something
  // else happened to call loadProjects(). Patch them on the edge itself (#124).
  if (typeof window.patchTabStatuses === 'function' && !window.patchTabStatuses()) {
    if (typeof window.refreshSessionTabs === 'function') window.refreshSessionTabs();
  }
  announceAttentionSummary();
  syncNativeNotifications();
}

// --- Running sessions in the attention inbox (configurable) ---
// A live-but-idle terminal isn't inherently "your turn". The inbox membership of
// `running` sessions is therefore user-configurable; the classification itself
// lives in the pure session-status.js helper (inboxIncludes). We only feed it the
// current setting + `finishedAt` map. Default 'until-read': a session that
// finished while you were looking at it stays in the inbox until you open it,
// nothing silently drops.
let runningInboxSetting = { mode: 'until-read', minutes: 5 };
const RUNNING_INBOX_MODES = ['always', 'never', 'after-finish', 'until-read', 'timed'];

// Runtime fields the inbox filter needs, merged into every runtime snapshot that
// feeds getAttentionInboxItems / getNextAttentionInboxItem.
function attentionInboxRuntimeFields() {
  return {
    finishedAt,
    runningInboxMode: runningInboxSetting.mode,
    runningInboxMinutes: runningInboxSetting.minutes,
    now: Date.now(),
  };
}

// Window-based modes ('after-finish', 'timed') need a heartbeat: a finished
// session must drop out of the inbox once its window elapses even when no other
// event fires a re-render.
let runningInboxTick = null;
function ensureRunningInboxTick() {
  const need = runningInboxSetting.mode === 'after-finish' || runningInboxSetting.mode === 'timed';
  if (need && !runningInboxTick) {
    runningInboxTick = setInterval(() => { if (finishedAt.size) refreshSessionStatusViews(); }, 30000);
  } else if (!need && runningInboxTick) {
    clearInterval(runningInboxTick);
    runningInboxTick = null;
  }
}

// Bridge for settings-panel.js so the toggle applies live without a restart.
window._setRunningInboxSetting = (cfg) => {
  runningInboxSetting = {
    mode: RUNNING_INBOX_MODES.includes(cfg?.mode) ? cfg.mode : 'until-read',
    minutes: cfg?.minutes > 0 ? cfg.minutes : 5,
  };
  ensureRunningInboxTick();
  refreshSessionStatusViews();
};

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
    ...attentionInboxRuntimeFields(),
  };
}

// Open/focus a single attention inbox item. Shared so the sidebar "Focus next"
// button and the keyboard shortcut stay in sync.
function focusAttentionItem(item) {
  if (!item || !item.session) return;
  openSession(item.session);
  // Mirror the native-notification path (onFocusSession): openSession doesn't
  // clear the inbox state synchronously for a session not yet open in this
  // renderer, so clear it here too or the item lingers after being opened (#92).
  clearNotifications(item.session.sessionId);
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
// Recompute the subagent-activity overlay for one session. Gated by the subagent
// live-status setting (default on).
function recomputeSubagentActive(sessionId) {
  if (!sessionId) return;
  const enabled = !(typeof appGlobalSettings !== 'undefined' && appGlobalSettings.subagentLiveStatus === false);
  const liveCount = (typeof window._liveSubagentCount === 'function') ? window._liveSubagentCount(sessionId) : 0;
  const active = enabled && liveCount > 0;
  const had = subagentActiveSessions.has(sessionId);
  if (active) subagentActiveSessions.add(sessionId);
  else subagentActiveSessions.delete(sessionId);
  if (had !== active) refreshSessionStatusViews();
}
// Called by sidebar.js whenever the live-subagent set changes.
window._recomputeSubagentActive = recomputeSubagentActive;

function setActivity(sessionId, active) {
  if (responseReadySessions.has(sessionId)) {
    return;
  }

  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);

  if (active && !wasActive) {
    // New work started → any earlier "finished" stamp is stale.
    finishedAt.delete(sessionId);
  } else if (wasActive && !active) {
    // busy→idle edge: stamp the finish time. Unfocused sessions become
    // response-ready below; for the focused-then-left case this stamp is what
    // lets the configurable running-inbox (after-finish / until-read) surface it.
    finishedAt.set(sessionId, Date.now());
  }

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
    // A new turn started → clear any stale "ready" so the session flips to Working
    // even if it was left ready-but-unfocused (setActivity ignores busy while
    // response-ready is set).
    if (responseReadySessions.has(sessionId)) {
      responseReadySessions.delete(sessionId);
      const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
      if (item) item.classList.remove('response-ready');
    }
    setActivity(sessionId, true);
  } else if (kind === 'subagent-live-start' || kind === 'subagent-live-stop') {
    // Exact subagent edges from the SubagentStart/SubagentStop hooks (#119). The
    // JSONL scan writes to the same set, so a subagent seen twice counts once.
    if (signal.agentId && typeof window._setSubagentLive === 'function') {
      window._setSubagentLive(sessionId, signal.agentId, kind === 'subagent-live-start', 'hook');
    }
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
  // Opening the session settles it — drop the finish stamp so it won't reappear
  // in the running-inbox (until-read removal / after-finish "you looked"). A
  // running session isn't in attentionSessions, so this stamp removal is the
  // *only* state change for until-read — fold it into the re-render guard or the
  // item lingers until some unrelated event repaints the sidebar.
  // Exception: 'timed' keeps the session for its full window regardless of
  // opening (removal only by timeout), so the stamp must survive a focus there.
  const stampCleared = runningInboxSetting.mode === 'timed' ? false : finishedAt.delete(sessionId);
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) item.classList.remove('needs-attention');
  if (changed || stampCleared) refreshSessionStatusViews();
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

// The "while you were away" recap banner — the file-touch tracking, the banner and its dismissal —
// is shell/away-summary-banner.js (#218), beside the pure shell/away-summary.js it renders. It owns
// its own state; app.js calls into it at recordFileTouched and handleSessionViewed.
// Terminal themes, utils (cleanDisplayName, formatDate, escapeHtml, shellEscape)
// are defined in terminal-themes.js and utils.js (loaded before app.js).

// Terminal key bindings, write buffering, isAtBottom, safeFit, fitAndScroll → terminal-manager.js

// --- IPC listeners from main process ---

window.api.onTerminalData((sessionId, data) => {
  const entry = openSessions.get(sessionId);
  if (entry) {
    // PTY flow control: count received bytes; terminal-manager pauses the PTY
    // when too much output is in flight and resumes once xterm caught up (#81).
    if (typeof flowTrackReceived === 'function') flowTrackReceived(sessionId, data.length);
    let buf = terminalWriteBuffers.get(sessionId);
    if (!buf) {
      buf = { chunks: [], rafId: 0, timerId: 0 };
      terminalWriteBuffers.set(sessionId, buf);
    }
    buf.chunks.push(data);

    // DEC-2026 synchronized output is handled natively by xterm 6 (it defers painting
    // while ?2026h is active and flushes atomically on ?2026l). No app-level sync
    // buffering needed: the old syncDepth guard was redundant and mis-counted mixed
    // ?2026h/l markers landing in one coalesced IPC chunk, sticking syncDepth > 0 and
    // holding data until a 500 ms timeout — which left the prompt/status blank (#85).
    // Just coalesce writes on the next frame; xterm keeps redraws atomic.
    scheduleFlush(sessionId, buf);
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
    // Re-key only: the pending shape is { session, projectPath, folder } with no
    // own sessionId field (the Map key carries it); entry.session.sessionId was
    // already updated above (issue #75 — removed a dead write to a phantom field).
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

// Clear the main terminal area to the idle placeholder (no active session).
// Exposed for the session-tabs close fallback: when the closed tab was the active
// one and no other tab remains, the strip has nothing to switch to.
window.clearActiveTerminalView = function () {
  setActiveSession(null);
  terminalHeader.style.display = 'none';
  placeholder.style.display = '';
};

window.api.onProcessExited((sessionId, exitCode) => {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId);
  const userStopped = userStoppedSessions.has(sessionId);
  userStoppedSessions.delete(sessionId);
  if (entry) {
    entry.closed = true;
    recordTimelineEvent(sessionId, 'exited', 'Process exited', `Exit code ${exitCode}.`);
    // Write a visible exit banner so the user can see when the process ended
    // and read any error output it printed (claude / devbox / shell stderr).
    // Without this, a fast-failing pre-launch command would tear down the
    // terminal before the user could read the error. Skip it for a deliberate
    // stop/archive — the "re-click to relaunch" hint is misleading there.
    if (!userStopped) {
      try {
        const colour = exitCode === 0 ? '\x1b[2m' : '\x1b[33m';
        entry.terminal.write(
          `\r\n${colour}── session exited (code ${exitCode}) — re-click this session in the sidebar to relaunch, or click another to dismiss ──\x1b[0m\r\n`
        );
      } catch {}
    }
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

  // A deliberately stopped session leaves the grid with its process (#130). One
  // that died on its own keeps its card, so the exit banner stays readable and the
  // session can be relaunched from it. destroySession drops the card and fixes the
  // header count; showGridView reflows the survivors into the freed slot.
  if (gridViewActive && userStopped) {
    destroySession(sessionId);
    showGridView();
  }

  if (gridViewActive) {
    gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  }

  if (userStopped) {
    // Deliberate stop/archive: close the tab now (no timed auto-close, no banner).
    // closeTabNow switches to a neighbour tab or the placeholder in tabs mode; a
    // no-op in grid/legacy where the stop/archive handlers manage the view.
    if (typeof window.closeTabNow === 'function') window.closeTabNow(sessionId);
  } else if (typeof window.scheduleTabAutoClose === 'function') {
    // Tabs mode: optionally auto-close the tab after the exit (setting-driven; the
    // scheduler no-ops in grid mode and honours the mode/delay from settings).
    window.scheduleTabAutoClose(sessionId, exitCode);
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

// --- Session notices (#151) ---
// Something the app knows about the session that the session itself cannot say — today: its backend has
// no record of it, so no busy/idle state can be shown. Deliberately a toast and NOT an attention signal:
// nothing is waiting for the user, and lighting the row up would be a lie of a different kind.
window.api.onSessionNotice((sessionId, message) => {
  if (!message || typeof showControlToast !== 'function') return;
  const session = sessionMap.get(sessionId);
  const name = session ? (session.name || session.aiTitle || session.summary || '') : '';
  showControlToast({ message: name ? `${name}: ${message}` : message, timeoutMs: 8000 });
});

// --- Structured attention signals from Claude Code hooks (spec 05) ---
// main.js already normalized the raw hook JSON via attention-source.js; trust it.
window.api.onAttentionSignal((signal) => {
  if (!signal || !signal.sessionId) return;
  applyAttention(signal.sessionId, {
    kind: signal.kind,
    reason: signal.reason,
    source: signal.source || 'hook',
    agentId: signal.agentId || null,
    agentType: signal.agentType || null,
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

  // Mixed-mode decision for the provider badges (T-3.1/T-3.4): recomputed from the full session set
  // (not the filtered one) so a search doesn't flip badges on and off. A single-backend user gets no
  // badges at all — the app looks exactly as it did before multi-LLM.
  if (typeof computeShowAllBadges === 'function') {
    const all = [];
    // A terminal tab (plain Terminal, or a Tier-3 custom launcher, T-3.10) is NOT a backend
    // session: it has no provenance, so sessionBackendId would read it as Claude and a single
    // terminal tab could flip a Codex-only user into mixed mode. The sidebar skips it for the
    // badge too — keep the counting side in step.
    //
    // Only a session of an ENABLED backend counts (§5.8: disabling removes a backend from the
    // mixed-mode counting — its history stays visible, it just stops making the app "mixed").
    // Otherwise one Codex session from months ago badges every row forever, and turning Codex off
    // would not stop it.
    for (const p of (cachedAllProjects || [])) {
      for (const s of (p.sessions || [])) {
        if (s.type === 'terminal') continue;
        if (typeof isBackendEnabled === 'function' && !isBackendEnabled(sessionBackendId(s))) continue;
        all.push(s);
      }
    }
    computeShowAllBadges(all);
  }

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

  // Project tag filter (#98): AND match — keep only projects carrying every
  // selected tag. No-op when nothing is selected. Pure logic in project-tags-filter.js.
  if (activeProjectTagFilter.size > 0 && typeof filterProjectsByTags === 'function') {
    projects = filterProjectsByTags(projects, projectTagMap, activeProjectTagFilter);
  }

  // Session tag filter (#164): one axis down — keep the sessions carrying every selected session tag,
  // and drop the projects left with none. Applied AFTER the project filter, so the two AND together.
  if (activeSessionTagFilter.size > 0 && typeof filterProjectSessionsByTags === 'function') {
    projects = filterProjectSessionsByTags(projects, sessionTagMap, activeSessionTagFilter);
  }

  renderProjects(projects, resort);
  if (typeof updateCollapseAllToggle === 'function') updateCollapseAllToggle();
}

// --- The tag filter chip bar (#98 project tags, #164 session tags) ---
//
// ONE bar, two kinds: project chips, a separator, session chips. They are not the same thing — a project
// chip drops whole PROJECTS, a session chip drops session ROWS and a project disappears only as a
// consequence — and their names live in separate namespaces, so the same word can be both. A separator
// alone would leave two identical-looking chips doing different things, with position carrying the whole
// distinction; each chip therefore says what it is (a folder glyph, or a #).
//
// Selected together they AND across the kinds: "sessions tagged bug IN projects tagged kunde". That cross
// filter is exactly why both live in one bar instead of behind a Projects/Sessions switch.
const TAG_KIND_GLYPH = {
  // A folder for the project kind, a # for the session kind. Deliberately small — the tag's colour is
  // still what you read first.
  project: '<svg class="tag-chip-glyph" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.6a1 1 0 0 1 .8.4l1.2 1.6H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  session: '<span class="tag-chip-glyph tag-chip-hash">#</span>',
};

// Tag state (#138): a *disabled* tag renders no chip anywhere, so it leaves the matching map too. A
// *hidden* tag keeps its chips on the cards but drops out of the filter bar — it is still attached, just
// not something you filter by any more.
function _tagBarSlice(rows, activeSet) {
  const assigned = (rows || []).filter(r => r && r.tag && !r.disabled);
  const tags = [...new Set(assigned.filter(r => !r.hidden).map(r => r.tag))].sort();
  // Drop selections whose tag is gone, hidden or disabled — otherwise a filter stays active with no chip
  // left to switch it off.
  for (const t of [...activeSet]) {
    if (!tags.includes(t)) activeSet.delete(t);
  }
  // Colour comes from the tag def (#138), so every row for a tag carries the same value.
  const colorByTag = new Map();
  for (const r of assigned) {
    if (r.color && !colorByTag.has(r.tag)) colorByTag.set(r.tag, r.color);
  }
  return { assigned, tags, colorByTag };
}

function _tagChipsHtml(kind, tags, colorByTag, activeSet) {
  const pickColor = (window.bookmarksTags && typeof window.bookmarksTags.pickColor === 'function')
    ? window.bookmarksTags.pickColor
    : () => '#61afef';
  return tags.map(tag => {
    const color = colorByTag.get(tag) || pickColor(tag);
    const active = activeSet.has(tag);
    const style = active
      ? `background:${color};border-color:${color};color:#1a1a1a`
      : `background:${color}1a;border-color:${color};color:${color}`;
    return `<button type="button" class="project-tag-chip${active ? ' active' : ''}" data-kind="${kind}"`
      + ` data-tag="${escapeHtml(tag)}" style="${style}" aria-pressed="${active}"`
      + ` title="${kind === 'project' ? 'Project tag — filters projects' : 'Session tag — filters sessions'}">`
      + `${TAG_KIND_GLYPH[kind]}<span>${escapeHtml(tag)}</span></button>`;
  }).join('');
}

async function _refreshProjectTagFilter() {
  let projectRows = [];
  let sessionRows = [];
  try { projectRows = await window.api.projectTagsAll(); } catch { projectRows = []; }
  try { sessionRows = await window.api.sessionTagsAll(); } catch { sessionRows = []; }

  const proj = _tagBarSlice(projectRows, activeProjectTagFilter);
  const sess = _tagBarSlice(sessionRows, activeSessionTagFilter);

  projectTagMap = (typeof buildProjectTagMap === 'function') ? buildProjectTagMap(proj.assigned) : new Map();
  sessionTagMap = (typeof buildSessionTagMap === 'function') ? buildSessionTagMap(sess.assigned) : new Map();

  if (!projectTagFilters) return;
  if (proj.tags.length === 0 && sess.tags.length === 0) {
    projectTagFilters.innerHTML = '';
    applyProjectTagFilterVisibility();
    return;
  }

  // The separator only exists when it separates something.
  const sep = (proj.tags.length > 0 && sess.tags.length > 0) ? '<span class="tag-filter-sep" aria-hidden="true"></span>' : '';
  projectTagFilters.innerHTML =
    _tagChipsHtml('project', proj.tags, proj.colorByTag, activeProjectTagFilter)
    + sep
    + _tagChipsHtml('session', sess.tags, sess.colorByTag, activeSessionTagFilter);
  applyProjectTagFilterVisibility();
}
window._refreshProjectTagFilter = _refreshProjectTagFilter;

// The chips filter the project list, so they belong to the Sessions tab only —
// they were left standing over Plans / Memory / Work files, where nothing they
// filter is even on screen (#133). Sole owner of the bar's display state: the
// renderer above and the tab switcher both defer to it.
function applyProjectTagFilterVisibility() {
  if (!projectTagFilters) return;
  const hasChips = projectTagFilters.children.length > 0;
  projectTagFilters.style.display = (hasChips && activeTab === 'sessions') ? 'flex' : 'none';
}

if (projectTagFilters) {
  projectTagFilters.addEventListener('click', (e) => {
    const chip = e.target.closest('.project-tag-chip');
    if (!chip) return;
    const tag = chip.dataset.tag;
    // The chip says which kind it is; the two selections are separate sets and AND together (#164).
    const active = chip.dataset.kind === 'session' ? activeSessionTagFilter : activeProjectTagFilter;
    if (active.has(tag)) active.delete(tag);
    else active.add(tag);
    _refreshProjectTagFilter();
    refreshSidebar({ resort: true });
  });
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

// --- Favorite-projects filter toggle (project-level, not session-level) ---
if (favoriteToggle) {
  favoriteToggle.addEventListener('click', () => {
    showFavoritedProjectsOnly = !showFavoritedProjectsOnly;
    favoriteToggle.classList.toggle('active', showFavoritedProjectsOnly);
    refreshSidebar({ resort: true });
  });
}
// The star filter only makes sense when favorites are a separate list. When they
// are pinned on top (favoritesOwnList off) the filter is redundant → hide it (and
// drop any active filter so the pinned list shows).
function updateFavoriteToggleVisibility() {
  if (!favoriteToggle) return;
  if (favoritesOwnList) {
    favoriteToggle.style.display = '';
  } else {
    favoriteToggle.style.display = 'none';
    if (showFavoritedProjectsOnly) {
      showFavoritedProjectsOnly = false;
      favoriteToggle.classList.remove('active');
    }
  }
}
updateFavoriteToggleVisibility();

// --- Project sort settings (#17) ---
// projectSortMode + favoritesOwnList live in the global settings blob (chosen in
// the Session Display settings). Mirror them into the render-time vars (+ a
// localStorage cache for the first paint) and re-render when they change.
window._applyProjectSortSettings = (g) => {
  if (!g) return;
  savedProjectSortMode = (g.projectSortMode === 'alpha' || g.projectSortMode === 'manual') ? g.projectSortMode : 'activity';
  savedFavoritesOwnList = !!g.favoritesOwnList;
  localStorage.setItem('projectSortMode', savedProjectSortMode);
  localStorage.setItem('favoritesOwnList', savedFavoritesOwnList ? '1' : '0');
  applyEffectiveSort();
};

// --- The View menu's sort override (#181) ---
// Settings holds the sort. The View menu in the sidebar can put a different one in front of you for
// THIS RUN of the app — never written anywhere, so a restart is back to what Settings says, and a Save
// in Settings is never something the sidebar did behind your back.
function applyEffectiveSort() {
  projectSortMode = sortOverride ? sortOverride.projectSortMode : savedProjectSortMode;
  favoritesOwnList = sortOverride ? sortOverride.favoritesOwnList : savedFavoritesOwnList;
  if (typeof updateFavoriteToggleVisibility === 'function') updateFavoriteToggleVisibility();
  if (typeof window._renderViewMenu === 'function') window._renderViewMenu();
  if (typeof window._updateViewMenuBtn === 'function') window._updateViewMenuBtn();
  if (typeof refreshSidebar === 'function') refreshSidebar({ resort: true });
}

// What the View menu shows and edits. `overridden` is the difference between the two, and it is what the
// menu has to say out loud — an order you cannot tell from the saved one is how you end up "fixing" a
// setting that was never wrong.
window._getSortView = () => ({
  projectSortMode,
  favoritesOwnList,
  savedProjectSortMode,
  savedFavoritesOwnList,
  overridden: !!sortOverride
    && (sortOverride.projectSortMode !== savedProjectSortMode
      || sortOverride.favoritesOwnList !== savedFavoritesOwnList),
});

// A patch from the menu. It always lands in the override — even when it happens to equal the saved value,
// because "I chose this" and "nobody said otherwise" are different states, and only the reset clears it.
window._setSortOverride = (patch) => {
  const next = {
    projectSortMode: projectSortMode,
    favoritesOwnList: favoritesOwnList,
    ...(patch || {}),
  };
  sortOverride = next;
  applyEffectiveSort();
};

window._resetSortOverride = () => {
  sortOverride = null;
  applyEffectiveSort();
};
// Persist the manual project order (written by drag-reorder in the sidebar).
window._persistProjectOrder = (arr) => {
  projectOrder = Array.isArray(arr) ? arr.slice() : [];
  localStorage.setItem('projectOrder', JSON.stringify(projectOrder));
};

// --- Refresh button ---
// Reloads the project list from main (filesystem reconcile + backend scan) and
// rebuilds the order from it. The only sidebar control that goes back to main —
// the filter and view toggles re-sort the already-loaded data (#180).
resortBtn.addEventListener('click', () => {
  loadProjects({ resort: true });
});

// --- Collapse / expand all ---
// Operates on every collapsible section in the session overview: project and
// worktree headers, and auto slug groups. They all share the `.collapsed` class,
// so "collapse all" adds it everywhere and "expand all" removes it. Slug collapse
// state is persisted via its existing helpers; project/worktree headers persist
// across re-renders via morphdom.
const COLLAPSIBLE_SECTION_SELECTOR = '.project-header, .worktree-header, .slug-group';

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

// Apply the startup collapse default (sidebarCollapseDefault setting):
// 'expanded' / 'collapsed' force all sections; 'remember' leaves the persisted
// state alone. Called once after the initial sidebar render.
function applyCollapseDefault(mode) {
  if (mode !== 'expanded' && mode !== 'collapsed') return; // 'remember' = persisted state
  const sections = getCollapsibleSections();
  if (sections.length === 0) return;
  const collapse = mode === 'collapsed';
  for (const section of sections) section.classList.toggle('collapsed', collapse);
  saveExpandedSlugs();
  if (typeof updateCollapseAllToggle === 'function') updateCollapseAllToggle();
}

function toggleCollapseAllSections() {
  const sections = getCollapsibleSections();
  if (sections.length === 0) return;
  // Collapse everything unless it's already all collapsed (then expand).
  const collapse = sections.some(s => !s.classList.contains('collapsed'));
  for (const section of sections) section.classList.toggle('collapsed', collapse);
  saveExpandedSlugs();
  updateCollapseAllToggle();
}

if (collapseAllToggle) {
  collapseAllToggle.addEventListener('click', toggleCollapseAllSections);
  updateCollapseAllToggle();
}

// --- Global settings gear button ---
globalSettingsBtn.innerHTML = ICONS.gear(18);
globalSettingsBtn.addEventListener('click', async () => {
  // Default action respects the settingsOpenMode preference: in-app overlay or
  // a standalone window.
  let mode = 'overlay';
  try { mode = (await window.api.getSetting('global'))?.settingsOpenMode || 'overlay'; } catch {}
  if (mode === 'window') window.api.openSettingsWindow();
  else openSettingsViewer('global');
});

// --- Add project button ---
addProjectBtn.addEventListener('click', () => {
  showAddProjectDialog();
});

syncTitleToAriaLabel(document);

// --- Search (debounced, per-tab FTS) ---
// Trigram tokenizer makes 1-2 char queries the most expensive (they match
// enormous row sets). Treat any query shorter than this as "no filter".
const MIN_SEARCH_CHARS = 3;

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
    // resort: true — sortedOrder was overwritten during the search render to
    // contain only matched projects; resorting from data is required to restore
    // the correct full-list order.
    refreshSidebar({ resort: true });
  } else if (activeTab === 'plans') {
    renderPlans(cachedPlans);
  } else if (activeTab === 'memory') {
    renderMemories();
  } else if (activeTab === 'work-files') {
    renderWorkFiles();
  }
}

// Reset search filter state without clearing the input text.
// Used when the query drops below MIN_SEARCH_CHARS while the user is still
// typing — we want no results filter applied, but we must not wipe the
// partially-typed text.
function resetSearchFilter() {
  if (activeTab === 'sessions') {
    searchMatchIds = null;
    searchMatchProjectPaths = null;
    // resort: true — same reason as clearSearch: sortedOrder may be stale if a
    // prior 3+ char search ran (and overwrote it with the filtered subset).
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
  // 1-2 char queries are the most expensive for the trigram tokenizer (they
  // match enormous row sets). Treat them as "no filter" and show the full
  // unfiltered list — but do NOT call clearSearch(), which would wipe the
  // partially-typed text; instead use resetSearchFilter() to reset only the
  // filter state.
  if (query.length < MIN_SEARCH_CHARS) {
    resetSearchFilter();
    return;
  }
  try {
    if (activeTab === 'sessions') {
      const results = await window.api.search('session', query, searchTitlesOnly);
      searchMatchIds = new Set(results.map(r => r.id));
      searchMatchProjectPaths = null;
      // Also match projects by name — the custom display name or the path
      // short-name (case-insensitive) — so typing a project name surfaces it,
      // not just sessions with matching content. Runs in every search mode (#96).
      const lowerQ = query.toLowerCase();
      for (const p of cachedAllProjects) {
        const shortName = p.projectPath.split('/').filter(Boolean).slice(-2).join('/');
        const displayName = p.displayName || '';
        if (shortName.toLowerCase().includes(lowerQ) || displayName.toLowerCase().includes(lowerQ)) {
          if (!searchMatchProjectPaths) searchMatchProjectPaths = new Set();
          searchMatchProjectPaths.add(p.projectPath);
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
  userStoppedSessions.add(sessionId); // suppress the relaunch banner + timed auto-close
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

terminalVariablesBtn.addEventListener('click', () => {
  const entry = activeSessionId ? openSessions.get(activeSessionId) : null;
  const session = activeSessionId ? (sessionMap.get(activeSessionId) || entry?.session) : null;
  window.showVariablesQuickPick?.({
    sessionId: activeSessionId,
    projectPath: session?.projectPath || null,
    running: !!activeSessionId && activePtyIds.has(activeSessionId),
    anchor: terminalVariablesBtn,
  });
});

// Switch the sidebar to the Variables admin tab (from quick-pick "Manage…" and
// the terminal context menu). Clicking the tab button runs the normal handler.
window.openVariablesTab = () => {
  const btn = document.querySelector('.sidebar-tab[data-tab="variables"]');
  if (btn) btn.click();
};


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

// Signature of the pty-id set from the last updateRunningIndicators() call.
// The two full sidebar querySelectorAll scans below only matter when a session
// started/stopped (the set changed); a sorted join is a cheap O(n log n)
// signature for the small counts expected (<20 active sessions). Grid card
// statuses run every call because sessionBusyState (CLI-busy) can change
// without the pty-set changing. Attention/ready/busy transitions reach
// refreshSessionStatusViews() on their own paths, so gating the sidebar scans
// here cannot drop a status update.
let _lastPtySignature = '';

function updateRunningIndicators() {
  const sig = Array.from(activePtyIds).sort().join(',');
  const ptySetChanged = sig !== _lastPtySignature;
  _lastPtySignature = sig;

  let statusChanged = false;
  if (ptySetChanged) {
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
        finishedAt.delete(id);
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
  }
  // Update grid card dots and status text in place (shared with refreshGridView).
  // Always run — sessionBusyState can change without the pty-set changing.
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

// The list, before it exists (#186). Placeholder rows in the shape of what is coming — a project header
// and a few session cards — so the sidebar has the same silhouette while it loads and the real list grows
// out of it. No text, no toolbar movement. Replaced wholesale by the first render.
function showSidebarSkeleton() {
  if (!sidebarContent) return;
  const card = '<div class="sk-card"><div class="sk-line sk-title"></div><div class="sk-line sk-meta"></div></div>';
  const group = (cards) => `<div class="sk-group"><div class="sk-line sk-head"></div>${card.repeat(cards)}</div>`;
  sidebarContent.innerHTML = `<div class="sidebar-skeleton" aria-hidden="true">${group(3)}${group(2)}${group(1)}</div>`;
}

// The other loading state: the list is already there, and the reload was asked for at the Refresh button
// (#180). Mark it at the trigger — replacing the list with a skeleton would take away what you are
// looking at and rebuild it, which is a flicker for nothing.
function setRefreshSpinning(on) {
  if (resortBtn) resortBtn.classList.toggle('spinning', !!on);
}

async function loadProjects({ resort = false } = {}) {
  const myGen = ++loadProjectsGen;
  const wasEmpty = cachedProjects.length === 0;
  // #186: a skeleton ONLY when there is nothing there \u2014 it stands where the list is about to be, so the
  // list grows out of it instead of out of nothing. With content already on screen a skeleton would take
  // away the list you are looking at and rebuild it, a flicker for nothing: mark the trigger instead.
  // (The "Loading\u2026" text this replaces sat in the filter toolbar, resizing a row of icons.)
  if (wasEmpty) showSidebarSkeleton();
  else setRefreshSpinning(true);
  const [defaultProjects, allProjects] = await Promise.all([
    window.api.getProjects(false),
    window.api.getProjects(true),
  ]);
  // A newer loadProjects() started while we awaited — drop this stale response
  // so it can't overwrite fresher cachedProjects with older data.
  // (A newer call owns the spinner too, so a stale one leaves it running for them.)
  if (myGen !== loadProjectsGen) return;
  setRefreshSpinning(false);
  cachedProjects = defaultProjects;
  cachedAllProjects = allProjects;
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
      injectPendingSession(pending.session, pending.projectPath, pending.folder);
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

  // Another loadProjects() may have superseded us during the awaits above — bail
  // before rendering so the newer call owns the final sidebar/grid state.
  if (myGen !== loadProjectsGen) return;
  await pollActiveSessions();
  refreshSidebar({ resort });
  // Reloaded project data can carry new titles (user renames, AI titles, /title)
  // and membership changes; keep the grid view in sync too — otherwise grid cards
  // stay stale until the layout is reset or the grid is toggled off and on.
  if (gridViewActive) refreshGridView();
  // Open tabs and the active session header read the in-memory session object, which
  // dedup() just refreshed with any newly generated AI title. Re-render them so the
  // tab label and header primary name don't stay stuck on "New session" while the
  // sidebar already shows the title (issue #73).
  if (typeof window.refreshSessionTabs === 'function') window.refreshSessionTabs();
  if (activeSessionId && typeof cleanDisplayName === 'function') {
    const active = sessionMap.get(activeSessionId);
    const name = active && cleanDisplayName(active.name || active.aiTitle || active.summary);
    if (name && !headerRenaming) terminalHeaderName.textContent = name;
  }
  renderDefaultStatus();
  refreshUnlistedNotice();
}

// #183: what the sidebar is NOT showing. A session in a project that is not on the list is indexed and
// searchable and painted nowhere — correct (the register decides, and in manual mode discovery may not
// write to it), and silent, which is not: the session you were in an hour ago is simply not there, with
// nothing to click and no reason given. This says how much is being withheld, and opens the manager on
// exactly those projects, where one click puts one on the list. It adds nothing by itself.
async function refreshUnlistedNotice() {
  const el = document.getElementById('unlisted-notice');
  if (!el || typeof window.api.getUnlistedProjects !== 'function') return;
  let res;
  try { res = await window.api.getUnlistedProjects(); } catch { return; }
  const projects = (res && res.projects) || [];
  if (projects.length === 0) { el.style.display = 'none'; return; }

  const sessions = res.sessionCount || 0;
  const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  el.textContent = `${s(sessions, 'session')} in ${s(projects.length, 'project')} not on your list`;
  el.title = projects.map(p => `${p.projectPath} — ${s(p.sessionCount, 'session')}`).join('\n')
    + '\n\nClick to see them in the project manager, where you can put one on the list.';
  el.style.display = '';
}

{
  const el = document.getElementById('unlisted-notice');
  if (el) {
    el.addEventListener('click', () => {
      window._paUnlistedOnly = true;                       // the manager opens filtered to them
      document.querySelector('.sidebar-tab[data-tab="projects"]')?.click();
    });
  }
}

// Sidebar rendering (slugId, folderId, buildSlugGroup, renderProjects,
// rebindSidebarEvents, buildSessionItem, startRename) → sidebar.js


async function launchNewSession(project, sessionOptions, seedText) {
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
    // The provenance of a session that does not exist on disk yet. Without it the row falls through
    // sessionBackendId() to the launch overlay — which the renderer only loads at start-up, so it has
    // never heard of the session being launched right now — and lands on the default. A Codex session
    // therefore wore Claude's badge for as long as it took the cache to catch up. We are the ones
    // launching it; we know what it is.
    //
    // `_defaultBackendId` is already resolved to something launchable, or '' when nothing is (#225), so
    // it needs no rescuing here. It used to end `|| 'claude'`, which named a backend that may not even
    // be enabled — and this row is what the sidebar badges.
    backendId: (sessionOptions && sessionOptions.backendId) || window._defaultBackendId,
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
    return null;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  syncPtySize(sessionId); // PTY spawned at 120x30 — push the real dimensions (#81)
  showSession(sessionId);
  pollActiveSessions();

  // For the guided handoff flow: seed the fresh session with the handoff packet as its first message
  // once the CLI has booted. The session id we launched under is the one we seed — a backend that names
  // its own session (Codex/Hermes/Pi) is re-keyed later, but the PTY is addressed by the id we hold.
  if (seedText && String(seedText).trim()) {
    const backend = (typeof getBackend === 'function' && sessionOptions && sessionOptions.backendId)
      ? getBackend(sessionOptions.backendId)
      : null;
    seedSessionWhenReady(sessionId, String(seedText), { graceMs: (backend && backend.seedGraceMs) || 0 });
  }

  return sessionId;
}

// Seed a freshly-launched session with its first message once the CLI has booted and gone quiet. Rather
// than guessing a fixed delay, we watch lastActivityTime (populated by trackActivity for every session's
// output) for the boot UI to render and then settle. Best-effort: seeds anyway at timeout.
//
// `graceMs` (from the backend descriptor) is a floor, not a hint: Hermes needs ~12s of Python imports
// before its TUI can take input at all, and it PRINTS during that time (our own startup hint does too),
// so "the terminal went quiet" arrives long before the process can hear anything. Without the floor the
// packet is pasted into a process with no input loop and is simply gone — on exactly the backend whose
// handoff support this feature was extended for.
function seedSessionWhenReady(sessionId, seedText, { graceMs = 0, timelineLabel, timelineNote } = {}) {
  const SETTLE_MS = 700;
  const POLL_MS = 250;
  const MAX_WAIT_MS = 12000 + graceMs;
  const startedAt = Date.now();
  let seeded = false;

  function attempt() {
    if (seeded) return;
    const entry = openSessions.get(sessionId);
    if (!entry || entry.closed) return; // session closed before it was ready

    const elapsed = Date.now() - startedAt;
    if (elapsed < graceMs) { setTimeout(attempt, POLL_MS); return; }   // it cannot listen yet

    const last = lastActivityTime.get(sessionId);
    const quietFor = last ? Date.now() - last.getTime() : Infinity;
    const settled = last && quietFor >= SETTLE_MS;
    const timedOut = elapsed >= MAX_WAIT_MS;

    if (settled || timedOut) {
      seeded = true;
      // Bracketed paste keeps the multi-line text intact, then SUBMIT.
      //
      // The submit is a CARRIAGE RETURN (\r), not a newline (\n). Enter is 0x0D on a terminal; 0x0A only
      // moves the cursor down. The handoff's other route sent \n and so pasted its prompt into the input
      // and never submitted it — while the code that follows sat waiting for an answer the user had to
      // press Enter to get. Both routes use this one function now, so they cannot drift apart again.
      window.api.sendInput(sessionId, `\x1b[200~${seedText}\x1b[201~\r`);
      recordTimelineEvent(
        sessionId, 'started',
        timelineLabel || 'Handoff seeded',
        timelineNote || 'Seeded fresh session with the handoff packet.',
      );
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

// Inline-rename the active session from the header title (top-left), mirroring the
// sidebar's startRename: double-click → edit in place → save on Enter/blur, cancel
// on Escape, then sync the sidebar. Same backend as the sidebar (issue #95).
function startHeaderRename() {
  if (headerRenaming || !activeSessionId) return;
  const entry = openSessions.get(activeSessionId);
  const session = (entry && entry.session) || sessionMap.get(activeSessionId);
  if (!session) return;
  headerRenaming = true;
  const el = terminalHeaderName;
  const original = el.textContent;
  el.contentEditable = 'plaintext-only';
  el.spellcheck = false;
  el.classList.add('editing');
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = async (commit) => {
    if (!headerRenaming) return;
    headerRenaming = false;
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('blur', onBlur);
    el.contentEditable = 'false';
    el.classList.remove('editing');
    if (commit) {
      const newName = el.textContent.trim();
      const fallback = cleanDisplayName(session.aiTitle || session.summary);
      const nameToSave = (newName && newName !== fallback) ? newName : null;
      try { await window.api.renameSession(session.sessionId, nameToSave); } catch {}
      session.name = nameToSave;
      el.textContent = nameToSave || fallback || session.sessionId;
      if (typeof refreshSidebar === 'function') refreshSidebar();
    } else {
      el.textContent = original;
    }
  };
  function onKey(e) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  }
  function onBlur() { finish(true); }
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
}
terminalHeaderName.addEventListener('dblclick', (e) => { e.stopPropagation(); startHeaderRename(); });
terminalHeaderName.title = 'Double-click to rename';

async function showTerminalHeader(session) {
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);
  if (!headerRenaming) terminalHeaderName.textContent = displayName;
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

// `show: false` mounts the session without switching the view to it — the launch
// restore reopens several at once and would otherwise reveal, focus and re-fit
// each terminal in turn before landing on the one that should have focus.
async function openSession(session, customOptions, { show = true } = {}) {
  // Opening a terminal session is a fresh navigation — drop any pending
  // "return to tasks" target so a later viewer-close doesn't jump back to tasks.
  window.__tasksReturnTarget = null;
  window.__bookmarksReturnTarget = null;
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
      if (show) showSession(sessionId);
      return;
    }
  }

  // Create new terminal entry (hidden until showSession)
  const entry = createTerminalEntry(session);

  // Open terminal in main process.
  // Resume is binary-bound (§5.11): main reapplies the session's RECORDED backend, so we must not
  // hand it Claude's launch defaults when the session belongs to another binary — Claude's `model`
  // would land on Codex's `-m`, and its permission mode means nothing there. Resolve the options for
  // the session's OWN backend instead. (No backendId is sent: main reapplies the recorded one.)
  //
  // The guard here only fires when backend-registry.js has not loaded at all — `sessionBackendId` carries
  // its own documented fallback for a session that predates provenance. And if the registry is missing,
  // nothing about backends is known, so there is no id to give: '' resolves no options, and main still
  // reapplies the session's RECORDED backend, which is what decides the binary either way. Naming Claude
  // here (as this did) only ever meant "hand Claude's options to whatever this session is".
  const resumeBackendId = window.sessionBackendId ? window.sessionBackendId(session) : '';
  const resumeOptions = customOptions || await resolveLaunchOptionsFor({ projectPath }, resumeBackendId);
  if (resumeOptions) delete resumeOptions.backendId;
  // The `worktree` default applies to NEW sessions only. Resuming must reuse the
  // session's existing directory, so never pass --worktree on resume — otherwise
  // a plain-click resume tries to spin up a fresh git worktree and fails to attach
  // (the Resume-with-config dialog already omits worktree, which is why it works).
  if (resumeOptions) { delete resumeOptions.worktree; delete resumeOptions.worktreeName; }
  const result = await window.api.openTerminal(sessionId, projectPath, false, resumeOptions);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    if (show) showSession(sessionId);
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  syncPtySize(sessionId); // push real dimensions to the (re)spawned/reattached PTY (#81)
  if (show) showSession(sessionId);
  pollActiveSessions();
}

// Relaunch a session from the tab context menu. If it's still running, stop the
// PTY first and wait for it to actually exit — main deletes the session from
// activeSessions on exit (see ptyProcess.onExit), so the follow-up open-terminal
// resumes a fresh process instead of reattaching to the dead PTY. Then reopen.
async function relaunchSession(sessionId) {
  const session = sessionMap.get(sessionId) || openSessions.get(sessionId)?.session;
  if (!session) return;
  const entry = openSessions.get(sessionId);
  if (entry && !entry.closed) {
    userStoppedSessions.add(sessionId); // suppress the "re-click to relaunch" banner
    try { await window.api.stopSession(sessionId); } catch { /* ignore */ }
    // Wait (bounded ~3s) until the exit event marks the entry closed — by then
    // main has cleared activeSessions, so openSession spawns fresh.
    for (let i = 0; i < 100 && !openSessions.get(sessionId)?.closed; i++) {
      await new Promise(r => setTimeout(r, 30));
    }
  }
  destroySession(sessionId);
  await openSession(session);
}
window.relaunchSession = relaunchSession;

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
  // Resume options mirror openSession() (worktree stripped) so that, in the rare race where the PTY
  // exited between the last poll and now, the fallback spawn still resumes the existing session rather
  // than starting a fresh one.
  //
  // They must be THIS session's backend's options, not Claude's: resolving Claude's defaults here would
  // hand a Claude model to `pi --model` / `codex -m` in exactly that race. (openSession() was fixed for
  // this; this caller was missed.) Which is why the fallback must not name Claude either — it only fires
  // when backend-registry.js has not loaded, and then '' is the honest answer (#225).
  const backendId = (typeof sessionBackendId === 'function' ? sessionBackendId(session) : null) || '';
  const resumeOptions = await resolveLaunchOptionsFor({ projectPath }, backendId);
  if (resumeOptions) { delete resumeOptions.worktree; delete resumeOptions.worktreeName; }
  const result = await window.api.openTerminal(sessionId, projectPath, false, resumeOptions);
  if (!result || !result.ok) {
    if (result && result.error) entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return false;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);
  syncPtySize(sessionId); // see openSession (#81)
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
    forceRepaint(entry); // flush the WebGL atlas so the resize doesn't leave a staircase
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
    // The "not on your list" notice belongs to the session list it stands under (#183).
    const unlistedNotice = document.getElementById('unlisted-notice');
    if (unlistedNotice) unlistedNotice.style.display = 'none';
    plansContent.style.display = 'none';
    statsContent.style.display = 'none';
    memoryContent.style.display = 'none';
    workFilesContent.style.display = 'none';
    projectsViewer.style.display = 'none';
    variablesAdminContent.style.display = 'none';
    sessionFilters.style.display = 'none';
    searchBar.style.display = 'none';
    applyProjectTagFilterVisibility(); // #133 — chips belong to Sessions only

    if (tabName === 'sessions') {
      sessionFilters.style.display = '';
      searchBar.style.display = '';
      searchInput.placeholder = 'Search...';
      sidebarContent.style.display = '';
      refreshUnlistedNotice();   // #183 — it hangs under this list, and only under it
      // Restore terminal area
      returnToTerminal();
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
      // Immediately show stats viewer in main area. hideAllViewers() (in
      // plans-memory-view.js) replaces the previously hand-maintained hide
      // lists, which had already diverged between branches (#79).
      hideAllViewers();
      placeholder.style.display = 'none';
      terminalArea.style.display = 'none';
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
    } else if (tabName === 'projects') {
      // Big-viewport admin list in the main area (its own filter, no sidebar content).
      hideAllViewers();
      placeholder.style.display = 'none';
      terminalArea.style.display = 'none';
      projectsViewer.style.display = 'flex';
      loadProjectsAdmin();
    } else if (tabName === 'variables') {
      // Session-independent variable management in the main area (own filter).
      // hideAllViewers doesn't know variablesAdminContent — the tab prologue
      // above hides it on every switch, so showing it here is enough.
      hideAllViewers();
      placeholder.style.display = 'none';
      terminalArea.style.display = 'none';
      variablesAdminContent.style.display = 'flex';
      loadVariablesAdmin();
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
      // Atomic key-scoped merge (see session-tabs persistOrder) — avoids clobbering
      // unrelated settings on a concurrent save / second window (issue #75).
      window.api.mergeSetting('global', { sidebarWidth: width });
    }
  });
}

// Close any open viewer overlay (Message History / Timeline / etc.) and restore
// the terminal area — grid, the active single session, or the placeholder.
function returnToTerminal() {
  // If a viewer (e.g. View messages) was opened by jumping from a task, closing
  // it returns to that task list instead of the terminal.
  if (window.__tasksReturnTarget && typeof openTasksView === 'function') {
    const t = window.__tasksReturnTarget;
    window.__tasksReturnTarget = null;
    openTasksView(t.filter, t.label);
    return;
  }
  // Same idea for a jump from the bookmark view — return to that list (#68).
  if (window.__bookmarksReturnTarget && typeof openBookmarksView === 'function') {
    const b = window.__bookmarksReturnTarget;
    window.__bookmarksReturnTarget = null;
    openBookmarksView(b.filter, b.label);
    return;
  }
  hideAllViewers();
  if (gridViewActive) {
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
}

// Re-apply global settings live — called when the pop-out settings window saves
// (Phase 2). Mirrors the apply done by the in-app settings save.
async function reapplyGlobalSettings() {
  const g = await window.api.getSetting('global');
  if (!g) return;
  try { window._applyNotificationSettings?.(g); } catch {}
  if (g.notifications) window._setNotificationSettings?.(g.notifications);
  if (g.runningInbox) window._setRunningInboxSetting?.(g.runningInbox);
  if (g.terminalTheme) window._applyTerminalTheme?.(g.terminalTheme);
  if (g.terminalFontFamily) window._setTerminalFontFamily?.(g.terminalFontFamily);
  if (g.terminalFontSize) window._setTerminalFontSize?.(g.terminalFontSize);
  if (g.terminalRightClick) window._applyTerminalRightClick?.(g.terminalRightClick);
  if (g.terminalMouseReporting && typeof setTerminalMouseReporting === 'function') setTerminalMouseReporting(g.terminalMouseReporting);
  window._setGpuAcceleration?.(
    (g.gpuAcceleration === 'on' || g.gpuAcceleration === 'off' || g.gpuAcceleration === 'auto')
      ? g.gpuAcceleration
      : (g.terminalWebgl === false ? 'off' : 'auto')); // migrate old boolean (#87); default auto
  window._setUsageThresholds?.({ fiveHWarn: g.usage5hWarn, fiveHCrit: g.usage5hCrit, sevenDWarn: g.usage7dWarn, sevenDCrit: g.usage7dCrit });
  window._setUsageBackendSelection?.(g.usageBackends || {});
  if (g.visibleSessionCount != null) window._setVisibleSessionCount?.(g.visibleSessionCount);
  if (g.sessionMaxAgeDays != null) window._setSessionMaxAge?.(g.sessionMaxAgeDays);
  if (g.shortcuts && typeof setAppShortcuts === 'function') setAppShortcuts(g.shortcuts);
  window._applySessionDisplaySettings?.(g);
  window._applyProjectSortSettings?.(g);
  // Tag definitions (name, colour, hidden/disabled) are edited in the same window
  // and are committed without a Save, so re-read them here: from the standalone
  // settings window this broadcast is the only thing that reaches the chips in the
  // sidebar and on the session cards (#174).
  window._refreshProjectTagFilter?.();
  window.bookmarksTags?.reloadTags?.();
  refreshSidebar?.();
}

// --- Grid view toggle button (next to resort button in sidebar filters) ---
{
  // Viewer-overlay close buttons (Message History / Timeline headers) → back to terminal.
  document.querySelectorAll('[data-close-viewer]').forEach(btn => {
    btn.addEventListener('click', returnToTerminal);
  });

  // Terminal-header toolbar: View messages + Tasks scoped to the active session.
  const activeSessionObject = () =>
    (activeSessionId && openSessions.has(activeSessionId)) ? openSessions.get(activeSessionId).session : null;
  const messagesBtn = document.getElementById('terminal-messages-btn');
  if (messagesBtn) {
    messagesBtn.addEventListener('click', () => {
      const s = activeSessionObject();
      if (s && typeof showJsonlViewer === 'function') showJsonlViewer(s);
    });
  }
  const sessionTasksBtn = document.getElementById('terminal-tasks-btn');
  if (sessionTasksBtn) {
    sessionTasksBtn.addEventListener('click', () => {
      const s = activeSessionObject();
      if (!s || typeof openTasksView !== 'function') return;
      openTasksView({ sessionId: s.sessionId }, 'Session · ' + (s.name || s.aiTitle || s.summary || s.sessionId));
    });
  }

  // Settings pop-out: open the standalone settings window, close the in-app overlay.
  const popoutBtn = document.getElementById('settings-popout-btn');
  if (popoutBtn) {
    popoutBtn.addEventListener('click', () => {
      window.api.openSettingsWindow();
      if (typeof window.closeSettingsViewer === 'function') window.closeSettingsViewer();
    });
  }
  if (window.api && typeof window.api.onSettingsChanged === 'function') {
    window.api.onSettingsChanged(reapplyGlobalSettings);
  }

  // Closing the window kills every running session — a CLI mid-turn included. Main cancels the close and
  // asks here, so the question looks like the rest of the app instead of like a Windows system box, and
  // then closes for real if the answer is yes. Not dismissible: a stray click on the backdrop must not
  // read as an answer to a question about work that cannot be got back.
  if (window.api && typeof window.api.onConfirmClose === 'function') {
    window.api.onConfirmClose(async (warning) => {
      let ok = false;
      try {
        ok = await showControlDialog({
          title: warning?.title || 'Sessions are still running',
          message: warning?.message || 'Closing Switchboard stops every running session.',
          details: warning?.details || [],
          confirmLabel: 'Close and stop them',
          cancelLabel: 'Cancel',
          tone: 'danger',
          dismissible: false,
        });
      } catch { ok = false; }
      window.api.confirmCloseResult(!!ok);
    });
  }

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
    // Grid move mode owns Esc/Enter/arrows while it runs — check before the
    // Escape branch below, which would otherwise close a viewer instead.
    if (typeof handleGridMoveModeKey === 'function' && handleGridMoveModeKey(e)) return;
    // Esc closes an open Message History / Timeline viewer → back to terminal.
    if (e.key === 'Escape' && (jsonlViewer.style.display !== 'none' || timelineViewer.style.display !== 'none'
        || (tasksViewer && tasksViewer.style.display !== 'none')
        || (bookmarksViewer && bookmarksViewer.style.display !== 'none'))) {
      e.preventDefault();
      returnToTerminal();
      return;
    }
    // Toggle grid view (default Cmd/Ctrl+Shift+G)
    if (matchShortcut('gridToggle', e, isMac, appShortcuts)) {
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
    // Bookmark (default Cmd/Ctrl+Shift+B) — context-aware toggle.
    if (matchShortcut('toggleBookmark', e, isMac, appShortcuts)) {
      e.preventDefault();
      window.bookmarksTags?.handleBookmarkShortcut();
      return;
    }
    // Create task from the current transcript selection (default Cmd/Ctrl+Shift+T).
    if (matchShortcut('createTask', e, isMac, appShortcuts)) {
      e.preventDefault();
      window.bookmarksTags?.createTaskFromSelection();
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
    if (global.visibleSessionCount != null) {
      visibleSessionCount = global.visibleSessionCount;
    }
    if (global.sessionMaxAgeDays != null) {
      sessionMaxAgeDays = global.sessionMaxAgeDays;
    }
    if (global.terminalTheme && TERMINAL_THEMES[global.terminalTheme]) {
      currentThemeName = global.terminalTheme;
      TERMINAL_THEME = getTerminalTheme();
    }
    // Terminal font (size + family) — set the module vars before any terminal is
    // created so the first open already uses them.
    if (global.terminalFontFamily) window._setTerminalFontFamily?.(global.terminalFontFamily);
    if (global.terminalFontSize) window._setTerminalFontSize?.(global.terminalFontSize);
    if (global.notifications) {
      window._setNotificationSettings(global.notifications);
    }
    if (global.runningInbox) {
      window._setRunningInboxSetting(global.runningInbox);
    }
    if (global.terminalRightClick) terminalRightClickMode = global.terminalRightClick;
    if (global.terminalMouseReporting && typeof setTerminalMouseReporting === 'function') {
      setTerminalMouseReporting(global.terminalMouseReporting);
    }
    window._setGpuAcceleration?.(
      (global.gpuAcceleration === 'on' || global.gpuAcceleration === 'off' || global.gpuAcceleration === 'auto')
        ? global.gpuAcceleration
        : (global.terminalWebgl === false ? 'off' : 'auto')); // migrate old boolean (#87); default auto
    window._setUsageThresholds?.({ fiveHWarn: global.usage5hWarn, fiveHCrit: global.usage5hCrit, sevenDWarn: global.usage7dWarn, sevenDCrit: global.usage7dCrit });
    window._setUsageBackendSelection?.(global.usageBackends || {});
    if (global.shortcuts) setAppShortcuts(global.shortcuts);
    if (typeof window._applySessionDisplaySettings === 'function') window._applySessionDisplaySettings(global);
    // The project sort comes from Settings, and the boot never read it: it was taken from the
    // localStorage mirror alone, which is only written when the settings are SAVED. A profile whose
    // localStorage says something else — a fresh one, a cleared one — sorted by that instead, and the
    // saved value was ignored until the next save. It is the fallback the View menu falls back TO (#181),
    // so it has to be read here.
    if (typeof window._applyProjectSortSettings === 'function') window._applyProjectSortSettings(global);
  }

  refreshSidebar();
})();

// Let the settings panel push updated key bindings live (no restart needed).
window._applyShortcuts = (stored) => setAppShortcuts(stored);

// Load the backend registry + the launch-time overlay once at startup (T-3.1), so the sidebar and the
// launch picker can resolve a session's backend synchronously. Best-effort: a failure here must not
// block the app — the caches simply stay empty and everything falls back to Claude.
if (typeof refreshBackendCaches === 'function') {
  refreshBackendCaches().then(() => refreshSidebar()).catch(() => {});
}

loadProjects().then(async () => {
  // Build the project tag-filter chip bar once projects are loaded (#98).
  _refreshProjectTagFilter();
  // Apply the configured startup collapse default once the sidebar (incl. project
  // sections) is built. 'remember' is a no-op (persisted state already applied).
  let tabsMode = false;
  try {
    const g = await window.api.getSetting('global');
    applyCollapseDefault(g?.sidebarCollapseDefault || 'remember');
    tabsMode = g?.sessionDisplayMode === 'tabs';
  } catch { /* ignore */ }

  // Restore grid view preference before opening sessions so they enter grid mode.
  // Tabs mode is single-view only: never open grid there, and heal a stale grid
  // flag (a desync from a lost startup race) back to 0 so it can't fire next boot.
  // Read the mode from settings, not the <body> class — the class is set by a
  // separate async chain that can still be pending here.
  if (tabsMode) {
    if (localStorage.getItem('gridViewActive') === '1') localStorage.setItem('gridViewActive', '0');
  } else if (localStorage.getItem('gridViewActive') === '1') {
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
// The usage segments — their state, the colour thresholds, the two window._set* entry points, the
// snapshot and the poll — are shell/statusbar-usage.js (#218). The status bar is three elements that only
// ever shared this heading: renderDefaultStatus below paints status-bar-info, activityTimer and the
// onStatusUpdate listener paint status-bar-activity, and status-bar-usage is the module's.

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


// The session-restore cluster — the durable open-sessions blob, the progress bar and the relaunch
// mount — is shell/session-restore.js (#218). It reads the state declared here and writes none of it,
// so it moved unchanged; its pure half was already in shell/update-restart.js.

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
