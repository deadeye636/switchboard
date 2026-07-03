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

  return { shouldRenderProjectGroup };
});
