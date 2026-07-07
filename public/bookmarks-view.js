// --- Bookmarks: large project/scope view (#68) ---
// A large-viewport list of bookmarks, opened filtered by project (from the
// project header) or session. Same classic-<script> pattern as tasks-view.js;
// pure filter/sort/label logic lives in bookmarks-logic.js (shared with node
// tests). Reuses the tv-* CSS from the task viewer for layout/styling.
//
// Depends on globals: escapeHtml (utils.js), hideAllViewers, returnToTerminal,
// openSession (app.js), showControlToast, showControlDialog (control-dialogs.js),
// filterBookmarks, sortBookmarks, bookmarkLabel (bookmarks-logic.js),
// window.bookmarksTags.openSessionAt (bookmarks-tags.js), window.api (preload).

(function () {
  const viewer = document.getElementById('bookmarks-viewer');
  if (!viewer) return;

  let data = [];              // enriched bookmark rows from bookmark-list-admin
  let scopeFilter = {};       // { projectPath } | { sessionId } | {}
  let contextLabel = '';      // heading suffix ("Project · foo")
  let textFilter = '';
  let sortMode = 'newest';

  // Bookmark counts per project — drives the project-header bookmark-icon highlight.
  const projectBookmarkCounts = new Map();
  async function loadBookmarkCounts() {
    try {
      const res = await window.api.bookmarkCountsByProject();
      projectBookmarkCounts.clear();
      for (const p of Object.keys(res || {})) projectBookmarkCounts.set(p, res[p]);
    } catch { /* keep stale counts on failure */ }
    if (typeof refreshSidebar === 'function') refreshSidebar();
  }

  function toast(msg) {
    if (typeof showControlToast === 'function') showControlToast({ message: msg, timeoutMs: 3000 });
  }

  function fmtDate(ms) {
    if (!ms) return '';
    try {
      const d = new Date(ms);
      if (isNaN(d.getTime())) return '';
      return typeof formatDate === 'function' ? formatDate(d) : d.toLocaleString();
    } catch { return ''; }
  }

  function cardHtml(b) {
    const created = fmtDate(b.createdAt);
    const meta = [
      b.projectDisplayName ? escapeHtml(b.projectDisplayName) : '',
      b.sessionName ? escapeHtml(b.sessionName) : '',
    ].filter(Boolean).join(' · ');
    const canJump = !!b.sessionId;
    return `
      <div class="tv-card bmv-card" data-id="${b.id}">
        <div class="tv-main">
          <div class="tv-title">${escapeHtml(bookmarkLabel(b))}</div>
          ${meta ? `<div class="tv-meta">${meta}</div>` : ''}
        </div>
        <div class="tv-actions">
          ${canJump ? '<button data-action="open-session" title="Open session (starts it if stopped)">▶</button>' : ''}
          ${canJump ? '<button data-action="jump" title="Jump to transcript">↗</button>' : ''}
          <button data-action="delete" class="tv-danger" title="Remove bookmark">×</button>
        </div>
        ${created ? `<div class="tv-dates">Added ${created}</div>` : ''}
      </div>`;
  }

  function visibleBookmarks() {
    return sortBookmarks(filterBookmarks(data, { text: textFilter }), sortMode);
  }

  function bodyHtml() {
    const rows = visibleBookmarks();
    if (!rows.length) {
      const empty = data.length ? 'No bookmarks match the filter.' : 'No bookmarks yet.';
      return `<div class="tv-empty">${empty}</div>`;
    }
    return rows.map(cardHtml).join('');
  }

  function render() {
    const heading = contextLabel ? `Bookmarks · ${escapeHtml(contextLabel)}` : 'All bookmarks';
    viewer.innerHTML = `
      <div class="tv-header">
        <span class="tv-heading">${heading}</span>
        <input type="text" class="tv-search" placeholder="Filter bookmarks…" value="${escapeHtml(textFilter)}">
        <select class="tv-sort" title="Sort">
          <option value="newest"${sortMode === 'newest' ? ' selected' : ''}>Added (newest)</option>
          <option value="oldest"${sortMode === 'oldest' ? ' selected' : ''}>Added (oldest)</option>
        </select>
        <button class="tv-refresh" data-action="refresh" title="Reload">⟳</button>
        <button class="viewer-header-close" data-close-viewer title="Close (Esc)" aria-label="Close">&times;</button>
      </div>
      <div class="tv-body">${bodyHtml()}</div>`;

    const closeBtn = viewer.querySelector('[data-close-viewer]');
    if (closeBtn && typeof returnToTerminal === 'function') {
      closeBtn.addEventListener('click', returnToTerminal);
    }
    const search = viewer.querySelector('.tv-search');
    if (search) {
      search.addEventListener('input', () => { textFilter = search.value; refreshBody(); });
    }
    const sortSel = viewer.querySelector('.tv-sort');
    if (sortSel) sortSel.addEventListener('change', () => { sortMode = sortSel.value; refreshBody(); });
  }

  function refreshBody() {
    const body = viewer.querySelector('.tv-body');
    if (body) body.innerHTML = bodyHtml();
  }

  async function load() {
    viewer.innerHTML = '<div class="tv-loading">Loading bookmarks…</div>';
    try {
      const rows = await window.api.bookmarkListAdmin(scopeFilter);
      data = Array.isArray(rows) ? rows : [];
      render();
    } catch (err) {
      viewer.innerHTML = `<div class="tv-loading">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  function findBookmark(id) {
    return data.find((b) => String(b.id) === String(id));
  }

  async function handleAction(action, id, card) {
    if (action === 'refresh') { load(); return; }
    const bm = findBookmark(id);
    if (!bm) return;
    try {
      if (action === 'jump') {
        if (bm.sessionId && window.bookmarksTags && typeof window.bookmarksTags.openSessionAt === 'function') {
          // Closing the transcript comes back to this list (consumed by returnToTerminal).
          window.__bookmarksReturnTarget = { filter: { ...scopeFilter }, label: contextLabel };
          window.bookmarksTags.openSessionAt(bm.sessionId, bm.entryIndex != null ? bm.entryIndex : -1);
        }
        return;
      }
      if (action === 'open-session') {
        if (bm.sessionId && typeof openSession === 'function') {
          if (typeof hideAllViewers === 'function') hideAllViewers();
          try { await openSession({ sessionId: bm.sessionId, projectPath: bm.projectPath }); }
          catch (err) { toast('Could not open session: ' + err.message); }
        }
        return;
      }
      if (action === 'delete') {
        const ok = await showControlDialog({
          title: 'Remove bookmark?',
          message: `"${bookmarkLabel(bm)}" will be removed.`,
          confirmLabel: 'Remove',
          tone: 'danger',
        });
        if (!ok) return;
        await window.api.bookmarkRemove(bm.id);
        data = data.filter((b) => b.id !== bm.id);
        refreshBody();
        loadBookmarkCounts();
        toast('Bookmark removed.');
        return;
      }
    } catch (err) {
      toast('Error: ' + err.message);
    }
  }

  viewer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('.tv-card');
    const id = card ? card.dataset.id : null;
    handleAction(btn.dataset.action, id, card);
  });

  // --- Public API ---

  // Open the viewer filtered to a project / session / everything.
  function openBookmarksView(filter, label) {
    window.__bookmarksReturnTarget = null;
    scopeFilter = filter || {};
    contextLabel = label || '';
    textFilter = '';
    sortMode = 'newest';
    if (typeof hideAllViewers === 'function') hideAllViewers();
    // Mirror showJsonlViewer: hide placeholder + terminalArea so the later-in-DOM
    // #terminal-area doesn't cover this overlay and swallow clicks.
    if (typeof placeholder !== 'undefined' && placeholder) placeholder.style.display = 'none';
    if (typeof terminalArea !== 'undefined' && terminalArea) terminalArea.style.display = 'none';
    viewer.style.display = 'flex';
    load();
  }

  window.openBookmarksView = openBookmarksView;
  window.bookmarksView = {
    openBookmarksView,
    reload: load,
    reloadCounts: loadBookmarkCounts,
    projectBookmarkCount: (projectPath) => projectBookmarkCounts.get(projectPath) || 0,
  };

  // Prime the project-header bookmark counts once the page is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadBookmarkCounts);
  } else {
    loadBookmarkCounts();
  }
})();
