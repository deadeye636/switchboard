(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function shouldRenderProjectGroup({
    visibleCount = 0,
    olderCount = 0,
    projectMatchedOnly = false,
    emptyPlaceholder = false,
  } = {}) {
    // A non-hidden project always renders — the backend already dropped hidden
    // projects, so anything reaching here should stay visible. That includes a
    // project whose sessions are all older than the fold threshold (visibleCount
    // 0, olderCount > 0): render the group with its sessions folded behind
    // "+N older" instead of silently dropping the whole project (#54). The
    // explicit hide / auto-hide feature (#57) is the only thing that removes a
    // project. emptyPlaceholder covers the no-sessions case (all archived / fresh
    // directory). Only case left hidden: an active search/filter that this project
    // matches nothing in (visibleCount 0, olderCount 0, emptyPlaceholder false).
    return projectMatchedOnly || visibleCount > 0 || olderCount > 0 || emptyPlaceholder;
  }

  // Sessions that still count toward a user group's membership under an active
  // filter — a stopped session still belongs to its group; archived and subagent
  // sessions never form a top-level group. (#102)
  function sessionsForGroupVisibility(sessions) {
    return (sessions || []).filter((s) => s && !s.archived && !s.parentSessionId);
  }

  // The user-group sections to render for a project. Rows come from the already
  // filtered sessions (so "running only" hides stopped rows), but under
  // showRunningOnly a group with assigned, non-archived members stays visible
  // with an empty body — so a new session can still be started from its header
  // even when nothing in it is running (#102). `groupSessions` is injected (from
  // groups-model) to keep this DOM-free and unit-testable.
  function userGroupSections({
    groupSessions,
    groupsState,
    projectSessions = [],
    filteredSessions = [],
    showRunningOnly = false,
  } = {}) {
    if (typeof groupSessions !== 'function' || !groupsState) {
      return { sections: [], ungrouped: filteredSessions };
    }
    const gs = groupSessions(groupsState, filteredSessions);
    const sections = gs.grouped.map((g) => ({ group: g.group, sessions: g.sessions }));
    if (showRunningOnly) {
      const shown = new Set(sections.map((s) => s.group.id));
      const assignable = sessionsForGroupVisibility(projectSessions);
      for (const g of groupSessions(groupsState, assignable).grouped) {
        if (!shown.has(g.group.id)) sections.push({ group: g.group, sessions: [] });
      }
    }
    return { sections, ungrouped: gs.ungrouped };
  }

  return { shouldRenderProjectGroup, sessionsForGroupVisibility, userGroupSections };
});
