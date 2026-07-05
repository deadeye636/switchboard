// --- Bookmarks + session tags (renderer module) ---
//
// Persisted in SQLite (db.js); reached via window.api.bookmark* / sessionTags*.
// Bookmark anchors are { sessionId, entryIndex }; entryIndex = the position in
// the transcript entries array (deadeye JSONL has no per-message uuid, so the
// index is the stable anchor). entryIndex === -1 marks a session-level bookmark
// made from the live terminal, which has no message granularity.
//
// Wires three hooks consumed by the render loops:
//   window._decorateJsonlEntry(el, entry, sessionId, entryIndex)  (jsonl-viewer.js)
//   window._jsonlAfterRender(sessionId)                           (jsonl-viewer.js)
//   window._decorateSessionItem(item, session)                   (sidebar.js)
// and the public window.bookmarksTags surface used by the keyboard shortcut
// (app.js / terminal-manager.js) and the terminal context menu.
(function () {
  const SESSION_ANCHOR = -1;
  const TAG_PALETTE = ['#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#d19a66'];

  // sessionId -> Set<entryIndex> currently bookmarked (loaded per transcript view).
  const bookmarkCache = new Map();
  // sessionId -> [{ tag, color }] — kept in sync so sidebar chips render
  // synchronously during morphdom reconciliation.
  const tagCache = new Map();

  function toast(message) {
    if (typeof showControlToast === 'function') showControlToast({ message, timeoutMs: 3000 });
  }

  // Deterministic color so the same tag keeps its hue across sessions.
  function pickColor(tag) {
    let h = 0;
    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
    return TAG_PALETTE[h % TAG_PALETTE.length];
  }

  // --- Tag cache ---

  async function loadTagCache() {
    try {
      const rows = await window.api.sessionTagsAll();
      tagCache.clear();
      for (const r of rows || []) {
        if (!tagCache.has(r.sessionId)) tagCache.set(r.sessionId, []);
        tagCache.get(r.sessionId).push({ tag: r.tag, color: r.color });
      }
    } catch { /* keep stale cache on failure */ }
    if (typeof refreshSidebar === 'function') refreshSidebar();
  }

  function getTags(sessionId) {
    return tagCache.get(sessionId) || [];
  }

  // --- Sidebar tag chips ---

  function decorateSessionItem(item, session) {
    const tags = getTags(session.sessionId);
    if (!tags.length) return;
    const info = item.querySelector('.session-info');
    if (!info) return;
    const wrap = document.createElement('div');
    wrap.className = 'session-tag-chips';
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'session-tag-chip';
      chip.textContent = t.tag;
      if (t.color) { chip.style.borderColor = t.color; chip.style.color = t.color; }
      chip.title = 'Edit tags';
      chip.addEventListener('click', (e) => { e.stopPropagation(); editTags(session); });
      wrap.appendChild(chip);
    }
    info.appendChild(wrap);
  }

  // --- Tag editing (Electron has no window.prompt → small inline dialog) ---

  function showTagDialog(current) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'bm-dialog-overlay';
      const box = document.createElement('div');
      box.className = 'bm-dialog popover';
      box.innerHTML = '<div class="bm-dialog-title">Session tags</div>'
        + '<div class="bm-dialog-hint">Comma-separated, e.g. <code>bug, review</code></div>';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'bm-dialog-input';
      input.value = current;
      const row = document.createElement('div');
      row.className = 'bm-dialog-buttons';
      const cancel = document.createElement('button');
      cancel.className = 'popover-option';
      cancel.textContent = 'Cancel';
      const save = document.createElement('button');
      save.className = 'popover-option bm-dialog-save';
      save.textContent = 'Save';
      row.appendChild(cancel);
      row.appendChild(save);
      box.appendChild(input);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      input.focus();
      input.select();

      function close(value) { overlay.remove(); resolve(value); }
      cancel.addEventListener('click', () => close(null));
      save.addEventListener('click', () => close(input.value));
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
        else if (e.key === 'Escape') { e.preventDefault(); close(null); }
      });
    });
  }

  async function editTags(session) {
    const current = getTags(session.sessionId).map(t => t.tag).join(', ');
    const input = await showTagDialog(current);
    if (input === null) return;
    const seen = new Set();
    const tags = [];
    for (const raw of input.split(',')) {
      const tag = raw.trim();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      tags.push({ tag, color: pickColor(tag) });
    }
    try { await window.api.sessionTagsSet(session.sessionId, tags); } catch { return; }
    await loadTagCache();
  }

  // --- Bookmarks in the transcript viewer ---

  function entryLabel(entry, el) {
    if (entry) {
      if (typeof entry.text === 'string' && entry.text.trim()) return entry.text.trim().slice(0, 80);
      const c = entry.message && entry.message.content;
      if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 80);
      if (Array.isArray(c)) {
        const t = c.find(b => b && (b.type === 'text' || b.text));
        if (t) return String(t.text || '').trim().slice(0, 80);
      }
      if (entry.type) return String(entry.type);
    }
    if (el) return (el.textContent || '').trim().slice(0, 80);
    return 'Bookmark';
  }

  const ICON_BOOKMARK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
  const ICON_COPY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const ICON_TASK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';

  // Raw text of a transcript entry, for copy + task quote. Prefers the JSONL
  // getEntryText (raw markdown); falls back to the rendered text nodes.
  function entryText(entry, el) {
    let t = '';
    if (entry && typeof getEntryText === 'function') {
      try { t = getEntryText(entry) || ''; } catch { /* fall through */ }
    }
    if (!t && el) t = entryElText(el);
    return t;
  }

  // Rendered text of an entry element, excluding the gutter buttons (SVG-only).
  function entryElText(el) {
    const parts = el.querySelectorAll('.jsonl-text');
    if (parts.length) return Array.from(parts).map(n => n.textContent).join('\n').trim();
    return (el.textContent || '').trim();
  }

  async function copyEntry(entry, el) {
    const text = entryText(entry, el);
    if (!text) return;
    try { await window.api.writeClipboard(text); toast('Copied.'); } catch { /* ignore */ }
  }

  function createTaskFromEntry(sessionId, entryIndex, entry, el) {
    if (!window.tasksView || typeof window.tasksView.createFromSource !== 'function') return;
    window.tasksView.createFromSource({ sessionId, entryIndex, quote: entryText(entry, el) });
  }

  function gutterButton(cls, title, icon, onClick) {
    const btn = document.createElement('button');
    btn.className = 'jsonl-gutter-btn ' + cls;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = icon;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  // A hover-revealed gutter at the front of each message: bookmark · copy · task.
  function decorateJsonlEntry(el, entry, sessionId, entryIndex) {
    const gutter = document.createElement('div');
    gutter.className = 'jsonl-entry-gutter';
    gutter.appendChild(gutterButton('jsonl-copy-btn', 'Copy message text', ICON_COPY,
      () => copyEntry(entry, el)));
    gutter.appendChild(gutterButton('jsonl-task-btn', 'Create task from this message', ICON_TASK,
      () => createTaskFromEntry(sessionId, entryIndex, entry, el)));
    gutter.appendChild(gutterButton('jsonl-bookmark-toggle', 'Bookmark this message', ICON_BOOKMARK,
      () => toggleEntry(sessionId, entryIndex, entry, el)));
    el.classList.add('jsonl-entry-bookmarkable');
    el.insertBefore(gutter, el.firstChild);
  }

  async function afterRender(sessionId) {
    let rows = [];
    try { rows = await window.api.bookmarkList(sessionId); } catch { /* ignore */ }
    const set = new Set((rows || []).map(r => r.entryIndex));
    bookmarkCache.set(sessionId, set);
    applyBookmarkClasses(set);
  }

  function applyBookmarkClasses(set) {
    const body = document.getElementById('jsonl-viewer-body');
    if (!body) return;
    body.querySelectorAll('[data-entry-index]').forEach(el => {
      const idx = Number(el.dataset.entryIndex);
      const on = set.has(idx);
      el.classList.toggle('bookmarked', on);
      const btn = el.querySelector('.jsonl-bookmark-toggle');
      if (btn) btn.classList.toggle('active', on);
    });
  }

  async function toggleEntry(sessionId, entryIndex, entry, el) {
    if (!sessionId) return;
    const label = entryLabel(entry, el);
    let res;
    try {
      res = await window.api.bookmarkToggle({
        sessionId,
        entryIndex,
        timestamp: (entry && entry.timestamp) || null,
        label,
      });
    } catch { return; }
    const set = bookmarkCache.get(sessionId) || new Set();
    if (res && res.bookmarked) set.add(entryIndex); else set.delete(entryIndex);
    bookmarkCache.set(sessionId, set);
    if (el) {
      el.classList.toggle('bookmarked', !!(res && res.bookmarked));
      const btn = el.querySelector('.jsonl-bookmark-toggle');
      if (btn) btn.classList.toggle('active', !!(res && res.bookmarked));
    }
    toast(res && res.bookmarked ? 'Bookmarked.' : 'Bookmark removed.');
  }

  // --- Transcript text selection → task ---

  // The non-collapsed selection inside the transcript, resolved to its message
  // anchor. Returns null when there's no usable selection in the viewer.
  function selectionInTranscript() {
    const body = document.getElementById('jsonl-viewer-body');
    if (!body) return null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const node = sel.anchorNode;
    const start = node && (node.nodeType === 1 ? node : node.parentElement);
    const entryEl = start && start.closest ? start.closest('[data-entry-index]') : null;
    if (!entryEl || !body.contains(entryEl)) return null;
    return { sessionId: currentJsonlSessionId(), entryIndex: Number(entryEl.dataset.entryIndex), text, range: sel.getRangeAt(0) };
  }

  function createTaskFromSelection() {
    const s = selectionInTranscript();
    if (!s || !window.tasksView) return;
    window.tasksView.createFromSource({ sessionId: s.sessionId, entryIndex: s.entryIndex, quote: s.text });
    hideSelectionButton();
  }

  // Floating "+ Task" affordance shown just below a fresh selection.
  let selectionBtn = null;
  function hideSelectionButton() {
    if (selectionBtn) { selectionBtn.remove(); selectionBtn = null; }
  }
  function showSelectionButton() {
    const s = selectionInTranscript();
    if (!s) { hideSelectionButton(); return; }
    const rect = s.range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { hideSelectionButton(); return; }
    hideSelectionButton();
    selectionBtn = document.createElement('button');
    selectionBtn.className = 'jsonl-selection-task-btn';
    selectionBtn.innerHTML = ICON_TASK + '<span>Task</span>';
    selectionBtn.style.top = (rect.bottom + 6) + 'px';
    selectionBtn.style.left = rect.left + 'px';
    // Keep the selection alive when pressing the button.
    selectionBtn.addEventListener('mousedown', (e) => e.preventDefault());
    selectionBtn.addEventListener('click', (e) => { e.stopPropagation(); createTaskFromSelection(); });
    document.body.appendChild(selectionBtn);
  }

  // --- Transcript right-click menu: copy · task · bookmark ---

  let transcriptMenu = null;
  function closeTranscriptMenu() {
    if (transcriptMenu) { transcriptMenu.remove(); transcriptMenu = null; }
  }
  function showTranscriptMenu(e) {
    const entryEl = e.target.closest && e.target.closest('[data-entry-index]');
    if (!entryEl) return; // outside a message → native menu
    e.preventDefault();
    closeTranscriptMenu();
    const sessionId = currentJsonlSessionId();
    const entryIndex = Number(entryEl.dataset.entryIndex);
    const sel = selectionInTranscript();
    const menu = document.createElement('div');
    menu.className = 'popover jsonl-context-menu';
    const add = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'popover-option';
      b.textContent = label;
      b.addEventListener('click', () => { closeTranscriptMenu(); fn(); });
      menu.appendChild(b);
    };
    add('Copy message', async () => {
      const text = entryElText(entryEl);
      if (text) { try { await window.api.writeClipboard(text); toast('Copied.'); } catch {} }
    });
    if (sel) add('Create task from selection', () => createTaskFromSelection());
    add('Create task from message', () =>
      window.tasksView?.createFromSource({ sessionId, entryIndex, quote: entryElText(entryEl) }));
    const set = bookmarkCache.get(sessionId);
    const isBm = set && set.has(entryIndex);
    add(isBm ? 'Remove bookmark' : 'Bookmark message', () => toggleEntry(sessionId, entryIndex, null, entryEl));
    document.body.appendChild(menu);
    // Clamp to viewport.
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
    transcriptMenu = menu;
  }

  // Wire the transcript interactions once (the body element is static in the DOM).
  function initTranscriptInteractions() {
    const body = document.getElementById('jsonl-viewer-body');
    if (!body) return;
    body.addEventListener('mouseup', () => setTimeout(showSelectionButton, 0));
    body.addEventListener('contextmenu', showTranscriptMenu);
    body.addEventListener('scroll', () => { hideSelectionButton(); closeTranscriptMenu(); });
    document.addEventListener('mousedown', (e) => {
      if (selectionBtn && !selectionBtn.contains(e.target)) hideSelectionButton();
      if (transcriptMenu && !transcriptMenu.contains(e.target)) closeTranscriptMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { hideSelectionButton(); closeTranscriptMenu(); }
    });
  }

  // --- Keyboard shortcut: bookmark the centered transcript message, else open
  // the overlay.

  function jsonlViewerVisible() {
    const v = document.getElementById('jsonl-viewer');
    return !!(v && v.style.display !== 'none' && v.offsetParent !== null);
  }

  function currentJsonlSessionId() {
    const el = document.getElementById('jsonl-viewer-session-id');
    return el ? (el.textContent || '').trim() : '';
  }

  function centeredEntry() {
    const body = document.getElementById('jsonl-viewer-body');
    if (!body) return null;
    const mid = body.getBoundingClientRect().top + body.clientHeight / 2;
    let best = null, bestDist = Infinity;
    body.querySelectorAll('[data-entry-index]').forEach(el => {
      const r = el.getBoundingClientRect();
      const center = r.top + r.height / 2;
      const d = Math.abs(center - mid);
      if (d < bestDist) { bestDist = d; best = el; }
    });
    return best;
  }

  function handleBookmarkShortcut() {
    if (jsonlViewerVisible()) {
      const el = centeredEntry();
      if (el) toggleEntry(currentJsonlSessionId(), Number(el.dataset.entryIndex), null, el);
      return;
    }
    openOverlay();
  }

  // --- Bookmark overlay (global list, click to jump) ---

  let activeOverlay = null;

  function closeOverlay() {
    if (activeOverlay) { activeOverlay.remove(); activeOverlay = null; }
  }

  async function openOverlay() {
    closeOverlay();
    let rows = [];
    try { rows = await window.api.bookmarkList(null); } catch { /* ignore */ }

    const overlay = document.createElement('div');
    overlay.className = 'bm-dialog-overlay';
    const box = document.createElement('div');
    box.className = 'bm-overlay popover';
    const title = document.createElement('div');
    title.className = 'bm-dialog-title';
    title.textContent = `Bookmarks (${rows.length})`;
    box.appendChild(title);

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'bm-dialog-hint';
      empty.textContent = 'No bookmarks yet.';
      box.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'bm-overlay-list';
      for (const r of rows) {
        const item = document.createElement('div');
        item.className = 'bm-overlay-item';
        const main = document.createElement('button');
        main.className = 'bm-overlay-jump';
        const label = r.label || (r.entryIndex === SESSION_ANCHOR ? 'Session bookmark' : `Message #${r.entryIndex}`);
        const when = r.timestamp ? new Date(r.timestamp).toLocaleString() : '';
        main.innerHTML = `<span class="bm-overlay-label"></span><span class="bm-overlay-meta"></span>`;
        main.querySelector('.bm-overlay-label').textContent = label;
        main.querySelector('.bm-overlay-meta').textContent = `${r.sessionId.slice(0, 8)}${when ? ' · ' + when : ''}`;
        main.addEventListener('click', () => openSessionAt(r.sessionId, r.entryIndex));
        const del = document.createElement('button');
        del.className = 'bm-overlay-del';
        del.title = 'Remove bookmark';
        del.textContent = '×';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          try { await window.api.bookmarkRemove(r.id); } catch { return; }
          openOverlay();
        });
        item.appendChild(main);
        item.appendChild(del);
        list.appendChild(item);
      }
      box.appendChild(list);
    }

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    activeOverlay = overlay;
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeOverlay(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { closeOverlay(); document.removeEventListener('keydown', esc, true); }
    }, true);
  }

  async function openSessionAt(sessionId, entryIndex) {
    closeOverlay();
    if (typeof showJsonlViewer !== 'function') return;
    // Minimal session object — showJsonlViewer reads sessionId for the API call
    // and falls back to it for the display name.
    await showJsonlViewer({ sessionId });
    if (entryIndex >= 0) {
      scrollToJsonlEntry(entryIndex);
    } else {
      const body = document.getElementById('jsonl-viewer-body');
      if (body) body.scrollTop = body.scrollHeight;
    }
  }

  function scrollToJsonlEntry(index) {
    const body = document.getElementById('jsonl-viewer-body');
    if (!body) return;
    const el = body.querySelector(`[data-entry-index="${index}"]`);
    if (!el) return;
    // Scroll *within* the body only — el.scrollIntoView() also scrolls outer
    // ancestors, which pushes the fixed viewer header up and clips the title.
    const bodyRect = body.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    body.scrollTop += (elRect.top - bodyRect.top) - (body.clientHeight - el.clientHeight) / 2;
    el.classList.add('bm-flash');
    setTimeout(() => el.classList.remove('bm-flash'), 1200);
  }

  // --- Init ---

  function init() {
    loadTagCache();
    const btn = document.getElementById('jsonl-bookmarks-btn');
    if (btn) btn.addEventListener('click', () => openOverlay());
    initTranscriptInteractions();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window._decorateJsonlEntry = decorateJsonlEntry;
  window._jsonlAfterRender = afterRender;
  window._decorateSessionItem = decorateSessionItem;
  window.bookmarksTags = {
    handleBookmarkShortcut,
    createTaskFromSelection,
    openOverlay,
    openSessionAt,
    scrollToJsonlEntry,
    reloadTags: loadTagCache,
  };
})();
