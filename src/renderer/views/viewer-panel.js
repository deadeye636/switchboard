/**
 * viewer-panel.js — Unified viewer component for CodeMirror-based panels.
 *
 * A single component used by plan viewer, memory viewer, and file panel.
 * Manages toolbar, editor, preview area, and all interactions.
 * Watches files for external changes and reloads automatically.
 *
 * Toolbar buttons are shown/hidden automatically based on file type:
 *   - View modes (live/preview/text): shown for previewable files (Markdown and HTML)
 *   - Wrap: always shown (defaults on for markdown, off for others)
 *   - Save: shown if onSave is provided, hidden for a file that cannot be written
 *   - Close: shown if onClose is provided
 *   - Copy path/content: shown if opted in
 *
 * A previewable file has three modes (#281), the same three Obsidian has:
 *   live     the source editor drawn as the rendered document — markers hidden,
 *            content styled — plus the formatting bar. The cursor's line shows
 *            its markers again, which is what makes it editable.
 *   preview  the rendered document, read-only
 *   text     the source as it is, every marker visible, no bar
 * All three hold the SAME text: the file's own. Nothing serialises anything back.
 * Everything else has one view and no control.
 *
 * Depends on: viewer-toolbar.js, format-toolbar.js, format-commands.js
 * Reads five globals off `appGlobalSettings` (app.js), all guarded by typeof:
 *   markdownDefaultView     — rendered-or-source for every previewable kind (#279, legacy key)
 *   editorToolbarMode       — which of the two source modes the setting means (#281)
 *   editorToolbarPlacement  — where the formatting bar sits (#281)
 *   editorToolbarVisibility — always, or only under the pointer / on focus (#281)
 *   editorToolbarHtmlTags   — whether the Markdown bar offers its four HTML commands (#281)
 * codemirror-bundle.js is loaded on demand (lazy) via loadCodeMirrorBundle();
 * `live` itself lives in the bundle (jsonl/live-markdown.js) and is switched
 * through window.setLivePreview.
 */

// ── Lazy CodeMirror loader ───────────────────────────────────────────────────
//
// Returns a Promise that resolves once codemirror-bundle.js has been injected
// and its globals (CMEditorView, createPlanEditor, …) are available on window.
// The Promise is cached after the first call — the <script> is injected exactly
// once regardless of how many callers race to open a panel.

let _cmBundlePromise = null;

function loadCodeMirrorBundle() {
  if (_cmBundlePromise) return _cmBundlePromise;

  _cmBundlePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'codemirror-bundle.js';
    script.onload = () => resolve();
    script.onerror = (err) => { _cmBundlePromise = null; reject(err); };
    document.head.appendChild(script);
  });

  return _cmBundlePromise;
}

window.loadCodeMirrorBundle = loadCodeMirrorBundle;

// Every live panel, so a settings change reaches the formatting bar without
// reopening the file (#281). app.js calls the hook below from
// reapplyGlobalSettings, AFTER it has refreshed appGlobalSettings — a listener
// registered here would run before that and read the old values, because these
// panels are constructed long before app.js binds its own.
//
// Detached panels prune themselves on the next broadcast: the file panel creates
// one instance per tab (#311), and destroy() is its between-files teardown, not
// its end of life, so there is no single moment to unregister in.
const _livePanels = new Set();

window._applyViewerFormatSettings = () => {
  for (const panel of _livePanels) {
    if (!panel.container || !panel.container.isConnected) { _livePanels.delete(panel); continue; }
    panel._applyFormatBar();
  }
};

class ViewerPanel {
  /**
   * @param {HTMLElement} container - Parent element to render into
   * @param {Object} opts
   * @param {Function}  opts.onSave       - async (filePath, content) => result
   * @param {Function}  opts.onClose      - () => void
   * @param {boolean}   opts.copyPath     - Show copy-path button
   * @param {boolean}   opts.copyContent  - Show copy-content button
   * @param {string}    opts.language     - 'markdown' or 'auto' (default 'markdown')
   * @param {string}    opts.storageKey   - localStorage key for preview mode persistence
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;

    // State
    this.filePath = '';
    this.editorView = null;
    this.viewMode = 'live';
    this.readOnly = false;
    this.wrapMode = false;
    this._previewable = false;
    this._formatKind = null;
    this._watchedPath = null;
    this._saving = false;

    // Create toolbar — always include the mode control, wrap and save; visibility
    // managed in open()
    this.toolbar = window.createViewerToolbar({
      copyPath: !!opts.copyPath,
      copyContent: !!opts.copyContent,
      viewModes: true,
      wrap: true,
      gotoLine: true,
      format: !!opts.format,
      delete: !!opts.onDelete,
      save: !!opts.onSave,
      close: !!opts.onClose,
      externalEditor: !!opts.onExternalOpen,
    });
    container.insertBefore(this.toolbar.el, container.firstChild);

    // The overlay and selection placements position themselves against this
    // element, so it has to be the offset parent (#281).
    container.classList.add('viewer-panel-host');

    // Formatting bar, directly under the toolbar row and above the editor (#281).
    this.formatBar = window.createFormatBar
      ? window.createFormatBar({ onCommand: (cmd, value) => this._runFormatCommand(cmd, value) })
      : null;
    if (this.formatBar) container.insertBefore(this.formatBar.el, this.toolbar.el.nextSibling);

    // Create editor area
    this.editorEl = document.createElement('div');
    this.editorEl.className = 'viewer-panel-editor';
    container.appendChild(this.editorEl);

    // Selection placement: the popup follows the selection, so the panel watches
    // for one. CodeMirror's update listener is not reachable from here (the
    // bundle exposes views, not extensions), and reading the selection off the
    // view after a mouse or key event is enough — it is the same state the
    // command would run against.
    this._onEditorSelectionChange = () => this._syncSelectionPopup();
    for (const evt of ['mouseup', 'keyup', 'focusout']) {
      this.editorEl.addEventListener(evt, this._onEditorSelectionChange);
    }

    // Create preview area
    this.previewEl = document.createElement('div');
    this.previewEl.className = 'markdown-preview';
    this.previewEl.style.display = 'none';
    container.appendChild(this.previewEl);

    // Wire toolbar events
    this._wireEvents();

    // Listen for Cmd/Ctrl+S from CM editors
    container.addEventListener('cm-save', () => this._save());

    // Listen for file changes from main process
    this._onFileChanged = (changedPath) => {
      if (changedPath === this._watchedPath && !this._saving) {
        this._reloadFromDisk();
      }
    };
    if (window.api.onFileChanged) {
      this._offFileChanged = window.api.onFileChanged(this._onFileChanged);
    }

    _livePanels.add(this);
  }

  _wireEvents() {
    const { toolbar, opts } = this;

    for (const [mode, btn] of Object.entries(toolbar.modeButtons || {})) {
      btn.addEventListener('click', () => this._setViewMode(mode));
    }

    if (toolbar.previewBtn) {
      toolbar.previewBtn.addEventListener('click', () => this._togglePreview());
    }

    if (toolbar.wrapBtn) {
      toolbar.wrapBtn.addEventListener('click', () => this._toggleWrap());
    }

    if (toolbar.gotoLineBtn) {
      toolbar.gotoLineBtn.addEventListener('click', () => {
        if (this.editorView && window.cmOpenGotoLine) {
          window.cmOpenGotoLine(this.editorView);
        }
      });
    }

    if (toolbar.saveBtn && opts.onSave) {
      toolbar.saveBtn.addEventListener('click', () => this._save());
    }

    if (toolbar.closeBtn && opts.onClose) {
      toolbar.closeBtn.addEventListener('click', () => opts.onClose());
    }

    if (toolbar.externalEditorBtn && opts.onExternalOpen) {
      toolbar.externalEditorBtn.addEventListener('click', () => {
        if (this.filePath) opts.onExternalOpen(this.filePath);
      });
    }

    if (toolbar.copyPathBtn) {
      toolbar.copyPathBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(this.filePath);
        toolbar.flashCopyPath();
      });
    }

    if (toolbar.copyContentBtn) {
      toolbar.copyContentBtn.addEventListener('click', () => {
        const content = this.getContent();
        navigator.clipboard.writeText(content);
        toolbar.flashCopyContent();
      });
    }

    if (toolbar.formatBtn) {
      toolbar.formatBtn.addEventListener('click', () => this._format());
    }

    if (toolbar.deleteBtn && opts.onDelete) {
      toolbar.deleteBtn.addEventListener('click', () => this._delete());
    }
  }

  _format() {
    if (!this.editorView || !this.filePath) return;
    const ext = this.filePath.split('.').pop()?.toLowerCase();
    const raw = this.getContent();
    let formatted = null;
    try {
      if (ext === 'jsonl') {
        // Pretty-print each JSON line, separate with --- to preserve line semantics
        const lines = raw.split('\n').filter(l => l.trim().length > 0);
        formatted = lines.map(l => JSON.stringify(JSON.parse(l), null, 2)).join('\n---\n');
      } else {
        // Default: treat as JSON
        formatted = JSON.stringify(JSON.parse(raw), null, 2);
      }
    } catch (err) {
      window.flashButtonText?.(this.toolbar.formatBtn, '!', 1200);
      return;
    }
    if (formatted === raw) return;
    this.editorView.dispatch({
      changes: { from: 0, to: this.editorView.state.doc.length, insert: formatted },
    });
    window.flashButtonText?.(this.toolbar.formatBtn, '✓', 800);
  }

  async _delete() {
    if (!this.opts.onDelete || !this.filePath) return;
    const name = this.filePath.split('/').pop();
    // App control dialog instead of native confirm/alert (issue #78).
    const ok = await showControlDialog({
      title: `Delete "${name}"?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const result = await this.opts.onDelete(this.filePath);
      if (result && result.ok !== false) {
        // Close panel and trigger refresh through onClose
        if (this.opts.onClose) this.opts.onClose();
      } else {
        showControlMessage({ title: 'Delete failed', message: result?.error || 'unknown error', tone: 'danger' });
      }
    } catch (err) {
      showControlMessage({ title: 'Delete failed', message: err.message, tone: 'danger' });
    }
  }

  /**
   * Open a file in the viewer.
   *
   * The toolbar and file-watch are configured synchronously so the panel
   * header appears immediately. CodeMirror editor creation is deferred until
   * codemirror-bundle.js has been loaded (first call triggers the load; all
   * subsequent calls share the same cached Promise and resolve near-instantly).
   */
  open(title, filePath, content, options = {}) {
    this._unwatchFile();

    this.filePath = filePath;
    this.readOnly = !!options.readOnly;
    this.toolbar.setTitle(title);
    this.toolbar.setPath(filePath);
    this.toolbar.setReadOnly(this.readOnly);

    this._previewKind = (typeof previewKindForExt === 'function')
      ? previewKindForExt(typeof extOf === 'function' ? extOf(filePath) : (filePath.split('.').pop() || '').toLowerCase())
      : 'text';

    // Image preview: render the data URL as an <img>, no CodeMirror editor (#49).
    if (this._previewKind === 'image') {
      this._openImage(title, filePath, content);
      return;
    }
    this._imageMode = false;
    // Restore editor + editor-only buttons (a prior image open may have hidden them).
    this.editorEl.style.display = '';
    for (const b of [this.toolbar.wrapBtn, this.toolbar.gotoLineBtn]) {
      if (b) b.style.display = '';
    }
    // Saving a file that cannot be written is a button that only ever fails.
    if (this.toolbar.saveBtn) {
      this.toolbar.saveBtn.style.display = this.readOnly ? 'none' : '';
    }

    const isMd = this._isMarkdown(filePath);
    const isPreviewable = this._isPreviewable(filePath);
    const isJsonish = this._isJsonish(filePath);

    this._previewable = isPreviewable;
    this._formatKind = isPreviewable ? (isMd ? 'markdown' : 'html') : null;

    // The three-way control replaces the old preview toggle for previewable kinds.
    this.toolbar.setViewModesVisible(isPreviewable);
    if (this.toolbar.previewBtn) {
      this.toolbar.previewBtn.style.display = 'none';
    }
    // Format button: only for .json / .jsonl
    if (this.toolbar.formatBtn) {
      this.toolbar.formatBtn.style.display = isJsonish ? '' : 'none';
    }

    // Reset to a source view before updating content (without touching localStorage)
    this.previewEl.style.display = 'none';
    this.editorEl.style.display = '';
    this.viewMode = 'live';
    this.toolbar.setPreviewMode(false);

    // Watch for external changes (sync — does not need CodeMirror)
    this._watchFile(filePath);

    // Snapshot the caller's intent so that if open() is called again before
    // the bundle resolves, the latest content/filePath wins.
    // A monotonically-incrementing generation token lets each .then() callback
    // identify whether it is the most-recent open() call or a stale one.
    this._openGen = (this._openGen || 0) + 1;
    const myGen = this._openGen;
    const pending = { content, filePath, isMd, isPreviewable };

    // Ask whether the file can be written, unless the caller already knows (#281).
    // The panel asks rather than each of the four readers reporting it: three of
    // them return a bare string, and a caller-supplied flag would be present only
    // where someone remembered to pass it.
    const readOnlyProbe = options.readOnly !== undefined
      ? Promise.resolve(!!options.readOnly)
      : Promise.resolve(window.api.isFileReadOnly ? window.api.isFileReadOnly(filePath) : false)
        .catch(() => false);

    // Defer all CodeMirror work until the bundle is available.
    Promise.all([loadCodeMirrorBundle(), readOnlyProbe]).then(([, readOnly]) => {
      // Guard: if open() was called again after this closure was queued,
      // a newer call has incremented _openGen — skip this stale one.
      if (this._openGen !== myGen) return;
      const { content: c, filePath: fp, isMd: md, isPreviewable: previewable } = pending;

      this.readOnly = !!readOnly;
      this.toolbar.setReadOnly(this.readOnly);
      if (this.toolbar.saveBtn) this.toolbar.saveBtn.style.display = this.readOnly ? 'none' : '';

      // Resolve the starting mode before creating/updating the editor. A stored
      // per-viewer choice wins; with none, the settings decide (#279, #281).
      const stored = (previewable && this.opts.storageKey) ? localStorage.getItem(this.opts.storageKey) : null;
      const wantMode = this._resolveViewMode(previewable, stored);

      // Create or update editor
      if (!this.editorView) {
        this._createEditor(c, fp);
      } else {
        this.editorView.dispatch({
          changes: { from: 0, to: this.editorView.state.doc.length, insert: c },
        });
      }

      // Set wrap default based on file type
      this.wrapMode = md;
      this.toolbar.setWrapMode(this.wrapMode);
      if (this.editorView && this.editorView._wrapCompartment) {
        this.editorView.dispatch({
          effects: this.editorView._wrapCompartment.reconfigure(
            this.wrapMode ? window.CMEditorView.lineWrapping : []
          ),
        });
      }

      // Apply the resolved mode. Persist only when the value came from storage —
      // a settings seed (stored === null) must not be written back, or it would
      // pin itself and outlive the setting (#279) — and never when read-only
      // forced the choice, which would pin one unwritable file's mode onto the
      // rest (#281).
      const migrate = stored !== null && !this.readOnly && stored !== wantMode;
      this.viewMode = null; // force _setViewMode to apply, even for 'live'
      this._setViewMode(wantMode, migrate);
    }).catch((err) => {
      console.error('[viewer-panel] Failed to load codemirror-bundle:', err);
    });
  }

  // Render an image file (content is a data URL) as an <img>; view-only, so the
  // editor and editor-only toolbar buttons are hidden (#49).
  _openImage(title, filePath, dataUrl) {
    this._imageMode = true;
    this._watchFile(filePath);
    if (this.editorView) { this.editorView.destroy(); this.editorView = null; }
    this.editorEl.style.display = 'none';
    for (const b of [this.toolbar.previewBtn, this.toolbar.formatBtn, this.toolbar.wrapBtn,
                     this.toolbar.saveBtn, this.toolbar.gotoLineBtn]) {
      if (b) b.style.display = 'none';
    }
    this.toolbar.setViewModesVisible(false);
    this._previewable = false;
    this._formatKind = null;
    this.viewMode = 'live';
    this._applyFormatBar();
    this.previewEl.innerHTML = '';
    const img = document.createElement('img');
    img.className = 'fp-image-preview';
    img.alt = title || '';
    img.src = dataUrl;
    this.previewEl.appendChild(img);
    this.previewEl.style.display = 'block';
  }

  _createEditor(content, filePath) {
    if (this.opts.language === 'auto') {
      this.editorView = window.createEditableViewer(
        this.editorEl, content, filePath, { wrap: this.wrapMode },
      );
    } else {
      this.editorView = window.createPlanEditor(this.editorEl);
      if (content) {
        this.editorView.dispatch({
          changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
        });
      }
    }
  }

  // `previewMode` stayed as a derived read: it is what the rest of the panel and
  // its tests ask about, and there is exactly one source of truth for it.
  get previewMode() { return this.viewMode === 'preview'; }

  // Which of the two source modes the settings mean.
  _toolbarMode() {
    const settings = (typeof appGlobalSettings !== 'undefined' && appGlobalSettings) || {};
    return settings.editorToolbarMode === 'plain' ? 'text' : 'live';
  }

  // The starting mode, in priority order: a file that cannot be written is pinned
  // to preview, then the stored per-viewer choice (including the two legacy
  // boolean values this replaced), then the settings.
  _resolveViewMode(previewable, stored) {
    if (!previewable) return 'live';
    if (this.readOnly) return 'preview';
    if (stored === 'live' || stored === 'preview' || stored === 'text') return stored;
    // Two legacies now: the key first held the preview flag as 'true' / 'false',
    // then the source mode was called 'edit' before Live Preview gave it a
    // rendering of its own.
    if (stored === 'edit') return 'live';
    if (stored === 'true') return 'preview';
    if (stored === 'false') return this._toolbarMode();
    const settings = (typeof appGlobalSettings !== 'undefined' && appGlobalSettings) || {};
    return settings.markdownDefaultView === 'preview' ? 'preview' : this._toolbarMode();
  }

  // persist=false is used when the settings seed the initial mode: it must not
  // write to storageKey, or that default would freeze into a per-viewer override
  // and later changes to the setting would be ignored (#279).
  _setViewMode(mode, persist = true) {
    if (!this._previewable && mode !== 'live') return;
    // The pin applies where there is something to pin TO: a kind with no rendered
    // preview keeps its single editor view, read-only or not.
    if (this.readOnly && this._previewable && mode !== 'preview') return;
    if (mode === this.viewMode) return;

    this.viewMode = mode;
    this._applyViewMode();
    if (persist && this.opts.storageKey && this._previewable) {
      localStorage.setItem(this.opts.storageKey, mode);
    }
  }

  _applyViewMode() {
    if (this.previewMode) {
      this._renderPreview();
      this.editorEl.style.display = 'none';
      this.previewEl.style.display = 'block';
    } else {
      this.previewEl.style.display = 'none';
      this.previewEl.innerHTML = ''; // drop the rendered content / iframe
      this.editorEl.style.display = '';
    }
    this.toolbar.setViewMode(this.viewMode);
    this.toolbar.setPreviewMode(this.previewMode);
    this._applyLiveMarkdown();
    this._applyFormatBar();
  }

  // `live` is the same editor over the same text as `text` — only drawn with the
  // markers hidden and the content styled. Toggling it is a compartment
  // reconfigure, so the undo history, the scroll position and the selection
  // survive a mode switch (#281).
  _applyLiveMarkdown() {
    if (typeof window.setLivePreview !== 'function' || !this.editorView) return;
    const base = (typeof fileDirUrl === 'function' && this.filePath) ? fileDirUrl(this.filePath) : '';
    window.setLivePreview(this.editorView, this.viewMode === 'live' ? this._formatKind : null, base);
  }

  // The bar belongs to `live` alone: `text` exists precisely to switch it off,
  // and `preview` has nothing to write into.
  _applyFormatBar() {
    if (!this.formatBar) return;
    const settings = (typeof appGlobalSettings !== 'undefined' && appGlobalSettings) || {};
    const placement = settings.editorToolbarPlacement || 'bar';
    this.formatBar.setPlacement(placement);
    if (placement === 'overlay') this.formatBar.setOverlayTop(this.toolbar.el.offsetHeight + 6);

    // Hover-only makes no sense for the popup, which is already conditional; and
    // FOCUS has to reveal it too, or the bar is unreachable without a mouse.
    const hoverOnly = settings.editorToolbarVisibility === 'hover' && placement !== 'selection';
    this.container.classList.toggle('viewer-panel-hover-toolbar', hoverOnly);

    const show = this.viewMode === 'live' && this._formatKind && !this._imageMode;
    if (!show || typeof formatCommandsFor !== 'function') {
      this.formatBar.setCommands([]);
      this.formatBar.hidePopup();
      return;
    }
    const htmlTags = settings.editorToolbarHtmlTags !== 'off';
    this.formatBar.setCommands(formatCommandsFor(this._formatKind, { htmlTags }));
    this.formatBar.setDisabled(this.readOnly);
    this._syncSelectionPopup();
  }

  // Selection placement only: show the popup beside a non-empty selection, hide
  // it otherwise. Coordinates come back from CodeMirror in viewport space and are
  // translated into the panel's, which is what the popup is positioned against.
  _syncSelectionPopup() {
    if (!this.formatBar || this.formatBar.placement !== 'selection') return;
    const view = this.editorView;
    if (!view || this.readOnly || this.viewMode !== 'live' || !this._formatKind) {
      this.formatBar.hidePopup();
      return;
    }
    const sel = view.state.selection.main;
    if (sel.from === sel.to || typeof view.coordsAtPos !== 'function') {
      this.formatBar.hidePopup();
      return;
    }
    const coords = view.coordsAtPos(sel.from);
    if (!coords) { this.formatBar.hidePopup(); return; }
    const host = this.container.getBoundingClientRect();
    this.formatBar.showAt(coords.left - host.left, coords.top - host.top - 42);
  }

  // One command, one dispatch: the command decides the text, the panel decides
  // nothing. Focus goes back to the editor so a second click keeps working on the
  // selection the first one left behind.
  _runFormatCommand(command, value) {
    const view = this.editorView;
    if (!view || this.readOnly) return;

    if (command.kind === 'history') {
      const run = command.id === 'redo' ? window.cmRedo : window.cmUndo;
      if (typeof run === 'function') run(view);
      view.focus();
      return;
    }

    const doc = view.state.doc.toString();
    const { from, to } = view.state.selection.main;
    const change = command.run(doc, from, to, value);
    view.dispatch({
      changes: { from: change.from, to: change.to, insert: change.insert },
      selection: { anchor: change.anchor, head: change.head },
      scrollIntoView: true,
    });
    view.focus();
    this._syncSelectionPopup();
  }

  _togglePreview(persist = true) {
    this._setViewMode(this.previewMode ? this._toolbarMode() : 'preview', persist);
  }

  // Fill the preview element for the current file kind: a sandboxed iframe for
  // HTML (display-only, no scripts — #49 security), DOMPurify-sanitized marked
  // output for Markdown (never regress the #46 wrap).
  _renderPreview() {
    const content = this.getContent();
    if (this._previewKind === 'html') {
      this.previewEl.innerHTML = '';
      const frame = document.createElement('iframe');
      frame.className = 'html-preview-frame';
      frame.setAttribute('sandbox', 'allow-same-origin'); // NO allow-scripts
      frame.srcdoc = (typeof htmlWithBase === 'function')
        ? htmlWithBase(content, typeof fileDirUrl === 'function' ? fileDirUrl(this.filePath) : '')
        : content;
      this.previewEl.appendChild(frame);
    } else {
      this.previewEl.innerHTML = DOMPurify.sanitize(window.marked.parse(content));
    }
  }

  _setPreview(show, persist = true) {
    if (this.previewMode === show) return;
    this._togglePreview(persist);
  }

  _toggleWrap() {
    if (!this.editorView || !this.editorView._wrapCompartment) return;
    this.wrapMode = !this.wrapMode;
    this.editorView.dispatch({
      effects: this.editorView._wrapCompartment.reconfigure(
        this.wrapMode ? window.CMEditorView.lineWrapping : []
      ),
    });
    this.toolbar.setWrapMode(this.wrapMode);
  }

  async _save() {
    if (!this.opts.onSave || !this.filePath) return;
    // Cmd/Ctrl+S reaches here even with the button hidden (#281).
    if (this.readOnly) return;
    this._saving = true;
    const content = this.getContent();
    try {
      const result = await this.opts.onSave(this.filePath, content);
      if (result && result.ok !== false) {
        this.toolbar.flashSave();
      } else {
        showControlMessage({ title: 'Save failed', message: result?.error || 'unknown error', tone: 'danger' });
      }
    } catch (err) {
      // Without this the user got no feedback when onSave threw (issue #78).
      showControlMessage({ title: 'Save failed', message: err.message, tone: 'danger' });
    } finally {
      setTimeout(() => { this._saving = false; }, 500);
    }
  }

  getContent() {
    return this.editorView ? this.editorView.state.doc.toString() : '';
  }

  destroy() {
    this._openGen = (this._openGen || 0) + 1;  // invalidate in-flight open() closure
    if (this._offFileChanged) { this._offFileChanged(); this._offFileChanged = null; }
    this._unwatchFile();
    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }
    // Clear stale search/goto-line bar references so they get recreated with the new editor
    delete this.editorEl._cmSearchBar;
    delete this.editorEl._cmGotoLine;
    this.editorEl.innerHTML = '';
    this.previewEl.innerHTML = '';
    this.previewEl.style.display = 'none';
    this._imageMode = false;
    // The bar is emptied, not destroyed: destroy() is also the "between files"
    // teardown and the panel is reopened with the same instance. dispose() is
    // the end of life.
    if (this.formatBar) this.formatBar.setCommands([]);
  }

  /**
   * End of life, as opposed to destroy()'s between-files reset.
   *
   * The file panel builds one ViewerPanel per file tab (#311), and each one's
   * format bar holds two document-level listeners. Without this, every preview
   * opened and closed leaves both behind — with the panel, its DOM and its
   * commands still reachable through them.
   */
  dispose() {
    this.destroy();
    if (this.formatBar) this.formatBar.destroy();
    for (const evt of ['mouseup', 'keyup', 'focusout']) {
      this.editorEl.removeEventListener(evt, this._onEditorSelectionChange);
    }
    _livePanels.delete(this);
  }

  // ── File Watching ──────────────────────────────────────────────────

  _watchFile(filePath) {
    if (!filePath || !window.api.watchFile) return;
    this._watchedPath = filePath;
    window.api.watchFile(filePath);
  }

  _unwatchFile() {
    if (this._watchedPath && window.api.unwatchFile) {
      window.api.unwatchFile(this._watchedPath);
      this._watchedPath = null;
    }
  }

  async _reloadFromDisk() {
    if (!this.filePath) return;

    // Image: re-fetch the data URL and swap the <img> src (#49).
    if (this._imageMode) {
      const res = window.api.readFileDataUrl ? await window.api.readFileDataUrl(this.filePath) : null;
      if (res && res.ok) {
        const img = this.previewEl.querySelector('img');
        if (img) img.src = res.dataUrl;
      }
      return;
    }

    if (!window.api.readFileForPanel) return;
    const result = await window.api.readFileForPanel(this.filePath);
    if (!result.ok) return;

    const newContent = result.content;
    const currentContent = this.getContent();
    if (newContent === currentContent) return;

    if (this.editorView) {
      this.editorView.dispatch({
        changes: { from: 0, to: this.editorView.state.doc.length, insert: newContent },
      });
    }

    if (this.previewMode) this._renderPreview();
  }

  _isMarkdown(filePath) {
    if (!filePath) return this.opts.language === 'markdown';
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'md' || ext === 'mdx';
  }

  _isPreviewable(filePath) {
    if (!filePath) return this.opts.language === 'markdown';
    return this._isMarkdown(filePath) || this._previewKind === 'html';
  }

  _isJsonish(filePath) {
    if (!filePath) return false;
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'json' || ext === 'jsonl';
  }
}

window.ViewerPanel = ViewerPanel;
