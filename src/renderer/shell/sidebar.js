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

// The one runtime snapshot builder lives in app.js (window.sessionRuntimeState, #260). This name is
// what the sidebar row + tabs call; keep it as a thin delegate so those callers are untouched.
function getSessionRuntimeState() {
  return window.sessionRuntimeState();
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
  ariaButton(header, `Toggle ${displayName}`); // click/keyboard delegated in sidebar-events.js (#218 opt6)

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
      ariaButton(moreBtn, moreBtn.textContent); // click/keyboard delegated (#218 opt6)

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
      // #193 (Model A): an idle lineage ancestor folds under its descendant's thread expander instead of
      // showing as its own row. While searching, keep everything so a match still surfaces.
      if (typeof foldedAncestorIds === 'function') {
        const folded = foldedAncestorIds(filtered);
        if (folded.size) filtered = filtered.filter(s => !folded.has(s.sessionId));
      }
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
// knownSessionIds carries the project's full, unfiltered id set so the orphan section can tell a
// parent that is GONE from one that is merely filtered away (#247).
function buildSessionsList(fId, visible, older, subagentIndex, projectPath, knownSessionIds) {
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
    // Same ▶/▼ caret as the subagent tree and the lineage thread (#193) — three expanders in one
    // list should not be three shapes. The count is stamped here and never recounted from the DOM:
    // appendSubagentChildren drops carets and containers into this very list as siblings, so
    // `children.length` is sessions + carets + containers (#249).
    const moreBtn = document.createElement('div');
    moreBtn.className = 'sidebar-children-caret sessions-more-toggle';
    moreBtn.id = 'older-' + fId;
    moreBtn.dataset.olderCount = String(older.length);
    moreBtn.innerHTML = `<span class="caret-arrow">&#9654;</span> ${older.length} older`;
    moreBtn.setAttribute('aria-expanded', 'false');
    ariaButton(moreBtn, `${older.length} older sessions`); // click/keyboard delegated in sidebar-events.js (#218 opt6)
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
  // Gated on showSubagentsOn (#231) too — the nested path (appendSubagentChildren) is not the only one
  // that renders subagent rows, so hiding subagents must cover the orphan group as well.
  if (nestSubagents && (typeof showSubagentsOn !== 'function' || showSubagentsOn())) {
    const topLevelIds = new Set([...visible, ...older]
      .map(i => i.element.dataset && i.element.dataset.sessionId).filter(Boolean));
    // Who belongs here and who is too old for it lives in sidebar-state.js (#247/#248) — the same
    // place the other "does this even render" decisions do, and the only one of them that is tested.
    const shown = orphanSubagents({
      subagentIndex,
      renderedParentIds: topLevelIds,
      knownSessionIds,
      maxAgeDays: typeof orphanSubagentMaxAgeDays === 'function' ? orphanSubagentMaxAgeDays() : 0,
      now: Date.now(),
    });
    if (shown.length > 0) {
      const orphanStateKey = 'orphanExpanded:' + (projectPath || fId);
      const expanded = localStorage.getItem(orphanStateKey) === '1';
      const orphanGroup = document.createElement('div');
      orphanGroup.className = 'sidebar-orphan-subagents' + (expanded ? '' : ' collapsed');
      const orphanLabel = document.createElement('div');
      orphanLabel.className = 'sidebar-orphan-label';
      orphanLabel.innerHTML = `<span class="orphan-caret">&#9656;</span> Orphan subagents <span class="orphan-count">${shown.length}</span>`;
      orphanLabel.addEventListener('click', () => {
        const isCollapsed = orphanGroup.classList.toggle('collapsed');
        localStorage.setItem(orphanStateKey, isCollapsed ? '0' : '1');
      });
      orphanGroup.appendChild(orphanLabel);
      for (const orphan of shown) orphanGroup.appendChild(buildSubagentItem(orphan));
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
    ariaButton(header, `Toggle ${shortName} sessions`); // click/keyboard delegated in sidebar-events.js (#218 opt6)
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

    const sessionsList = buildSessionsList(fId, visible, older, buildSubagentIndex(project.sessions), project.projectPath, buildKnownSessionIds(project.sessions));

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
      wtGroup.dataset.projectPath = wt.projectPath; // lets the delegated listener resolve the worktree (#218 opt6)

      const wtHeader = document.createElement('div');
      wtHeader.className = 'worktree-header';
      wtHeader.id = 'ph-' + wtFId;
      wtHeader.innerHTML = `<span class="worktree-branch-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4"/><path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3"/><path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35"/><path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14"/></svg></span> <span class="worktree-name">${escapeHtml(wtName)}</span>`;
      ariaButton(wtHeader, `Toggle ${wtName} worktree sessions`); // click/keyboard delegated (#218 opt6)

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

      const wtSessionsList = buildSessionsList(wtFId, wtResult.visible, wtResult.older, buildSubagentIndex(wt.sessions), wt.projectPath, buildKnownSessionIds(wt.sessions));
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
        // Only the open/closed state carries over — the label is the same in both states now, and
        // rewriting it here is what used to plant "- hide older" on a rebuilt node.
        toEl.classList.add('expanded');
        toEl.setAttribute('aria-expanded', 'true');
      }
      if (fromEl.classList.contains('slug-group-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      // #229: the lineage thread is built collapsed (sidebar-lineage.js sets display:none), so without
      // this a re-render folds an expanded thread back up — the sidebar re-renders on every store
      // event, so it closed itself while the user was reading it.
      if (fromEl.classList.contains('session-lineage-ancestors') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('session-lineage-toggle') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
        toEl.setAttribute('aria-expanded', 'true');
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

// The click wiring (rebindSidebarEvents), the drag scaffold it uses and the worktree-delete dialog
// moved to shell/sidebar-events.js (#218). finalizeSidebar calls it after every morphdom patch.
//
// The session row itself (buildSessionItem), its inline rename and positionPopover moved to
// shell/sidebar-session-row.js (#218). buildSessionsList above calls it.
