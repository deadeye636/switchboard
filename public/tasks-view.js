// --- Task/note system: viewer ---
// A large-viewport list of scoped tasks, opened filtered by project (from the
// project header) or by session (from the terminal toolbar). Same classic-<script>
// pattern as projects-admin.js. Pure filter/sort/status logic lives in
// tasks-logic.js (shared with node tests); this file is render + wiring only.
//
// Depends on globals: escapeHtml, formatDate (utils.js), hideAllViewers,
// returnToTerminal (app.js), showControlToast (control-dialogs.js),
// filterTasks, sortTasks, nextTaskStatus, taskStatusLabel, taskScopeLabel,
// TASK_STATUS_ORDER (tasks-logic.js), window.bookmarksTags.openSessionAt
// (bookmarks-tags.js), window.api (preload).

(function () {
  const viewer = document.getElementById('tasks-viewer');
  if (!viewer) return;

  let data = [];              // enriched task rows from task-list
  let scopeFilter = {};       // { projectPath } | { sessionId } | {}
  let contextLabel = '';      // heading suffix ("Project · foo", "Session · bar")
  let statusFilter = 'all';
  let textFilter = '';
  let sortMode = 'newest';

  // Open task counts (open + in_progress) for the sidebar: per session (card
  // badge) and per project (project-header icon highlight).
  const taskCounts = new Map();          // sessionId -> count
  const projectTaskCounts = new Map();   // projectPath -> count
  async function loadTaskCounts() {
    try {
      const res = await window.api.taskOpenCounts();
      const sessions = (res && res.sessions) || {};
      const projects = (res && res.projects) || {};
      taskCounts.clear();
      for (const sid of Object.keys(sessions)) taskCounts.set(sid, sessions[sid]);
      projectTaskCounts.clear();
      for (const p of Object.keys(projects)) projectTaskCounts.set(p, projects[p]);
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

  // --- Task create/edit dialog (title + note; optional read-only quote) ---

  // --- Status pulldown (badge click) ---

  let statusMenu = null;
  function closeStatusMenu() {
    if (statusMenu) { statusMenu.remove(); statusMenu = null; }
    document.removeEventListener('mousedown', onStatusMenuOutside, true);
  }
  function onStatusMenuOutside(e) {
    if (statusMenu && !statusMenu.contains(e.target)) closeStatusMenu();
  }
  function showStatusMenu(task, anchorEl) {
    closeStatusMenu();
    const menu = document.createElement('div');
    menu.className = 'popover tv-status-menu';
    for (const s of TASK_STATUS_ORDER) {
      const b = document.createElement('button');
      b.className = 'popover-option tv-status-opt tv-opt-' + s + (s === task.status ? ' tv-status-current' : '');
      b.textContent = taskStatusLabel(s);
      b.addEventListener('click', async () => {
        closeStatusMenu();
        if (s === task.status) return;
        try {
          const res = await window.api.taskUpdate({ id: task.id, status: s });
          if (res && res.task) { applyUpdated(res.task); loadTaskCounts(); }
        } catch (err) { toast('Error: ' + err.message); }
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchorEl.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(r.left, window.innerWidth - mw - 8) + 'px';
    menu.style.top = (r.bottom + mh > window.innerHeight - 8 ? r.top - mh - 4 : r.bottom + 4) + 'px';
    statusMenu = menu;
    setTimeout(() => document.addEventListener('mousedown', onStatusMenuOutside, true), 0);
  }

  function taskDialog({ heading, title, note, quote, status }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'bm-dialog-overlay';
      const box = document.createElement('div');
      box.className = 'bm-dialog tv-dialog popover';
      box.innerHTML = `<div class="bm-dialog-title">${escapeHtml(heading || 'Task')}</div>`;
      if (quote) {
        const q = document.createElement('blockquote');
        q.className = 'tv-dialog-quote';
        q.textContent = quote.length > 400 ? quote.slice(0, 400) + '…' : quote;
        box.appendChild(q);
      }
      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.className = 'bm-dialog-input';
      titleInput.placeholder = 'Task title';
      titleInput.value = title || '';
      const noteInput = document.createElement('textarea');
      noteInput.className = 'tv-dialog-note';
      noteInput.placeholder = 'Notes (optional)';
      noteInput.rows = 3;
      noteInput.value = note || '';
      const row = document.createElement('div');
      row.className = 'bm-dialog-buttons';
      const cancel = document.createElement('button');
      cancel.className = 'popover-option';
      cancel.textContent = 'Cancel';
      const save = document.createElement('button');
      save.className = 'popover-option bm-dialog-save';
      save.textContent = 'Save';
      // Save before Cancel so tab order is title → note → (status) → save → cancel.
      row.appendChild(save);
      row.appendChild(cancel);
      box.appendChild(titleInput);
      box.appendChild(noteInput);
      // Status picker — only when editing (a status was passed in).
      let statusSelect = null;
      if (status !== undefined) {
        const wrap = document.createElement('label');
        wrap.className = 'tv-dialog-status';
        wrap.textContent = 'Status';
        statusSelect = document.createElement('select');
        for (const s of TASK_STATUS_ORDER) {
          const opt = document.createElement('option');
          opt.value = s;
          opt.textContent = taskStatusLabel(s);
          if (s === status) opt.selected = true;
          statusSelect.appendChild(opt);
        }
        wrap.appendChild(statusSelect);
        box.appendChild(wrap);
      }
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      titleInput.focus();
      titleInput.select();

      function close(value) { overlay.remove(); resolve(value); }
      function commit() {
        const t = titleInput.value.trim();
        if (!t) { titleInput.focus(); return; }
        close({ title: t, note: noteInput.value.trim(), status: statusSelect ? statusSelect.value : undefined });
      }
      cancel.addEventListener('click', () => close(null));
      save.addEventListener('click', commit);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
      // Enter in the title field submits; Ctrl/Cmd+Enter submits from the note.
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(null); }
      });
      noteInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(null); }
      });
    });
  }

  // --- Rendering ---

  function cardHtml(t) {
    const created = fmtDate(t.createdAt);
    const updated = (t.updatedAt && t.updatedAt !== t.createdAt) ? fmtDate(t.updatedAt) : '';
    const meta = [
      taskScopeLabel(t.scope),
      t.projectDisplayName ? escapeHtml(t.projectDisplayName) : '',
      t.sessionName && t.scope !== 'project' ? escapeHtml(t.sessionName) : '',
    ].filter(Boolean).join(' · ');
    const dates = [
      created ? 'Created ' + created : '',
      updated ? 'Updated ' + updated : '',
    ].filter(Boolean).join(' · ');
    const canJump = !!t.sessionId;
    return `
      <div class="tv-card" data-id="${t.id}" data-status="${escapeHtml(t.status)}">
        <button class="tv-status tv-status-${escapeHtml(t.status)}" data-action="status-menu"
          title="Change status">${escapeHtml(taskStatusLabel(t.status))}</button>
        <div class="tv-main">
          <div class="tv-title">${escapeHtml(t.title)}</div>
          ${meta ? `<div class="tv-meta">${meta}</div>` : ''}
          ${t.note ? `<div class="tv-note">${escapeHtml(t.note)}</div>` : ''}
          ${t.quote && t.quote.trim() !== (t.title || '').trim() ? `<blockquote class="tv-quote">${escapeHtml(t.quote)}</blockquote>` : ''}
        </div>
        <div class="tv-actions">
          ${canJump ? '<button data-action="open-session" title="Open session (starts it if stopped)">▶</button>' : ''}
          ${canJump ? '<button data-action="jump" title="Jump to transcript">↗</button>' : ''}
          <button data-action="edit" title="Edit">✎</button>
          <button data-action="delete" class="tv-danger" title="Delete">×</button>
        </div>
        ${dates ? `<div class="tv-dates">${dates}</div>` : ''}
      </div>`;
  }

  function visibleTasks() {
    return sortTasks(filterTasks(data, { status: statusFilter, text: textFilter }), sortMode);
  }

  // Just the cards — so a filter keystroke refreshes the list without replacing
  // the search input (which would steal focus mid-typing).
  function bodyHtml() {
    const rows = visibleTasks();
    if (!rows.length) {
      const empty = data.length ? 'No tasks match the filter.' : 'No tasks yet.';
      return `<div class="tv-empty">${empty}</div>`;
    }
    return rows.map(cardHtml).join('');
  }

  function statusOptions() {
    const opts = ['all'].concat(TASK_STATUS_ORDER);
    return opts.map((s) => {
      const label = s === 'all' ? 'All statuses' : taskStatusLabel(s);
      const sel = s === statusFilter ? ' selected' : '';
      return `<option value="${s}"${sel}>${escapeHtml(label)}</option>`;
    }).join('');
  }

  function render() {
    const heading = contextLabel ? `Tasks · ${escapeHtml(contextLabel)}` : 'All tasks';
    viewer.innerHTML = `
      <div class="tv-header">
        <span class="tv-heading">${heading}</span>
        <select class="tv-status-filter" title="Filter by status">${statusOptions()}</select>
        <input type="text" class="tv-search" placeholder="Filter tasks…" value="${escapeHtml(textFilter)}">
        <select class="tv-sort" title="Sort">
          <option value="newest"${sortMode === 'newest' ? ' selected' : ''}>Created (newest)</option>
          <option value="oldest"${sortMode === 'oldest' ? ' selected' : ''}>Created (oldest)</option>
          <option value="updated"${sortMode === 'updated' ? ' selected' : ''}>Updated (newest)</option>
          <option value="updated_oldest"${sortMode === 'updated_oldest' ? ' selected' : ''}>Updated (oldest)</option>
          <option value="status"${sortMode === 'status' ? ' selected' : ''}>By status</option>
        </select>
        <button class="tv-new" data-action="new">+ New task</button>
        <button class="tv-refresh" data-action="refresh" title="Reload">⟳</button>
        <button class="viewer-header-close" data-close-viewer title="Close (Esc)" aria-label="Close">&times;</button>
      </div>
      <div class="tv-body">${bodyHtml()}</div>`;

    // Re-wire the close button (rendered after the init-time delegation ran).
    const closeBtn = viewer.querySelector('[data-close-viewer]');
    if (closeBtn && typeof returnToTerminal === 'function') {
      closeBtn.addEventListener('click', returnToTerminal);
    }
    const search = viewer.querySelector('.tv-search');
    if (search) {
      search.addEventListener('input', () => {
        textFilter = search.value;
        refreshBody();
      });
    }
    const statusSel = viewer.querySelector('.tv-status-filter');
    if (statusSel) statusSel.addEventListener('change', () => { statusFilter = statusSel.value; refreshBody(); });
    const sortSel = viewer.querySelector('.tv-sort');
    if (sortSel) sortSel.addEventListener('change', () => { sortMode = sortSel.value; refreshBody(); });
  }

  function refreshBody() {
    const body = viewer.querySelector('.tv-body');
    if (body) body.innerHTML = bodyHtml();
  }

  async function load() {
    viewer.innerHTML = '<div class="tv-loading">Loading tasks…</div>';
    try {
      const res = await window.api.taskList(scopeFilter);
      if (!res || res.error) {
        viewer.innerHTML = `<div class="tv-loading">Error: ${escapeHtml(res && res.error || 'unknown')}</div>`;
        return;
      }
      data = res.tasks || [];
      render();
    } catch (err) {
      viewer.innerHTML = `<div class="tv-loading">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  function findTask(id) {
    return data.find((t) => String(t.id) === String(id));
  }

  // Patch one task in the local array from a server response, then repaint.
  function applyUpdated(task) {
    if (!task) return;
    const i = data.findIndex((t) => t.id === task.id);
    if (i !== -1) data[i] = task; else data.unshift(task);
    refreshBody();
  }

  async function handleAction(action, id, card) {
    const task = findTask(id);
    try {
      if (action === 'new') {
        const input = await taskDialog({ heading: 'New task' });
        if (!input) return;
        const res = await window.api.taskCreate({
          ...scopeFilter,
          title: input.title,
          note: input.note,
        });
        if (res && res.error) { toast(res.error); return; }
        if (res && res.task) { data.unshift(res.task); refreshBody(); loadTaskCounts(); }
        return;
      }
      if (action === 'refresh') { load(); return; }
      if (!task) return;
      if (action === 'status-menu') {
        const anchor = card && card.querySelector('.tv-status');
        if (anchor) showStatusMenu(task, anchor);
        return;
      }
      if (action === 'edit') {
        const input = await taskDialog({ heading: 'Edit task', title: task.title, note: task.note, quote: task.quote, status: task.status });
        if (!input) return;
        const res = await window.api.taskUpdate({ id: task.id, title: input.title, note: input.note, status: input.status });
        if (res && res.task) { applyUpdated(res.task); loadTaskCounts(); }
        return;
      }
      if (action === 'delete') {
        // Destructive with no restore API → confirm first, matching the stop
        // pattern (archive elsewhere uses undo; task delete has neither) (issue #78).
        const ok = await showControlDialog({
          title: 'Delete task?',
          message: `"${task.title || 'Untitled task'}" will be permanently removed.`,
          confirmLabel: 'Delete',
          tone: 'danger',
        });
        if (!ok) return;
        await window.api.taskRemove(task.id);
        data = data.filter((t) => t.id !== task.id);
        refreshBody();
        loadTaskCounts();
        toast('Task removed.');
        return;
      }
      if (action === 'open-session') {
        if (task.sessionId && typeof openSession === 'function') {
          // Resume/start the live terminal (same path as clicking the session in
          // the sidebar). hideAllViewers first so this overlay is dismissed.
          if (typeof hideAllViewers === 'function') hideAllViewers();
          try { await openSession({ sessionId: task.sessionId, projectPath: task.projectPath }); }
          catch (err) { toast('Could not open session: ' + err.message); }
        }
        return;
      }
      if (action === 'jump') {
        if (task.sessionId && window.bookmarksTags && typeof window.bookmarksTags.openSessionAt === 'function') {
          // Remember where to return: closing the transcript comes back to this
          // task list instead of the terminal (consumed by returnToTerminal).
          window.__tasksReturnTarget = { filter: { ...scopeFilter }, label: contextLabel };
          // entryIndex null (session scope) → openSessionAt scrolls to the end.
          window.bookmarksTags.openSessionAt(task.sessionId, task.entryIndex != null ? task.entryIndex : -1);
        }
        return;
      }
    } catch (err) {
      toast('Error: ' + err.message);
    }
  }

  viewer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const card = btn.closest('.tv-card');
    const id = card ? card.dataset.id : null;
    handleAction(action, id, card);
  });

  // --- Public API ---

  // Open the viewer filtered to a project / session / everything.
  // filter: { projectPath } | { sessionId } | {} ; label: heading suffix.
  function openTasksView(filter, label) {
    window.__tasksReturnTarget = null;
    scopeFilter = filter || {};
    contextLabel = label || '';
    statusFilter = 'all';
    textFilter = '';
    sortMode = 'newest';
    if (typeof hideAllViewers === 'function') hideAllViewers();
    // hideAllViewers restores terminalArea; hide it (and the placeholder) so this
    // overlay isn't covered by the later-in-DOM #terminal-area, which would also
    // swallow clicks. Mirrors showJsonlViewer's sequence.
    if (typeof placeholder !== 'undefined' && placeholder) placeholder.style.display = 'none';
    if (typeof terminalArea !== 'undefined' && terminalArea) terminalArea.style.display = 'none';
    viewer.style.display = 'flex';
    load();
  }

  // Create a task from a source (a transcript selection/block, or a terminal
  // selection) without opening the viewer. Used by the gutter / right-click /
  // shortcut in the transcript (bookmarks-tags.js) and the terminal (context
  // menu + shortcut). Scope is derived: 'message' when an entryIndex is given
  // (transcript), else 'session' (terminal). Pre-fills the title from the quote.
  async function createFromSource({ sessionId, entryIndex, quote }) {
    if (!sessionId) return;
    const seed = (quote || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const input = await taskDialog({ heading: 'New task', title: seed, quote });
    if (!input) return;
    try {
      const res = await window.api.taskCreate({
        sessionId,
        entryIndex: entryIndex != null ? entryIndex : null,
        title: input.title,
        note: input.note,
        quote: quote || null,
      });
      if (res && res.error) { toast(res.error); return; }
      loadTaskCounts();
      toast('Task created.');
    } catch (err) {
      toast('Error: ' + err.message);
    }
  }

  window.openTasksView = openTasksView;
  window.tasksView = {
    openTasksView,
    createFromSource,
    reload: load,
    reloadCounts: loadTaskCounts,
    openTaskCount: (sessionId) => taskCounts.get(sessionId) || 0,
    projectTaskCount: (projectPath) => projectTaskCounts.get(projectPath) || 0,
  };

  // Prime the session-card task badge counts once the page is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadTaskCounts);
  } else {
    loadTaskCounts();
  }
})();
