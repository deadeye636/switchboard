// --- Sidebar rendering ---
// Depends on globals: sidebarContent, openSessions, activeSessionId, activePtyIds,
// pendingSessions, sessionMap, lastActivityTime, sortedOrder, searchMatchIds,
// searchMatchProjectPaths, showStarredOnly, showRunningOnly, showTodayOnly,
// visibleSessionCount, sessionMaxAgeDays, attentionSessions, responseReadySessions,
// sessionBusyState, cachedProjects, cachedAllProjects, gridCards, gridViewActive (app.js)
// Depends on: cleanDisplayName, formatDate, escapeHtml (utils.js), ICONS (icons.js),
// showSession (terminal-manager.js), confirmAndStopSession, pollActiveSessions,
// showNewSessionPopover, openSettingsViewer, showResumeSessionDialog,
// showJsonlViewer, showTimelineViewer, forkSession, openSession, loadProjects (app.js/dialogs.js)

function slugId(slug) {
  return 'slug-' + slug.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function groupDomId(groupId) {
  return 'group-' + String(groupId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function folderId(projectPath) {
  return 'project-' + projectPath.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getSessionRuntimeState() {
  return {
    activePtyIds,
    attentionSessions,
    responseReadySessions,
    sessionBusyState,
    openSessions,
    lastActivityTime,
    activeSessionId,
  };
}

function getSessionProjectLabel(session) {
  return session.projectPath ? session.projectPath.split('/').filter(Boolean).slice(-2).join('/') : 'Other';
}

function getAllRenderableSessions(projects) {
  const sessionsById = new Map();
  for (const project of projects) {
    for (const session of project.sessions || []) {
      sessionsById.set(session.sessionId, session);
    }
  }
  return [...sessionsById.values()];
}

function shortSessionLabel(session) {
  return cleanDisplayName(session.name || session.aiTitle || session.summary) || session.sessionId;
}

function showSpringCleaningDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'spring-cleaning-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'spring-cleaning-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'spring-cleaning-title');

  let ageDays = DEFAULT_CLEANUP_AGE_DAYS;
  let candidates = [];
  let selectedIds = new Set();

  dialog.innerHTML = `
    <div class="spring-cleaning-header">
      <div>
        <div class="spring-cleaning-kicker">Spring Cleaning</div>
        <h3 id="spring-cleaning-title">Hide Old Sessions</h3>
        <p>Archive old stopped sessions from the sidebar. Session files are not deleted, and you can undo immediately after cleanup.</p>
      </div>
      <button type="button" class="spring-cleaning-close-btn" aria-label="Close spring cleaning">&times;</button>
    </div>
    <div class="spring-cleaning-controls">
      <span>Older than</span>
      <div class="spring-cleaning-age-options" role="group" aria-label="Session age threshold"></div>
    </div>
    <div class="spring-cleaning-summary"></div>
    <div class="spring-cleaning-list"></div>
    <div class="spring-cleaning-actions">
      <button type="button" class="spring-cleaning-cancel-btn">Cancel</button>
      <button type="button" class="spring-cleaning-archive-btn">Archive Selected</button>
    </div>
  `;

  const ageOptionsEl = dialog.querySelector('.spring-cleaning-age-options');
  const summaryEl = dialog.querySelector('.spring-cleaning-summary');
  const listEl = dialog.querySelector('.spring-cleaning-list');
  const archiveBtn = dialog.querySelector('.spring-cleaning-archive-btn');

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function refreshCandidates() {
    candidates = getSpringCleaningCandidates(cachedAllProjects, {
      ageDays,
      activePtyIds,
      lastActivityTime,
    });
    selectedIds = new Set(candidates.map(item => item.session.sessionId));
    renderBody();
  }

  function renderAgeOptions() {
    ageOptionsEl.innerHTML = '';
    for (const days of CLEANUP_AGE_PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'spring-cleaning-age-btn' + (days === ageDays ? ' active' : '');
      button.textContent = `${days} days`;
      button.addEventListener('click', () => {
        ageDays = days;
        renderAgeOptions();
        refreshCandidates();
      });
      ageOptionsEl.appendChild(button);
    }
  }

  function renderBody() {
    const summary = summarizeSpringCleaningSelection(candidates, selectedIds);
    summaryEl.textContent = candidates.length
      ? `${summary.selectedCount} of ${candidates.length} sessions selected across ${summary.projectCount} project${summary.projectCount === 1 ? '' : 's'}.`
      : `No stopped, unpinned sessions older than ${ageDays} days.`;
    archiveBtn.disabled = summary.selectedCount === 0;
    archiveBtn.textContent = summary.selectedCount === 0
      ? 'Archive Selected'
      : `Archive ${summary.selectedCount} Selected`;

    listEl.innerHTML = '';
    if (candidates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'spring-cleaning-empty';
      empty.textContent = 'Nothing to clean up for this age threshold.';
      listEl.appendChild(empty);
      return;
    }

    const byProject = new Map();
    for (const item of candidates) {
      const key = item.projectPath || 'Other';
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(item);
    }

    for (const [, items] of byProject) {
      const group = document.createElement('section');
      group.className = 'spring-cleaning-group';

      const header = document.createElement('div');
      header.className = 'spring-cleaning-group-title';
      header.textContent = `${items[0].projectLabel} · ${items.length}`;
      group.appendChild(header);

      for (const item of items) {
        const session = item.session;
        const row = document.createElement('label');
        row.className = 'spring-cleaning-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedIds.has(session.sessionId);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selectedIds.add(session.sessionId);
          else selectedIds.delete(session.sessionId);
          renderBody();
        });
        row.appendChild(checkbox);

        const info = document.createElement('span');
        info.className = 'spring-cleaning-row-info';
        const title = document.createElement('span');
        title.className = 'spring-cleaning-row-title';
        title.textContent = shortSessionLabel(session);
        const meta = document.createElement('span');
        meta.className = 'spring-cleaning-row-meta';
        meta.textContent = `${item.ageDays} days old · ${session.messageCount || 0} msgs`;
        info.appendChild(title);
        info.appendChild(meta);
        row.appendChild(info);

        group.appendChild(row);
      }

      listEl.appendChild(group);
    }
  }

  archiveBtn.addEventListener('click', async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    for (const id of ids) {
      await window.api.archiveSession(id, 1);
      const session = sessionMap.get(id);
      if (session) session.archived = 1;
    }
    close();
    loadProjects();
    if (typeof playSpringCleaningParticles === 'function') {
      playSpringCleaningParticles('confetti', document.body);
    }
    showControlToast({
      message: `Archived ${ids.length} old session${ids.length === 1 ? '' : 's'}.`,
      actionLabel: 'Undo',
      onAction: async () => {
        for (const id of ids) {
          await window.api.archiveSession(id, 0);
          const session = sessionMap.get(id);
          if (session) session.archived = 0;
        }
        loadProjects();
      },
    });
  });

  dialog.querySelector('.spring-cleaning-close-btn').addEventListener('click', close);
  dialog.querySelector('.spring-cleaning-cancel-btn').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  function onKey(event) { if (event.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  if (typeof playSpringCleaningParticles === 'function') {
    playSpringCleaningParticles('leaves', overlay);
  }
  renderAgeOptions();
  refreshCandidates();
  dialog.querySelector('.spring-cleaning-close-btn').focus();
}

function buildAttentionInbox(projects) {
  const items = getAttentionInboxItems(getAllRenderableSessions(projects), getSessionRuntimeState());
  if (items.length === 0) return null;

  const section = document.createElement('section');
  section.className = 'attention-inbox';
  section.setAttribute('aria-label', 'Sessions needing attention');

  const header = document.createElement('div');
  header.className = 'attention-inbox-header';
  header.innerHTML = `
    <span>Attention</span>
    <div class="attention-inbox-header-actions">
      <span>${items.length}</span>
      <button type="button" class="attention-inbox-next-btn" title="Focus next session needing attention">Focus next</button>
    </div>
  `;
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'attention-inbox-list';

  for (const { session, status } of items.slice(0, 8)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `attention-inbox-item ${status.className}`;
    button.dataset.sessionId = session.sessionId;

    const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary) || session.sessionId;
    const modified = lastActivityTime.get(session.sessionId) || new Date(session.modified);
    const timeStr = formatDate(modified);
    button.innerHTML = `
      <span class="attention-inbox-status">${escapeHtml(status.label)}</span>
      <span class="attention-inbox-title">${escapeHtml(displayName)}</span>
      <span class="attention-inbox-meta">${escapeHtml(getSessionProjectLabel(session))} · ${escapeHtml(timeStr)}</span>
    `;
    list.appendChild(button);
  }

  if (items.length > 8) {
    const more = document.createElement('div');
    more.className = 'attention-inbox-more';
    more.textContent = `+ ${items.length - 8} more in project list`;
    list.appendChild(more);
  }

  section.appendChild(list);
  return section;
}

// User-defined group section (spec 07). Mirrors buildSlugGroup but is keyed by
// a stable, persisted group id, carries the group's color, and rolls up status
// counts so a collapsed group still signals attention.
function buildUserGroup(group, sessions) {
  const container = document.createElement('div');
  const id = groupDomId(group.id);
  const collapsed = getCollapsedGroups().has(id);
  container.className = collapsed ? 'user-group collapsed' : 'user-group';
  container.id = id;
  container.dataset.groupId = group.id;
  container.style.setProperty('--user-group-color', group.color);

  const counts = getStatusCounts(sessions, getSessionRuntimeState());
  const hasRunning = sessions.some(s => activePtyIds.has(s.sessionId));

  const header = document.createElement('div');
  header.className = 'user-group-header';

  const row = document.createElement('div');
  row.className = 'user-group-row';

  const expand = document.createElement('span');
  expand.className = 'user-group-expand';
  expand.innerHTML = '<span class="arrow">&#9654;</span>';

  // Folder glyph carries the group's accent colour and doubles as the
  // collapsed/expanded affordance (closed vs open folder is swapped in CSS).
  const folder = document.createElement('span');
  folder.className = 'user-group-folder';
  folder.innerHTML = `<span class="folder-closed">${ICONS.folder(15)}</span><span class="folder-open">${ICONS.folderOpen(15)}</span>`;

  const info = document.createElement('div');
  info.className = 'user-group-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'user-group-name';
  nameEl.textContent = group.name;

  const meta = document.createElement('div');
  meta.className = 'user-group-meta';
  meta.innerHTML = `<span class="user-group-status-dot${hasRunning ? ' running' : ''}"></span><span class="user-group-count">${sessions.length} session${sessions.length === 1 ? '' : 's'}</span>`;

  const chips = document.createElement('span');
  chips.className = 'user-group-chips';
  if (counts.attention > 0) {
    const chip = document.createElement('span');
    chip.className = 'user-group-chip status-needs-attention';
    chip.textContent = String(counts.attention);
    chip.title = `${counts.attention} need${counts.attention === 1 ? 's' : ''} attention`;
    chips.appendChild(chip);
  }
  if (counts.ready > 0) {
    const chip = document.createElement('span');
    chip.className = 'user-group-chip status-response-ready';
    chip.textContent = String(counts.ready);
    chip.title = `${counts.ready} ready`;
    chips.appendChild(chip);
  }

  const menuBtn = document.createElement('button');
  menuBtn.className = 'user-group-menu-btn';
  menuBtn.title = 'Group options';
  menuBtn.setAttribute('aria-label', `Options for ${group.name}`);
  menuBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

  info.appendChild(nameEl);
  info.appendChild(meta);
  row.appendChild(expand);
  row.appendChild(folder);
  row.appendChild(info);
  // Roll-up attention/ready chips sit on the right of the header so a collapsed
  // group still signals supervision needs; only mount them when non-empty so an
  // empty span doesn't introduce a stray flex gap.
  if (chips.childElementCount > 0) row.appendChild(chips);
  row.appendChild(menuBtn);
  header.appendChild(row);

  const sessionsContainer = document.createElement('div');
  sessionsContainer.className = 'user-group-sessions';
  for (const session of sessions) {
    sessionsContainer.appendChild(buildSessionItem(session));
  }

  container.appendChild(header);
  container.appendChild(sessionsContainer);
  return container;
}

function buildSlugGroup(slug, sessions) {
  const group = document.createElement('div');
  const id = slugId(slug);
  const expanded = getExpandedSlugs().has(id);
  group.className = expanded ? 'slug-group' : 'slug-group collapsed';
  group.id = id;

  const mostRecent = sessions.reduce((a, b) => {
    const aTime = lastActivityTime.get(a.sessionId) || new Date(a.modified);
    const bTime = lastActivityTime.get(b.sessionId) || new Date(b.modified);
    return bTime > aTime ? b : a;
  });
  const displayName = cleanDisplayName(mostRecent.name || mostRecent.aiTitle || mostRecent.summary || slug);
  const mostRecentTime = lastActivityTime.get(mostRecent.sessionId) || new Date(mostRecent.modified);
  const timeStr = formatDate(mostRecentTime);

  const header = document.createElement('div');
  header.className = 'slug-group-header';

  const row = document.createElement('div');
  row.className = 'slug-group-row';

  const expand = document.createElement('span');
  expand.className = 'slug-group-expand';
  expand.innerHTML = '<span class="arrow">&#9654;</span>';

  const info = document.createElement('div');
  info.className = 'slug-group-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'slug-group-name';
  nameEl.textContent = displayName;

  const hasRunning = sessions.some(s => activePtyIds.has(s.sessionId));

  const meta = document.createElement('div');
  meta.className = 'slug-group-meta';
  meta.innerHTML = `<span class="slug-group-dot${hasRunning ? ' running' : ''}"></span><span class="slug-group-count">${sessions.length} sessions</span> ${escapeHtml(timeStr)}`;

  const archiveSlugBtn = document.createElement('button');
  archiveSlugBtn.className = 'slug-group-archive-btn';
  archiveSlugBtn.title = 'Archive all sessions in group';
  archiveSlugBtn.innerHTML = ICONS.archive(14);

  info.appendChild(nameEl);
  info.appendChild(meta);
  row.appendChild(expand);
  row.appendChild(info);
  row.appendChild(archiveSlugBtn);
  header.appendChild(row);

  const sessionsContainer = document.createElement('div');
  sessionsContainer.className = 'slug-group-sessions';

  const promoted = [];
  const rest = [];
  for (const session of sessions) {
    if (activePtyIds.has(session.sessionId)) {
      promoted.push(session);
    } else {
      rest.push(session);
    }
  }

  if (promoted.length > 0) {
    group.classList.add('has-promoted');
    for (const session of promoted) {
      sessionsContainer.appendChild(buildSessionItem(session));
    }
    if (rest.length > 0) {
      const moreBtn = document.createElement('div');
      moreBtn.className = 'slug-group-more';
      moreBtn.id = 'sgm-' + id;
      moreBtn.textContent = `+ ${rest.length} more`;

      const olderDiv = document.createElement('div');
      olderDiv.className = 'slug-group-older';
      olderDiv.id = 'sgo-' + id;
      for (const session of rest) {
        olderDiv.appendChild(buildSessionItem(session));
      }

      sessionsContainer.appendChild(moreBtn);
      sessionsContainer.appendChild(olderDiv);
    }
  } else {
    for (const session of sessions) {
      sessionsContainer.appendChild(buildSessionItem(session));
    }
  }

  group.appendChild(header);
  group.appendChild(sessionsContainer);
  return group;
}

function renderProjects(projects, resort) {
  const newSidebar = document.createElement('div');
  const attentionInbox = buildAttentionInbox(projects);
  if (attentionInbox) newSidebar.appendChild(attentionInbox);

  // Sort project groups using sortedOrder as source of truth
  if (!resort && sortedOrder.length > 0) {
    const orderIndex = new Map(sortedOrder.map((e, i) => [e.projectPath, i]));
    projects = [...projects].sort((a, b) => {
      const aPos = orderIndex.get(a.projectPath);
      const bPos = orderIndex.get(b.projectPath);
      if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
      if (aPos === undefined && bPos !== undefined) return -1;
      if (aPos !== undefined && bPos === undefined) return 1;
      return 0;
    });
  }
  // projects are now in the correct order (data order for resort, preserved order otherwise)

  // Detect worktree projects and group them under their parent
  const worktreePattern = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;
  const worktreeMap = new Map(); // parentPath → [worktreeProject, ...]
  const worktreeSet = new Set();
  for (const project of projects) {
    const match = project.projectPath.match(worktreePattern);
    if (match) {
      const parentPath = match[1];
      if (!worktreeMap.has(parentPath)) worktreeMap.set(parentPath, []);
      worktreeMap.get(parentPath).push(project);
      worktreeSet.add(project.projectPath);
    }
  }

  const newSortedOrder = [];

  // Process a project's sessions: filter, sort, slug-group, order, and truncate.
  // Returns { filtered, visible, older, sortOrderEntry } or null if project should be skipped.
  function processProjectSessions(project, resort) {
    let filtered = project.sessions;
    if (showStarredOnly) filtered = filtered.filter(s => s.starred);
    if (showRunningOnly) filtered = filtered.filter(s => activePtyIds.has(s.sessionId));
    if (showTodayOnly) {
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      filtered = filtered.filter(s => {
        if (!s.modified) return false;
        const d = new Date(s.modified);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
      });
    }
    const anyFilterActive = showStarredOnly || showRunningOnly || showTodayOnly || searchMatchIds !== null;
    if (filtered.length === 0 && !project._projectMatchedOnly && (project.sessions.length > 0 || anyFilterActive)) return null;

    // Sort
    filtered = [...filtered].sort((a, b) => {
      const aRunning = activePtyIds.has(a.sessionId) || pendingSessions.has(a.sessionId);
      const bRunning = activePtyIds.has(b.sessionId) || pendingSessions.has(b.sessionId);
      const aPri = (a.starred && aRunning ? 3 : aRunning ? 2 : a.starred ? 1 : 0);
      const bPri = (b.starred && bRunning ? 3 : bRunning ? 2 : b.starred ? 1 : 0);
      if (aPri !== bPri) return bPri - aPri;
      return new Date(b.modified) - new Date(a.modified);
    });

    // User-defined groups (spec 07): pull assigned sessions into collapsible
    // group sections first; the remainder fall through to slug grouping. Groups
    // that span projects render in each project section filtered to that
    // project's members (cards stay under the project header for context).
    const { grouped: userGroups, ungrouped: groupUngrouped } =
      (typeof groupSessions === 'function' && typeof groupsState !== 'undefined')
        ? groupSessions(groupsState, filtered)
        : { grouped: [], ungrouped: filtered };

    // Slug grouping (over sessions not claimed by a user group)
    const slugMap = new Map();
    const ungrouped = [];
    for (const session of groupUngrouped) {
      if (session.slug) {
        if (!slugMap.has(session.slug)) slugMap.set(session.slug, []);
        slugMap.get(session.slug).push(session);
      } else {
        ungrouped.push(session);
      }
    }
    const allItems = [];
    for (const session of ungrouped) {
      const isRunning = activePtyIds.has(session.sessionId) || pendingSessions.has(session.sessionId);
      allItems.push({ sortTime: new Date(session.modified).getTime(), pinned: !!session.starred, running: isRunning, element: buildSessionItem(session) });
    }
    for (const [slug, sessions] of slugMap) {
      const mostRecentTime = Math.max(...sessions.map(s => new Date(s.modified).getTime()));
      const hasRunning = sessions.some(s => activePtyIds.has(s.sessionId) || pendingSessions.has(s.sessionId));
      const hasPinned = sessions.some(s => s.starred);
      const element = sessions.length === 1 ? buildSessionItem(sessions[0]) : buildSlugGroup(slug, sessions);
      allItems.push({ sortTime: mostRecentTime, pinned: hasPinned, running: hasRunning, element });
    }
    for (const { group, sessions } of userGroups) {
      // Don't render a group section with no sessions in the current filtered
      // view — an empty section would otherwise linger after its members are
      // filtered out or unassigned.
      if (!sessions || sessions.length === 0) continue;
      const mostRecentTime = Math.max(...sessions.map(s => new Date(s.modified).getTime()));
      const hasRunning = sessions.some(s => activePtyIds.has(s.sessionId) || pendingSessions.has(s.sessionId));
      const hasPinned = sessions.some(s => s.starred);
      allItems.push({ sortTime: mostRecentTime, pinned: hasPinned, running: hasRunning, element: buildUserGroup(group, sessions) });
    }

    // Sort render items
    const prevEntry = sortedOrder.find(e => e.projectPath === project.projectPath);
    if (resort || !prevEntry) {
      allItems.sort((a, b) => {
        const aPri = (a.pinned && a.running ? 3 : a.running ? 2 : a.pinned ? 1 : 0);
        const bPri = (b.pinned && b.running ? 3 : b.running ? 2 : b.pinned ? 1 : 0);
        if (aPri !== bPri) return bPri - aPri;
        return b.sortTime - a.sortTime;
      });
    } else {
      const orderIndex = new Map(prevEntry.itemIds.map((id, i) => [id, i]));
      allItems.sort((a, b) => {
        const aPos = orderIndex.get(a.element.id);
        const bPos = orderIndex.get(b.element.id);
        if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
        if (aPos === undefined && bPos !== undefined) return -1;
        if (aPos !== undefined && bPos === undefined) return 1;
        return b.sortTime - a.sortTime;
      });
    }

    // Truncate
    let visible = [];
    let older = [];
    if (searchMatchIds !== null || showStarredOnly || showRunningOnly || showTodayOnly) {
      visible = allItems;
    } else {
      let count = 0;
      const ageCutoff = Date.now() - sessionMaxAgeDays * 86400000;
      for (const item of allItems) {
        if (item.running || item.pinned || (count < visibleSessionCount && item.sortTime >= ageCutoff)) {
          visible.push(item);
          count++;
        } else {
          older.push(item);
        }
      }
    }

    if (typeof shouldRenderProjectGroup === 'function' && !shouldRenderProjectGroup({
      filteredCount: filtered.length,
      visibleCount: visible.length,
      olderCount: older.length,
      projectMatchedOnly: !!project._projectMatchedOnly,
    })) {
      return null;
    }

    return {
      filtered, visible, older,
      sortOrderEntry: { projectPath: project.projectPath, itemIds: allItems.map(item => item.element.id) },
    };
  }

  // Build the sessions list DOM (shared between projects and worktrees)
  function buildSessionsList(fId, visible, older) {
    const sessionsList = document.createElement('div');
    sessionsList.className = 'project-sessions';
    sessionsList.id = 'sessions-' + fId;
    for (const item of visible) sessionsList.appendChild(item.element);
    if (older.length > 0) {
      const moreBtn = document.createElement('div');
      moreBtn.className = 'sessions-more-toggle';
      moreBtn.id = 'older-' + fId;
      moreBtn.textContent = `+ ${older.length} older`;
      const olderList = document.createElement('div');
      olderList.className = 'sessions-older';
      olderList.id = 'older-list-' + fId;
      olderList.style.display = 'none';
      for (const item of older) olderList.appendChild(item.element);
      sessionsList.appendChild(moreBtn);
      sessionsList.appendChild(olderList);
    }
    return sessionsList;
  }

  for (const project of projects) {
    // Skip worktree projects — they'll be rendered nested under their parent
    if (worktreeSet.has(project.projectPath)) continue;

    const result = processProjectSessions(project, resort);
    if (!result) continue;
    const { filtered, visible, older, sortOrderEntry } = result;
    newSortedOrder.push(sortOrderEntry);
    const fId = folderId(project.projectPath);

    // Build DOM
    const group = document.createElement('div');
    group.className = 'project-group' + (project.missing ? ' missing' : '');
    group.id = fId;

    const header = document.createElement('div');
    header.className = 'project-header';
    header.id = 'ph-' + fId;
    const shortName = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
    const missingIcon = project.missing ? '<svg class="project-missing-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ' : '';
    header.innerHTML = `<span class="arrow">&#9660;</span> ${missingIcon}<span class="project-name">${escapeHtml(shortName)}</span>`;

    const scheduleBtn = document.createElement('button');
    scheduleBtn.className = 'project-schedule-btn';
    scheduleBtn.title = 'Create scheduled task';
    scheduleBtn.innerHTML = ICONS.schedule(16);
    header.appendChild(scheduleBtn);

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'project-settings-btn';
    settingsBtn.title = 'Project settings';
    settingsBtn.innerHTML = ICONS.gear(16);
    header.appendChild(settingsBtn);

    const archiveGroupBtn = document.createElement('button');
    archiveGroupBtn.className = 'project-archive-btn';
    archiveGroupBtn.title = 'Archive all sessions';
    archiveGroupBtn.innerHTML = ICONS.archive(18);
    header.appendChild(archiveGroupBtn);

    if (project.missing) {
      const remapBtn = document.createElement('button');
      remapBtn.className = 'project-remap-btn';
      remapBtn.title = 'Change project path';
      remapBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
      header.appendChild(remapBtn);
    }

    const newBtn = document.createElement('button');
    newBtn.className = 'project-new-btn';
    newBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
    newBtn.title = 'New session';
    header.appendChild(newBtn);

    const sessionsList = buildSessionsList(fId, visible, older);

    // Auto-collapse if project path is missing, most recent session is older than threshold, or project matched with no sessions
    if (project.missing) {
      header.classList.add('collapsed');
    } else if (project._projectMatchedOnly) {
      header.classList.add('collapsed');
    } else if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
      const mostRecent = filtered[0]?.modified;
      if (mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
        header.classList.add('collapsed');
      }
    }

    group.appendChild(header);
    group.appendChild(sessionsList);

    // Render nested worktree sub-groups
    const childWorktrees = worktreeMap.get(project.projectPath) || [];
    for (const wt of childWorktrees) {
      const wtResult = processProjectSessions(wt, resort);
      if (!wtResult) continue;
      newSortedOrder.push(wtResult.sortOrderEntry);

      const wtName = wt.projectPath.match(worktreePattern)?.[2] || wt.projectPath.split('/').pop();
      const wtFId = folderId(wt.projectPath);

      const wtGroup = document.createElement('div');
      wtGroup.className = 'worktree-group';
      wtGroup.id = wtFId;

      const wtHeader = document.createElement('div');
      wtHeader.className = 'worktree-header';
      wtHeader.id = 'ph-' + wtFId;
      wtHeader.innerHTML = `<span class="worktree-branch-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4"/><path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3"/><path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35"/><path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14"/></svg></span> <span class="worktree-name">${escapeHtml(wtName)}</span>`;

      const wtHideBtn = document.createElement('button');
      wtHideBtn.className = 'worktree-hide-btn';
      wtHideBtn.title = 'Hide worktree';
      wtHideBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      wtHeader.appendChild(wtHideBtn);

      const wtNewBtn = document.createElement('button');
      wtNewBtn.className = 'project-new-btn worktree-new-btn';
      wtNewBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
      wtNewBtn.title = 'New session in worktree';
      wtHeader.appendChild(wtNewBtn);

      const wtSessionsList = buildSessionsList(wtFId, wtResult.visible, wtResult.older);
      wtSessionsList.className = 'worktree-sessions';

      // Auto-collapse worktree if stale
      if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
        const mostRecent = wtResult.filtered[0]?.modified;
        if (mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
          wtHeader.classList.add('collapsed');
        }
      }

      wtGroup.appendChild(wtHeader);
      wtGroup.appendChild(wtSessionsList);
      sessionsList.appendChild(wtGroup);
    }

    newSidebar.appendChild(group);
  }

  // Re-apply active state
  if (activeSessionId) {
    const activeItem = newSidebar.querySelector(`[data-session-id="${activeSessionId}"]`);
    if (activeItem) activeItem.classList.add('active');
  }

  morphdom(sidebarContent, newSidebar, {
    childrenOnly: true,
    onBeforeElUpdated(fromEl, toEl) {
      // Skip updating session items that have an active rename input
      if (fromEl.classList.contains('session-item') && fromEl.querySelector('.session-rename-input')) {
        return false;
      }
      if (fromEl.classList.contains('project-header')) {
        if (fromEl.classList.contains('collapsed')) {
          toEl.classList.add('collapsed');
        } else {
          toEl.classList.remove('collapsed');
        }
      }
      if (fromEl.classList.contains('slug-group') || fromEl.classList.contains('worktree-header') || fromEl.classList.contains('user-group')) {
        if (fromEl.classList.contains('collapsed')) {
          toEl.classList.add('collapsed');
        } else {
          toEl.classList.remove('collapsed');
        }
      }
      if (fromEl.classList.contains('sessions-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('sessions-more-toggle') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
        toEl.textContent = '- hide older';
      }
      if (fromEl.classList.contains('slug-group-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('slug-group-more') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
      }
      return true;
    },
    getNodeKey(node) {
      return node.id || undefined;
    }
  });

  // Save the full sorted order (project order + item order) as source of truth
  sortedOrder = newSortedOrder;

  rebindSidebarEvents(projects);

  // Restore terminal focus after morphdom DOM updates, but not if the user is
  // interacting with an input/textarea (search box, rename input, dialogs, etc.)
  const ae = document.activeElement;
  const isUserTyping = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.closest('.modal-overlay'));
  if (activeSessionId && openSessions.has(activeSessionId) && !isUserTyping) {
    openSessions.get(activeSessionId).terminal.focus();
  }
}

function rebindSidebarEvents(projects) {
  const nextAttentionBtn = sidebarContent.querySelector('.attention-inbox-next-btn');
  if (nextAttentionBtn) {
    nextAttentionBtn.onclick = (e) => {
      e.stopPropagation();
      const next = getNextAttentionInboxItem(getAllRenderableSessions(projects), getSessionRuntimeState(), activeSessionId);
      focusAttentionItem(next);
    };
  }

  sidebarContent.querySelectorAll('.attention-inbox-item').forEach(item => {
    const sessionId = item.dataset.sessionId;
    const session = sessionMap.get(sessionId);
    if (!session) return;
    item.onclick = () => openSession(session);
  });

  for (const project of projects) {
    const fId = folderId(project.projectPath);
    const header = document.getElementById('ph-' + fId);
    if (!header) continue;
    const newBtn = header.querySelector('.project-new-btn');
    if (newBtn) {
      newBtn.onclick = (e) => { e.stopPropagation(); showNewSessionPopover(project, newBtn); };
    }
    const scheduleBtn = header.querySelector('.project-schedule-btn');
    if (scheduleBtn) {
      scheduleBtn.onclick = (e) => { e.stopPropagation(); launchScheduleCreator(project); };
    }
    const settingsBtn = header.querySelector('.project-settings-btn');
    if (settingsBtn) {
      settingsBtn.onclick = (e) => { e.stopPropagation(); openSettingsViewer('project', project.projectPath); };
    }
    const remapBtn = header.querySelector('.project-remap-btn');
    if (remapBtn) {
      remapBtn.onclick = async (e) => {
        e.stopPropagation();
        const newPath = await window.api.browseFolder();
        if (!newPath) return;
        const shortName = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
        const confirmed = await showControlDialog({
          title: 'Change Project Path',
          message: 'Switchboard will associate this project group with the selected folder.',
          confirmLabel: 'Change Path',
          tone: 'warning',
          details: {
            Project: shortName,
            From: project.projectPath,
            To: newPath,
          },
        });
        if (!confirmed) return;
        const result = await window.api.remapProject(project.projectPath, newPath);
        if (result.error) {
          await showControlMessage({
            title: 'Remap Failed',
            message: result.error,
            confirmLabel: 'OK',
            tone: 'danger',
          });
        } else {
          loadProjects();
        }
      };
    }
    const archiveGroupBtn = header.querySelector('.project-archive-btn');
    if (archiveGroupBtn) {
      archiveGroupBtn.onclick = async (e) => {
        e.stopPropagation();
        const sessions = project.sessions.filter(s => !s.archived);
        if (sessions.length === 0) return;
        const shortName = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
        const confirmed = await showControlDialog({
          title: 'Archive Project Sessions',
          message: 'Archived sessions are hidden from the default sidebar view. Running sessions will be stopped first.',
          confirmLabel: `Archive ${sessions.length} Session${sessions.length === 1 ? '' : 's'}`,
          tone: 'warning',
          details: {
            Project: shortName,
            Sessions: sessions.length,
            Running: sessions.filter(s => activePtyIds.has(s.sessionId)).length,
          },
        });
        if (!confirmed) return;
        const archivedIds = sessions.map(s => s.sessionId);
        for (const s of sessions) {
          if (activePtyIds.has(s.sessionId)) {
            await window.api.stopSession(s.sessionId);
          }
          await window.api.archiveSession(s.sessionId, 1);
          s.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
        showControlToast({
          message: `Archived ${archivedIds.length} session${archivedIds.length === 1 ? '' : 's'} from ${shortName}.`,
          actionLabel: 'Undo',
          onAction: async () => {
            for (const id of archivedIds) {
              await window.api.archiveSession(id, 0);
              const session = sessionMap.get(id);
              if (session) session.archived = 0;
            }
            loadProjects();
          },
        });
      };
    }
    const toggleProject = (e) => {
      if (e.target.closest('.project-new-btn') || e.target.closest('.project-archive-btn') || e.target.closest('.project-settings-btn') || e.target.closest('.project-schedule-btn') || e.target.closest('.project-remap-btn')) return;
      header.classList.toggle('collapsed');
    };
    header.onclick = toggleProject;
    makeButtonLike(header, toggleProject, `Toggle ${project.projectPath.split('/').filter(Boolean).slice(-2).join('/')} sessions`);
  }

  // Bind worktree header events
  sidebarContent.querySelectorAll('.worktree-header').forEach(wtHeader => {
    const wtFId = wtHeader.id.replace('ph-', '');
    const wtProject = projects.find(p => folderId(p.projectPath) === wtFId);
    if (!wtProject) return;

    const wtNewBtn = wtHeader.querySelector('.worktree-new-btn');
    if (wtNewBtn) {
      wtNewBtn.onclick = (e) => { e.stopPropagation(); showNewSessionPopover(wtProject, wtNewBtn); };
    }
    const wtHideBtn = wtHeader.querySelector('.worktree-hide-btn');
    if (wtHideBtn) {
      wtHideBtn.onclick = async (e) => {
        e.stopPropagation();
        const name = wtProject.projectPath.split('/').pop();
        const confirmed = await showControlDialog({
          title: 'Hide Worktree',
          message: 'This removes the worktree from Switchboard. Session files are not deleted.',
          confirmLabel: 'Hide Worktree',
          tone: 'warning',
          details: {
            Worktree: name,
            Path: wtProject.projectPath,
          },
        });
        if (!confirmed) return;
        await window.api.removeProject(wtProject.projectPath);
        loadProjects();
      };
    }
    const toggleWorktree = (e) => {
      if (e.target.closest('.worktree-new-btn') || e.target.closest('.worktree-hide-btn')) return;
      wtHeader.classList.toggle('collapsed');
    };
    wtHeader.onclick = toggleWorktree;
    makeButtonLike(wtHeader, toggleWorktree, `Toggle ${wtProject.projectPath.split('/').pop()} worktree sessions`);
  });

  sidebarContent.querySelectorAll('.slug-group-header').forEach(header => {
    const archiveBtn = header.querySelector('.slug-group-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const group = header.parentElement;
        const sessionItems = group.querySelectorAll('.session-item');
        const archiveTargets = [];
        for (const item of sessionItems) {
          const sid = item.dataset.sessionId;
          const session = sessionMap.get(sid);
          if (!session || session.archived) continue;
          archiveTargets.push(session);
        }
        if (archiveTargets.length === 0) return;
        const name = header.querySelector('.slug-group-name')?.textContent || 'session group';
        const confirmed = await showControlDialog({
          title: 'Archive Session Group',
          message: 'Archived sessions are hidden from the default sidebar view. Running sessions will be stopped first.',
          confirmLabel: `Archive ${archiveTargets.length} Session${archiveTargets.length === 1 ? '' : 's'}`,
          tone: 'warning',
          details: {
            Group: name,
            Sessions: archiveTargets.length,
            Running: archiveTargets.filter(s => activePtyIds.has(s.sessionId)).length,
          },
        });
        if (!confirmed) return;
        const archivedIds = archiveTargets.map(s => s.sessionId);
        for (const session of archiveTargets) {
          const sid = session.sessionId;
          if (activePtyIds.has(sid)) await window.api.stopSession(sid);
          await window.api.archiveSession(sid, 1);
          session.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
        showControlToast({
          message: `Archived ${archivedIds.length} session${archivedIds.length === 1 ? '' : 's'} from ${name}.`,
          actionLabel: 'Undo',
          onAction: async () => {
            for (const id of archivedIds) {
              await window.api.archiveSession(id, 0);
              const session = sessionMap.get(id);
              if (session) session.archived = 0;
            }
            loadProjects();
          },
        });
      };
    }
    const toggleSlugGroup = (e) => {
      if (e.target.closest('.slug-group-archive-btn')) return;
      header.parentElement.classList.toggle('collapsed');
      saveExpandedSlugs();
    };
    header.onclick = toggleSlugGroup;
    const name = header.querySelector('.slug-group-name')?.textContent || 'session group';
    makeButtonLike(header, toggleSlugGroup, `Toggle ${name}`);
  });

  sidebarContent.querySelectorAll('.user-group-header').forEach(header => {
    const container = header.parentElement;
    const groupId = container?.dataset.groupId;
    const menuBtn = header.querySelector('.user-group-menu-btn');
    if (menuBtn && groupId) {
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        showGroupMenu(groupId, menuBtn);
      };
    }
    const toggleUserGroup = (e) => {
      if (e.target.closest('.user-group-menu-btn')) return;
      container.classList.toggle('collapsed');
      saveCollapsedGroups();
    };
    header.onclick = toggleUserGroup;
    const name = header.querySelector('.user-group-name')?.textContent || 'group';
    makeButtonLike(header, toggleUserGroup, `Toggle ${name}`);
  });

  sidebarContent.querySelectorAll('.slug-group-more').forEach(moreBtn => {
    const expandSlugGroup = () => {
      const group = moreBtn.closest('.slug-group');
      if (group) {
        group.classList.remove('collapsed');
        saveExpandedSlugs();
      }
    };
    moreBtn.onclick = expandSlugGroup;
    makeButtonLike(moreBtn, expandSlugGroup, moreBtn.textContent);
  });

  sidebarContent.querySelectorAll('.sessions-more-toggle').forEach(moreBtn => {
    const olderList = moreBtn.nextElementSibling;
    if (!olderList || !olderList.classList.contains('sessions-older')) return;
    const count = olderList.children.length;
    const toggleOlderSessions = () => {
      const showing = olderList.style.display !== 'none';
      olderList.style.display = showing ? 'none' : '';
      moreBtn.classList.toggle('expanded', !showing);
      moreBtn.textContent = showing ? `+ ${count} older` : '- hide older';
    };
    moreBtn.onclick = toggleOlderSessions;
    makeButtonLike(moreBtn, toggleOlderSessions, moreBtn.textContent);
  });

  sidebarContent.querySelectorAll('.session-item').forEach(item => {
    const sessionId = item.dataset.sessionId;
    const session = sessionMap.get(sessionId);
    if (!session) return;

    // Sessions under missing projects can't be opened — the path no longer exists
    if (item.closest('.project-group.missing')) {
      item.classList.add('disabled');
      item.title = 'Project path no longer exists — use "Change path" to fix';
      item.onclick = () => {};
      return;
    }

    const openSessionFromRow = (e) => {
      if (e?.target?.closest?.('.session-actions, .session-pin, .session-health-chip')) return;
      openSession(session);
    };
    item.onclick = openSessionFromRow;
    makeButtonLike(item, openSessionFromRow, `Open ${cleanDisplayName(session.name || session.aiTitle || session.summary) || session.sessionId}`);

    const pin = item.querySelector('.session-pin');
    if (pin) {
      const togglePin = async (e) => {
        e.stopPropagation();
        const { starred } = await window.api.toggleStar(session.sessionId);
        session.starred = starred;
        refreshSidebar({ resort: true });
      };
      pin.onclick = togglePin;
      makeButtonLike(pin, togglePin, pin.title);
    }

    const summaryEl = item.querySelector('.session-summary');
    if (summaryEl) {
      summaryEl.ondblclick = (e) => { e.stopPropagation(); startRename(summaryEl, session); };
    }

    const stopBtn = item.querySelector('.session-stop-btn');
    if (stopBtn) {
      stopBtn.onclick = (e) => {
        e.stopPropagation();
        confirmAndStopSession(session.sessionId);
      };
    }

    const launchConfigBtn = item.querySelector('.session-launch-config-btn');
    if (launchConfigBtn) {
      launchConfigBtn.onclick = (e) => {
        e.stopPropagation();
        showResumeSessionDialog(session);
      };
    }

    item.querySelectorAll('.session-handoff-btn, .session-health-chip').forEach(handoffBtn => {
      handoffBtn.onclick = (e) => {
        e.stopPropagation();
        showHandoffPrompt(session);
      };
    });

    const forkBtn = item.querySelector('.session-fork-btn');
    if (forkBtn) {
      forkBtn.onclick = async (e) => {
        e.stopPropagation();
        // Find the project for this session
        const project = [...cachedAllProjects, ...cachedProjects].find(p =>
          p.sessions.some(s => s.sessionId === session.sessionId)
        );
        if (project) {
          forkSession(session, project);
        }
      };
    }

    const jsonlBtn = item.querySelector('.session-jsonl-btn');
    if (jsonlBtn) {
      jsonlBtn.onclick = (e) => {
        e.stopPropagation();
        showJsonlViewer(session);
      };
    }

    const copyIdBtn = item.querySelector('.session-copy-id-btn');
    if (copyIdBtn) {
      copyIdBtn.onclick = async (e) => {
        e.stopPropagation();
        await window.api.writeClipboard(session.sessionId);
        showControlToast({ message: 'Session ID copied.' });
      };
    }

    const groupBtn = item.querySelector('.session-group-btn');
    if (groupBtn) {
      groupBtn.onclick = (e) => {
        e.stopPropagation();
        showGroupAssignPopover(session, groupBtn);
      };
    }

    const timelineBtn = item.querySelector('.session-timeline-btn');
    if (timelineBtn) {
      timelineBtn.onclick = (e) => {
        e.stopPropagation();
        showTimelineViewer(session);
      };
    }

    const archiveBtn = item.querySelector('.session-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const newVal = session.archived ? 0 : 1;
        if (newVal && activePtyIds.has(session.sessionId)) {
          const confirmed = await showControlDialog({
            title: 'Archive Running Session',
            message: 'Archiving this running session will stop its process first.',
            confirmLabel: 'Stop And Archive',
            tone: 'danger',
            details: {
              Session: cleanDisplayName(session.name || session.aiTitle || session.summary) || session.sessionId,
              Project: session.projectPath ? session.projectPath.split('/').filter(Boolean).slice(-2).join('/') : '',
            },
          });
          if (!confirmed) return;
          await window.api.stopSession(session.sessionId);
          pollActiveSessions();
        }
        await window.api.archiveSession(session.sessionId, newVal);
        session.archived = newVal;
        loadProjects();
        if (newVal) {
          showControlToast({
            message: 'Session archived.',
            actionLabel: 'Undo',
            onAction: async () => {
              await window.api.archiveSession(session.sessionId, 0);
              session.archived = 0;
              loadProjects();
            },
          });
        }
      };
    }
  });
  syncTitleToAriaLabel(sidebarContent);
  syncTitleToTooltip(sidebarContent);

  // Auto-expand slug group if it contains the active session
  if (activeSessionId) {
    const activeItem = sidebarContent.querySelector(`[data-session-id="${activeSessionId}"]`);
    const collapsedGroup = activeItem?.closest('.slug-group.collapsed');
    if (collapsedGroup) {
      collapsedGroup.classList.remove('collapsed');
      saveExpandedSlugs();
    }
    const collapsedUserGroup = activeItem?.closest('.user-group.collapsed');
    if (collapsedUserGroup) {
      collapsedUserGroup.classList.remove('collapsed');
      saveCollapsedGroups();
    }
  }
}

function buildSessionItem(session) {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.id = 'si-' + session.sessionId;
  if (session.type === 'terminal') item.classList.add('is-terminal');
  if (session.archived) item.classList.add('archived-item');
  if (activePtyIds.has(session.sessionId)) item.classList.add('has-running-pty');
  if (attentionSessions.has(session.sessionId)) item.classList.add('needs-attention');
  if (responseReadySessions.has(session.sessionId)) item.classList.add('response-ready');
  if (sessionBusyState.get(session.sessionId)) item.classList.add('cli-busy');
  item.dataset.sessionId = session.sessionId;

  const modified = lastActivityTime.get(session.sessionId) || new Date(session.modified);
  const timeStr = formatDate(modified);
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);
  const status = getSessionStatus(session, getSessionRuntimeState());
  const health = getSessionHealth(session);
  item.classList.add(status.className);
  item.classList.add(health.className);

  const row = document.createElement('div');
  row.className = 'session-row';

  // Pin
  const pin = document.createElement('span');
  pin.className = 'session-pin' + (session.starred ? ' pinned' : '');
  pin.title = session.starred ? 'Unpin session' : 'Pin session';
  pin.setAttribute('aria-label', pin.title);
  pin.innerHTML = session.starred
    ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>';

  // Running status dot
  const dot = document.createElement('span');
  dot.className = 'session-status-dot' + (activePtyIds.has(session.sessionId) ? ' running' : '');

  const indicators = document.createElement('div');
  indicators.className = 'session-indicators';
  indicators.appendChild(pin);
  indicators.appendChild(dot);

  // Info block
  const info = document.createElement('div');
  info.className = 'session-info';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = displayName;

  const detailEl = document.createElement('div');
  detailEl.className = 'session-card-details';

  const statusChip = document.createElement('span');
  statusChip.className = `session-detail-pill session-status-chip ${status.className}`;
  statusChip.textContent = status.label;
  detailEl.appendChild(statusChip);
  if (health.state !== 'healthy') {
    const healthChip = document.createElement('button');
    healthChip.type = 'button';
    healthChip.className = `session-detail-pill session-health-chip ${health.className}`;
    healthChip.textContent = health.label;
    healthChip.title = 'Create handoff';
    healthChip.setAttribute('aria-label', `Create handoff for ${displayName}`);
    detailEl.appendChild(healthChip);
  }

  const quietParts = getQuietDetailParts({
    timeLabel: timeStr,
    session,
    includeMetrics: health.state !== 'healthy',
  });
  const worktreeLabel = getWorktreeLabel(session);
  if (worktreeLabel) quietParts.push(worktreeLabel);
  if (typeof getSessionFilePanelSummary === 'function') {
    const fileSummary = getSessionFilePanelSummary(session.sessionId);
    if (fileSummary?.label) {
      quietParts.push(`${fileSummary.type === 'diff' ? 'Diff' : 'File'} ${fileSummary.label}`);
    }
  }
  if (quietParts.length > 0) {
    const quietLine = document.createElement('div');
    quietLine.className = 'session-quiet-details';
    quietLine.textContent = quietParts.join(' · ');
    detailEl.appendChild(quietLine);
  }

  if (session.type === 'terminal') {
    const badge = document.createElement('span');
    badge.className = 'terminal-badge';
    badge.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>';
    summaryEl.prepend(badge);
  }
  info.appendChild(summaryEl);
  if (detailEl.children.length > 0) info.appendChild(detailEl);

  // Action buttons container
  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'session-stop-btn';
  stopBtn.title = 'Stop session';
  stopBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'session-archive-btn';
  archiveBtn.title = session.archived ? 'Unarchive' : 'Archive';
  archiveBtn.innerHTML = ICONS.archive(16);

  const forkBtn = document.createElement('button');
  forkBtn.className = 'session-fork-btn';
  forkBtn.title = 'Fork session';
  forkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3h-5v5"/><path d="M21 3l-7.536 7.536a5 5 0 0 0-1.464 3.534v6.93"/><path d="M3 3l7.536 7.536a5 5 0 0 1 1.464 3.534v.93"/></svg>';

  const jsonlBtn = document.createElement('button');
  jsonlBtn.className = 'session-jsonl-btn';
  jsonlBtn.title = 'View messages';
  jsonlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>';

  const copyIdBtn = document.createElement('button');
  copyIdBtn.className = 'session-copy-id-btn';
  copyIdBtn.title = 'Copy session ID';
  copyIdBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  const assignedGroup = (typeof getGroupForSession === 'function' && typeof groupsState !== 'undefined')
    ? getGroupForSession(groupsState, session.sessionId)
    : null;
  const groupBtn = document.createElement('button');
  groupBtn.className = 'session-group-btn' + (assignedGroup ? ' assigned' : '');
  groupBtn.title = assignedGroup ? `Group: ${assignedGroup.name}` : 'Add to group';
  if (assignedGroup) groupBtn.style.setProperty('--user-group-color', assignedGroup.color);
  groupBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

  const timelineBtn = document.createElement('button');
  timelineBtn.className = 'session-timeline-btn';
  timelineBtn.title = 'View timeline';
  timelineBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="9"/></svg>';

  const launchConfigBtn = document.createElement('button');
  launchConfigBtn.className = 'session-launch-config-btn';
  launchConfigBtn.title = 'Resume with config';
  launchConfigBtn.innerHTML = ICONS.launchConfig(14);

  const handoffBtn = document.createElement('button');
  handoffBtn.className = 'session-handoff-btn';
  handoffBtn.title = 'Create handoff';
  handoffBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/><path d="M5 3h14a2 2 0 0 1 2 2v14l-4-3H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg>';

  actions.appendChild(stopBtn);
  actions.appendChild(copyIdBtn);
  actions.appendChild(groupBtn);
  if (session.type !== 'terminal') {
    if (health.state !== 'healthy') actions.appendChild(handoffBtn);
    actions.appendChild(forkBtn);
    actions.appendChild(timelineBtn);
    actions.appendChild(jsonlBtn);
    actions.appendChild(archiveBtn);
    actions.appendChild(launchConfigBtn);
  }

  row.appendChild(indicators);
  row.appendChild(info);
  row.appendChild(actions);
  item.appendChild(row);

  return item;
}

// Small dialog for creating/editing a group (name + color). Resolves to
// { name, color } or null if cancelled.
function showGroupEditorDialog({ title = 'New Group', name = '', color = '' } = {}) {
  const palette = (typeof GROUP_COLORS !== 'undefined' && GROUP_COLORS) || ['#8088ff'];
  return new Promise(resolve => {
    let selectedColor = color || palette[0];
    let settled = false;

    const overlay = document.createElement('div');
    overlay.className = 'control-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'control-dialog group-editor-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'group-editor-title');

    dialog.innerHTML = `
      <div class="control-dialog-kicker">Session Group</div>
      <h3 id="group-editor-title">${escapeHtml(title)}</h3>
      <input type="text" class="group-editor-name" placeholder="Group name" maxlength="40" />
      <div class="group-editor-swatches" role="group" aria-label="Group color"></div>
      <div class="control-dialog-actions">
        <button type="button" class="control-dialog-cancel">Cancel</button>
        <button type="button" class="control-dialog-confirm">Save</button>
      </div>
    `;

    const input = dialog.querySelector('.group-editor-name');
    input.value = name;
    const swatchesEl = dialog.querySelector('.group-editor-swatches');

    function renderSwatches() {
      swatchesEl.innerHTML = '';
      for (const swatchColor of palette) {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'group-editor-swatch' + (swatchColor === selectedColor ? ' selected' : '');
        swatch.style.background = swatchColor;
        swatch.title = swatchColor;
        swatch.setAttribute('aria-label', `Color ${swatchColor}`);
        swatch.addEventListener('click', () => {
          selectedColor = swatchColor;
          renderSwatches();
        });
        swatchesEl.appendChild(swatch);
      }
    }
    renderSwatches();

    function finish(result) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    }

    function confirm() {
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      finish({ name: value, color: selectedColor });
    }

    function onKey(event) {
      if (event.key === 'Escape') finish(null);
      if (event.key === 'Enter' && document.activeElement === input) confirm();
    }

    dialog.querySelector('.control-dialog-cancel').addEventListener('click', () => finish(null));
    dialog.querySelector('.control-dialog-confirm').addEventListener('click', confirm);
    overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
    document.addEventListener('keydown', onKey);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

// Per-session popover: assign to an existing group, create a new one, or remove.
function showGroupAssignPopover(session, anchorEl) {
  document.querySelectorAll('.group-assign-popover').forEach(el => el.remove());

  const popover = document.createElement('div');
  popover.className = 'new-session-popover group-assign-popover';

  const current = getGroupForSession(groupsState, session.sessionId);

  for (const group of [...groupsState.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const btn = document.createElement('button');
    btn.className = 'popover-option' + (current && current.id === group.id ? ' active' : '');
    const dot = `<span class="group-assign-dot" style="background:${escapeHtml(group.color)}"></span>`;
    btn.innerHTML = `${dot}<span class="group-assign-name">${escapeHtml(group.name)}</span>${current && current.id === group.id ? '<span class="group-assign-check">&#10003;</span>' : ''}`;
    btn.onclick = () => {
      popover.remove();
      assignSessionToGroup(session.sessionId, group.id);
    };
    popover.appendChild(btn);
  }

  const newBtn = document.createElement('button');
  newBtn.className = 'popover-option group-assign-new';
  newBtn.innerHTML = '<span class="group-assign-dot group-assign-dot-new">+</span><span class="group-assign-name">New group…</span>';
  newBtn.onclick = async () => {
    popover.remove();
    const result = await showGroupEditorDialog({ title: 'New Group' });
    if (result) createGroupForSession(session.sessionId, result);
  };
  popover.appendChild(newBtn);

  if (current) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'popover-option group-assign-remove';
    removeBtn.innerHTML = '<span class="group-assign-name">Remove from group</span>';
    removeBtn.onclick = () => {
      popover.remove();
      assignSessionToGroup(session.sessionId, null);
    };
    popover.appendChild(removeBtn);
  }

  positionPopover(popover, anchorEl);
}

// Group header menu: rename, recolor, delete.
function showGroupMenu(groupId, anchorEl) {
  document.querySelectorAll('.group-assign-popover').forEach(el => el.remove());
  const group = groupsState.groups.find(g => g.id === groupId);
  if (!group) return;

  const popover = document.createElement('div');
  popover.className = 'new-session-popover group-assign-popover';

  const editBtn = document.createElement('button');
  editBtn.className = 'popover-option';
  editBtn.innerHTML = '<span class="group-assign-name">Rename / recolor…</span>';
  editBtn.onclick = async () => {
    popover.remove();
    const result = await showGroupEditorDialog({ title: 'Edit Group', name: group.name, color: group.color });
    if (!result) return;
    if (result.name !== group.name) renameUserGroup(groupId, result.name);
    if (result.color !== group.color) recolorUserGroup(groupId, result.color);
  };
  popover.appendChild(editBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'popover-option group-assign-remove';
  deleteBtn.innerHTML = '<span class="group-assign-name">Delete group</span>';
  deleteBtn.onclick = async () => {
    popover.remove();
    const confirmed = await showControlDialog({
      title: 'Delete Group',
      message: 'Sessions in this group return to their project. Session files are not affected.',
      confirmLabel: 'Delete Group',
      tone: 'warning',
      details: { Group: group.name },
    });
    if (confirmed) removeUserGroup(groupId);
  };
  popover.appendChild(deleteBtn);

  positionPopover(popover, anchorEl);
}

function positionPopover(popover, anchorEl) {
  document.body.appendChild(popover);
  const rect = anchorEl.getBoundingClientRect();
  const popoverHeight = popover.offsetHeight;
  if (rect.bottom + 4 + popoverHeight > window.innerHeight) {
    popover.style.top = (rect.top - popoverHeight - 4) + 'px';
  } else {
    popover.style.top = (rect.bottom + 4) + 'px';
  }
  popover.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8)) + 'px';

  function onClickOutside(e) {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.remove();
      document.removeEventListener('mousedown', onClickOutside);
    }
  }
  setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);
}

function startRename(summaryEl, session) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = session.name || session.aiTitle || session.summary;

  summaryEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    const fallback = session.aiTitle || session.summary;
    const nameToSave = (newName && newName !== fallback) ? newName : null;
    await window.api.renameSession(session.sessionId, nameToSave);
    session.name = nameToSave;

    const newSummary = document.createElement('div');
    newSummary.className = 'session-summary';
    newSummary.textContent = nameToSave || fallback;
    newSummary.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(newSummary, session);
    });
    input.replaceWith(newSummary);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.removeEventListener('blur', save);
      const restored = document.createElement('div');
      restored.className = 'session-summary';
      restored.textContent = session.name || session.aiTitle || session.summary;
      restored.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        startRename(restored, session);
      });
      input.replaceWith(restored);
    }
  });
}
