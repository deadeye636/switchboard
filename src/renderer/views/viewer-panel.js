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
    // What this panel last knew the file to hold on disk (#452). Everything about the live document is
    // decided against it: the panel is DIRTY when the editor no longer matches it, an external write is
    // detected by the file no longer matching it, and a save is refused when the two disagree.
    //
    // It is the content and not the mtime on purpose. mtime has a resolution, a clock and a filesystem
    // behind it; the text either changed or it did not.
    this._baseline = null;
    this._conflict = null;   // { diskContent } while the panel is holding edits the file has moved past
    this._conflictDiffEl = null;      // the side-by-side overlay, while it is open
    this._conflictDiffNote = null;    // its heading, which says whether the disk side moved under it
    this._conflictMergeView = null;   // the MergeView inside it — held so it can be destroyed (#456)

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

    // The bar that appears when the file moved under edits this panel is holding (#452). Built once and
    // hidden, so nothing has to be inserted into the DOM at the moment the user is about to lose work.
    this.conflictBar = this._buildConflictBar();
    container.insertBefore(this.conflictBar.el, this.editorEl);

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

    // A new document starts in step with its file, and carries none of the previous one's conflict (#452).
    this._baseline = typeof content === 'string' ? content : null;
    this._setConflict(null);
    this._closeConflictDiff();

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

    // The other direction of the same conflict, and the one that costs more (#452). While the user has a
    // document open an agent may have been rewriting it for twenty minutes; a reflexive Ctrl+S wrote the
    // panel's stale copy straight over that work, with nothing to notice it by. So the file is read back
    // first and compared against what this panel last knew it to hold.
    //
    // Content, not mtime: mtime has a resolution and a clock behind it. A window of milliseconds remains
    // between this read and the write below — against a writer that saves every few seconds that is the
    // difference between a certainty and a coincidence.
    if (this._baseline !== null && window.api.readFileForPanel) {
      try {
        const onDisk = await window.api.readFileForPanel(this.filePath);
        if (onDisk && onDisk.ok && onDisk.content !== this._baseline) {
          if (onDisk.content === this.getContent()) {
            this._baseline = onDisk.content;   // someone saved exactly what we hold; nothing to do
            this._setConflict(null);
            return;
          }
          this._setConflict(onDisk.content);
          return;
        }
      } catch { /* an unreadable file is the save path's problem, not this check's */ }
    }

    this._saving = true;
    const content = this.getContent();
    try {
      const result = await this.opts.onSave(this.filePath, content);
      if (result && result.ok !== false) {
        // What was written IS what the file holds now, so the panel is back in step with it. Without
        // this the next external write would read as a conflict against a baseline from before the save.
        this._baseline = content;
        this._setConflict(null);
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
    this._closeConflictDiff();
    this._setConflict(null);
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
    if (newContent === this.getContent()) {
      // The panel already holds what the file holds — nothing to apply, and the two are back in step, so
      // whatever the panel was carrying is no longer a divergence.
      this._baseline = newContent;
      this._setConflict(null);
      return;
    }

    // The panel is holding edits the file has moved past. Replacing the document here is what silently
    // destroyed them; the only guard before this was a 500 ms flag around the panel's own save, which
    // covered nothing an agent does. So the change is NOT applied — it is announced, and the user decides.
    if (this._isDirty()) {
      this._setConflict(newContent);
      return;
    }

    this._applyDiskContent(newContent);
  }

  // --- staying live while someone else writes (#452) ---------------------------------------------

  /** Does the editor hold something the file does not? */
  _isDirty() {
    if (this._baseline === null || !this.editorView) return false;
    return this.getContent() !== this._baseline;
  }

  /**
   * The bar that says the file moved and the panel is holding edits.
   *
   * It offers three answers, and the third is the one that turns a frightening choice into an informed
   * one: seeing what actually changed. Reusing the existing button class rather than shipping a bare
   * `<button>`, which would render as the browser's own control next to the styled ones.
   */
  _buildConflictBar() {
    const el = document.createElement('div');
    el.className = 'viewer-conflict-bar';
    el.style.display = 'none';

    const msg = document.createElement('span');
    msg.className = 'viewer-conflict-message';
    el.appendChild(msg);

    const mk = (label, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'new-session-secondary-btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      el.appendChild(b);
      return b;
    };
    const showBtn = mk('Show changes');
    const reloadBtn = mk('Reload', 'danger');
    const keepBtn = mk('Keep mine');

    showBtn.addEventListener('click', () => this._showConflictDiff());
    reloadBtn.addEventListener('click', () => this._resolveConflict('reload'));
    keepBtn.addEventListener('click', () => this._resolveConflict('keep'));

    return { el, msg, showBtn, reloadBtn, keepBtn };
  }

  /**
   * Announce a conflict, or clear it.
   *
   * The bar STAYS until it is answered. A notice that fades leaves the reader looking at a document they
   * believe is current, which is the state this whole thing exists to prevent.
   */
  _setConflict(diskContent) {
    // A conflict that is REPLACED rather than raised is the case #456 was about: the file moved a second
    // time while the user was still deciding about the first move. The version they are being asked about
    // is now a different one, and saying nothing turns their next answer into an answer about something
    // they never saw — "Reload" would apply content that was never on screen.
    const moved = !!(this._conflict && diskContent !== null && diskContent !== this._conflict.diskContent);

    this._conflict = diskContent === null ? null : { diskContent };
    // The side-by-side view is a view OF the conflict. Once the conflict is answered — or overtaken by a
    // save, or by the file coming back into step on its own — it is showing two versions that no longer
    // stand against each other, so it goes with it.
    if (!this._conflict) this._closeConflictDiff();

    if (this.conflictBar) {
      if (!this._conflict) {
        this.conflictBar.el.style.display = 'none';
      } else {
        this.conflictBar.msg.textContent = moved
          ? 'This file changed on disk again — what you are being asked about has been updated.'
          : 'This file changed on disk while you were editing it.';
        this.conflictBar.el.style.display = '';
      }
    }

    // The repaint goes LAST, and inside a guard. It is the only step here that runs someone else's code,
    // and this runs on the reload path — an exception escaping would surface as an unhandled rejection
    // and take the refresh down with it. If the merge viewer refuses, the state above is already
    // consistent: the panel says the file moved, and the side-by-side view is the part that failed
    // rather than the part that is lying. So the view goes, and the notice stays.
    if (this._conflict && moved) {
      try {
        this._paintConflictDiff(true);
      } catch (err) {
        this._closeConflictDiff();
        window.showControlToast?.('The diff viewer stopped working; the notice above is still current.');
      }
    }
  }

  _resolveConflict(answer) {
    const disk = this._conflict ? this._conflict.diskContent : null;
    this._setConflict(null);
    if (disk === null) return;
    if (answer === 'reload') {
      // Reload discards the panel's edits deliberately — the button says so. Applying it as a CHANGE
      // rather than a replacement keeps the reading position, exactly like an ordinary refresh.
      this._applyDiskContent(disk);
      return;
    }

    // "Keep mine" has to move the baseline as well (#442), and it is not obvious why.
    //
    // The baseline answers two questions at once: what an external write is measured against, and what
    // `_save` re-reads the file for. Leaving it where it was would mean the user answers the bar, presses
    // Ctrl+S, and gets the SAME bar back — the save's own readback compares the file against a baseline
    // from before the change it was just told to disregard. The panel would have no way to write at all.
    //
    // So the disk content becomes what this panel last knew the file to hold. The edits are untouched —
    // they are now a divergence from the version the user has seen and chosen against, which is what
    // keeping them means. A LATER external write still raises the bar again, measured against this one.
    this._baseline = disk;
  }

  /**
   * Side by side: what is on disk against what this panel holds.
   *
   * Rendered INSIDE the panel rather than in a dialog. `showControlDialog` builds its body from escaped
   * HTML and has nowhere to put an editor, and the app's diff window answers only for file versions git
   * knows about — neither can show two strings that exist nowhere but here.
   */
  _showConflictDiff() {
    if (!this._conflict) return;
    if (typeof window.createMergeViewer !== 'function') {
      window.showControlToast?.('The diff viewer is not available.');
      return;
    }
    if (this._conflictDiffEl) { this._closeConflictDiff(); return; }

    const overlay = document.createElement('div');
    overlay.className = 'viewer-conflict-diff';

    const bar = document.createElement('div');
    bar.className = 'viewer-conflict-diff-head';
    const label = document.createElement('span');
    label.textContent = 'On disk (left) against your version (right)';
    bar.appendChild(label);
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'new-session-secondary-btn';
    back.textContent = 'Back';
    back.addEventListener('click', () => this._closeConflictDiff());
    bar.appendChild(back);
    overlay.appendChild(bar);

    const host = document.createElement('div');
    host.className = 'viewer-conflict-diff-body';
    overlay.appendChild(host);

    this.container.appendChild(overlay);
    this._conflictDiffEl = overlay;
    this._conflictDiffNote = label;
    this._paintConflictDiff();
  }

  /**
   * Draw (or redraw) the two versions into the open overlay.
   *
   * Separate from opening it because the file can move again while it is up (#456). A merge view is a
   * snapshot of two strings; leaving it on the first one meant the user compared their edits against
   * something that was no longer on disk, and then answered a bar that had quietly moved on.
   *
   * The whole body is rebuilt rather than patched: `createMergeViewer` owns what it puts in the host, and
   * a merge view has no "and now show these two instead".
   */
  _paintConflictDiff(moved = false) {
    if (!this._conflictDiffEl || !this._conflict) return;
    if (typeof window.createMergeViewer !== 'function') return;
    const host = this._conflictDiffEl.querySelector('.viewer-conflict-diff-body');
    if (!host) return;
    // Told, not inferred. Whether this is a repaint is the CALLER's fact; reading it off the host would
    // make the heading depend on what the merge viewer happens to put in there.
    const repaint = moved;
    // A MergeView is two EditorViews with observers on each, and `replaceChildren` takes the DOM without
    // telling them. That was survivable while the view was built once; repainting on every write turns it
    // into one abandoned pair per write. `file-panel.js` destroys its diff editors for the same reason.
    this._destroyConflictMergeView();
    host.replaceChildren();
    // "Theirs" then "mine", the order every merge tool uses.
    this._conflictMergeView = window.createMergeViewer(
      host, this._conflict.diskContent, this.getContent(), this.filePath || '') || null;
    if (this._conflictDiffNote) {
      // The heading is where a reader looks to find out what they are looking at, so it carries the fact
      // that it is not what they opened.
      this._conflictDiffNote.textContent = repaint
        ? 'On disk (left) against your version (right) — the disk side changed while you were reading it'
        : 'On disk (left) against your version (right)';
    }
  }

  /** Give the merge editors back before their DOM goes. Safe when there is none. */
  _destroyConflictMergeView() {
    const view = this._conflictMergeView;
    this._conflictMergeView = null;
    if (view && typeof view.destroy === 'function') {
      try { view.destroy(); } catch { /* a view that is already gone is the state we wanted */ }
    }
  }

  _closeConflictDiff() {
    if (!this._conflictDiffEl) return;
    this._destroyConflictMergeView();
    this._conflictDiffEl.remove();
    this._conflictDiffEl = null;
    this._conflictDiffNote = null;
  }

  /**
   * Put the file's content into the editor as a CHANGE, keeping the reader where they were.
   *
   * The old path replaced the whole document, and every position inside a replaced range maps to its
   * boundary — so the cursor jumped and the view scrolled away on every write. Here the shared head and
   * tail are left untouched, the selection is mapped across what actually moved, and the scroll position
   * is restored unless the reader was following the end, in which case it follows.
   */
  _applyDiskContent(newContent) {
    this._baseline = newContent;
    if (!this.editorView) { if (this.previewMode) this._renderPreview(); return; }

    const change = window.textSyncChange(this.getContent(), newContent);
    if (!change) return;

    const scroller = this.editorView.scrollDOM;
    const follow = scroller
      ? window.isPinnedToBottom(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight)
      : false;
    const scrollTop = scroller ? scroller.scrollTop : 0;
    const sel = this.editorView.state.selection.main;

    this.editorView.dispatch({
      changes: change,
      selection: { anchor: window.mapPosition(sel.anchor, change), head: window.mapPosition(sel.head, change) },
      scrollIntoView: false,
    });

    if (scroller) {
      // After the layout settles, not before — the document just got longer or shorter.
      requestAnimationFrame(() => {
        scroller.scrollTop = follow ? scroller.scrollHeight : scrollTop;
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
