// --- Sidebar events: one delegated listener for every click on a row, a header or a chip (#218) ---
//
// The sidebar re-renders through `morphdom(sidebarContent, …)` (finalizeSidebar), which patches the tree
// IN PLACE — old nodes' handlers go with them. The previous version answered that by re-binding every
// handler on every render: one `.onclick =` per row, per button, per header, ~30 kinds across N sessions,
// each pass. This version binds ONCE. `sidebarContent` is the morphdom ROOT — it is never replaced, only
// its children are diffed — so a listener on it survives every patch. `rebindSidebarEvents` no longer
// wires handlers; it records the current project list and runs the few per-render DOM decorations that are
// state, not events (the missing-project "can't open" marker, the title→aria sync, the active-slug
// auto-expand). The button SEMANTICS (role/tabindex/aria-label) moved into the builders (sidebar.js,
// sidebar-session-row.js) via `ariaButton`, where morphdom keeps them; the ACTIVATION is delegated here.
//
// HOW A CLICK IS ROUTED — `dispatchSidebarActivation` walks `e.target.closest(...)` most-specific first and
// returns on the first match, so an action button is handled before the row-open it sits inside; the old
// per-handler `stopPropagation()` (which kept a button click off the row's own handler) is preserved on the
// branches that had it, now as one call at the container so nothing above sidebarContent sees it either.
// Context is resolved from the DOM, not a closure: the session from `.session-item[data-session-id]` via
// sessionMap, the project (or worktree) from the nearest `.worktree-group`/`.project-group`'s
// `data-project-path` looked up in the render's project list (`sidebarProjects`). The worktree group is the
// INNER container, so it wins for a worktree button — which is why `.project-new-btn` inside a worktree
// header resolves to the worktree without a separate branch.
//
// KEYBOARD — a real <button> already synthesizes a click on Enter/Space, so the delegated click covers it;
// the keyboard listener only activates the button-like DIVs/SPANs (`role="button"`, not a <button>), and
// runs them through the same dispatch via `handleKeyboardActivation` (Enter on keydown, Space on keyup).
//
// A classic <script>, like the file it came from: nothing runs at parse time. It reaches back into
// sidebar.js (getAllRenderableSessions, getSessionRuntimeState, folderId, refreshSidebar's callers), into
// app.js's session maps and caches, out to the dialogs — all at click time.
//
// It WRITES fields on objects other files own (`session.archived`, `session.starred`, `session.name` on
// app.js's sessionMap rows; `p.favorited` on cachedProjects). Those are field writes on shared objects,
// not rebindings of another file's `let`, so they cross a file boundary without caring about it. The one
// that DOES rebind — `sortedOrder = newSortedOrder` — stayed in sidebar.js with finalizeSidebar.

// The render's project list, kept for click-time context resolution. Set by rebindSidebarEvents on every
// render; read by the delegated handlers, which run later, on a click.
let sidebarProjects = [];
// The delegated listeners are attached to sidebarContent exactly once (it outlives every morphdom patch).
let sidebarEventsDelegated = false;

function rebindSidebarEvents(projects) {
  sidebarProjects = projects;
  ensureSidebarDelegation();

  // Sessions under a missing project can't be opened — the path no longer exists. This is DOM state
  // (a class + a title), not an event, so it is applied per render; the open dispatch also bails on it.
  sidebarContent.querySelectorAll('.project-group.missing .session-item').forEach(item => {
    item.classList.add('disabled');
    item.title = 'Project path no longer exists — use "Change path" to fix';
    // Not an actionable button — the old code left missing rows without role/tabindex/aria (it never ran
    // makeButtonLike on them), so strip what the builder set unconditionally.
    item.removeAttribute('role');
    item.removeAttribute('tabindex');
    item.removeAttribute('aria-label');
  });

  syncTitleToAriaLabel(sidebarContent);
  syncTitleToTooltip(sidebarContent);

  // Auto-expand a slug group that holds the active session, so the selection is never hidden in a
  // collapsed group after a re-render.
  if (activeSessionId) {
    const activeItem = sidebarContent.querySelector(`[data-session-id="${activeSessionId}"]`);
    const collapsedGroup = activeItem?.closest('.slug-group.collapsed');
    if (collapsedGroup) {
      collapsedGroup.classList.remove('collapsed');
      saveExpandedSlugs();
    }
  }
}

// Attach the delegated listeners once. sidebarContent is the morphdom root, so these outlive every patch.
function ensureSidebarDelegation() {
  if (sidebarEventsDelegated || !sidebarContent) return;
  sidebarEventsDelegated = true;
  sidebarContent.addEventListener('click', dispatchSidebarActivation);
  sidebarContent.addEventListener('dblclick', handleSidebarDblclick);
  sidebarContent.addEventListener('keydown', handleSidebarKeyboard);
  sidebarContent.addEventListener('keyup', handleSidebarKeyboard);
  sidebarContent.addEventListener('pointerdown', handleSidebarPointerdown);
}

// Resolve the project (or worktree) object an element sits in. The worktree group is nested inside its
// parent project-group, so it is the more specific match and wins — that is what lets a worktree's
// `.project-new-btn` resolve to the worktree without a dedicated branch.
function sidebarProjectForEl(el) {
  const wtGroup = el.closest('.worktree-group');
  const path = wtGroup ? wtGroup.dataset.projectPath : el.closest('.project-group')?.dataset.projectPath;
  if (!path) return null;
  return sidebarProjects.find(p => p.projectPath === path) || null;
}

function sidebarShortName(projectPath) {
  return projectPath.split('/').filter(Boolean).slice(-2).join('/');
}

// The single click router. Most-specific selector first; returns on the first match.
function dispatchSidebarActivation(e) {
  const t = e.target;

  // --- Attention inbox ---
  if (t.closest('.attention-inbox-next-btn')) {
    e.stopPropagation();
    const next = getNextAttentionInboxItem(getAllRenderableSessions(sidebarProjects), getSessionRuntimeState(), activeSessionId);
    focusAttentionItem(next);
    return;
  }
  const inboxItem = t.closest('.attention-inbox-item');
  if (inboxItem) {
    const session = sessionMap.get(inboxItem.dataset.sessionId);
    if (session) focusAttentionItem({ session });
    return;
  }

  // --- Session rows and their action buttons (before the row-open) ---
  const sessionEl = t.closest('.session-item');
  if (sessionEl) {
    const session = sessionMap.get(sessionEl.dataset.sessionId);
    if (!session) return;
    // A row under a missing project is inert — the path is gone. The old code bound NO handlers on such a
    // row (it early-returned before any), so no action fires here either, not just the open.
    if (sessionEl.closest('.project-group.missing')) return;

    // Lineage thread (#193): the "N earlier" toggle folds/unfolds the ancestors; an ancestor row opens its
    // read-only transcript. Both sit inside the item, so they are checked before the row-open.
    const lineageToggle = t.closest('.session-lineage-toggle');
    if (lineageToggle) {
      e.stopPropagation();
      const list = lineageToggle.nextElementSibling;
      if (list && list.classList.contains('session-lineage-ancestors')) {
        const showing = list.style.display !== 'none';
        list.style.display = showing ? 'none' : '';
        // The ▶/▼ rotation comes from the shared `.expanded` class, like the subagent caret.
        lineageToggle.classList.toggle('expanded', !showing);
      }
      return;
    }
    // Ancestor rows are now full `.session-item`s inside the thread — their actions and open route through
    // the normal delegated handling below, no special case (#193).

    if (t.closest('.session-pin')) { e.stopPropagation(); toggleSessionPin(session); return; }
    if (t.closest('.session-stop-btn')) { e.stopPropagation(); confirmAndStopSession(session.sessionId); return; }
    if (t.closest('.session-launch-config-btn')) { e.stopPropagation(); showResumeSessionDialog(session); return; }
    if (t.closest('.session-handoff-btn') || t.closest('.session-health-chip')) { e.stopPropagation(); showHandoffPrompt(session); return; }
    if (t.closest('.session-fork-btn')) { e.stopPropagation(); forkSessionFromRow(session); return; }
    if (t.closest('.session-jsonl-btn')) { e.stopPropagation(); showJsonlViewer(session); return; }
    if (t.closest('.session-copy-id-btn')) { e.stopPropagation(); copySessionId(session); return; }
    if (t.closest('.session-tags-btn')) { e.stopPropagation(); window.bookmarksTags?.openTagPicker(session, t.closest('.session-tags-btn')); return; }
    if (t.closest('.session-timeline-btn')) { e.stopPropagation(); showTimelineViewer(session); return; }
    if (t.closest('.session-archive-btn')) { e.stopPropagation(); archiveSessionFromRow(session); return; }

    // Row open (least specific). Clicks in the actions area / pin / health-chip / lineage thread never open
    // the row. (Missing-project rows already returned above.)
    if (t.closest('.session-actions, .session-pin, .session-health-chip, .session-lineage-thread')) return;
    // Subagents are ephemeral child runs — open the read-only subagent transcript, not a PTY resume.
    // The branch keys on the SESSION FIELD, never on the row's markup, and that is load-bearing (#234):
    // during a search the sidebar flattens subagents into ordinary top-level rows (nestSubagents === false
    // in sidebar.js), so they carry none of the `.sidebar-subagent` nesting. A class check would look right
    // and would try to resume every subagent as a terminal session in the search view alone.
    // test/sidebar-subagent-routing.test.js pins both shapes.
    if (session.parentSessionId) { if (typeof showSubagentTranscript === 'function') showSubagentTranscript(session); return; }
    openSession(session);
    return;
  }

  // --- Worktree headers ---
  const wtHeader = t.closest('.worktree-header');
  if (wtHeader) {
    const wtProject = sidebarProjectForEl(wtHeader);
    if (!wtProject) return;
    if (t.closest('.worktree-new-btn')) { e.stopPropagation(); showNewSessionPopover(wtProject, t.closest('.worktree-new-btn')); return; }
    if (t.closest('.worktree-hide-btn')) { e.stopPropagation(); hideWorktree(wtProject); return; }
    if (t.closest('.worktree-delete-btn')) { e.stopPropagation(); deleteWorktree(wtProject); return; }
    wtHeader.classList.toggle('collapsed');
    return;
  }

  // --- Slug groups ---
  const slugHeader = t.closest('.slug-group-header');
  if (slugHeader) {
    if (t.closest('.slug-group-archive-btn')) { e.stopPropagation(); archiveSlugGroup(slugHeader); return; }
    slugHeader.parentElement.classList.toggle('collapsed');
    saveExpandedSlugs();
    return;
  }
  const slugMore = t.closest('.slug-group-more');
  if (slugMore) {
    const group = slugMore.closest('.slug-group');
    if (group) { group.classList.remove('collapsed'); saveExpandedSlugs(); }
    return;
  }

  // --- "+ N older" toggle ---
  const olderToggle = t.closest('.sessions-more-toggle');
  if (olderToggle) {
    const olderList = olderToggle.nextElementSibling;
    if (!olderList || !olderList.classList.contains('sessions-older')) return;
    const count = olderList.children.length;
    const showing = olderList.style.display !== 'none';
    olderList.style.display = showing ? 'none' : '';
    olderToggle.classList.toggle('expanded', !showing);
    olderToggle.textContent = showing ? `+ ${count} older` : '- hide older';
    return;
  }

  // --- Project headers (checked last: everything above is nested inside a project-group) ---
  const projectHeader = t.closest('.project-header');
  if (projectHeader) {
    const project = sidebarProjectForEl(projectHeader);
    if (!project) return;
    if (t.closest('.project-new-btn')) { e.stopPropagation(); showNewSessionPopover(project, t.closest('.project-new-btn')); return; }
    if (t.closest('.project-tasks-btn')) {
      e.stopPropagation();
      if (typeof openTasksView === 'function') {
        openTasksView({ projectPath: project.projectPath }, 'Project · ' + projectDisplayLabel(project.displayName, sidebarShortName(project.projectPath)));
      }
      return;
    }
    if (t.closest('.project-bookmarks-btn')) {
      e.stopPropagation();
      if (typeof openBookmarksView === 'function') {
        openBookmarksView({ projectPath: project.projectPath }, 'Project · ' + projectDisplayLabel(project.displayName, sidebarShortName(project.projectPath)));
      }
      return;
    }
    if (t.closest('.project-schedule-btn')) { e.stopPropagation(); launchScheduleCreator(project); return; }
    if (t.closest('.project-settings-btn')) { e.stopPropagation(); openSettingsViewer('project', project.projectPath); return; }
    if (t.closest('.project-favorite-btn')) { e.stopPropagation(); toggleProjectFavorite(project); return; }
    if (t.closest('.project-missing-icon')) { e.stopPropagation(); loadProjects(); return; }
    if (t.closest('.project-remap-btn')) { e.stopPropagation(); remapProject(project); return; }
    if (t.closest('.project-archive-btn')) { e.stopPropagation(); archiveProjectGroup(project); return; }
    // Header toggle (collapse/expand), persisted.
    projectHeader.classList.toggle('collapsed');
    setProjectCollapsed(project.projectPath, projectHeader.classList.contains('collapsed'));
    return;
  }
}

// A double-click on a session name starts the inline rename. Delegated, so the rename input's replacement
// summary is caught here too — sidebar-session-row.js no longer binds dblclick per node.
function handleSidebarDblclick(e) {
  const summaryEl = e.target.closest('.session-summary');
  if (!summaryEl) return;
  const item = summaryEl.closest('.session-item');
  const session = item && sessionMap.get(item.dataset.sessionId);
  if (session) { e.stopPropagation(); startRename(summaryEl, session); }
}

// Keyboard activation for the button-like DIVs/SPANs (role="button"). A real <button> already fires a
// click on Enter/Space, so the click delegation covers it — skip it here to avoid a double activation.
function handleSidebarKeyboard(e) {
  // A real <button> already emits a synthetic click on Enter/Space (the click delegation handles it), so
  // resolve to the nearest button-like ancestor and skip it when it is a native button — only the
  // role="button" DIV/SPANs need explicit keyboard activation.
  const activatable = e.target.closest('button, [role="button"]');
  if (!activatable || activatable.tagName === 'BUTTON') return;
  handleKeyboardActivation(e, () => dispatchSidebarActivation(e));
}

// The manual project-reorder drag begins on the grip handle (pointerdown, threshold-gated in
// startProjectDrag/startPointerDrag).
function handleSidebarPointerdown(e) {
  const handle = e.target.closest('.project-drag-handle');
  if (!handle) return;
  const header = handle.closest('.project-header');
  const project = sidebarProjectForEl(handle);
  if (project && header) { e.stopPropagation(); startProjectDrag(project, header, e); }
}

// --- Action flows (the bodies of the old per-node handlers, unchanged; context now passed in) ---

async function toggleProjectFavorite(project) {
  const { favorited } = await window.api.toggleProjectFavorite(project.projectPath);
  const fav = !!favorited;
  // Update the flag in both cached lists so either view re-sorts correctly, then a light re-render —
  // not a full loadProjects() (2× getProjects IPC), matching the session-pin path (issue #78).
  for (const list of [cachedProjects, cachedAllProjects]) {
    const p = list && list.find(x => x.projectPath === project.projectPath);
    if (p) p.favorited = fav;
  }
  refreshSidebar({ resort: true });
}

async function remapProject(project) {
  const newPath = await window.api.browseFolder();
  if (!newPath) return;
  const shortName = sidebarShortName(project.projectPath);
  const confirmed = await showControlDialog({
    title: 'Change Project Path',
    message: 'Switchboard will associate this project group with the selected folder.',
    confirmLabel: 'Change Path',
    tone: 'warning',
    details: { Project: shortName, From: project.projectPath, To: newPath },
  });
  if (!confirmed) return;
  const result = await window.api.remapProject(project.projectPath, newPath);
  if (result.error) {
    await showControlMessage({ title: 'Remap Failed', message: result.error, confirmLabel: 'OK', tone: 'danger' });
  } else {
    loadProjects();
  }
}

async function archiveProjectGroup(project) {
  const sessions = project.sessions.filter(s => !s.archived);
  if (sessions.length === 0) return;
  const shortName = sidebarShortName(project.projectPath);
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
}

async function hideWorktree(wtProject) {
  const name = wtProject.projectPath.split('/').pop();
  const confirmed = await showControlDialog({
    title: 'Hide Worktree',
    message: 'This removes the worktree from Switchboard. Session files are not deleted.',
    confirmLabel: 'Hide Worktree',
    tone: 'warning',
    details: { Worktree: name, Path: wtProject.projectPath },
  });
  if (!confirmed) return;
  // The dialog says "Hide", so it hides (#167). It used to call removeProject — which, back when hiding
  // and removing were the same act, was the only thing it could do.
  await window.api.hideProject(wtProject.projectPath);
  loadProjects();
}

async function deleteWorktree(wtProject) {
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
}

async function archiveSlugGroup(slugHeader) {
  const group = slugHeader.parentElement;
  const sessionItems = group.querySelectorAll('.session-item');
  const archiveTargets = [];
  for (const item of sessionItems) {
    const sid = item.dataset.sessionId;
    const session = sessionMap.get(sid);
    if (!session || session.archived) continue;
    archiveTargets.push(session);
  }
  if (archiveTargets.length === 0) return;
  const name = slugHeader.querySelector('.slug-group-name')?.textContent || 'session group';
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
}

async function toggleSessionPin(session) {
  const { starred } = await window.api.toggleStar(session.sessionId);
  session.starred = starred;
  refreshSidebar({ resort: true });
}

async function copySessionId(session) {
  await window.api.writeClipboard(session.sessionId);
  showControlToast({ message: 'Session ID copied.' });
}

function forkSessionFromRow(session) {
  // Find the project for this session.
  const project = [...cachedAllProjects, ...cachedProjects].find(p =>
    p.sessions.some(s => s.sessionId === session.sessionId)
  );
  if (project) forkSession(session, project);
}

async function archiveSessionFromRow(session) {
  const newVal = session.archived ? 0 : 1;
  if (newVal && activePtyIds.has(session.sessionId)) {
    const confirmed = await showControlDialog({
      title: 'Archive Running Session',
      message: 'Archiving this running session will stop its process first.',
      confirmLabel: 'Stop And Archive',
      tone: 'danger',
      details: {
        Session: cleanDisplayName(session.name || session.aiTitle || session.summary) || session.sessionId,
        Project: session.projectPath ? sidebarShortName(session.projectPath) : '',
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
