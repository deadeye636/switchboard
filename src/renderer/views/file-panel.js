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

// Every preview and every diff that is open, keyed by what it shows (#311).
//
//   key = `<kind>:<ref>`   ref = the file path for a preview, the diff id for a diff
//
// A NATURAL key on purpose: the MCP bridge re-sends the same file on every session switch, so a counter
// would pile up duplicates nobody asked for. Re-opening the same thing lands on the tab that has it.
//
// One model in every display mode, and the mode decides only one thing: outside panes mode the side panel
// shows one thing at a time, so opening a preview closes that session's previous one — which is what tabs
// and grid have always promised. In panes mode nothing closes; each entry is a tab of its own.
//
// entry = { key, kind, ref, sessionId, tab, instance }
//   `tab`      the state — label, filePath, diffId, contents, `resolved`, `editorView`
//   `instance` the DOM, from createPanelInstance. `instance.root` IS the element a pane hosts.
const panelTabs = new Map();
const tabKey = (kind, ref) => kind + ':' + String(ref);
const panesActive = () => !!(window.panesView && window.panesView.active());
// Set while a close is travelling through the pane tree, so panes-view calling back here does not start
// the same teardown a second time.
let closingThroughPanes = false;

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

  // Paging between the reviews of ONE session (#398). Several at once is a real case — the bridge
  // dispatches tool calls without awaiting the previous one — and they share this one surface now, so
  // without a counter a second one waiting would be invisible. Hidden entirely when there is one, which
  // is the common case: nothing to page through, nothing to explain.
  const pager = document.createElement('div');
  pager.className = 'fp-review-pager';
  pager.style.display = 'none';
  const prevBtn = document.createElement('button');
  prevBtn.className = 'fp-toolbar-btn fp-icon-btn';
  prevBtn.textContent = '‹';
  prevBtn.title = 'Previous review';
  prevBtn.addEventListener('click', () => hooks.onPageReview?.(-1));
  const pagerCount = document.createElement('span');
  pagerCount.className = 'fp-review-count';
  const nextBtn = document.createElement('button');
  nextBtn.className = 'fp-toolbar-btn fp-icon-btn';
  nextBtn.textContent = '›';
  nextBtn.title = 'Next review';
  nextBtn.addEventListener('click', () => hooks.onPageReview?.(1));
  pager.append(prevBtn, pagerCount, nextBtn);
  controls.appendChild(pager);

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
    /**
     * Say where this review sits among the session's open ones (#398).
     *
     * Hidden for the ordinary case of exactly one — a pager with nothing to page through is noise. With
     * more, the count is the part that matters: it is the only thing that says a second review is
     * waiting, which a tab used to say by existing.
     */
    setPager(index, total) {
      if (!total || total < 2) { pager.style.display = 'none'; return; }
      pager.style.display = '';
      pagerCount.textContent = `${index + 1} of ${total}`;
      pagerCount.title = `${total} reviews waiting in this session`;
    },
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

  // The side-panel shell. It holds no content of its own any more (#311): whichever entry is on screen
  // parks its instance root in here, and in panes mode the roots live in panes instead.
  filePanelEl = document.createElement('div');
  filePanelEl.id = 'file-panel';

  terminalSplitEl.appendChild(filePanelEl);
  terminalArea.appendChild(terminalSplitEl);

  wireIpcListeners();
  setupPanelResizeHandle();
  addMcpToggle();
}

// ── Handlers ────────────────────────────────────────────────────────

// The panel's own close button, for the entry that owns it. Outside panes mode this is also what the
// side panel's × means, because there is only ever one entry on screen there.
function handleClose(entry) {
  const target = entry || shownEntryFor(currentPanelSessionId);
  if (target) { closePanelTab(target.key); return; }
  if (currentPanelSessionId) getSessionState(currentPanelSessionId).panelVisible = false;
  hidePanel();
}

async function handleDiffSave(entry) {
  const tab = entry && entry.tab;
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
    const btn = entry.instance.root.querySelector('.fp-save-btn');
    if (btn) flashButtonText(btn, 'Saved!');
  }
}

// Side-by-side or inline is a SETTING, so it applies to every diff on screen — the label and the rebuild
// are per instance, the choice is not.
function handleDiffModeToggle() {
  diffMode = diffMode === 'inline' ? 'side-by-side' : 'inline';
  localStorage.setItem(DIFF_MODE_KEY, diffMode);
  for (const entry of panelTabs.values()) {
    entry.instance.applyDiffModeLabel(diffMode);
    if (entry.tab.type !== 'diff') continue;
    if (entry.tab.editorView) { entry.tab.editorView.destroy(); entry.tab.editorView = null; }
    entry.instance.forgetEditorBars();
    entry.instance.render(entry.sessionId, entry.tab);
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
      currentTab: null,   // what the side panel shows for this session — the entry it opened last
      shownKey: null,     // …and that entry's key in `panelTabs` (#311)
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
  // The entries have to follow too (#311). They carry the session id themselves, because that is what
  // answers the bridge — so a `/clear` left every open preview and diff tagged with a session that no
  // longer exists: `close_tab` from the CLI arrives under the NEW id and matched nothing, and closing an
  // entry looked up a state bucket that had already moved.
  for (const entry of panelTabs.values()) {
    if (entry.sessionId === oldId) entry.sessionId = newId;
  }
}

/**
 * Leaving panes mode collapses to one entry per session (#311).
 *
 * The side panel shows one thing at a time, so the others have nowhere to go — and a pane rebuild has
 * already taken their DOM. Left in the registry they would be unreachable AND unanswered, which is the
 * hang this whole change exists to prevent: closing them answers the diffs, exactly as displacing one in
 * the side panel does.
 */
window.filePanelCollapseToOne = () => {
  const keep = new Set();
  for (const state of filePanelState.values()) if (state.shownKey) keep.add(state.shownKey);
  for (const key of [...panelTabs.keys()]) {
    if (!keep.has(key)) closePanelTab(key, { keepPanel: true });
  }
};

// ── Tab Operations ──────────────────────────────────────────────────

/** Every entry belonging to a session, oldest first. */
function entriesOf(sessionId) {
  return [...panelTabs.values()].filter((e) => e.sessionId === sessionId);
}

/** What the side panel shows for a session: the one it opened last. */
function shownEntryFor(sessionId) {
  const state = sessionId ? filePanelState.get(sessionId) : null;
  const key = state && state.shownKey;
  return (key && panelTabs.get(key)) || null;
}

/**
 * Create the entry for a preview or a diff, or re-target the one that already shows it.
 *
 * Re-targeting rather than replacing is the whole point of the natural key: the same file arriving again
 * keeps its instance, its place in the layout and the pane the user dropped it into.
 */
function upsertPanelTab(sessionId, kind, ref, tab) {
  const key = tabKey(kind, ref);
  const existing = panelTabs.get(key);
  if (existing) {
    destroyTabContent(existing);
    existing.sessionId = sessionId;
    existing.tab = tab;
    return existing;
  }
  // Outside panes mode the side panel shows one thing at a time. Closing the previous entry here is what
  // keeps tabs and grid behaving exactly as before — and it answers the unresolved diff on the way out,
  // instead of leaving a CLI waiting for a call nothing can reach any more.
  if (!panesActive()) for (const e of entriesOf(sessionId)) closePanelTab(e.key, { keepPanel: true });

  const entry = { key, kind, ref, sessionId, tab, instance: null };
  entry.instance = createPanelInstance(null, {
    onClose: () => handleClose(entry),
    onDiffSave: () => handleDiffSave(entry),
    onToggleDiffMode: handleDiffModeToggle,
    onDiffAction: (_sid, _tab, action) => handleDiffAction(entry, action),
    onPageReview: (direction) => pageReview(entry, direction),
  });
  panelTabs.set(key, entry);
  return entry;
}

/** The element a pane hosts for this tab (#311). Panes-view asks; it never builds one. */
window.filePanelHostFor = (kind, ref) => {
  const entry = panelTabs.get(tabKey(kind, ref));
  return (entry && entry.instance.root) || null;
};

/**
 * The review a session is showing right now, for the pane that renders that session (#398).
 *
 * A review does not get a tab of its own any more. It belongs to one session, it is read while the
 * terminal underneath it is used to answer it — the accept/reject buttons are the CLI's, not ours — so
 * a tab promising a separate surface delivered the same session with an attachment, and the session
 * ended up occupying two tabs, one a subset of the other.
 *
 * Several reviews of one session are a real case: the bridge dispatches tool calls without awaiting the
 * previous one, so a CLI can have two open at once. They share this one surface and are paged through,
 * which is why the shown one is a property of the SESSION rather than of a tab.
 */
window.filePanelReviewHostFor = (sessionId) => {
  const entry = shownEntryFor(sessionId);
  if (!entry || entry.kind !== 'diff') return null;
  return entry.instance.root || null;
};

/** Every open review of a session, oldest first — what the pager pages through. */
function reviewsOf(sessionId) {
  return entriesOf(sessionId).filter((e) => e.kind === 'diff');
}

/**
 * Move to the review before or after this one, within its own session (#398).
 *
 * Paging answers NOTHING: it changes which review is on screen and nothing else. The one paged away
 * from stays open and still blocks its CLI, which is the whole reason the counter has to be visible.
 * It wraps, because with two reviews "next" and "previous" should both reach the other one.
 */
function pageReview(entry, direction) {
  const reviews = reviewsOf(entry.sessionId);
  if (reviews.length < 2) return;
  const at = reviews.findIndex((e) => e.key === entry.key);
  const next = reviews[(at + direction + reviews.length) % reviews.length];
  if (!next || next.key === entry.key) return;

  const state = getSessionState(entry.sessionId);
  state.shownKey = next.key;
  state.currentTab = next.tab;
  if (panesActive()) window.panesView?.render?.();
  next.instance.render(entry.sessionId, next.tab);
  updateReviewPager(entry.sessionId);
}

/** Keep every review of a session honest about where it sits in the queue. */
function updateReviewPager(sessionId) {
  const reviews = reviewsOf(sessionId);
  reviews.forEach((e, i) => e.instance.setPager?.(i, reviews.length));
}

/**
 * Which session this preview or diff was opened FROM (#388).
 *
 * A file panel is always reached from a session — a terminal's file link, its context menu, or the
 * MCP bridge — so that session is what closing it should go back to. The pane tree cannot know: its
 * close rule picks the neighbouring tab by position, which is right for a terminal tab and lands
 * somewhere unrelated for a file.
 *
 * Answers null when nothing holds that ref, and the caller then does what it always did.
 */
window.filePanelSessionFor = (kind, ref) => {
  const entry = panelTabs.get(tabKey(kind, ref));
  return (entry && entry.sessionId) || null;
};

/** What a pane tab for this entry is called — the file or the diff it shows. */
window.filePanelTabLabel = (kind, ref) => {
  const entry = panelTabs.get(tabKey(kind, ref));
  return (entry && entry.tab.label) || null;
};

/** Closing the pane tab closes the view — panes-view routes here (#311). */
window.filePanelCloseInstance = (kind, ref) => {
  closingThroughPanes = true;
  try { closePanelTab(tabKey(kind, ref)); } finally { closingThroughPanes = false; }
};

/**
 * Take everything that is open into the pane tree. Called when panes mode turns on with the side panel
 * already showing something: left alone it stays a fixed strip squeezing the tree, with no tab (#310).
 */
window.filePanelReopenInPanes = () => {
  for (const entry of panelTabs.values()) {
    window.panesView?.openViewTab(entry.kind, { ref: entry.ref, nearSessionId: entry.sessionId });
  }
};

/** Tear down what an entry RENDERS, leaving the entry itself in place (a re-target, a mode toggle). */
function destroyTabContent(entry) {
  const tab = entry.tab;
  if (!tab) return;
  if (tab.type === 'diff' && tab.editorView) {
    tab.editorView.destroy();
    tab.editorView = null;
    entry.instance.forgetEditorBars();
  }
  if (tab.type === 'file') entry.instance.destroyViewer();
}

/**
 * Close one entry for good.
 *
 * An unanswered diff is REJECTED on the way out, per entry: a pane holding three diff tabs rejects those
 * three and nothing else. Without it the CLI's `tools/call` hangs until the bridge's ten-minute timeout.
 */
function closePanelTab(key, { keepPanel = false, answer = true } = {}) {
  const entry = panelTabs.get(key);
  if (!entry) return;
  const tab = entry.tab;
  if (answer && tab && tab.type === 'diff' && !tab.resolved) {
    tab.resolved = true;
    window.api.mcpDiffResponse(entry.sessionId, tab.diffId, 'reject', null);
  }
  destroyTabContent(entry);
  entry.instance.root.remove();
  panelTabs.delete(key);

  // The pane tab goes with it — unless the pane tree is what asked for this close.
  if (panesActive() && !closingThroughPanes && window.panesView?.hasViewTab?.(entry.kind, entry.ref)) {
    window.panesView.closeViewTab(entry.kind, { ref: entry.ref });
  }

  const state = filePanelState.get(entry.sessionId);
  if (state && state.shownKey === key) {
    const next = entriesOf(entry.sessionId).pop();
    state.shownKey = next ? next.key : null;
    state.currentTab = next ? next.tab : null;
    state.panelVisible = !!next;
    // In panes mode a review has no tab to fall back to (#398), so answering the visible one has to
    // put the next one on screen here — otherwise the surface goes blank while a review is still open
    // and still blocking its CLI, which is the failure the counter exists to make impossible.
    if (panesActive()) {
      window.panesView?.render?.();
      if (next) next.instance.render(entry.sessionId, next.tab);
    } else if (!keepPanel && currentPanelSessionId === entry.sessionId) {
      if (next) { showPanel(state); renderPanel(entry.sessionId); }
      else hidePanel();
    }
  }
  updateReviewPager(entry.sessionId);
}

function openDiffTab(sessionId, diffId, data) {
  const state = getSessionState(sessionId);
  const entry = upsertPanelTab(sessionId, 'diff', diffId, {
    type: 'diff',
    label: data.tabName || basename(data.oldFilePath),
    filePath: data.oldFilePath,
    diffId,
    oldContent: data.oldContent,
    newContent: data.newContent,
    resolved: false,
    editorView: null,
  });
  revealEntry(state, sessionId, entry);
}

function openFileTab(sessionId, data) {
  const state = getSessionState(sessionId);
  const entry = upsertPanelTab(sessionId, 'preview', data.filePath, {
    type: 'file',
    label: basename(data.filePath),
    filePath: data.filePath,
    content: data.content,
  });
  revealEntry(state, sessionId, entry);
}

/** Make this entry the one on screen: a pane tab in panes mode, the side panel's content otherwise. */
function revealEntry(state, sessionId, entry) {
  state.shownKey = entry.key;
  state.currentTab = entry.tab;
  state.panelVisible = true;
  if (panesActive()) {
    // The shell still has to enter its panes state: `.open` is how a later mode switch learns something
    // is showing, and the width and the resize handle belong to a side panel that does not exist here.
    showPanel(state);
    // A REVIEW rides along with its session's tab (#398) — it is read and answered together with the
    // terminal underneath it, so it is not a surface of its own. Everything else still gets a tab: a
    // preview is for looking at, and several files side by side is the point of one.
    if (entry.kind === 'diff') {
      window.panesView.render?.();
    } else {
      window.panesView.openViewTab(entry.kind, { ref: entry.ref, nearSessionId: sessionId });
    }
    entry.instance.render(sessionId, entry.tab);
    updateReviewPager(sessionId);
    window.panesView.refreshChrome?.();
    return;
  }
  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
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
  // The CLI asked for this, so its calls are already settled — closing must not answer them.
  for (const entry of entriesOf(sessionId)) {
    if (entry.tab.type === 'diff') closePanelTab(entry.key, { answer: false });
  }
}

function closeDiffByDiffId(sessionId, diffId) {
  const entry = panelTabs.get(tabKey('diff', diffId));
  if (!entry || entry.sessionId !== sessionId) return;
  closePanelTab(entry.key, { answer: false });
}

// ── Panel Show/Hide ─────────────────────────────────────────────────

function showPanel(state) {
  if (!filePanelEl) return;
  filePanelEl.classList.add('open');
  // Panes mode (#310, #311): the panel is not a fixed strip beside the terminal area, and since #311 it
  // is not one element either — each entry's instance root is a tab in the pane that produced it. Width
  // and the split handle belong to the side-panel layout, which does not exist here.
  if (panesActive()) {
    filePanelEl.style.width = '';
    filePanelResizeHandle.style.display = 'none';
    return;
  }
  // Outside panes mode the shell holds whichever entry is on screen. `replaceChildren` rather than append:
  // the previous entry's root must not be left behind stacked underneath it.
  const entry = shownEntryFor(currentPanelSessionId);
  if (entry) filePanelEl.replaceChildren(entry.instance.root);
  filePanelEl.style.width = (state.panelWidth || DEFAULT_PANEL_WIDTH) + 'px';
  filePanelResizeHandle.style.display = 'block';
  refitActiveTerminal();
}

function hidePanel() {
  if (!filePanelEl) return;
  filePanelEl.classList.remove('open');
  if (panesActive()) {
    // Drop the side-panel width too: left behind, it becomes an empty strip of the old width the moment
    // the mode changes back.
    filePanelEl.style.width = '';
    return;
  }
  filePanelEl.replaceChildren();
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

function switchPanel(sessionId) {
  currentPanelSessionId = sessionId;
  updateMcpIndicator();

  if (!sessionId) {
    hidePanel();
    return;
  }

  const state = getSessionState(sessionId);

  if (state.panelVisible && shownEntryFor(sessionId)) {
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
  const entry = shownEntryFor(sessionId);
  if (entry) entry.instance.render(sessionId, entry.tab);
}

// ── Diff Actions ────────────────────────────────────────────────────

function handleDiffAction(entry, action) {
  const tab = entry && entry.tab;
  if (!tab || tab.resolved) return;
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
      window.api.mcpDiffResponse(entry.sessionId, tab.diffId, 'accept-edited', editedContent);
    } else {
      window.api.mcpDiffResponse(entry.sessionId, tab.diffId, 'accept', null);
    }
  } else {
    window.api.mcpDiffResponse(entry.sessionId, tab.diffId, 'reject', null);
  }

  entry.instance.hideDiffActions();
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
