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

  function decorateJsonlEntry(el, entry, sessionId, entryIndex) {
    const btn = document.createElement('button');
    btn.className = 'jsonl-bookmark-toggle';
    btn.title = 'Bookmark this message';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleEntry(sessionId, entryIndex, entry, el);
    });
    el.classList.add('jsonl-entry-bookmarkable');
    el.appendChild(btn);
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

  // Session-level bookmark from the live terminal (no message index).
  async function bookmarkSession(sessionId) {
    if (!sessionId) return;
    let res;
    try {
      res = await window.api.bookmarkToggle({
        sessionId,
        entryIndex: SESSION_ANCHOR,
        timestamp: new Date().toISOString(),
        label: 'Session bookmark',
      });
    } catch { return; }
    toast(res && res.bookmarked ? 'Session bookmarked.' : 'Session bookmark removed.');
  }

  // --- Keyboard shortcut: bookmark the centered transcript message, else open
  // the overlay. (The terminal path is handled separately via bookmarkSession.)

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
    bookmarkSession,
    openOverlay,
    scrollToJsonlEntry,
    reloadTags: loadTagCache,
  };
})();
