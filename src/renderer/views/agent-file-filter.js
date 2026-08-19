// views/agent-file-filter.js — which rows the Agent Files tab shows, as pure functions (#447).
//
// WHY THIS IS ITS OWN FILE. The filtering used to live inline in plans-memory-view.js, where the only
// thing a test could do was assert that certain source strings were present. That is what let a real
// defect ship green: the empty-state branch asked whether the RAW data was empty, so filtering a
// non-empty list down to nothing rendered a blank panel while the "nothing matches" message it had
// just gained sat unreachable — and the test that "covered" it only checked that the sentence existed
// somewhere in the file.
//
// So the decisions live here, in functions a test can call with data and check the answer of. The view
// keeps the DOM.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  /**
   * Does one row survive the active filters?
   *
   * `searchIds` is a Set of file paths, or null for "no search". An EMPTY set is not null: it means the
   * search ran and matched nothing, which has to narrow the list to nothing rather than open it up.
   *
   * A row claimed by several backends passes on any of them — Codex and Pi both declare `AGENTS.md`,
   * and filtering to Pi has to show the file Pi really reads.
   */
  function agentFileRowVisible(file, filters) {
    if (!file) return false;
    const f = filters || {};
    if (f.searchIds && !f.searchIds.has(file.filePath)) return false;
    if (f.type && file.kind !== f.type) return false;
    if (f.backend && !(file.backendIds || []).includes(f.backend)) return false;
    return true;
  }

  /** Any filter at all? Several behaviours hang off this: the empty-state wording, and whether a group renders collapsed. */
  function agentFileFiltering(filters) {
    const f = filters || {};
    return !!(f.searchIds || f.type || f.backend);
  }

  function groupsOf(scope) {
    return (scope && Array.isArray(scope.groups)) ? scope.groups : [];
  }

  /**
   * A resource group with only its surviving files; a group left with none drops out entirely.
   *
   * `g.files || []` because this module's whole point is that it can be handed data — including data
   * from a caller that got the shape wrong. The payload never emits a group without files today, so
   * the guard is for the day something upstream changes and the tab would otherwise go blank.
   */
  function agentFileVisibleGroups(groups, filters) {
    // Normalised even when no filter is on, so every consumer downstream — the counter here, the view
    // that iterates `rg.files` — can rely on the array being there. Returning the input untouched was
    // the cheaper path and moved the same crash one caller along.
    const filtering = agentFileFiltering(filters);
    return (groups || [])
      .map(g => ({
        ...g,
        files: filtering
          ? (g.files || []).filter(file => agentFileRowVisible(file, filters))
          : (g.files || []),
      }))
      .filter(g => g.files.length > 0);
  }

  /**
   * The whole list, already filtered: what the view should build, and how many rows that is.
   *
   * `shown` is counted from what SURVIVED, never from the raw data. That is the fix for the defect
   * above, and the reason this function returns the count rather than letting each caller add it up.
   */
  function agentFileSections(data, filters) {
    const d = data || { global: { files: [] }, projects: [] };
    const globalFiles = ((d.global && d.global.files) || []).filter(file => agentFileRowVisible(file, filters));
    const globalGroups = agentFileVisibleGroups(groupsOf(d.global), filters);

    const projects = (d.projects || [])
      .map(proj => ({
        proj,
        files: (proj.files || []).filter(file => agentFileRowVisible(file, filters)),
        groups: agentFileVisibleGroups(groupsOf(proj), filters),
      }))
      .filter(section => section.files.length > 0 || section.groups.length > 0);

    const countGroups = (groups) => groups.reduce((n, g) => n + g.files.length, 0);
    const shown = globalFiles.length + countGroups(globalGroups)
      + projects.reduce((n, s) => n + s.files.length + countGroups(s.groups), 0);

    return { globalFiles, globalGroups, projects, shown };
  }

  /**
   * Does this row show its own backend badges?
   *
   * The badge belongs where it DISTINGUISHES. Inside a group that already names one backend, every row
   * has that backend and the badge would be the same word eighty times over — so the group says it once
   * and the rows stay quiet. A row that disagrees with its group keeps its badges, and there the badge
   * means something again: this one is not what the heading led you to expect.
   *
   * Outside such a group (the instruction files, where CLAUDE.md is Claude's and Pi's while AGENTS.md
   * next to it is Codex' and Pi's) every row shows them, because there the rows really do differ.
   */
  function agentFileRowShowsBadges(file, groupBackendId) {
    const ids = (file && file.backendIds) || [];
    if (!ids.length) return false;
    if (!groupBackendId) return true;
    return !(ids.length === 1 && ids[0] === groupBackendId);
  }

  /** What an empty list should say. The two cases are different facts and must not read alike. */
  function agentFileEmptyMessage(filters) {
    return agentFileFiltering(filters)
      ? 'Nothing matches the current filter.'
      : 'No agent files found.';
  }

  /**
   * A filter whose chip is no longer in the data clears itself — otherwise the list stays narrowed by
   * something there is no way left to switch off.
   */
  function agentFileLiveFilter(value, rows) {
    if (!value) return null;
    return (rows || []).some(r => r && r.id === value) ? value : null;
  }

  return {
    agentFileRowVisible,
    agentFileFiltering,
    agentFileVisibleGroups,
    agentFileSections,
    agentFileRowShowsBadges,
    agentFileEmptyMessage,
    agentFileLiveFilter,
  };
});
