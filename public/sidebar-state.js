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

  // Whether a project has nothing left to render and should be dropped from the
  // sidebar before any DOM is built.
  //
  // `topLevelCount` is the number of NON-SUBAGENT sessions in the payload, and it
  // has to be: subagents are rendered nested under their parent (or in the orphan
  // section), never in the flat list, so they are stripped before `filteredCount`
  // is counted. Weighing an empty filtered list against the RAW payload therefore
  // dropped a project whose payload held nothing but subagent rows — one whose
  // top-level sessions were all archived — while a project with a genuinely empty
  // payload kept its placeholder row. Same situation, two outcomes (#173).
  //
  // With no filter active and nothing top-level left, the project stays on as an
  // empty row: only the explicit hide / auto-hide actions (#57) remove a project.
  function projectHasNothingToRender({
    filteredCount = 0,
    topLevelCount = 0,
    anyFilterActive = false,
    projectMatchedOnly = false,
  } = {}) {
    if (filteredCount > 0 || projectMatchedOnly) return false;
    return topLevelCount > 0 || anyFilterActive;
  }

  return { shouldRenderProjectGroup, projectHasNothingToRender };
});
