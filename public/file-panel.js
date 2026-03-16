/**
 * file-panel.js — Renderer-side file/diff side panel for Switchboard.
 *
 * Manages a collapsible panel to the right of the terminal that shows
 * files and diffs received from the MCP bridge. Each session has its
 * own set of tabs and panel state.
 *
 * Globals expected: window.api, window.createReadOnlyViewer,
 *   window.createMergeViewer, window.CMMergeView, openSessions (from app.js)
 */

// ── Per-Session State ───────────────────────────────────────────────

/**
 * Map<sessionId, {
 *   tabs: Map<tabId, TabState>,
 *   activeTabId: string|null,
 *   panelVisible: boolean,
 *   mcpEnabled: boolean,
 *   panelWidth: number,
 * }>
 */
const filePanelState = new Map();

/**
 * TabState:
 * {
 *   tabId: string,
 *   type: 'diff' | 'file',
 *   label: string,
 *   filePath: string,
 *   // diff-specific:
 *   diffId: string,
 *   oldContent: string,
 *   newContent: string,
 *   resolved: boolean,
 *   // file-specific:
 *   content: string,
 *   // runtime:
 *   editorView: EditorView|MergeView|null,
 * }
 */

// ── DOM References ──────────────────────────────────────────────────

let filePanelEl = null;
let filePanelHeaderEl = null;
let filePanelPathEl = null;
let filePanelBodyEl = null;
let filePanelActionsEl = null;
let filePanelResizeHandle = null;
let terminalSplitEl = null;
let currentPanelSessionId = null;

const PANEL_WIDTH_KEY = 'filePanelWidth';
const DEFAULT_PANEL_WIDTH = parseInt(localStorage.getItem(PANEL_WIDTH_KEY), 10) || 450;
const MIN_PANEL_WIDTH = 280;

// ── Initialization ──────────────────────────────────────────────────

function initFilePanel() {
  const terminalArea = document.getElementById('terminal-area');
  const terminalsEl = document.getElementById('terminals');
  if (!terminalArea || !terminalsEl) return;

  // Create the split container
  terminalSplitEl = document.createElement('div');
  terminalSplitEl.id = 'terminal-split';

  // Reparent #terminals into the split
  terminalArea.removeChild(terminalsEl);
  terminalSplitEl.appendChild(terminalsEl);

  // Create resize handle
  filePanelResizeHandle = document.createElement('div');
  filePanelResizeHandle.id = 'file-panel-resize-handle';
  terminalSplitEl.appendChild(filePanelResizeHandle);

  // Create the file panel
  filePanelEl = document.createElement('div');
  filePanelEl.id = 'file-panel';

  filePanelHeaderEl = document.createElement('div');
  filePanelHeaderEl.id = 'file-panel-header';
  filePanelEl.appendChild(filePanelHeaderEl);

  filePanelPathEl = document.createElement('div');
  filePanelPathEl.className = 'file-panel-path';
  filePanelEl.appendChild(filePanelPathEl);

  filePanelBodyEl = document.createElement('div');
  filePanelBodyEl.id = 'file-panel-body';
  filePanelEl.appendChild(filePanelBodyEl);

  filePanelActionsEl = document.createElement('div');
  filePanelActionsEl.id = 'file-panel-actions';
  filePanelActionsEl.style.display = 'none';
  filePanelEl.appendChild(filePanelActionsEl);

  terminalSplitEl.appendChild(filePanelEl);
  terminalArea.appendChild(terminalSplitEl);

  // Wire up IPC listeners
  wireIpcListeners();

  // Wire up resize handle
  setupPanelResizeHandle();

  // Add MCP toggle to terminal header
  addMcpToggle();
}

// ── IPC Wiring ──────────────────────────────────────────────────────

function wireIpcListeners() {
  window.api.onMcpOpenDiff((sessionId, diffId, data) => {
    openDiffTab(sessionId, diffId, data);
  });

  window.api.onMcpOpenFile((sessionId, data) => {
    openFileTab(sessionId, data);
  });

  window.api.onMcpCloseAllDiffs((sessionId) => {
    closeAllDiffTabs(sessionId);
  });
}

// ── Session State Helpers ───────────────────────────────────────────

function getSessionState(sessionId) {
  if (!filePanelState.has(sessionId)) {
    filePanelState.set(sessionId, {
      tabs: new Map(),
      activeTabId: null,
      panelVisible: false,
      mcpEnabled: true,
      panelWidth: DEFAULT_PANEL_WIDTH,
    });
  }
  return filePanelState.get(sessionId);
}

function rekeyFilePanelState(oldId, newId) {
  const state = filePanelState.get(oldId);
  if (state) {
    filePanelState.delete(oldId);
    filePanelState.set(newId, state);
  }
}

// ── Tab Operations ──────────────────────────────────────────────────

function openDiffTab(sessionId, diffId, data) {
  const state = getSessionState(sessionId);

  // If MCP is disabled, auto-respond as TAB_CLOSED
  if (!state.mcpEnabled) {
    window.api.mcpDiffResponse(sessionId, diffId, 'accept', null);
    return;
  }

  const tabId = `diff:${diffId}`;
  const label = data.tabName || basename(data.oldFilePath);

  state.tabs.set(tabId, {
    tabId,
    type: 'diff',
    label,
    filePath: data.oldFilePath,
    diffId,
    oldContent: data.oldContent,
    newContent: data.newContent,
    resolved: false,
    editorView: null,
  });

  state.activeTabId = tabId;
  state.panelVisible = true;

  // If this is the active session, update the UI
  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

function openFileTab(sessionId, data) {
  const state = getSessionState(sessionId);

  if (!state.mcpEnabled) return;

  const tabId = `file:${data.filePath}`;
  const label = basename(data.filePath);

  // Reuse existing tab for same file
  if (state.tabs.has(tabId)) {
    const tab = state.tabs.get(tabId);
    tab.content = data.content;
    // Destroy old editor so it re-renders
    if (tab.editorView) {
      tab.editorView.destroy();
      tab.editorView = null;
    }
  } else {
    state.tabs.set(tabId, {
      tabId,
      type: 'file',
      label,
      filePath: data.filePath,
      content: data.content,
      editorView: null,
    });
  }

  state.activeTabId = tabId;
  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

/**
 * Open a file in the panel from an OSC 8 file:// link click.
 * Reads the file via IPC and creates a file tab.
 */
async function openFileInPanel(sessionId, filePath) {
  const state = getSessionState(sessionId);
  if (!state.mcpEnabled) return;

  const result = await window.api.readFileForPanel(filePath);
  if (!result.ok) return;

  openFileTab(sessionId, { filePath, content: result.content });
}

function closeTab(sessionId, tabId) {
  const state = getSessionState(sessionId);
  const tab = state.tabs.get(tabId);
  if (!tab) return;

  // If it's an unresolved diff, respond as rejected
  if (tab.type === 'diff' && !tab.resolved) {
    window.api.mcpDiffResponse(sessionId, tab.diffId, 'reject', null);
  }

  // Destroy editor
  if (tab.editorView) {
    tab.editorView.destroy();
    tab.editorView = null;
  }

  state.tabs.delete(tabId);

  // Switch to another tab or hide panel
  if (state.activeTabId === tabId) {
    const remaining = [...state.tabs.keys()];
    state.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }

  if (state.tabs.size === 0) {
    state.panelVisible = false;
    if (currentPanelSessionId === sessionId) {
      hidePanel();
    }
  } else if (currentPanelSessionId === sessionId) {
    renderPanel(sessionId);
  }
}

function closeAllDiffTabs(sessionId) {
  const state = getSessionState(sessionId);

  for (const [tabId, tab] of state.tabs) {
    if (tab.type === 'diff') {
      if (tab.editorView) {
        tab.editorView.destroy();
        tab.editorView = null;
      }
      state.tabs.delete(tabId);
    }
  }

  // Update active tab
  if (state.activeTabId && !state.tabs.has(state.activeTabId)) {
    const remaining = [...state.tabs.keys()];
    state.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }

  if (state.tabs.size === 0) {
    state.panelVisible = false;
    if (currentPanelSessionId === sessionId) hidePanel();
  } else if (currentPanelSessionId === sessionId) {
    renderPanel(sessionId);
  }
}

// ── Panel Show/Hide ─────────────────────────────────────────────────

function showPanel(state) {
  if (!filePanelEl) return;
  filePanelEl.classList.add('open');
  filePanelEl.style.width = (state.panelWidth || DEFAULT_PANEL_WIDTH) + 'px';
  filePanelResizeHandle.style.display = 'block';
  refitActiveTerminal();
}

function hidePanel() {
  if (!filePanelEl) return;
  filePanelEl.classList.remove('open');
  filePanelEl.style.width = '0';
  filePanelResizeHandle.style.display = 'none';
  refitActiveTerminal();
}

/**
 * Called when the active session changes. Shows/hides the panel
 * based on the new session's state.
 */
function switchPanel(sessionId) {
  currentPanelSessionId = sessionId;

  // Destroy any visible editors from previous session
  clearPanelEditors();

  if (!sessionId) {
    hidePanel();
    return;
  }

  const state = getSessionState(sessionId);

  // Update MCP toggle state
  updateMcpToggle(state.mcpEnabled);

  if (state.panelVisible && state.tabs.size > 0) {
    showPanel(state);
    renderPanel(sessionId);
  } else {
    hidePanel();
  }
}

// ── Panel Rendering ─────────────────────────────────────────────────

function renderPanel(sessionId) {
  if (!filePanelEl || currentPanelSessionId !== sessionId) return;

  const state = getSessionState(sessionId);
  if (!state) return;

  // Render tab bar
  renderTabBar(sessionId, state);

  // Render active tab content
  const activeTab = state.activeTabId ? state.tabs.get(state.activeTabId) : null;
  renderTabContent(sessionId, activeTab);
}

function renderTabBar(sessionId, state) {
  filePanelHeaderEl.innerHTML = '';

  for (const [tabId, tab] of state.tabs) {
    const tabEl = document.createElement('button');
    tabEl.className = 'file-tab';
    if (tabId === state.activeTabId) tabEl.classList.add('active');
    if (tab.type === 'diff') {
      tabEl.classList.add('is-diff');
      if (tab.resolved) tabEl.classList.add('resolved');
    }

    const labelSpan = document.createElement('span');
    labelSpan.textContent = tab.label;
    tabEl.appendChild(labelSpan);

    const closeBtn = document.createElement('span');
    closeBtn.className = 'file-tab-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(sessionId, tabId);
    });
    tabEl.appendChild(closeBtn);

    tabEl.addEventListener('click', () => {
      state.activeTabId = tabId;
      renderPanel(sessionId);
    });

    filePanelHeaderEl.appendChild(tabEl);
  }
}

function renderTabContent(sessionId, tab) {
  // Clear previous editor
  clearPanelEditors();

  if (!tab) {
    filePanelPathEl.textContent = '';
    filePanelActionsEl.style.display = 'none';
    return;
  }

  // Show file path
  filePanelPathEl.textContent = tab.filePath || '';

  if (tab.type === 'diff') {
    renderDiffContent(sessionId, tab);
  } else {
    renderFileContent(tab);
  }
}

function renderDiffContent(sessionId, tab) {
  // Create merge viewer if not already created
  if (!tab.editorView) {
    tab.editorView = window.createMergeViewer(
      filePanelBodyEl,
      tab.oldContent,
      tab.newContent,
      tab.filePath,
    );
  } else {
    filePanelBodyEl.appendChild(tab.editorView.dom);
  }

  // Show accept/reject buttons (unless already resolved)
  if (!tab.resolved) {
    filePanelActionsEl.style.display = 'flex';
    filePanelActionsEl.innerHTML = '';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'file-panel-accept-btn';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => {
      handleDiffAction(sessionId, tab, 'accept');
    });

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'file-panel-reject-btn';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => {
      handleDiffAction(sessionId, tab, 'reject');
    });

    filePanelActionsEl.appendChild(acceptBtn);
    filePanelActionsEl.appendChild(rejectBtn);
  } else {
    filePanelActionsEl.style.display = 'none';
  }
}

function renderFileContent(tab) {
  filePanelActionsEl.style.display = 'none';

  if (!tab.editorView) {
    tab.editorView = window.createReadOnlyViewer(
      filePanelBodyEl,
      tab.content,
      tab.filePath,
    );
  } else {
    filePanelBodyEl.appendChild(tab.editorView.dom);
  }
}

function clearPanelEditors() {
  if (filePanelBodyEl) {
    filePanelBodyEl.innerHTML = '';
  }
}

// ── Diff Actions ────────────────────────────────────────────────────

function handleDiffAction(sessionId, tab, action) {
  if (tab.resolved) return;
  tab.resolved = true;

  if (action === 'accept') {
    // Get content from the right side of the merge view (user may have edited)
    let editedContent = null;
    if (tab.editorView && tab.editorView.b) {
      editedContent = tab.editorView.b.state.doc.toString();
    }

    // If user edited the content, send accept-edited; otherwise just accept
    if (editedContent && editedContent !== tab.newContent) {
      window.api.mcpDiffResponse(sessionId, tab.diffId, 'accept-edited', editedContent);
    } else {
      window.api.mcpDiffResponse(sessionId, tab.diffId, 'accept', null);
    }
  } else {
    window.api.mcpDiffResponse(sessionId, tab.diffId, 'reject', null);
  }

  // Update tab UI
  const tabEl = filePanelHeaderEl.querySelector(`.file-tab.active`);
  if (tabEl) tabEl.classList.add('resolved');
  filePanelActionsEl.style.display = 'none';
}

// ── MCP Toggle ──────────────────────────────────────────────────────

let mcpToggleEl = null;
let mcpToggleCheckbox = null;

function addMcpToggle() {
  const controls = document.getElementById('terminal-header-controls');
  if (!controls) return;

  mcpToggleEl = document.createElement('label');
  mcpToggleEl.className = 'mcp-toggle';
  mcpToggleEl.title = 'Auto-open file diffs and opens in side panel';

  mcpToggleCheckbox = document.createElement('input');
  mcpToggleCheckbox.type = 'checkbox';
  mcpToggleCheckbox.checked = true;

  const label = document.createElement('span');
  label.textContent = 'Auto Open Files';

  mcpToggleEl.appendChild(mcpToggleCheckbox);
  mcpToggleEl.appendChild(label);

  mcpToggleCheckbox.addEventListener('change', () => {
    if (!currentPanelSessionId) return;
    const state = getSessionState(currentPanelSessionId);
    state.mcpEnabled = mcpToggleCheckbox.checked;
    mcpToggleEl.classList.toggle('enabled', state.mcpEnabled);
  });

  // Insert before the stop button
  const stopBtn = document.getElementById('terminal-stop-btn');
  if (stopBtn) {
    controls.insertBefore(mcpToggleEl, stopBtn);
  } else {
    controls.appendChild(mcpToggleEl);
  }
}

function updateMcpToggle(enabled) {
  if (mcpToggleCheckbox) {
    mcpToggleCheckbox.checked = enabled;
  }
  if (mcpToggleEl) {
    mcpToggleEl.classList.toggle('enabled', enabled);
  }
}

// ── Resize Handle ───────────────────────────────────────────────────

function setupPanelResizeHandle() {
  if (!filePanelResizeHandle) return;

  let startX = 0;
  let startWidth = 0;

  function onMouseDown(e) {
    e.preventDefault();
    startX = e.clientX;
    startWidth = filePanelEl.offsetWidth;
    filePanelResizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    // Panel is on the right, so dragging left increases width
    const delta = startX - e.clientX;
    const newWidth = Math.max(MIN_PANEL_WIDTH, startWidth + delta);
    filePanelEl.style.width = newWidth + 'px';
  }

  function onMouseUp() {
    filePanelResizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    // Save width globally (persists across sessions and restarts)
    const w = filePanelEl.offsetWidth;
    localStorage.setItem(PANEL_WIDTH_KEY, w);
    if (currentPanelSessionId) {
      const state = getSessionState(currentPanelSessionId);
      state.panelWidth = w;
    }

    refitActiveTerminal();
  }

  filePanelResizeHandle.addEventListener('mousedown', onMouseDown);
}

// ── Terminal Refit ──────────────────────────────────────────────────

function refitActiveTerminal() {
  // Refit terminal after panel resize — uses openSessions from app.js
  requestAnimationFrame(() => {
    if (typeof openSessions !== 'undefined' && currentPanelSessionId) {
      const entry = openSessions.get(currentPanelSessionId);
      if (entry && entry.fitAddon) {
        try { entry.fitAddon.fit(); } catch {}
      }
    }
  });
}

// ── Utility ─────────────────────────────────────────────────────────

function basename(filePath) {
  if (!filePath) return 'untitled';
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'untitled';
}
