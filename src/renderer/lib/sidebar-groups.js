// The session sidebar's groups by id and name (#835), in their default order. Electron-free (UMD).
//
// Two pages need them: the sidebar itself (session/session-sidebar.js, index.html), which draws the groups and reads
// them, and the settings window (panels/settings-panel.js, settings.html), whose Sessions category lists them to show
// and hide. The settings window does not load the sidebar, so the names live here and both read them; the sidebar's
// own group table (`SESSION_SIDEBAR_GROUPS`) adds a loader per id, and test/session-sidebar-hidden.test.js checks that
// the two name the same ids in the same order.
//
// `sessionSidebarHidden` (a global setting, a list of group ids) is what is hidden. `hiddenSidebarGroups` reads it: an
// id this version does not know is dropped, a repeat counts once, anything that is not a list hides nothing.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // The default order (#841): the two figures a user glances at most come right after where the session runs. A saved
  // order (`sessionSidebarOrder`, #829) is kept as it is.
  const SESSION_SIDEBAR_GROUP_NAMES = Object.freeze([
    Object.freeze({ id: 'repository', label: 'Repository' }),
    Object.freeze({ id: 'processes', label: 'Processes' }),
    Object.freeze({ id: 'context', label: 'Context' }),
    Object.freeze({ id: 'tasks', label: 'Tasks & notes' }),
    Object.freeze({ id: 'handoffs', label: 'Handoffs' }),
    Object.freeze({ id: 'instructions', label: 'Instructions' }),
    Object.freeze({ id: 'connectors', label: 'Connectors' }),
  ]);

  function hiddenSidebarGroups(saved) {
    const known = new Set(SESSION_SIDEBAR_GROUP_NAMES.map((g) => g.id));
    const out = [];
    for (const id of Array.isArray(saved) ? saved : []) {
      if (known.has(id) && !out.includes(id)) out.push(id);
    }
    return out;
  }

  // The list with one group shown or hidden, in the default order, so the stored value does not depend on the
  // order the clicks came in.
  function withSidebarGroupHidden(saved, id, hide) {
    const current = new Set(hiddenSidebarGroups(saved));
    if (hide) current.add(id); else current.delete(id);
    return SESSION_SIDEBAR_GROUP_NAMES.map((g) => g.id).filter((g) => current.has(g));
  }

  return { SESSION_SIDEBAR_GROUP_NAMES, hiddenSidebarGroups, withSidebarGroupHidden };
});
