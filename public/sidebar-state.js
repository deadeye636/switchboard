(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function shouldRenderProjectGroup({
    visibleCount = 0,
    projectMatchedOnly = false,
    emptyPlaceholder = false,
  } = {}) {
    // emptyPlaceholder: a project with no sessions at all (all archived, or a
    // fresh project directory) — nothing filtered and nothing truncated away.
    // Render it as an empty placeholder row so archiving the last session doesn't
    // silently drop the whole project; the explicit hide feature should be the
    // only thing that removes a project. Distinct from the "all sessions truncated
    // away" case (olderCount > 0), which stays hidden.
    return projectMatchedOnly || visibleCount > 0 || emptyPlaceholder;
  }

  return { shouldRenderProjectGroup };
});
