// --- Sidebar events: what every click on a row, a header or a chip does (#218) ---
//
// `rebindSidebarEvents` runs after each render and wires the whole tree: open a session, stop it,
// archive, star, rename, fork, hand off, the project header's menu, favourites, the worktree actions.
// The two drag helpers and the worktree-delete confirmation come with it — it is their only caller.
//
// Came out of sidebar.js as the largest thing in it. The reason it is one function and not twenty is
// morphdom: `finalizeSidebar` patches the DOM in place and the old nodes' handlers go with them, so
// everything has to be re-bound in one pass over the fresh tree. That is a real constraint, not a mess,
// and it is why this file is one big function rather than a folder.
//
// The split makes the shape visible: it is all `.onclick =` assignment on nodes that
// sidebar-session-row.js and sidebar.js built. It creates no DOM and holds no state.
//
// A classic <script>, like the file it came from: nothing runs at parse time. It reaches back into
// sidebar.js (renderProjects, refreshSidebar's callers, folderId, getAllRenderableSessions), into
// app.js's session maps, and out to the dialogs — all at call time, from a click.
//
// It WRITES fields on objects other files own (`session.archived`, `session.starred`, `session.name` on
// app.js's sessionMap rows; `p.favorited` on cachedProjects). Those are field writes on shared objects,
// not rebindings of another file's `let`, so they cross a file boundary without caring about it. The one
// that DOES rebind — `sortedOrder = newSortedOrder` — stayed in sidebar.js with finalizeSidebar.

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

// The session row itself (buildSessionItem), the inline rename, and positionPopover moved to
// shell/sidebar-session-row.js (#218).

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
