// --- Task/note system: viewer ---
// A large-viewport list of scoped tasks, opened filtered by project (from the
// project header) or by session (from the terminal toolbar). Same classic-<script>
// pattern as projects-admin.js. Pure filter/sort/status logic lives in
// tasks-logic.js (shared with node tests); this file is render + wiring only.
//
// Depends on globals: escapeHtml, formatDate (utils.js), hideAllViewers,
// returnToTerminal (app.js), showControlToast (control-dialogs.js),
// filterTasks, filterIssues, sortTasks, nextTaskStatus, taskStatusLabel, taskScopeLabel,
// TASK_STATUS_ORDER, and for the issue filters (#830) normalizeIssueFilter, issueQueryOf, issueLabels,
// issueCountLabel, readIssueFilter, patchIssueFilter, ISSUE_FILTER_EVENT (tasks-logic.js), settingsOwnerPath
// (shared/worktree-path.js), window.bookmarksTags.openSessionAt (bookmarks-tags.js), window.api (preload).

(function () {
  const viewer = document.getElementById('tasks-viewer');
  if (!viewer) return;

  let data = [];              // enriched task rows from task-list
  let scopeFilter = {};       // { projectPath } | { sessionId } | {}
  let contextLabel = '';      // heading suffix ("Project · foo", "Session · bar")
  let statusFilter = 'all';
  let textFilter = '';
  let sortMode = 'newest';
  // A project's forge issues (#816): null while nothing is known or the feature is off, { loading: true } while
  // the CLI runs, else main's answer. In memory until the view next loads, never stored; `issuesAsked` drops a late answer.
  let issues = null;
  let issuesAsked = 0;
  let issuesOpen = true;
  // The issue filters (#830, spec 42): the stored half (state, the two "me" toggles, the label) is the project's row
  // `forgeIssueFilter:<owner>`, shared with the session sidebar; the text is this view's alone and never stored.
  // `issueSupports` is the last answer's, so the toggles stay put while the next answer loads.
  let issueFilter = normalizeIssueFilter(null);
  let issueText = '';
  let issueSupports = null;

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
    // Which CLI ran the referenced session (#202). It sits UNDER the status pill rather than inline in the
    // meta: the meta wraps (a session name can be long), which orphaned the badge onto a line of its own,
    // and the left column already is where this card's badges live. Keyed on the id — every backend gets
    // one with no branching here.
    const badge = (t.sessionId && t.scope !== 'project') ? backendBadgeHtml(t.backendId, 14) : '';
    const dates = [
      created ? 'Created ' + created : '',
      updated ? 'Updated ' + updated : '',
    ].filter(Boolean).join(' · ');
    const canJump = !!t.sessionId;
    return `
      <div class="tv-card" data-id="${t.id}" data-status="${escapeHtml(t.status)}">
        <div class="tv-statuscol">
          <button class="tv-status tv-status-${escapeHtml(t.status)}" data-action="status-menu"
            title="Change status">${escapeHtml(taskStatusLabel(t.status))}</button>
          ${badge}
        </div>
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
      return `<div class="tv-empty">${empty}</div>${issuesHtml()}`;
    }
    return rows.map(cardHtml).join('') + issuesHtml();
  }

  // Foreign text throughout, so it is escaped and the body stays plain text: no markup, and no image in an issue
  // can make the app fetch from another host.
  function issueCardHtml(i) {
    const meta = [i.author ? escapeHtml(i.author) : '', i.updatedAt ? 'Updated ' + escapeHtml(fmtDate(i.updatedAt)) : ''].filter(Boolean).join(' · ');
    // A closed issue says so whenever the list can hold one (E17); an open-only list needs no badge on every card.
    const closed = i.state === 'closed' && issueFilter.state !== 'open';
    return `
      <div class="tv-card tv-issue"${closed ? ' data-status="dropped"' : ''}>
        ${closed ? '<div class="tv-statuscol"><span class="tv-status tv-status-dropped">Closed</span></div>' : ''}
        <div class="tv-main">
          <div class="tv-title">#${escapeHtml(String(i.number))} ${escapeHtml(i.title)}</div>
          ${i.labels.length ? `<div class="tv-issue-labels">${i.labels.map((l) => `<span class="tv-issue-label">${escapeHtml(l)}</span>`).join('')}</div>` : ''}
          ${meta ? `<div class="tv-meta">${meta}</div>` : ''}
          ${i.body.trim() ? `<details class="tv-issue-body"><summary>Description</summary><div class="tv-note">${escapeHtml(i.body)}</div></details>` : ''}
        </div>
        <div class="tv-actions">
          ${i.url ? `<button data-action="open-issue" data-url="${escapeHtml(i.url)}" title="Open in the browser">↗</button>` : ''}
        </div>
      </div>`;
  }

  const ISSUE_STATE_WORDS = { open: 'open', closed: 'closed', all: '' };

  function issueOwner() {
    const p = scopeFilter.projectPath;
    return p && typeof settingsOwnerPath === 'function' ? settingsOwnerPath(p) : (p || '');
  }

  // The cards and the count, which a keystroke in the issue filter redraws without touching the filter row.
  function issueListParts() {
    if (!issues || issues.loading) return { count: '', list: '<div class="tv-empty">Loading issues…</div>' };
    if (!issues.ok) return { count: '', list: `<div class="tv-empty">${escapeHtml(issues.message || 'The issues could not be read.')}</div>` };
    const rows = filterIssues(issues.issues, { text: issueText, label: issueFilter.label });
    const word = ISSUE_STATE_WORDS[issueFilter.state] || '';
    const count = issueCountLabel(rows.length, issues.issues.length, issues.limit) + (word ? ` ${word}` : '');
    const none = issueFilter.state === 'closed' ? 'No closed issues.' : issueFilter.state === 'all' ? 'No issues.' : 'No open issues.';
    const list = rows.length ? rows.map(issueCardHtml).join('')
      : `<div class="tv-empty">${issues.issues.length ? 'No issues match the filter.' : none}</div>`;
    return { count, list };
  }

  // State and the two toggles go to the CLI; a toggle the provider cannot answer is not drawn (#830).
  function issueFiltersHtml() {
    const supports = (issues && issues.ok && issues.supports) || issueSupports || {};
    const labels = issueLabels(issues && issues.ok ? issues.issues : [], issueFilter.label);
    const states = [['open', 'Open'], ['closed', 'Closed'], ['all', 'Open and closed']];
    // A stored "on" the provider can no longer answer stays visible, so it can be seen and switched off.
    const toggle = (field, label) => (supports[field] === true || issueFilter[field]
      ? `<button type="button" class="tv-refresh tv-issues-toggle" data-action="issue-toggle" data-field="${field}" aria-pressed="${issueFilter[field] ? 'true' : 'false'}"${supports[field] === true ? '' : ' title="The provider cannot tell this right now, so the list is not filtered by it. Click to switch it off."'}>${label}</button>`
      : '');
    return `
      <div class="tv-issues-filters">
        <input type="text" class="tv-search tv-issues-search" placeholder="Filter issues…" value="${escapeHtml(issueText)}">
        <select class="tv-issues-state" title="Issue state">${states.map(([v, l]) => `<option value="${v}"${v === issueFilter.state ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <select class="tv-issues-label" title="Label"><option value="">All labels</option>${labels.map((l) => `<option value="${escapeHtml(l)}"${l === issueFilter.label ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>
        ${toggle('assignee', 'Assigned to me')}
        ${toggle('author', 'Opened by me')}
      </div>`;
  }

  function issuesHtml() {
    if (!issues) return '';
    const heading = issues.ok ? `${escapeHtml(issues.provider)} issues · ${escapeHtml(issues.repo)}` : 'Issues';
    const parts = issueListParts();
    return `
      <details class="tv-issues"${issuesOpen ? ' open' : ''}>
        <summary class="tv-issues-head"><span>${heading}</span><span class="tv-issues-count">${escapeHtml(parts.count)}</span><span class="tv-issues-readonly">Read-only</span></summary>
        ${issueFiltersHtml()}
        <div class="tv-issues-list">${parts.list}</div>
      </details>`;
  }

  function refreshIssueList() {
    const list = viewer.querySelector('.tv-issues-list');
    if (!list) { refreshBody(); return; }
    const parts = issueListParts();
    list.innerHTML = parts.list;
    const count = viewer.querySelector('.tv-issues-count');
    if (count) count.textContent = parts.count;
  }

  // Stored, then told to this window's session sidebar; a change of what the CLI is asked reads again.
  async function changeIssueFilter(patch) {
    const before = issueQueryOf(issueFilter);
    issueFilter = normalizeIssueFilter({ ...issueFilter, ...patch });
    const owner = issueOwner();
    try {
      // Only the changed field is written, merged in main: another window's change to another field survives.
      const stored = await patchIssueFilter(window.api, owner, patch);
      if (issueOwner() !== owner) return; // the view moved to another project meanwhile
      issueFilter = stored;
    } catch (err) {
      toast('The issue filter could not be saved.');
    }
    if (issueOwner() !== owner) return;
    window.dispatchEvent(new CustomEvent(ISSUE_FILTER_EVENT, { detail: { owner, filter: issueFilter, from: 'tasks-view' } }));
    const after = issueQueryOf(issueFilter);
    if (before.state !== after.state || before.assignee !== after.assignee || before.author !== after.author) loadIssues(false, true);
    else refreshIssueList();
  }

  // `force` is the reload button: main holds an answer of its own for a while (#830). `keepFilter` skips re-reading
  // the stored filter when this view has just written it.
  async function loadIssues(force, keepFilter) {
    const projectPath = scopeFilter.projectPath;
    const asked = ++issuesAsked;
    if (!keepFilter) issues = null;
    if (!projectPath || !window.api.forgeIssuesList) { issues = null; return; }
    let answer = null;
    try {
      const effective = await window.api.getEffectiveSettings(projectPath);
      if (asked !== issuesAsked) return;
      if (!effective || effective.forgeIssuesEnabled !== true) { issues = null; refreshBody(); return; }
      if (!keepFilter) {
        const stored = await readIssueFilter(window.api, issueOwner());
        if (asked !== issuesAsked) return;
        issueFilter = stored;
      }
      issues = { loading: true };
      refreshBody();
      answer = await window.api.forgeIssuesList(projectPath, issueQueryOf(issueFilter), { force: force === true });
    } catch (err) {
      answer = { enabled: true, ok: false, message: err.message };
    }
    if (asked !== issuesAsked) return;
    issues = answer && answer.enabled ? answer : null;
    if (issues && issues.ok && issues.supports) issueSupports = issues.supports;
    refreshBody();
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

  // The issue controls live inside the body, so a redraw (an answer arriving, a task filter keystroke) would take
  // the caret out of them. The control that had it gets it back, with its selection.
  const ISSUE_CONTROLS = ['.tv-issues-search', '.tv-issues-state', '.tv-issues-label', '.tv-issues-toggle[data-field="assignee"]', '.tv-issues-toggle[data-field="author"]'];
  function refreshBody() {
    const body = viewer.querySelector('.tv-body');
    if (!body) return;
    const active = document.activeElement;
    const had = active && body.contains(active) ? ISSUE_CONTROLS.find((sel) => active.matches(sel)) : null;
    const caret = had && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    body.innerHTML = bodyHtml();
    if (!had) return;
    const again = body.querySelector(had);
    if (!again) return;
    again.focus();
    if (caret) { try { again.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ } }
  }

  async function load(force) {
    viewer.innerHTML = '<div class="tv-loading">Loading tasks…</div>';
    try {
      const res = await window.api.taskList(scopeFilter);
      if (!res || res.error) {
        viewer.innerHTML = `<div class="tv-loading">Error: ${escapeHtml(res && res.error || 'unknown')}</div>`;
        return;
      }
      data = res.tasks || [];
      issues = null; // another project's answer must not be drawn for this one
      render();
      loadIssues(force);
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
      if (action === 'refresh') { load(true); return; }
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

  // Capture: `toggle` does not bubble. A filter keystroke redraws the group, so its state has to live here.
  viewer.addEventListener('toggle', (e) => {
    if (e.target.classList && e.target.classList.contains('tv-issues')) issuesOpen = e.target.open;
  }, true);

  // The issue filters (#830). Delegated, because the row is redrawn with every answer.
  viewer.addEventListener('input', (e) => {
    if (!e.target.matches || !e.target.matches('.tv-issues-search')) return;
    issueText = e.target.value;
    refreshIssueList();
  });
  viewer.addEventListener('change', (e) => {
    if (!e.target.matches) return;
    if (e.target.matches('.tv-issues-state')) changeIssueFilter({ state: e.target.value });
    else if (e.target.matches('.tv-issues-label')) changeIssueFilter({ label: e.target.value });
  });
  // The sidebar in this window changed it: follow, and ask main again only when the CLI half moved.
  window.addEventListener(ISSUE_FILTER_EVENT, (e) => {
    const d = e.detail || {};
    if (d.from === 'tasks-view' || !scopeFilter.projectPath || d.owner !== issueOwner() || viewer.style.display === 'none') return;
    const before = issueQueryOf(issueFilter);
    issueFilter = normalizeIssueFilter(d.filter);
    const after = issueQueryOf(issueFilter);
    if (before.state !== after.state || before.assignee !== after.assignee || before.author !== after.author) loadIssues(false, true);
    else refreshBody();
  });

  viewer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'open-issue') { window.api.openExternal(btn.dataset.url); return; }
    if (action === 'issue-toggle') {
      const field = btn.dataset.field;
      if (field === 'assignee' || field === 'author') changeIssueFilter({ [field]: !issueFilter[field] });
      return;
    }
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
    issueText = '';
    issueSupports = null;
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
