/**
 * file-panel.js — Renderer-side file/diff side panel for Switchboard.
 *
 * Manages a collapsible panel to the right of the terminal that shows
 * files and diffs received from the MCP bridge.
 *
 * For files: delegates to a ViewerPanel instance (shared component).
 * For diffs: uses its own MergeView rendering with accept/reject.
 *
 * Globals expected: window.api, window.ViewerPanel,
 *   window.createMergeViewer, window.createUnifiedMergeViewer,
 *   window.createViewerToolbar, openSessions (from app.js)
 */

// ── Per-Session State ───────────────────────────────────────────────

const filePanelState = new Map();

// ── DOM References ──────────────────────────────────────────────────

let filePanelEl = null;
let filePanelResizeHandle = null;
let terminalSplitEl = null;
let currentPanelSessionId = null;

// The one panel instance — the thing that actually renders a preview or a diff. It used to be a set of
// module-level singletons (the content container, one ViewerPanel, the diff toolbar/body/actions) found
// by element id, which is why a second preview could not exist: ids are unique and there was one of each.
// It is a factory now, still called exactly once here; per-pane instances are #311's second half.
let panelInstance = null;

const PANEL_WIDTH_KEY = 'filePanelWidth';
const DEFAULT_PANEL_WIDTH = parseInt(localStorage.getItem(PANEL_WIDTH_KEY), 10) || 450;
const MIN_PANEL_WIDTH = 280;

const DIFF_MODE_KEY = 'filePanelDiffMode';
let diffMode = localStorage.getItem(DIFF_MODE_KEY) || 'side-by-side';

// ── A panel instance ────────────────────────────────────────────────
//
// One preview or one diff, rendered into a container of its own (#311). Everything in here used to be a
// module-level singleton addressed by element id — `#file-panel-viewer`, `#file-panel-diff`,
// `#file-panel-body`, `#file-panel-actions`, `#diff-title`, `#diff-path`. An id is unique, so there could
// only ever be one, which IS the reported symptom: opening a second preview moved the first.
//
// The ids are classes now (`fp-viewer`, `fp-diff`, `fp-body`, `fp-actions`), and every part is reached
// through this closure instead of the document. The two title spans lost their ids entirely — nothing
// styled them; `.viewer-toolbar-title` / `-path` did.
//
// What it does NOT own: the panel element, the resize handle, the width, which session is on screen. Those
// belong to the side-panel LAYOUT, of which there is one in tabs and grid mode, and none in panes mode.
//
// `tab` is state and stays outside — it carries `editorView`, `resolved` and the content, and it outlives
// a re-render (a diff-mode toggle rebuilds the view from the same tab). The instance is the DOM.
function createPanelInstance(parent, hooks = {}) {
  const root = document.createElement('div');
  root.className = 'fp-content';

  const viewerContainer = document.createElement('div');
  viewerContainer.className = 'fp-viewer';
  viewerContainer.style.display = 'none';
  root.appendChild(viewerContainer);

  const viewerPanel = new ViewerPanel(viewerContainer, {
    language: 'auto',
    onSave: (filePath, content) => window.api.saveFileForPanel(filePath, content),
    onClose: () => hooks.onClose?.(),
    // Open the current file in the external editor, then close the panel (#69).
    onExternalOpen: (filePath) => { window.api.openInEditor(filePath); hooks.onClose?.(); },
  });

  const diffContainer = document.createElement('div');
  diffContainer.className = 'fp-diff';
  diffContainer.style.display = 'none';
  root.appendChild(diffContainer);

  const toolbar = document.createElement('div');
  toolbar.className = 'viewer-toolbar';
  const info = document.createElement('div');
  info.className = 'viewer-toolbar-info';
  info.innerHTML = '<span class="viewer-toolbar-title"></span><span class="viewer-toolbar-path"></span>';
  toolbar.appendChild(info);
  const titleEl = info.querySelector('.viewer-toolbar-title');
  const pathEl = info.querySelector('.viewer-toolbar-path');

  const controls = document.createElement('div');
  controls.className = 'viewer-toolbar-controls';

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'fp-toolbar-btn';
  toggleBtn.addEventListener('click', () => hooks.onToggleDiffMode?.());
  controls.appendChild(toggleBtn);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'fp-toolbar-btn fp-save-btn fp-icon-btn';
  saveBtn.title = 'Save changes';
  saveBtn.innerHTML = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 448 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M433.941 129.941l-83.882-83.882A48 48 0 0 0 316.118 32H48C21.49 32 0 53.49 0 80v352c0 26.51 21.49 48 48 48h352c26.51 0 48-21.49 48-48V163.882a48 48 0 0 0-14.059-33.941zM272 80v80H144V80h128zm122 352H54a6 6 0 0 1-6-6V86a6 6 0 0 1 6-6h42v104c0 13.255 10.745 24 24 24h176c13.255 0 24-10.745 24-24V83.882l78.243 78.243a6 6 0 0 1 1.757 4.243V426a6 6 0 0 1-6 6zM224 232c-48.523 0-88 39.477-88 88s39.477 88 88 88 88-39.477 88-88-39.477-88-88-88zm0 128c-22.056 0-40-17.944-40-40s17.944-40 40-40 40 17.944 40 40-17.944 40-40 40z"></path></svg>';
  saveBtn.addEventListener('click', () => hooks.onDiffSave?.());
  controls.appendChild(saveBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'fp-toolbar-btn fp-close-btn fp-icon-btn';
  closeBtn.innerHTML = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M400 145.49 366.51 112 256 222.51 145.49 112 112 145.49 222.51 256 112 366.51 145.49 400 256 289.49 366.51 400 400 366.51 289.49 256 400 145.49z"></path></svg>';
  closeBtn.title = 'Close panel';
  closeBtn.addEventListener('click', () => hooks.onClose?.());
  controls.appendChild(closeBtn);

  toolbar.appendChild(controls);
  diffContainer.appendChild(toolbar);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'fp-body';
  diffContainer.appendChild(bodyEl);

  const actionsEl = document.createElement('div');
  actionsEl.className = 'fp-actions';
  actionsEl.style.display = 'none';
  diffContainer.appendChild(actionsEl);

  if (parent) parent.appendChild(root);

  function applyDiffModeLabel(mode) {
    toggleBtn.textContent = mode === 'inline' ? 'Side-by-Side' : 'Inline';
    toggleBtn.title = mode === 'inline' ? 'Switch to side-by-side diff' : 'Switch to inline diff';
  }
  applyDiffModeLabel(diffMode);

  function showNothing() {
    viewerContainer.style.display = 'none';
    diffContainer.style.display = 'none';
  }

  function renderDiff(sessionId, tab) {
    bodyEl.innerHTML = '';
    titleEl.textContent = tab.label;
    pathEl.textContent = tab.filePath || '';

    // Accept/reject is rendered synchronously so the UI appears immediately; the diff viewer itself is
    // deferred until the bundle loads.
    if (!tab.resolved) {
      actionsEl.style.display = 'flex';
      actionsEl.innerHTML = '';
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'file-panel-accept-btn';
      acceptBtn.textContent = 'Accept';
      acceptBtn.addEventListener('click', () => hooks.onDiffAction?.(sessionId, tab, 'accept'));
      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'file-panel-reject-btn';
      rejectBtn.textContent = 'Reject';
      rejectBtn.addEventListener('click', () => hooks.onDiffAction?.(sessionId, tab, 'reject'));
      actionsEl.appendChild(acceptBtn);
      actionsEl.appendChild(rejectBtn);
    } else {
      actionsEl.style.display = 'none';
    }

    window.loadCodeMirrorBundle().then(() => {
      if (tab.resolved) return; // accepted/rejected before the bundle loaded
      if (!tab.editorView) {
        const build = diffMode === 'inline' ? window.createUnifiedMergeViewer : window.createMergeViewer;
        tab.editorView = build(bodyEl, tab.oldContent, tab.newContent, tab.filePath);
        tab._diffMode = diffMode === 'inline' ? 'inline' : 'side-by-side';
        tab.editorView.dom.addEventListener('click', () => tab.editorView.dom.focus());
      } else {
        bodyEl.appendChild(tab.editorView.dom);
      }
    }).catch((err) => {
      console.error('[file-panel] Failed to load codemirror-bundle:', err);
    });
  }

  return {
    root,
    render(sessionId, tab) {
      if (!tab) { showNothing(); return; }
      if (tab.type === 'file') {
        diffContainer.style.display = 'none';
        viewerContainer.style.display = 'flex';
        viewerPanel.open(tab.label, tab.filePath, tab.content);
      } else {
        viewerContainer.style.display = 'none';
        diffContainer.style.display = 'flex';
        renderDiff(sessionId, tab);
      }
    },
    showNothing,
    hideDiffActions() { actionsEl.style.display = 'none'; },
    applyDiffModeLabel,
    // A tab's editor view lives in this body, so its search / goto-line bars are cached on it. Dropping
    // the tab without forgetting them leaves the next diff reusing a bar attached to a destroyed view.
    forgetEditorBars() { delete bodyEl._cmSearchBar; delete bodyEl._cmGotoLine; },
    destroyViewer() { viewerPanel.destroy(); },
  };
}

// ── Initialization ──────────────────────────────────────────────────

function initFilePanel() {
  const terminalArea = document.getElementById('terminal-area');
  const terminalsEl = document.getElementById('terminals');
  if (!terminalArea || !terminalsEl) return;

  // Create the split container
  terminalSplitEl = document.createElement('div');
  terminalSplitEl.id = 'terminal-split';

  terminalArea.removeChild(terminalsEl);
  terminalSplitEl.appendChild(terminalsEl);

  // Create resize handle
  filePanelResizeHandle = document.createElement('div');
  filePanelResizeHandle.id = 'file-panel-resize-handle';
  terminalSplitEl.appendChild(filePanelResizeHandle);

  // Create the file panel — the side-panel shell. Everything that renders inside it is one instance,
  // built by the factory above; there is exactly one here, and panes mode will ask for more (#311).
  filePanelEl = document.createElement('div');
  filePanelEl.id = 'file-panel';

  panelInstance = createPanelInstance(filePanelEl, {
    onClose: handleClose,
    onDiffSave: handleDiffSave,
    onToggleDiffMode: handleDiffModeToggle,
    onDiffAction: handleDiffAction,
  });

  terminalSplitEl.appendChild(filePanelEl);
  terminalArea.appendChild(terminalSplitEl);

  wireIpcListeners();
  setupPanelResizeHandle();
  addMcpToggle();
}

// ── Handlers ────────────────────────────────────────────────────────

function handleClose() {
  if (!currentPanelSessionId) return;
  const state = getSessionState(currentPanelSessionId);
  const tab = state.currentTab;

  if (tab) {
    if (tab.type === 'diff' && !tab.resolved) {
      window.api.mcpDiffResponse(currentPanelSessionId, tab.diffId, 'reject', null);
    }
    if (tab.type === 'diff' && tab.editorView) {
      tab.editorView.destroy();
      tab.editorView = null;
    }
    if (tab.type === 'file') {
      panelInstance.destroyViewer();
    }
    state.currentTab = null;
  }

  state.panelVisible = false;
  hidePanel();
}

async function handleDiffSave() {
  const state = currentPanelSessionId ? getSessionState(currentPanelSessionId) : null;
  const tab = state?.currentTab;
  if (!tab || tab.type !== 'diff' || !tab.editorView || !tab.filePath) return;

  let content;
  if (tab._diffMode === 'inline') {
    content = tab.editorView.state.doc.toString();
  } else if (tab.editorView.b) {
    content = tab.editorView.b.state.doc.toString();
  }
  if (content == null) return;

  const result = await window.api.saveFileForPanel(tab.filePath, content);
  if (result.ok) {
    const btn = panelInstance.root.querySelector('.fp-save-btn');
    if (btn) flashButtonText(btn, 'Saved!');
  }
}

function handleDiffModeToggle() {
  diffMode = diffMode === 'inline' ? 'side-by-side' : 'inline';
  localStorage.setItem(DIFF_MODE_KEY, diffMode);
  panelInstance.applyDiffModeLabel(diffMode);

  if (currentPanelSessionId) {
    const state = getSessionState(currentPanelSessionId);
    const tab = state.currentTab;
    if (tab && tab.type === 'diff') {
      if (tab.editorView) { tab.editorView.destroy(); tab.editorView = null; }
      panelInstance.render(currentPanelSessionId, tab);
    }
  }
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
    closeAllDiffs(sessionId);
  });

  window.api.onMcpCloseTab((sessionId, diffId) => {
    closeDiffByDiffId(sessionId, diffId);
  });
}

// ── Session State Helpers ───────────────────────────────────────────

function getSessionState(sessionId) {
  if (!filePanelState.has(sessionId)) {
    filePanelState.set(sessionId, {
      currentTab: null,
      panelVisible: false,
      panelWidth: DEFAULT_PANEL_WIDTH,
      mcpActive: false,
    });
  }
  return filePanelState.get(sessionId);
}

function setSessionMcpActive(sessionId, active) {
  const state = getSessionState(sessionId);
  const changed = state.mcpActive !== active;
  state.mcpActive = active;
  if (currentPanelSessionId === sessionId) updateMcpIndicator();
  // The sidebar row carries the badge since #321, so it has to hear about this too —
  // it is the only place the state shows in panes mode. Only on a real change: this
  // runs on every session open, and a rebuild per open would be a waste.
  if (changed && typeof refreshSidebar === 'function') refreshSidebar();
}

function getSessionFilePanelSummary(sessionId) {
  const tab = filePanelState.get(sessionId)?.currentTab;
  if (!tab) return null;
  return {
    type: tab.type,
    label: tab.label || basename(tab.filePath || ''),
  };
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

  // Destroy previous
  destroyCurrentTab(state);

  state.currentTab = {
    type: 'diff',
    label: data.tabName || basename(data.oldFilePath),
    filePath: data.oldFilePath,
    diffId,
    oldContent: data.oldContent,
    newContent: data.newContent,
    resolved: false,
    editorView: null,
  };

  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

function openFileTab(sessionId, data) {
  const state = getSessionState(sessionId);

  // Destroy previous
  destroyCurrentTab(state);

  state.currentTab = {
    type: 'file',
    label: basename(data.filePath),
    filePath: data.filePath,
    content: data.content,
  };

  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

function destroyCurrentTab(state) {
  const tab = state.currentTab;
  if (!tab) return;
  if (tab.type === 'diff' && tab.editorView) {
    tab.editorView.destroy();
    tab.editorView = null;
    panelInstance.forgetEditorBars();
  }
  if (tab.type === 'file') {
    panelInstance.destroyViewer();
  }
}

async function openFileInPanel(sessionId, filePath) {
  // Images are binary — read them as a data URL instead of UTF-8 text (#49).
  if (typeof previewKindForExt === 'function' && previewKindForExt(extOf(filePath)) === 'image') {
    const res = await window.api.readFileDataUrl(filePath);
    if (!res || !res.ok) {
      window.showControlToast?.({ message: (res && res.error) || 'Cannot preview image', timeoutMs: 3000 });
      return;
    }
    openFileTab(sessionId, { filePath, content: res.dataUrl });
    return;
  }
  const result = await window.api.readFileForPanel(filePath);
  if (!result.ok) return;
  openFileTab(sessionId, { filePath, content: result.content });
}

function closeAllDiffs(sessionId) {
  const state = filePanelState.get(sessionId);
  if (!state) return;

  if (state.currentTab?.type === 'diff') {
    destroyCurrentTab(state);
    state.currentTab = null;
    state.panelVisible = false;
    if (currentPanelSessionId === sessionId) hidePanel();
  }
}

function closeDiffByDiffId(sessionId, diffId) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab) return;
  if (state.currentTab.type !== 'diff' || state.currentTab.diffId !== diffId) return;

  state.currentTab.resolved = true;
  destroyCurrentTab(state);
  state.currentTab = null;
  state.panelVisible = false;
  if (currentPanelSessionId === sessionId) hidePanel();
}

// ── Panel Show/Hide ─────────────────────────────────────────────────

function showPanel(state) {
  if (!filePanelEl) return;
  filePanelEl.classList.add('open');
  // Panes mode (#310): the panel is not a fixed strip beside the terminal area,
  // it is a tab in the pane that produced it. The element is the same one — it
  // moves into that pane — so everything below (state, rendering, diff actions)
  // is unchanged. Width and the split handle belong to the side-panel layout.
  if (window.panesView && window.panesView.active()) {
    filePanelEl.style.width = '';
    filePanelResizeHandle.style.display = 'none';
    window.panesView.openViewTab('preview', { ref: currentPanelSessionId, nearSessionId: currentPanelSessionId });
    return;
  }
  filePanelEl.style.width = (state.panelWidth || DEFAULT_PANEL_WIDTH) + 'px';
  filePanelResizeHandle.style.display = 'block';
  refitActiveTerminal();
}

function hidePanel() {
  if (!filePanelEl) return;
  filePanelEl.classList.remove('open');
  if (window.panesView && window.panesView.active()) {
    // Drop the side-panel width too: left behind, it becomes an empty strip of the
    // old width the moment the mode changes back.
    filePanelEl.style.width = '';
    if (window.panesView.hasViewTab('preview')) window.panesView.closeViewTab('preview');
    return;
  }
  filePanelEl.style.width = '0';
  filePanelResizeHandle.style.display = 'none';
  refitActiveTerminal();
}

// Closing the panel's pane tab (#310) has to close the PANEL, not just take the
// tab out of the layout: its state decides whether the panel comes back, so a
// tab-only close is undone by the next session switch.
window.closeFilePanel = () => handleClose();

// Re-apply the side-panel geometry after panes mode handed the element back —
// showPanel skipped width and the resize handle while it was a pane tab.
window.filePanelRelayout = () => { if (currentPanelSessionId) switchPanel(currentPanelSessionId); };

// What the pane tab for this panel is called: the file or diff it currently
// shows, so the tab reads like an editor tab rather than like a container.
window.filePanelTabLabel = (sessionId) => {
  const state = filePanelState.get(sessionId || currentPanelSessionId);
  const tab = state && state.currentTab;
  return tab ? tab.label : null;
};

function switchPanel(sessionId) {
  currentPanelSessionId = sessionId;
  updateMcpIndicator();

  if (!sessionId) {
    hidePanel();
    return;
  }

  const state = getSessionState(sessionId);

  if (state.panelVisible && state.currentTab) {
    showPanel(state);
    renderPanel(sessionId);
  } else {
    hidePanel();
  }
}

function updateMcpIndicator() {
  if (!mcpIndicatorEl) return;
  if (!currentPanelSessionId) {
    mcpIndicatorEl.style.display = 'none';
    return;
  }
  const state = filePanelState.get(currentPanelSessionId);
  mcpIndicatorEl.style.display = (state && state.mcpActive) ? '' : 'none';
  // Panes mode carries the chip per pane instead of once in the header (#309), so
  // it needs the flag, not this element. Rebuilding the strips picks it up.
  if (window.panesView && window.panesView.active()) window.panesView.refreshChrome();
}

// Is IDE emulation active for this session? The chip's state, exposed as data so
// panes mode can render one chip per pane (#309) instead of reading the DOM.
window.isMcpActiveForSession = (sessionId) => {
  const state = filePanelState.get(sessionId);
  return !!(state && state.mcpActive);
};

// ── Panel Rendering ─────────────────────────────────────────────────

function renderPanel(sessionId) {
  if (!filePanelEl || currentPanelSessionId !== sessionId) return;

  const state = getSessionState(sessionId);
  if (!state) return;

  panelInstance.render(sessionId, state.currentTab);
}

// ── Diff Actions ────────────────────────────────────────────────────

function handleDiffAction(sessionId, tab, action) {
  if (tab.resolved) return;
  tab.resolved = true;

  if (action === 'accept') {
    let editedContent = null;
    if (tab.editorView) {
      if (tab._diffMode === 'inline') {
        editedContent = tab.editorView.state.doc.toString();
      } else if (tab.editorView.b) {
        editedContent = tab.editorView.b.state.doc.toString();
      }
    }

    if (editedContent && editedContent !== tab.newContent) {
      window.api.mcpDiffResponse(sessionId, tab.diffId, 'accept-edited', editedContent);
    } else {
      window.api.mcpDiffResponse(sessionId, tab.diffId, 'accept', null);
    }
  } else {
    window.api.mcpDiffResponse(sessionId, tab.diffId, 'reject', null);
  }

  panelInstance.hideDiffActions();
}

// ── IDE Emulation Indicator ─────────────────────────────────────────

let mcpIndicatorEl = null;

function addMcpToggle() {
  const controls = document.getElementById('terminal-header-controls');
  if (!controls) return;

  mcpIndicatorEl = document.createElement('span');
  mcpIndicatorEl.className = 'mcp-toggle enabled';
  mcpIndicatorEl.title = 'IDE Emulation is active. Go to Global Settings to disable.';
  mcpIndicatorEl.textContent = 'IDE Emulation';
  mcpIndicatorEl.style.display = 'none';

  const stopBtn = document.getElementById('terminal-stop-btn');
  if (stopBtn) {
    controls.insertBefore(mcpIndicatorEl, stopBtn);
  } else {
    controls.appendChild(mcpIndicatorEl);
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
