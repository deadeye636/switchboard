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
    // Running-in-inbox config + finish stamps (app.js). Spread last so the inbox
    // filter (session-status.js inboxIncludes) sees the live setting.
    ...attentionInboxRuntimeFields(),
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

// The spring-cleaning dialog moved to shell/spring-cleaning.js (#218) — app.js opens it from the
// toolbar; nothing in this file ever called it.

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

// Apply the active sidebar filters (pinned / running / today) to a session list.
function filterSidebarSessions(sessions) {
  let filtered = sessions;
  // Hide archived sessions unless the archive toggle is on (search deliberately
  // ignores the archive filter). The backend already drops archived sessions from
  // the default project list, but open/pending sessions can be re-injected into the
  // cache client-side (e.g. a just-created "New session" that was then archived),
  // which would otherwise leave them lingering greyed-out in the sidebar/folders.
  if (!showArchived && (typeof searchMatchIds === 'undefined' || searchMatchIds === null)) {
    filtered = filtered.filter(s => !s.archived);
  }
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
  return filtered;
}

// Running/pinned priority then recency — the canonical sidebar session order.
function sortSidebarSessions(sessions) {
  return [...sessions].sort((a, b) => {
    const aRunning = activePtyIds.has(a.sessionId) || pendingSessions.has(a.sessionId);
    const bRunning = activePtyIds.has(b.sessionId) || pendingSessions.has(b.sessionId);
    const aPri = (a.starred && aRunning ? 3 : aRunning ? 2 : a.starred ? 1 : 0);
    const bPri = (b.starred && bRunning ? 3 : bRunning ? 2 : b.starred ? 1 : 0);
    if (aPri !== bPri) return bPri - aPri;
    return new Date(b.modified) - new Date(a.modified);
  });
}

// Process a project's sessions: filter, sort, slug-group, order, and truncate.
// Returns { filtered, visible, older, sortOrderEntry } or null if project should be skipped.
function processProjectSessions(project, resort) {
    let filtered = filterSidebarSessions(project.sessions);
    // Subagents are rendered nested under their parent (or in the orphan
    // section) by buildSessionsList — keep them out of the flat top-level list.
    // While searching, keep them so a subagent match still surfaces as a hit.
    if (typeof searchMatchIds === 'undefined' || searchMatchIds === null) {
      filtered = filtered.filter(s => !s.parentSessionId);
    }
    const anyFilterActive = showStarredOnly || showRunningOnly || showTodayOnly || searchMatchIds !== null;

    filtered = sortSidebarSessions(filtered);

    // Skip a project that has nothing to show. Counted over the top-level sessions
    // only, or a project whose payload is all subagent rows disappears entirely
    // (#173) — see projectHasNothingToRender.
    if (typeof projectHasNothingToRender === 'function' && projectHasNothingToRender({
      filteredCount: filtered.length,
      topLevelCount: project.sessions.filter(s => !s.parentSessionId).length,
      anyFilterActive,
      projectMatchedOnly: !!project._projectMatchedOnly,
    })) return null;

    // Slug grouping
    const slugMap = new Map();
    const ungrouped = [];
    for (const session of filtered) {
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
      // 0 = no limit for either dimension (#144).
      const unlimitedAge = sessionMaxAgeDays === 0;
      const ageCutoff = Date.now() - sessionMaxAgeDays * 86400000;
      for (const item of allItems) {
        const withinCount = visibleSessionCount === 0 || count < visibleSessionCount;
        const withinAge = unlimitedAge || item.sortTime >= ageCutoff;
        if (item.running || item.pinned || (withinCount && withinAge)) {
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
      // Genuinely empty project (no sessions after backend filtering, nothing
      // truncated) with no active filter → keep it as an empty placeholder row.
      emptyPlaceholder: filtered.length === 0 && older.length === 0 && !anyFilterActive,
    })) {
      return null;
    }

    return {
      filtered, visible, older,
      sortOrderEntry: { projectPath: project.projectPath, itemIds: allItems.map(item => item.element.id) },
    };
}

// The subagent tree (the caret, the nested rows, their expanded-state and colours, and the live badge
// hook window._updateSubagentLive) moved to shell/sidebar-subagents.js (#218).

// Build the sessions list DOM (shared between projects and worktrees).
// subagentIndex/projectPath are optional — when provided (and not searching),
// subagents render nested under their parent + an "Orphan subagents" section.
function buildSessionsList(fId, visible, older, subagentIndex, projectPath) {
  const nestSubagents = subagentIndex && (typeof searchMatchIds === 'undefined' || searchMatchIds === null);
  const sessionsList = document.createElement('div');
  sessionsList.className = 'project-sessions';
  sessionsList.id = 'sessions-' + fId;
  for (const item of visible) {
    sessionsList.appendChild(item.element);
    if (nestSubagents) {
      const sid = item.element.dataset && item.element.dataset.sessionId;
      if (sid) appendSubagentChildren(item.element, sid, subagentIndex);
    }
  }
  if (older.length > 0) {
    const moreBtn = document.createElement('div');
    moreBtn.className = 'sessions-more-toggle';
    moreBtn.id = 'older-' + fId;
    moreBtn.textContent = `+ ${older.length} older`;
    const olderList = document.createElement('div');
    olderList.className = 'sessions-older';
    olderList.id = 'older-list-' + fId;
    olderList.style.display = 'none';
    for (const item of older) {
      olderList.appendChild(item.element);
      if (nestSubagents) {
        const sid = item.element.dataset && item.element.dataset.sessionId;
        if (sid) appendSubagentChildren(item.element, sid, subagentIndex);
      }
    }
    sessionsList.appendChild(moreBtn);
    sessionsList.appendChild(olderList);
  }

  // Orphan subagents: children whose parent has no top-level session shown here.
  if (nestSubagents) {
    const topLevelIds = new Set([...visible, ...older]
      .map(i => i.element.dataset && i.element.dataset.sessionId).filter(Boolean));
    const orphans = [];
    for (const [parentId, kids] of subagentIndex) {
      if (!topLevelIds.has(parentId)) orphans.push(...kids);
    }
    if (orphans.length > 0) {
      const orphanStateKey = 'orphanExpanded:' + (projectPath || fId);
      const expanded = localStorage.getItem(orphanStateKey) === '1';
      const orphanGroup = document.createElement('div');
      orphanGroup.className = 'sidebar-orphan-subagents' + (expanded ? '' : ' collapsed');
      const orphanLabel = document.createElement('div');
      orphanLabel.className = 'sidebar-orphan-label';
      orphanLabel.innerHTML = `<span class="orphan-caret">&#9656;</span> Orphan subagents <span class="orphan-count">${orphans.length}</span>`;
      orphanLabel.addEventListener('click', () => {
        const isCollapsed = orphanGroup.classList.toggle('collapsed');
        localStorage.setItem(orphanStateKey, isCollapsed ? '0' : '1');
      });
      orphanGroup.appendChild(orphanLabel);
      for (const orphan of orphans) orphanGroup.appendChild(buildSubagentItem(orphan));
      sessionsList.appendChild(orphanGroup);
    }
  }
  return sessionsList;
}

// Build the project groups (with nested worktrees) into `container`, recording
// each project's item order into `newSortedOrder`.
function appendProjectGroups(container, projects, resort, newSortedOrder, { sortable = false } = {}) {
  const worktreePattern = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;
  const worktreeMap = new Map(); // parentPath → [worktreeProject, ...]
  const worktreeSet = new Set();
  // #17: divider between the favorites block and the rest (favorites pinned on
  // top, not in the favorites-only filter).
  const showFavDivider = sortable
    && !(typeof favoritesOwnList !== 'undefined' && favoritesOwnList)
    && !(typeof showFavoritedProjectsOnly !== 'undefined' && showFavoritedProjectsOnly);
  let sawFavorite = false;
  let dividerDone = false;
  for (const project of projects) {
    const match = project.projectPath.match(worktreePattern);
    if (match) {
      const parentPath = match[1];
      if (!worktreeMap.has(parentPath)) worktreeMap.set(parentPath, []);
      worktreeMap.get(parentPath).push(project);
      worktreeSet.add(project.projectPath);
    }
  }

  for (const project of projects) {
    // Skip worktree projects — they'll be rendered nested under their parent
    if (worktreeSet.has(project.projectPath)) continue;

    // Project-favorites filter: when active, only render favorited projects.
    if (typeof showFavoritedProjectsOnly !== 'undefined' && showFavoritedProjectsOnly && !project.favorited) continue;

    const result = processProjectSessions(project, resort);
    if (!result) continue;
    const { filtered, visible, older, subagentIndex, sortOrderEntry } = result;
    newSortedOrder.push(sortOrderEntry);
    const fId = folderId(project.projectPath);

    // Build DOM
    const group = document.createElement('div');
    group.className = 'project-group' + (project.missing ? ' missing' : '');
    group.id = fId;
    group.dataset.projectPath = project.projectPath;

    const header = document.createElement('div');
    header.className = 'project-header';
    header.id = 'ph-' + fId;
    const shortName = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
    const display = projectDisplayLabel(project.displayName, shortName);
    header.title = project.projectPath;
    const missingIcon = project.missing ? '<span class="project-missing-icon" role="button" tabindex="0" title="Unavailable — click to re-check (e.g. after mounting the drive)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span> ' : '';
    header.innerHTML = `<span class="arrow">&#9660;</span> ${missingIcon}<span class="project-name">${escapeHtml(display)}</span>`;
    if (sortable) {
      const dragHandle = document.createElement('span');
      dragHandle.className = 'project-drag-handle';
      dragHandle.textContent = '⡀'; // ⠀-style grip (⠿)
      dragHandle.innerHTML = '<svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor"><circle cx="3.5" cy="3" r="1.3"/><circle cx="8.5" cy="3" r="1.3"/><circle cx="3.5" cy="7" r="1.3"/><circle cx="8.5" cy="7" r="1.3"/><circle cx="3.5" cy="11" r="1.3"/><circle cx="8.5" cy="11" r="1.3"/></svg>';
      dragHandle.title = 'Reorder (manual sort)';
      header.insertBefore(dragHandle, header.firstChild);
    }

    const tasksBtn = document.createElement('button');
    tasksBtn.className = 'project-tasks-btn';
    tasksBtn.title = 'Tasks & notes';
    tasksBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
    if (window.tasksView && typeof window.tasksView.projectTaskCount === 'function'
        && window.tasksView.projectTaskCount(project.projectPath) > 0) {
      tasksBtn.classList.add('has-tasks');
      tasksBtn.title = 'Tasks & notes — open tasks';
    }
    header.appendChild(tasksBtn);

    const bookmarksBtn = document.createElement('button');
    bookmarksBtn.className = 'project-bookmarks-btn';
    bookmarksBtn.title = 'Bookmarks';
    bookmarksBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
    if (window.bookmarksView && typeof window.bookmarksView.projectBookmarkCount === 'function'
        && window.bookmarksView.projectBookmarkCount(project.projectPath) > 0) {
      bookmarksBtn.classList.add('has-bookmarks');
      bookmarksBtn.title = 'Bookmarks — this project has bookmarks';
    }
    header.appendChild(bookmarksBtn);

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

    const favoriteBtn = document.createElement('button');
    favoriteBtn.className = 'project-favorite-btn' + (project.favorited ? ' favorited' : '');
    favoriteBtn.title = project.favorited ? 'Remove project from favorites' : 'Mark project as favorite';
    favoriteBtn.innerHTML = project.favorited
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
    // Favorit-Button vor den Projektnamen (links), nicht in die rechte Button-Leiste.
    header.insertBefore(favoriteBtn, header.querySelector('.project-name'));

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

    const sessionsList = buildSessionsList(fId, visible, older, buildSubagentIndex(project.sessions), project.projectPath);

    // Explicit user collapse/expand (persisted) overrides the age heuristic, so the
    // "last state" startup default remembers project headers. Falls back to the
    // heuristic only when the user never toggled this project.
    const explicitCollapsed = getProjectCollapseState()[project.projectPath];
    if (explicitCollapsed === true) {
      header.classList.add('collapsed');
    } else if (explicitCollapsed === false) {
      // user explicitly expanded → leave open, skip heuristic
    } else if (project.missing) {
      header.classList.add('collapsed');
    } else if (project._projectMatchedOnly) {
      header.classList.add('collapsed');
    } else if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
      const mostRecent = filtered[0]?.modified;
      if (sessionMaxAgeDays > 0 && mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
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

      const wtDeleteBtn = document.createElement('button');
      wtDeleteBtn.className = 'worktree-delete-btn';
      wtDeleteBtn.title = 'Delete worktree from disk';
      wtDeleteBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
      wtHeader.appendChild(wtDeleteBtn);

      const wtNewBtn = document.createElement('button');
      wtNewBtn.className = 'project-new-btn worktree-new-btn';
      wtNewBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
      wtNewBtn.title = 'New session in worktree';
      wtHeader.appendChild(wtNewBtn);

      const wtSessionsList = buildSessionsList(wtFId, wtResult.visible, wtResult.older, buildSubagentIndex(wt.sessions), wt.projectPath);
      wtSessionsList.className = 'worktree-sessions';

      // Auto-collapse worktree if stale
      if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
        const mostRecent = wtResult.filtered[0]?.modified;
        if (sessionMaxAgeDays > 0 && mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
          wtHeader.classList.add('collapsed');
        }
      }

      wtGroup.appendChild(wtHeader);
      wtGroup.appendChild(wtSessionsList);
      sessionsList.appendChild(wtGroup);
    }

    if (showFavDivider) {
      if (project.favorited) {
        sawFavorite = true;
      } else if (sawFavorite && !dividerDone) {
        const divider = document.createElement('div');
        divider.className = 'project-favorites-divider';
        divider.textContent = 'More projects';
        container.appendChild(divider);
        dividerDone = true;
      }
    }
    container.appendChild(group);
  }
}

// Shared morphdom commit: re-apply active state, diff into the live sidebar
// (preserving collapse/expand state), persist sort order, rebind, restore focus.
function finalizeSidebar(newSidebar, projects, newSortedOrder) {
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
      if (fromEl.classList.contains('slug-group') || fromEl.classList.contains('worktree-header')) {
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
  // Don't steal focus from a control the user tabbed to inside the sidebar
  // (buttons, headers via makeButtonLike) — re-focusing the terminal on every
  // status-tick re-render breaks keyboard navigation / a11y (issue #78).
  const sidebarFocused = ae && ae.closest && ae.closest('#sidebar');
  if (activeSessionId && openSessions.has(activeSessionId) && !isUserTyping && !sidebarFocused) {
    openSessions.get(activeSessionId).terminal.focus();
  }
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

  // #17: apply the chosen project sort (favorites pin + activity/alpha/manual).
  if (typeof sortProjects === 'function') {
    projects = sortProjects(projects, { favoritesOwnList, projectSortMode, projectOrder });
  }
  sidebarContent.classList.toggle('sort-manual', typeof projectSortMode !== 'undefined' && projectSortMode === 'manual');

  const newSortedOrder = [];
  appendProjectGroups(newSidebar, projects, resort, newSortedOrder, { sortable: true });
  finalizeSidebar(newSidebar, projects, newSortedOrder);
}

// --- In-place status patching (#80) ---
// Busy/idle/attention edges fire refreshSessionStatusViews for every session's
// activity; rebuilding the whole sidebar (buildSessionItem for every session +
// morphdom + rebind) per edge is constant load with many sessions. Patch the
// status-driven bits of the already-rendered DOM instead. Structural changes
// (sessions added/removed, renames, sort, filters) still use refreshSidebar().
// Returns false when a full rebuild is required (caller falls back).
const SESSION_STATUS_CLASSES = ['status-needs-attention', 'status-response-ready',
  'status-busy', 'status-running', 'status-exited', 'status-idle'];

function patchSidebarStatuses() {
  if (!sidebarContent || !sidebarContent.querySelector('.session-item')) return false;
  // The running filter changes list membership on status edges — needs a rebuild.
  if (showRunningOnly) return false;
  const runtime = getSessionRuntimeState();
  // The attention inbox isn't patched here (only session-item chips are). If its
  // membership changed on this status edge, bail to the full refreshSidebar so the
  // inbox is rebuilt AND re-wired — otherwise items linger after being opened or
  // never appear in the timed modes (#92).
  if (typeof getAttentionInboxItems === 'function' && typeof cachedProjects !== 'undefined') {
    const want = getAttentionInboxItems(getAllRenderableSessions(cachedProjects), runtime)
      .slice(0, 8).map(i => i.session.sessionId).join(',');
    const have = Array.from(sidebarContent.querySelectorAll('.attention-inbox-item'))
      .map(el => el.dataset.sessionId).join(',');
    if (want !== have) return false;
  }
  for (const item of sidebarContent.querySelectorAll('.session-item[data-session-id]')) {
    const sid = item.dataset.sessionId;
    item.classList.toggle('has-running-pty', activePtyIds.has(sid));
    item.classList.toggle('needs-attention', attentionSessions.has(sid));
    item.classList.toggle('response-ready', responseReadySessions.has(sid));
    item.classList.toggle('cli-busy', !!sessionBusyState.get(sid));
    // Subagent-activity overlay (#112): parent keeps its status, dot goes two-color.
    item.classList.toggle('subagent-active', subagentActiveSessions.has(sid));
    const dot = item.querySelector('.session-status-dot');
    if (dot) dot.classList.toggle('running', activePtyIds.has(sid));
    const session = sessionMap.get(sid);
    if (!session || item.dataset.subagent) continue; // subagent rows carry no status chip
    const status = getSessionStatus(session, runtime);
    if (!item.classList.contains(status.className)) {
      item.classList.remove(...SESSION_STATUS_CLASSES);
      item.classList.add(status.className);
      const chip = item.querySelector('.session-status-chip');
      if (chip) {
        chip.className = `session-detail-pill session-status-chip ${status.className}`;
        chip.textContent = status.label;
      }
    }
  }
  for (const group of sidebarContent.querySelectorAll('.slug-group')) {
    const dot = group.querySelector('.slug-group-dot');
    if (dot) dot.classList.toggle('running', !!group.querySelector('.session-item.has-running-pty'));
  }
  return true;
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
    item.onclick = () => focusAttentionItem({ session });
  });

  for (const project of projects) {
    const fId = folderId(project.projectPath);
    const header = document.getElementById('ph-' + fId);
    if (!header) continue;
    const dragHandle = header.querySelector('.project-drag-handle');
    if (dragHandle) {
      dragHandle.onpointerdown = (e) => { e.stopPropagation(); startProjectDrag(project, header, e); };
    }
    const newBtn = header.querySelector('.project-new-btn');
    if (newBtn) {
      newBtn.onclick = (e) => { e.stopPropagation(); showNewSessionPopover(project, newBtn); };
    }
    const tasksBtn = header.querySelector('.project-tasks-btn');
    if (tasksBtn) {
      tasksBtn.onclick = (e) => {
        e.stopPropagation();
        if (typeof openTasksView === 'function') {
          const shortName = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
          openTasksView({ projectPath: project.projectPath },
            'Project · ' + projectDisplayLabel(project.displayName, shortName));
        }
      };
    }
    const bookmarksBtn = header.querySelector('.project-bookmarks-btn');
    if (bookmarksBtn) {
      bookmarksBtn.onclick = (e) => {
        e.stopPropagation();
        if (typeof openBookmarksView === 'function') {
          const shortName = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
          openBookmarksView({ projectPath: project.projectPath },
            'Project · ' + projectDisplayLabel(project.displayName, shortName));
        }
      };
    }
    const scheduleBtn = header.querySelector('.project-schedule-btn');
    if (scheduleBtn) {
      scheduleBtn.onclick = (e) => { e.stopPropagation(); launchScheduleCreator(project); };
    }
    const settingsBtn = header.querySelector('.project-settings-btn');
    if (settingsBtn) {
      settingsBtn.onclick = (e) => { e.stopPropagation(); openSettingsViewer('project', project.projectPath); };
    }
    const favoriteBtn = header.querySelector('.project-favorite-btn');
    if (favoriteBtn) {
      favoriteBtn.onclick = async (e) => {
        e.stopPropagation();
        const { favorited } = await window.api.toggleProjectFavorite(project.projectPath);
        const fav = !!favorited;
        // Update the flag in both cached lists so either view re-sorts correctly,
        // then a light re-render — not a full loadProjects() (2× getProjects IPC),
        // matching the session-pin path (issue #78).
        for (const list of [cachedProjects, cachedAllProjects]) {
          const p = list && list.find(x => x.projectPath === project.projectPath);
          if (p) p.favorited = fav;
        }
        refreshSidebar({ resort: true });
      };
    }
    const missingIcon = header.querySelector('.project-missing-icon');
    if (missingIcon) {
      // Force an availability re-check: the project-list rebuild re-evaluates path
      // existence, so a drive mounted after startup (e.g. an encrypted volume) flips
      // from missing to available without waiting for an unrelated refresh.
      const recheck = (e) => { e.stopPropagation(); loadProjects(); };
      missingIcon.onclick = recheck;
      missingIcon.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); recheck(e); }
      };
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
            window._markUserStopped?.(s.sessionId);
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
      if (e.target.closest('.project-new-btn') || e.target.closest('.project-archive-btn') || e.target.closest('.project-settings-btn') || e.target.closest('.project-tasks-btn') || e.target.closest('.project-bookmarks-btn') || e.target.closest('.project-schedule-btn') || e.target.closest('.project-remap-btn') || e.target.closest('.project-favorite-btn') || e.target.closest('.project-missing-icon')) return;
      header.classList.toggle('collapsed');
      setProjectCollapsed(project.projectPath, header.classList.contains('collapsed'));
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
        // The dialog says "Hide", so it hides (#167). It used to call removeProject — which, back when
        // hiding and removing were the same act, was the only thing it could do.
        await window.api.hideProject(wtProject.projectPath);
        loadProjects();
      };
    }
    const wtDeleteBtn = wtHeader.querySelector('.worktree-delete-btn');
    if (wtDeleteBtn) {
      wtDeleteBtn.onclick = async (e) => {
        e.stopPropagation();
        const name = wtProject.projectPath.split('/').pop();
        const confirmed = await showDeleteWorktreeDialog(name, wtProject.projectPath);
        if (!confirmed) return;
        const result = await window.api.deleteWorktree(wtProject.projectPath);
        if (result && result.ok) {
          loadProjects();
        } else {
          const msg = (result && result.error) ? result.error : 'Unknown error';
          showControlMessage({ title: 'Delete worktree failed', message: msg, tone: 'danger' });
        }
      };
    }
    const toggleWorktree = (e) => {
      if (e.target.closest('.worktree-new-btn') || e.target.closest('.worktree-hide-btn') || e.target.closest('.worktree-delete-btn')) return;
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
          if (activePtyIds.has(sid)) { window._markUserStopped?.(sid); await window.api.stopSession(sid); }
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
      // Subagents are ephemeral child runs — open the dedicated read-only
      // subagent transcript (reads via readSubagentJsonl(parent, agentId), the
      // correct on-disk path) instead of resuming a PTY or reading a synthetic id.
      if (session.parentSessionId) { if (typeof showSubagentTranscript === 'function') showSubagentTranscript(session); return; }
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

    const tagsBtn = item.querySelector('.session-tags-btn');
    if (tagsBtn) {
      tagsBtn.onclick = (e) => {
        e.stopPropagation();
        window.bookmarksTags?.openTagPicker(session, tagsBtn);
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
          window._markUserStopped?.(session.sessionId);
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
  // Subagent-activity overlay (#112): two-color dot while a subagent works here.
  if (subagentActiveSessions.has(session.sessionId)) item.classList.add('subagent-active');
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

  // Provider badge (T-3.4). Deliberately OFF for a single-backend user: badging every row when they all
  // came from the same CLI would be pure noise. It appears in "mixed mode" — ≥2 backends are in play
  // (computeShowAllBadges) — and on any individual row that is not the default, so a session can never be
  // mistaken for one of the default backend's. That second half needs a KNOWN default; see below.
  if (session.type !== 'terminal' && window.sessionBackendId) {
    const backendId = window.sessionBackendId(session);
    // The badge means "this row is NOT the one you would assume". That claim needs a default to compare
    // against, and `_defaultBackendId` is '' until the registry answers — and stays '' when nothing is
    // launchable at all (#225). With no default there is no assumption to correct, so the claim is not
    // made and `_showAllBadges` decides alone (it has its own registry-less fallback: what the sessions
    // themselves say). Writing `|| 'claude'` here, as this did, asserted the assumption instead of
    // checking it — on an install where Claude is switched off, every row was measured against a backend
    // the user does not run.
    const knownDefault = window._defaultBackendId;
    const isNonDefault = !!knownDefault && backendId !== knownDefault;
    if (window._showAllBadges || isNonDefault) {
      const descriptor = window.getBackend ? window.getBackend(backendId) : null;
      const badge = document.createElement('span');
      badge.className = 'session-backend-badge backend-' + backendId;
      badge.textContent = (descriptor && descriptor.monogram)
        || (window.backendMonogram ? window.backendMonogram(backendId) : backendId.slice(0, 2));
      badge.title = descriptor ? descriptor.label : backendId;
      if (window.backendIconColour) badge.style.background = window.backendIconColour(descriptor?.icon || backendId);
      indicators.appendChild(badge);
    }
  }

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
  // Open-task badge — count of open/in-progress tasks anchored to this session.
  const openTaskCount = (window.tasksView && typeof window.tasksView.openTaskCount === 'function')
    ? window.tasksView.openTaskCount(session.sessionId) : 0;
  if (openTaskCount > 0) {
    const taskChip = document.createElement('button');
    taskChip.type = 'button';
    taskChip.className = 'session-detail-pill session-task-chip';
    taskChip.textContent = `${openTaskCount} ${openTaskCount === 1 ? 'Task' : 'Tasks'}`;
    taskChip.title = 'Open tasks for this session';
    taskChip.setAttribute('aria-label', `${openTaskCount} open tasks for ${displayName || session.sessionId}`);
    taskChip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof openTasksView === 'function') {
        openTasksView({ sessionId: session.sessionId }, 'Session · ' + (displayName || session.sessionId));
      }
    });
    detailEl.appendChild(taskChip);
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

  const tagsBtn = document.createElement('button');
  tagsBtn.className = 'session-tags-btn';
  tagsBtn.title = 'Edit tags';
  tagsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.2" fill="currentColor" stroke="none"/></svg>';

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
  // Tags hang on the sessionId, which a terminal row has too — so this sits with the other
  // labelling actions, above the guard, not with the ones that open a transcript.
  actions.appendChild(tagsBtn);
  if (session.type !== 'terminal') {
    // Always offered. It used to appear only once the session was judged unhealthy, which meant you
    // discovered the feature the day the app started nagging you — and could not reach it at the moment
    // it is worth most: deliberately handing over at a clean breakpoint, before a session gets expensive.
    // The RECOMMENDATION still shows, as emphasis on the button (and in the health chip beside it); the
    // button's existence was never the signal.
    if (health.state !== 'healthy') handoffBtn.classList.add('recommended');
    handoffBtn.title = health.state !== 'healthy'
      ? `Create handoff — ${health.label}`
      : 'Create handoff';
    actions.appendChild(handoffBtn);

    // Only offer Fork where the backend can actually do it. Offering it anyway does NOT degrade into
    // "nothing happens" — it launches a fresh, empty session that has no relation to the one the user
    // forked, which is worse than not offering it at all.
    // `getBackend` and `sessionBackendId` live in the same file, so the second guard only fires if the
    // registry is missing — and then `getBackend` is gone too and this is already null. Naming Claude
    // there decided Fork's visibility from a backend the session may not be (#225).
    const sessionBackend = typeof getBackend === 'function'
      ? getBackend(typeof sessionBackendId === 'function' ? sessionBackendId(session) : '')
      : null;
    // A profile runs the claude binary, so it forks like Claude. An unknown backend (a row from a
    // backend that is no longer registered) is assumed not to fork.
    const canFork = sessionBackend
      ? (sessionBackend.isProfile ? true : sessionBackend.supportsFork === true)
      : false;
    if (canFork) actions.appendChild(forkBtn);
    actions.appendChild(timelineBtn);
    actions.appendChild(jsonlBtn);
    // "Resume with config" sits next to the other session-starting actions; Archive is the odd one out
    // (it removes the row), so it goes last, away from the buttons that launch something.
    actions.appendChild(launchConfigBtn);
    actions.appendChild(archiveBtn);
  }

  row.appendChild(indicators);
  row.appendChild(info);
  row.appendChild(actions);
  item.appendChild(row);

  // Tag chips (renders synchronously from the bookmarks-tags cache).
  window._decorateSessionItem?.(item, session);

  return item;
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
  // Stop key events from bubbling to the row's makeButtonLike handler / global
  // shortcuts — otherwise Space (which activates a button-like element on keyUP)
  // ends the rename instead of inserting a space (issue #94).
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
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
  input.addEventListener('keyup', (e) => e.stopPropagation());
}

// Generic pointer-drag scaffold behind the manual project reorder (#79): threshold-gated begin, cursor ghost, elementFromPoint
// drop-target tracking with a highlight class, listener cleanup. Variant
// behavior comes from opts:
//   dragEl                  — element that gets .dragging while a drag is live
//   ghostLabel              — text for the cursor ghost
//   findDropTarget(el,x,y)  — hit-test the element under the pointer; return
//                             { el, cls } to highlight or null
//   onDrop(targetEl, targetCls, ev) — called after a real drag ended (targetEl
//                             may be null when released outside any target;
//                             targetCls is the highlight class it carried,
//                             already removed by cleanup at this point)
function startPointerDrag(e, opts) {
  const startX = e.clientX, startY = e.clientY;
  let dragging = false, ghost = null, dropEl = null, dropCls = null;

  const clearDropTarget = () => {
    if (dropEl) { dropEl.classList.remove(dropCls); dropEl = null; dropCls = null; }
  };
  const beginDrag = () => {
    dragging = true;
    document.body.classList.add('sidebar-session-dragging');
    opts.dragEl.classList.add('dragging');
    ghost = document.createElement('div');
    ghost.className = 'sidebar-drag-ghost';
    ghost.textContent = opts.ghostLabel;
    document.body.appendChild(ghost);
  };
  const moveGhost = (x, y) => {
    if (ghost) {
      ghost.style.left = (x + 12) + 'px';
      ghost.style.top = (y + 12) + 'px';
    }
  };
  const updateDropTarget = (x, y) => {
    const hit = opts.findDropTarget(document.elementFromPoint(x, y), x, y);
    if (hit && hit.el === dropEl && hit.cls === dropCls) return;
    clearDropTarget();
    if (hit) { dropEl = hit.el; dropCls = hit.cls; dropEl.classList.add(dropCls); }
  };
  const onMove = (ev) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      beginDrag();
    }
    moveGhost(ev.clientX, ev.clientY);
    updateDropTarget(ev.clientX, ev.clientY);
  };
  const cleanup = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.body.classList.remove('sidebar-session-dragging');
    opts.dragEl.classList.remove('dragging');
    if (ghost) { ghost.remove(); ghost = null; }
    clearDropTarget();
  };
  const onUp = (ev) => {
    const didDrag = dragging;
    const target = dropEl;
    const targetCls = dropCls;
    cleanup();
    if (didDrag) opts.onDrop(target, targetCls, ev);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

// #17: manual reorder of project headers (drag from the grip handle). Only active
// in manual sort mode. On drop, persists the new full project order and re-renders;
// the favorites/rest partitioning is re-applied by sortProjects on the next render.
function startProjectDrag(project, header, e) {
  if (e.button !== 0) return;
  if (typeof projectSortMode === 'undefined' || projectSortMode !== 'manual') return;
  const group = header.closest('.project-group');
  if (!group) return;
  const container = group.parentElement;
  if (!container) return;

  startPointerDrag(e, {
    dragEl: group,
    ghostLabel: header.querySelector('.project-name')?.textContent || 'Project',
    findDropTarget: (el, _x, y) => {
      const g = el && el.closest ? el.closest('.project-group') : null;
      if (!g || g === group || g.parentElement !== container) return null;
      const r = g.getBoundingClientRect();
      const dropAfter = (y - r.top) > r.height / 2;
      return { el: g, cls: dropAfter ? 'drop-target-after' : 'drop-target-before' };
    },
    onDrop: (target, targetCls) => {
      if (!target) return;
      // The highlight class encodes the drop half (recomputed on every move).
      const after = targetCls === 'drop-target-after';
      if (after) target.after(group); else target.before(group);
      const order = Array.from(container.querySelectorAll('.project-group'))
        .map(g => g.dataset.projectPath)
        .filter(Boolean);
      if (typeof window._persistProjectOrder === 'function') window._persistProjectOrder(order);
      if (typeof refreshSidebar === 'function') refreshSidebar({ resort: true });
    },
  });
}

// --- Delete worktree confirmation dialog ---
// Returns a Promise<boolean> — true if the user confirmed deletion.
async function showDeleteWorktreeDialog(name, worktreePath) {
  // Fetch worktree status (dirty files) while the dialog is shown
  const statusPromise = window.api.worktreeStatus(worktreePath);

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'new-session-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'new-session-dialog delete-worktree-dialog';

    dialog.innerHTML = `
      <h3>Delete worktree "${escapeHtml(name)}"?</h3>
      <div class="delete-worktree-warning">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>Any uncommitted changes in this worktree will be permanently lost.</span>
      </div>
      <div class="delete-worktree-status" id="dwt-status">
        <span class="dwt-loading">Checking worktree status…</span>
      </div>
      <div class="new-session-actions">
        <button class="new-session-cancel-btn" id="dwt-cancel">Cancel</button>
        <button class="delete-worktree-confirm-btn" id="dwt-confirm">Delete anyway</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const statusEl = dialog.querySelector('#dwt-status');

    // Populate status once the IPC resolves
    statusPromise.then((status) => {
      if (!overlay.isConnected) return; // dialog already closed
      if (!status || !status.ok) {
        const errMsg = (status && status.error) ? escapeHtml(status.error) : 'Unknown error';
        statusEl.innerHTML = `<span class="dwt-error">Unable to read worktree status: ${errMsg}</span>`;
        return;
      }
      if (status.total === 0) {
        statusEl.innerHTML = `<span class="dwt-clean">Worktree is clean — no uncommitted changes.</span>`;
        return;
      }
      const shown = status.dirty.slice(0, 10);
      const overflow = status.total - shown.length;
      const lines = shown.map(l => escapeHtml(l)).join('\n');
      const extra = overflow > 0 ? `\n+ ${overflow} more…` : '';
      statusEl.innerHTML = `<div class="dwt-dirty-label">${status.total} uncommitted file${status.total !== 1 ? 's' : ''}:</div><pre class="dwt-dirty-list">${lines}${extra}</pre>`;
    }).catch((err) => {
      if (!overlay.isConnected) return;
      statusEl.innerHTML = `<span class="dwt-error">Unable to read worktree status: ${escapeHtml(String(err))}</span>`;
    });

    function close(confirmed) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(confirmed);
    }

    dialog.querySelector('#dwt-cancel').onclick = () => close(false);
    dialog.querySelector('#dwt-confirm').onclick = () => close(true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

    function onKey(e) {
      if (e.key === 'Escape') close(false);
    }
    document.addEventListener('keydown', onKey);
  });
}
